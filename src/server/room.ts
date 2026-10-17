/**
 * A single poker room: seats, membership, the hand loop, and bot turns.
 *
 * Trust model: the room owns the only `TableState`. Clients send *requests*;
 * every one is re-validated against the engine, and every outbound payload is a
 * filtered view built by `view.ts`. A bot is deliberately given the same
 * filtered context a human would get, so a future "GTO" personality cannot
 * accidentally read the deck.
 *
 * Time is injected (`schedule`) so the whole loop can be driven synchronously in
 * tests without timers.
 */

import { randomUUID } from "node:crypto";

import { cardToString, type Card, type Rng } from "../engine/cards.ts";
import {
  type HandEvent,
  type LegalActions,
  type PlayerAction,
  type Street,
  type TableState,
  applyAction,
  createTable,
  legalActions,
  removePlayer,
  seatPlayer,
  setBlinds,
  startHand,
  totalPot,
} from "../engine/table.ts";
import {
  DEFAULT_SETTINGS,
  type HandHistoryEntry,
  type HandHistorySummary,
  type RoomSettingsPatch,
  type RoomSettingsView,
  SETTINGS_BOUNDS,
  type ServerMessage,
} from "./protocol.ts";
import { buildTableView, buildHandHistoryEntry } from "./view.ts";

/** How many completed hands a room keeps for the history panel. */
export const MAX_HISTORY_HANDS = 100;
export const RECONNECT_GRACE_MS = 60_000;

export interface RoomMember {
  readonly playerId: string;
  readonly token: string;
  name: string;
  seat: number | null;
  connected: boolean;
  readonly isBot: boolean;
  readonly personaId: string | null;
  /** Chips this member has taken off the table; used for a future bankroll view. */
  bankroll: number;
  /** Asked to leave during a hand; the seat is released once it settles. */
  leaving: boolean;
  buyIn: number;
  pendingBuyIn: number;
}

export interface RoomSocket {
  send(message: ServerMessage): void;
}

export interface PersonaInfo {
  readonly id: string;
  readonly name: string;
  readonly description?: string;
}

export interface BotOpponent {
  readonly seatIndex: number;
  readonly stack: number;
  readonly committed: number;
  readonly folded: boolean;
  readonly allIn: boolean;
  readonly lastAction: string | null;
}

/** Everything a bot is allowed to know when it decides. */
export interface BotContext {
  readonly signal?: AbortSignal;
  readonly seatIndex: number;
  readonly handId: number;
  readonly hole: Card[];
  readonly board: Card[];
  readonly street: Street;
  readonly stack: number;
  readonly committed: number;
  readonly pot: number;
  readonly toCall: number;
  /** Call cost divided by the pot after calling; the break-even equity. */
  readonly potOdds: number;
  readonly bigBlind: number;
  readonly legal: LegalActions;
  readonly opponents: readonly BotOpponent[];
  /** Public event history — never contains another player's hole cards. */
  readonly history: readonly HandEvent[];
}

export type BotDecider = (
  context: BotContext,
  personaId: string,
) => PlayerAction | Promise<PlayerAction>;

/**
 * Injectable timing. Tests drive the whole loop synchronously by collecting the
 * callbacks instead of waiting on real clocks.
 */
export interface RoomTimers {
  set(fn: () => void, delayMs: number): number;
  clear(handle: number): void;
  now(): number;
}

export const systemTimers: RoomTimers = {
  set: (fn, delayMs) => setTimeout(fn, delayMs) as unknown as number,
  clear: (handle) => clearTimeout(handle as unknown as ReturnType<typeof setTimeout>),
  now: () => Date.now(),
};

export interface RoomOptions {
  readonly onClose?: (room: Room) => void;
  readonly code: string;
  readonly personas: readonly PersonaInfo[];
  readonly botDecider: BotDecider;
  /** Start from these; the host may change most of them at the table. */
  readonly settings?: Partial<RoomSettingsPatch>;
  /** Milliseconds to "think"; defaults to a short, slightly randomised pause. */
  readonly botDelay?: (context: { seatIndex: number; street: Street }) => number;
  /** Injected so tests can run the loop synchronously. */
  readonly timers?: RoomTimers;
  readonly rng?: Rng;
  /**
   * Overrides `settings.actionTimeoutMs`: seconds a human has to act before the
   * table moves on without them. 0 disables the clock.
   */
  readonly actionTimeoutMs?: number;
}

/** Rejects a settings change with a message the UI can show as-is. */
export function validateSettings(settings: Required<RoomSettingsPatch>): void {
  const check = (label: string, value: number, bounds: { min: number; max: number }): void => {
    if (!Number.isInteger(value) || value < bounds.min || value > bounds.max) {
      throw new Error(`${label} 必须在 ${bounds.min} 到 ${bounds.max} 之间`);
    }
  };

  check("座位数", settings.seats, SETTINGS_BOUNDS.seats);
  check("小盲", settings.smallBlind, SETTINGS_BOUNDS.smallBlind);
  check("大盲", settings.bigBlind, SETTINGS_BOUNDS.bigBlind);
  check("起始筹码", settings.startingStack, SETTINGS_BOUNDS.startingStack);
  check("行动限时", settings.actionTimeoutMs, SETTINGS_BOUNDS.actionTimeoutMs);
  check("升盲手数", settings.blindLevelHands, SETTINGS_BOUNDS.blindLevelHands);
  check("升盲倍数", settings.blindGrowth, SETTINGS_BOUNDS.blindGrowth);
  check("自动开局间隔", settings.autoStartSeconds, SETTINGS_BOUNDS.autoStartSeconds);

  if (settings.bigBlind <= settings.smallBlind) throw new Error("大盲必须大于小盲");
  if (settings.startingStack < settings.bigBlind * 2) throw new Error("起始筹码至少要有两个大盲");
  if (settings.mode === "tournament" && settings.startingStack < settings.bigBlind * 20) {
    throw new Error(`锦标赛起始筹码至少要 20 个大盲（也就是 ${settings.bigBlind * 20}）`);
  }
  if (settings.mode === "tournament" && settings.blindGrowth < 1) throw new Error("锦标赛的升盲倍数不能小于 1");
}

export class Room {
  readonly code: string;
  /** Replaced wholesale when the host changes the seat count before play. */
  table: TableState;
  readonly personas: readonly PersonaInfo[];

  private readonly members = new Map<string, RoomMember>();
  private readonly byToken = new Map<string, RoomMember>();
  private readonly sockets = new Map<string, RoomSocket>();
  private readonly botDecider: BotDecider;
  private readonly botDelay: (context: { seatIndex: number; street: Street }) => number;
  private readonly timers: RoomTimers;
  private readonly rng: Rng;
  private settings: Required<RoomSettingsPatch>;
  /** The first human to join owns the room and is the only one who may configure it. */
  private hostId: string | null = null;
  /** Tournament blind level, 1-based. Always 1 in a cash game. */
  private level = 1;
  private handsAtLevel = 0;
  /** Completed hands, oldest first, capped so a long session cannot grow forever. */
  private handHistory: HandHistoryEntry[] = [];
  private archivedHandId = -1;
  private actionTimer: number | null = null;
  private actionDeadline: number | null = null;
  private actionClockKey: string | null = null;
  /** Scheduled deal of the next hand, when auto-start is on. */
  private nextHandTimer: number | null = null;
  private nextHandAt: number | null = null;
  private botTurnPending = false;
  private botTimer: number | null = null;
  private botRequest: AbortController | null = null;
  private reconnectTimer: number | null = null;
  private readonly onClose?: (room: Room) => void;
  private closed = false;
  private everSeatedHuman = false;
  private readonly revealed = new Map<number, string[]>();
  private lastBotError: string | null = null;

  constructor(options: RoomOptions) {
    this.onClose = options.onClose;
    this.code = options.code;
    this.personas = options.personas;

    // Settings objects are readonly by contract, so build the resolved value in
    // one go rather than patching fields afterwards.
    const requested: Required<RoomSettingsPatch> = {
      ...DEFAULT_SETTINGS,
      ...options.settings,
      ...(options.actionTimeoutMs === undefined ? {} : { actionTimeoutMs: Math.max(0, options.actionTimeoutMs) }),
    };
    // A tournament with 2bb stacks is not a tournament, so a too-small stack
    // from the environment is raised to something playable before validating.
    const minimumTournamentStack = requested.bigBlind * 20;
    const resolved =
      requested.mode === "tournament" && requested.startingStack < minimumTournamentStack
        ? { ...requested, startingStack: minimumTournamentStack }
        : requested;
    validateSettings(resolved);
    this.settings = resolved;

    this.table = createTable({
      seats: this.settings.seats,
      smallBlind: this.settings.smallBlind,
      bigBlind: this.settings.bigBlind,
    });
    this.botDecider = options.botDecider;
    this.botDelay = options.botDelay ?? (() => 700 + Math.floor(Math.random() * 900));
    this.timers = options.timers ?? systemTimers;
    this.rng = options.rng ?? Math.random;
  }

  // ------------------------------------------------------------------ settings

  currentSettings(): RoomSettingsView {
    return {
      ...this.settings,
      level: this.level,
      handsUntilNextLevel:
        this.settings.mode === "tournament" ? Math.max(0, this.settings.blindLevelHands - this.handsAtLevel) : null,
    };
  }

  hostPlayerId(): string | null {
    return this.hostId;
  }

  isHost(playerId: string): boolean {
    return this.hostId === playerId;
  }

  /**
   * Applies a settings change from the host.
   *
   * The guards exist because some settings are baked into the table itself:
   * seat count needs an empty table; mode and blind schedule lock after the
   * first hand. Blinds change between hands, while the action clock is live.
   */
  configure(playerId: string, patch: RoomSettingsPatch): void {
    if (this.hostId !== playerId) throw new Error("只有房主可以修改房间设置");

    const previous = this.settings;
    const next: Required<RoomSettingsPatch> = { ...previous, ...patch };
    validateSettings(next);
    const blindsChanged = next.smallBlind !== previous.smallBlind || next.bigBlind !== previous.bigBlind;
    if (blindsChanged && this.handInProgress()) throw new Error("牌局进行中不能修改盲注");

    const occupied = this.table.seats.some((seat) => seat.playerId !== null);
    if (next.seats !== previous.seats && occupied) throw new Error("有人入座时不能修改座位数");
    if (this.table.handId > 0) {
      if (next.mode !== previous.mode) throw new Error("牌局已经开始，不能切换模式");
      if (next.blindLevelHands !== previous.blindLevelHands || next.blindGrowth !== previous.blindGrowth) {
        // Name the values that arrived: a rejection nobody can explain is worse
        // than the rejection itself.
        const changed = [
          next.blindLevelHands !== previous.blindLevelHands
            ? `每多少手升盲 ${previous.blindLevelHands} → ${next.blindLevelHands}`
            : null,
          next.blindGrowth !== previous.blindGrowth
            ? `升盲倍数 ${previous.blindGrowth} → ${next.blindGrowth}`
            : null,
        ]
          .filter((part): part is string => part !== null)
          .join("，");
        throw new Error(`牌局已经开始，不能修改升盲设置（收到：${changed}）`);
      }
    }

    if (next.seats !== previous.seats) {
      // Safe: the guard above proved nobody is seated.
      this.table = createTable({ seats: next.seats, smallBlind: next.smallBlind, bigBlind: next.bigBlind });
    }

    const modeChanged = next.mode !== previous.mode;
    this.settings = next;
    if (modeChanged) {
      this.level = 1;
      this.handsAtLevel = 0;
    }

    // An unchanged blind value must not prevent live changes to the action clock.
    if (blindsChanged || modeChanged) this.applyBlinds();
    this.afterStateChange();
  }

  private levelBlinds(): { small: number; big: number } {
    const factor = this.settings.blindGrowth ** (this.level - 1);
    const small = Math.max(1, Math.round(this.settings.smallBlind * factor));
    const big = Math.max(small + 1, Math.round(this.settings.bigBlind * factor));
    return { small, big };
  }

  private applyBlinds(): void {
    const blinds =
      this.settings.mode === "tournament"
        ? this.levelBlinds()
        : { small: this.settings.smallBlind, big: this.settings.bigBlind };
    setBlinds(this.table, blinds.small, blinds.big);
  }

  // ---------------------------------------------------------------- membership

  /** Creates a member, or resumes one from a previously issued token. */
  join(rawName: string, token?: string): RoomMember {
    this.assertOpen();
    if (token) {
      const existing = this.byToken.get(token);
      if (existing) {
        existing.connected = true;
        return existing;
      }
    }
    const member: RoomMember = {
      playerId: randomUUID(),
      token: randomUUID(),
      name: sanitizeName(rawName),
      seat: null,
      connected: true,
      isBot: false,
      personaId: null,
      bankroll: 0,
      leaving: false,
      buyIn: 0,
      pendingBuyIn: 0,
    };
    this.members.set(member.playerId, member);
    this.byToken.set(member.token, member);
    // First human in the door owns the room; bots never do.
    this.hostId ??= member.playerId;
    return member;
  }

  attach(playerId: string, socket: RoomSocket): void {
    this.assertOpen();
    this.sockets.set(playerId, socket);
    const member = this.members.get(playerId);
    if (member) member.connected = true;
    this.transferHost();
    this.afterStateChange();
  }

  detach(playerId: string, socket?: RoomSocket): void {
    if (socket && this.sockets.get(playerId) !== socket) return;
    this.sockets.delete(playerId);
    const member = this.members.get(playerId);
    if (member) member.connected = false;
    this.transferHost();
    this.afterStateChange();
  }

  leave(member: RoomMember): void {
    if (member.seat !== null) this.stand(member);
    this.detach(member.playerId);
    if (!this.hasConnectedPlayer()) this.close();
  }

  private transferHost(): void {
    if (this.hostId && this.members.get(this.hostId)?.connected) return;
    this.hostId = [...this.members.values()].find((member) => !member.isBot && member.connected)?.playerId ?? null;
  }

  isClosed(): boolean { return this.closed; }

  private assertOpen(): void {
    if (this.closed) throw new Error("牌桌已关闭");
  }

  private hasConnectedPlayer(): boolean {
    return [...this.members.values()].some((member) => !member.isBot && member.connected && member.seat !== null);
  }

  private cancelPlayTimers(): void {
    for (const handle of [this.botTimer, this.nextHandTimer, this.actionTimer]) {
      if (handle !== null) this.timers.clear(handle);
    }
    this.botTimer = this.nextHandTimer = this.actionTimer = null;
    this.nextHandAt = this.actionDeadline = this.actionClockKey = null;
    this.botTurnPending = false;
    this.botRequest?.abort();
    this.botRequest = null;
  }

  private close(): void {
    if (this.closed) return;
    this.closed = true;
    this.cancelPlayTimers();
    if (this.reconnectTimer !== null) this.timers.clear(this.reconnectTimer);
    this.reconnectTimer = null;
    for (const socket of this.sockets.values()) socket.send({ t: "roomClosed" });
    this.sockets.clear();
    this.onClose?.(this);
  }

  /** Pause immediately on a lost connection; never spend API calls without humans. */
  private syncPresence(): boolean {
    const humans = [...this.members.values()].filter((member) => !member.isBot && member.seat !== null);
    if (this.everSeatedHuman && humans.length === 0 && this.table.seats.some((seat) => this.isBotSeat(seat.index))) {
      this.close();
      return false;
    }
    if (this.hasConnectedPlayer()) {
      if (this.reconnectTimer !== null) this.timers.clear(this.reconnectTimer);
      this.reconnectTimer = null;
      return true;
    }
    this.cancelPlayTimers();
    if (this.everSeatedHuman && this.reconnectTimer === null) {
      this.reconnectTimer = this.timers.set(() => this.close(), RECONNECT_GRACE_MS);
    }
    return false;
  }

  memberOf(playerId: string): RoomMember | null {
    return this.members.get(playerId) ?? null;
  }

  seatOfMember(member: RoomMember): number | null {
    return member.seat;
  }

  members_(): RoomMember[] {
    return [...this.members.values()];
  }

  isBotSeat = (seatIndex: number): boolean => {
    const member = this.memberAtSeat(seatIndex);
    return member?.isBot === true;
  };

  /** Which persona a seated bot is playing, for the "one of each" rule. */
  personaAtSeat = (seatIndex: number): string | null => {
    const member = this.memberAtSeat(seatIndex);
    return member?.isBot === true ? member.personaId : null;
  };

  /** One bot per persona: three GTOpros is not a table, it is a bug. */
  private personaInUse(personaId: string): boolean {
    for (const member of this.members.values()) {
      if (member.isBot && member.seat !== null && member.personaId === personaId) return true;
    }
    return false;
  }

  memberAtSeat(seatIndex: number): RoomMember | null {
    for (const member of this.members.values()) if (member.seat === seatIndex) return member;
    return null;
  }

  // ------------------------------------------------------------------- seating

  private resolveBuyIn(requested: number | undefined): number {
    const amount = requested ?? this.settings.startingStack;
    const bounds = SETTINGS_BOUNDS.startingStack;
    if (!Number.isSafeInteger(amount) || amount < bounds.min || amount > bounds.max) {
      throw new Error(`买入必须在 ${bounds.min} 到 ${bounds.max} 之间`);
    }
    const minimum = this.settings.bigBlind * 2;
    if (amount < minimum) throw new Error(`买入至少要两个大盲（${minimum}）`);
    return amount;
  }

  sit(member: RoomMember, seatIndex: number, buyIn?: number): void {
    this.assertOpen();
    const seat = this.table.seats[seatIndex];
    if (!seat) throw new Error(`没有 ${seatIndex} 号座位`);
    if (seat.playerId !== null) throw new Error("该座位已经被占用");
    if (member.seat !== null) throw new Error("你已经在座上了，先点自己座位上的「离座」再换座");

    const amount = this.resolveBuyIn(buyIn);
    seatPlayer(this.table, seatIndex, { playerId: member.playerId, name: member.name, stack: amount });
    member.seat = seatIndex;
    member.buyIn = amount;
    member.pendingBuyIn = 0;
    this.everSeatedHuman = true;
    this.afterStateChange();
  }

  addBot(seatIndex: number, personaId: string, buyIn?: number): void {
    this.assertOpen();
    const seat = this.table.seats[seatIndex];
    if (!seat) throw new Error(`没有 ${seatIndex} 号座位`);
    if (seat.playerId !== null) throw new Error("该座位已经被占用");
    const amount = this.resolveBuyIn(buyIn);

    const persona = this.personas.find((candidate) => candidate.id === personaId);
    if (!persona) throw new Error(`未知的人格：${personaId}`);
    if (this.personaInUse(personaId)) throw new Error(`桌上已经有一个「${persona.name}」了`);

    const member: RoomMember = {
      playerId: `bot:${randomUUID()}`,
      token: `bot-token:${randomUUID()}`,
      name: persona.name,
      seat: seatIndex,
      connected: true,
      isBot: true,
      personaId: persona.id,
      bankroll: 0,
      leaving: false,
      buyIn: amount,
      pendingBuyIn: 0,
    };
    seatPlayer(this.table, seatIndex, { playerId: member.playerId, name: member.name, stack: amount });
    this.members.set(member.playerId, member);
    this.byToken.set(member.token, member);
    this.afterStateChange();
  }

  /**
   * Gives up the seat and takes the chips off the table.
   *
   * Mid-hand this is deferred, *even for a player who already folded*: a seat's
   * committed chips are part of the pot maths, so yanking one out from under a
   * live hand would corrupt the result. They sit out and leave when it settles.
   */
  stand(member: RoomMember): void {
    const seatIndex = member.seat;
    if (seatIndex === null) throw new Error("你还没有入座");
    const seat = this.table.seats[seatIndex]!;

    if (this.handInProgress() && seat.inHand) {
      seat.sittingOut = true;
      if (!member.leaving) {
        member.leaving = true;
      }
      this.afterStateChange();
      return;
    }

    this.releaseSeat(member);
    this.afterStateChange();
  }

  private releaseSeat(member: RoomMember): void {
    const seatIndex = member.seat;
    if (seatIndex === null) return;
    member.bankroll += this.table.seats[seatIndex]!.stack + member.pendingBuyIn;
    member.pendingBuyIn = 0;
    removePlayer(this.table, seatIndex);
    member.seat = null;
    member.leaving = false;
  }

  /** Takes a bot off the table for good, freeing its persona for another seat. */
  removeBot(seatIndex: number): void {
    const seat = this.table.seats[seatIndex];
    if (!seat) throw new Error(`没有 ${seatIndex} 号座位`);
    const member = this.memberAtSeat(seatIndex);
    if (member?.isBot !== true) throw new Error("那个座位上没有机器人");

    if (this.handInProgress() && seat.inHand) {
      // Same rule as a player leaving: the seat's chips are part of the pot.
      seat.sittingOut = true;
      if (!member.leaving) {
        member.leaving = true;
      }
      this.afterStateChange();
      return;
    }

    this.releaseSeat(member);
    this.forgetMember(member);
    this.afterStateChange();
  }

  addBotBy(playerId: string, seatIndex: number, personaId: string, buyIn?: number): void {
    if (!this.isHost(playerId)) throw new Error("只有房主可以管理机器人");
    this.addBot(seatIndex, personaId, buyIn);
  }

  removeBotBy(playerId: string, seatIndex: number): void {
    this.assertOpen();
    if (!this.isHost(playerId)) throw new Error("只有房主可以管理机器人");
    this.removeBot(seatIndex);
  }

  /** Drops a bot's membership entirely, so its persona is free again. */
  private forgetMember(member: RoomMember): void {
    this.members.delete(member.playerId);
    this.byToken.delete(member.token);
  }

  /** Seat anyone who asked to leave while a hand was running. */
  private removeDepartingPlayers(): void {
    if (this.handInProgress()) return;
    for (const member of [...this.members.values()]) {
      if (!member.leaving || member.seat === null) continue;
      this.releaseSeat(member);
      if (member.isBot) {
        // Gone for good; a human keeps their token so they can sit again later.
        this.forgetMember(member);
      }
    }
  }

  // ---------------------------------------------------------------- hand cycle

  handInProgress(): boolean {
    return this.table.hand !== null && this.table.hand.street !== "complete";
  }

  fundedSeats(): number[] {
    return this.table.seats.filter((seat) => seat.playerId !== null && seat.stack > 0 && !seat.sittingOut).map((seat) => seat.index);
  }

  canStartHand(): boolean {
    return !this.closed && this.hasConnectedPlayer() && !this.handInProgress() && this.fundedSeats().length >= 2;
  }

  startHand(): void {
    this.assertOpen();
    if (!this.hasConnectedPlayer()) throw new Error("至少需要一位在线真人玩家入座");
    if (this.handInProgress()) throw new Error("已经有一手牌在进行中");
    if (this.fundedSeats().length < 2) throw new Error("至少需要两位有筹码的玩家");
    for (const seat of this.table.seats) if (seat.playerId !== null && seat.stack > 0) seat.sittingOut = false;

    this.escalateBlindsIfDue();
    this.revealed.clear();
    startHand(this.table, this.rng);
    this.handsAtLevel += 1;
    this.afterStateChange();
  }

  /**
   * Tournaments raise the blinds on a schedule. The check runs *before* the
   * deal so the new level applies to this hand, and never mid-hand.
   */
  private escalateBlindsIfDue(): void {
    if (this.settings.mode !== "tournament") return;
    if (this.table.handId === 0) return; // the first hand is always level 1
    if (this.handsAtLevel < this.settings.blindLevelHands) return;
    this.level += 1;
    this.handsAtLevel = 0;
    this.applyBlinds();
  }

  /** Applies a *requested* action from a human, after checking it is their turn. */
  act(playerId: string, action: PlayerAction): void {
    this.assertOpen();
    const hand = this.table.hand;
    if (!hand || hand.street === "complete") throw new Error("当前没有进行中的牌局");
    if (hand.toActIndex === null) throw new Error("当前无人需要行动");
    const member = this.memberAtSeat(hand.toActIndex);
    if (!member || member.playerId !== playerId) throw new Error("还没轮到你行动");
    applyAction(this.table, action);
    this.afterStateChange();
  }

  // -------------------------------------------------------------------- brain

  buildBotContext(seatIndex: number): BotContext {
    const hand = this.table.hand;
    if (!hand) throw new Error("没有进行中的牌局");
    const seat = this.table.seats[seatIndex]!;
    const legal = legalActions(this.table);
    if (!legal) throw new Error("当前无人需要行动");

    const pot = totalPot(this.table);
    const toCall = legal.callCost;
    const lastActions = new Map<number, string>();
    for (const event of hand.events) {
      if (event.type === "action") lastActions.set(event.seat, event.action.type);
    }

    return {
      seatIndex,
      handId: hand.handId,
      hole: [...seat.hole],
      board: [...hand.board],
      street: hand.street,
      stack: seat.stack,
      committed: seat.committed,
      pot,
      toCall,
      potOdds: toCall > 0 ? toCall / (pot + toCall) : 0,
      bigBlind: this.table.bigBlind,
      legal,
      opponents: this.table.seats
        .filter((other) => other.index !== seatIndex && other.inHand)
        .map((other) => ({
          seatIndex: other.index,
          stack: other.stack,
          committed: other.committed,
          folded: other.folded,
          allIn: other.allIn,
          lastAction: lastActions.get(other.index) ?? null,
        })),
      history: hand.events.filter((event) => event.type !== "showdown"),
    };
  }

  private scheduleBotTurn(seatIndex: number): void {
    if (this.closed || !this.hasConnectedPlayer() || this.botTurnPending || this.botRequest !== null) return;
    this.botTurnPending = true;
    const street = this.table.hand?.street ?? "preflop";
    const delay = Math.max(0, this.botDelay({ seatIndex, street }));
    this.botTimer = this.timers.set(() => {
      this.botTimer = null;
      this.botTurnPending = false;
      void this.runBotTurn(seatIndex);
    }, delay);
  }

  private async runBotTurn(seatIndex: number): Promise<void> {
    if (this.closed || !this.hasConnectedPlayer()) return;
    const hand = this.table.hand;
    if (!hand || hand.street === "complete" || hand.toActIndex !== seatIndex) return;
    const member = this.memberAtSeat(seatIndex);
    if (!member?.isBot || member.personaId === null) return;

    let action: PlayerAction;
    const request = new AbortController();
    this.botRequest = request;
    try {
      action = await this.botDecider({ ...this.buildBotContext(seatIndex), signal: request.signal }, member.personaId);
    } catch (error) {
      this.lastBotError = error instanceof Error ? error.message : String(error);
      action = this.safeFallback(seatIndex);
    } finally {
      if (this.botRequest === request) this.botRequest = null;
    }

    // The world may have moved while the brain was thinking (a disconnect, an
    // admin action, a new hand): never apply a stale decision. Re-read the
    // table rather than trusting the narrowing from before the await.
    const current = this.table.hand;
    if (request.signal.aborted || this.closed || !this.hasConnectedPlayer() || current === null || current !== hand || current.street === "complete" || current.toActIndex !== seatIndex) return;

    try {
      applyAction(this.table, action);
    } catch (error) {
      this.lastBotError = error instanceof Error ? error.message : String(error);
      try {
        applyAction(this.table, this.safeFallback(seatIndex));
      } catch {
        return;
      }
    }
    this.afterStateChange();
  }

  private safeFallback(seatIndex: number): PlayerAction {
    const legal = legalActions(this.table);
    if (!legal || legal.seatIndex !== seatIndex) return { type: "fold" };
    if (legal.canCheck) return { type: "check" };
    if (legal.canCall) return { type: "call" };
    return { type: "fold" };
  }

  lastBotFailure(): string | null {
    return this.lastBotError;
  }

  // ------------------------------------------------------------------ outbound

  private afterStateChange(): void {
    if (this.closed) return;
    this.archiveCompletedHand();
    this.applyPendingBuyIns();
    this.topUpBustedBots();
    this.removeDepartingPlayers();
    if (!this.syncPresence()) {
      if (!this.closed) this.broadcast();
      return;
    }
    this.scheduleAutoStart();
    this.syncActionTimer();
    this.broadcast();
    const hand = this.table.hand;
    if (hand && hand.street !== "complete" && hand.toActIndex !== null && this.isBotSeat(hand.toActIndex)) {
      this.scheduleBotTurn(hand.toActIndex);
      return;
    }
  }

  /**
   * Guards against a human who closed the tab, walked away, or is simply
   * stalling: the table must never be stuck waiting on one seat forever.
   * Bots are excluded — they already act on their own schedule.
   */
  private syncActionTimer(): void {
    const hand = this.table.hand;
    const timedHuman = this.settings.actionTimeoutMs > 0 && hand && hand.street !== "complete"
      && hand.toActIndex !== null && !this.isBotSeat(hand.toActIndex);
    const key = timedHuman
      ? `${hand.handId}:${hand.events.length}:${hand.toActIndex}:${this.settings.actionTimeoutMs}`
      : null;
    // Seat changes and other unrelated updates must not restart a player's clock.
    if (key === this.actionClockKey) return;
    if (this.actionTimer !== null) {
      this.timers.clear(this.actionTimer);
      this.actionTimer = null;
      this.actionDeadline = null;
    }
    this.actionClockKey = key;
    if (key === null) return;

    this.actionDeadline = this.timers.now() + this.settings.actionTimeoutMs;
    this.actionTimer = this.timers.set(() => this.onActionTimeout(), this.settings.actionTimeoutMs);
  }

  private onActionTimeout(): void {
    this.actionTimer = null;
    this.actionDeadline = null;
    this.actionClockKey = null;

    const hand = this.table.hand;
    if (!hand || hand.street === "complete" || hand.toActIndex === null) return;
    if (this.isBotSeat(hand.toActIndex)) return;

    const legal = legalActions(this.table);
    if (!legal) return;

    // Checking is free, so it is the fair default; otherwise the seat is folded.
    const fallback: PlayerAction = legal.canCheck ? { type: "check" } : { type: "fold" };
    try {
      applyAction(this.table, fallback);
    } catch {
      return;
    }
    this.afterStateChange();
  }

  /** Milliseconds left for the seat on turn, or null when there is no clock. */
  actionTimeRemaining(): number | null {
    if (this.actionDeadline === null) return null;
    return Math.max(0, this.actionDeadline - this.timers.now());
  }

  // ------------------------------------------------------------------ history

  /** Files a finished hand exactly once, while its state is still intact. */
  private archiveCompletedHand(): void {
    const hand = this.table.hand;
    if (!hand?.result) return;
    if (this.archivedHandId === hand.handId) return;

    const entry = buildHandHistoryEntry(this.table, this.level);
    if (entry === null) return;

    this.archivedHandId = hand.handId;
    this.handHistory.push(entry);
    if (this.handHistory.length > MAX_HISTORY_HANDS) this.handHistory.shift();
  }

  historySummaries(): HandHistorySummary[] {
    return this.handHistory.map((entry) => ({
      handId: entry.handId,
      level: entry.level,
      smallBlind: entry.smallBlind,
      bigBlind: entry.bigBlind,
      board: entry.board,
      reason: entry.reason,
      potTotal: entry.potTotal,
      winners: entry.winners,
    }));
  }

  historyEntry(handId: number): HandHistoryEntry | null {
    return this.handHistory.find((entry) => entry.handId === handId) ?? null;
  }

  // ------------------------------------------------------------- quality of life

  /**
   * Cash games never end, so a bot that busts would sit out for the rest of the
   * night and the table would slowly empty. Tournaments are the opposite: going
   * broke is how you are eliminated, so there is deliberately no top-up.
   */
  private topUpBustedBots(): void {
    if (this.settings.mode !== "cash") return;
    if (!this.settings.botAutoRebuy) return;
    if (!this.table.hand?.result) return;

    for (const seat of this.table.seats) {
      if (seat.playerId === null || seat.stack > 0) continue;
      const member = this.memberAtSeat(seat.index);
      if (member?.isBot !== true || member.leaving) continue;
      seat.stack = member.buyIn;
      seat.allIn = false;
      seat.sittingOut = false;
    }
  }

  /** Cash-game additions are queued while a hand is live; pots never change. */
  rebuy(member: RoomMember, buyIn?: number): void {
    this.assertOpen();
    const seatIndex = member.seat;
    if (seatIndex === null) throw new Error("你还没有入座");
    if (this.settings.mode === "tournament") throw new Error("锦标赛不能重新买入，出局就是出局");
    if (member.leaving) throw new Error("已申请离座，不能追加买入");

    const amount = this.resolveBuyIn(buyIn);
    const seat = this.table.seats[seatIndex]!;
    if (seat.stack + seat.committed + member.pendingBuyIn + amount > SETTINGS_BOUNDS.startingStack.max) {
      throw new Error(`筹码和待到账买入合计不能超过 ${SETTINGS_BOUNDS.startingStack.max}`);
    }
    member.pendingBuyIn += amount;
    this.afterStateChange();
  }

  private applyPendingBuyIns(): void {
    if (this.handInProgress()) return;
    for (const member of this.members.values()) {
      if (member.seat === null || member.pendingBuyIn <= 0 || member.leaving) continue;
      const seat = this.table.seats[member.seat]!;
      seat.stack += member.pendingBuyIn;
      member.pendingBuyIn = 0;
      seat.allIn = false;
      seat.sittingOut = false;
    }
  }

  canShowCards(member: RoomMember): boolean {
    const hand = this.table.hand;
    const seat = member.seat === null ? null : this.table.seats[member.seat];
    return !this.closed && hand?.result?.reason === "fold" && seat?.inHand === true && seat.hole.length === 2
      && hand.result.awards.some((award) => award.winners.includes(seat.index)) && !this.revealed.has(seat.index);
  }

  showCards(member: RoomMember, handId: number): void {
    this.assertOpen();
    if (this.table.hand?.handId !== handId || !this.canShowCards(member)) throw new Error("只能在本手结束后亮出自己的获胜底牌");
    const seat = this.table.seats[member.seat!]!;
    const hole = seat.hole.map(cardToString);
    this.revealed.set(seat.index, hole);
    // Seats may already have changed since settlement. Update the immutable
    // archived player, rather than rebuilding a past hand from today's seats.
    this.handHistory = this.handHistory.map((entry) => entry.handId === handId
      ? { ...entry, seats: entry.seats.map((player) => player.seatIndex === seat.index ? { ...player, hole } : player) }
      : entry);
    this.broadcast();
  }

  /**
   * Deals the next hand automatically a few seconds after one ends. Without it
   * somebody has to click "开始下一手" after every single hand, which is the
   * most tedious part of playing against bots.
   */
  private scheduleAutoStart(): void {
    if (this.nextHandTimer !== null) {
      this.timers.clear(this.nextHandTimer);
      this.nextHandTimer = null;
      this.nextHandAt = null;
    }

    const seconds = this.settings.autoStartSeconds;
    if (seconds <= 0) return;
    if (this.handInProgress()) return;
    if (this.table.hand === null) return; // never deal the very first hand unasked
    if (!this.canStartHand()) return;

    const delayMs = seconds * 1000;
    this.nextHandAt = this.timers.now() + delayMs;
    this.nextHandTimer = this.timers.set(() => {
      this.nextHandTimer = null;
      this.nextHandAt = null;
      if (!this.canStartHand()) return;
      this.startHand();
    }, delayMs);
  }

  broadcast(): void {
    for (const playerId of this.sockets.keys()) this.sendStateTo(playerId);
  }

  sendStateTo(playerId: string): void {
    const socket = this.sockets.get(playerId);
    if (!socket) return;
    const member = this.members.get(playerId);
    if (!member) return;
    socket.send({ t: "state", view: this.viewFor(member) });
  }

  viewFor(member: RoomMember) {
    return buildTableView(this.table, {
      roomCode: this.code,
      viewerSeat: member.seat,
      isBotAt: this.isBotSeat,
      personaAt: this.personaAtSeat,
      canStartHand: this.canStartHand() && member.seat !== null,
      actionDeadlineMs: this.actionDeadline,
      nextHandAtMs: this.nextHandAt,
      isHost: this.isHost(member.playerId),
      settings: this.currentSettings(),
      history: this.historySummaries(),
      reveal: this.revealed,
      leavingAt: (index) => this.memberAtSeat(index)?.leaving ?? false,
      pendingBuyInAt: (index) => this.memberAtSeat(index)?.pendingBuyIn ?? 0,
      canShowCards: this.canShowCards(member),
      cardsShown: member.seat !== null && this.revealed.has(member.seat),
      paused: this.everSeatedHuman && !this.hasConnectedPlayer(),
    });
  }

  broadcastChat(from: string, text: string): void {
    for (const playerId of this.sockets.keys()) {
      this.sockets.get(playerId)?.send({ t: "chat", from, text });
    }
  }

  sendTo(playerId: string, message: ServerMessage): void {
    this.sockets.get(playerId)?.send(message);
  }
}

function sanitizeName(rawName: string): string {
  const cleaned = rawName.replace(/[\p{Cc}\p{Cf}]/gu, "").trim().slice(0, 16);
  return cleaned.length > 0 ? cleaned : "玩家";
}
