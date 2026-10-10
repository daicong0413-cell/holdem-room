/**
 * Wire protocol between the browser and the game server.
 *
 * Everything is JSON over one WebSocket. The client only ever *requests*
 * actions; the server re-derives legality from its own copy of the table, so a
 * tampered client cannot invent chips, act out of turn, or peek at cards.
 */

import type { LegalActions, PlayerAction, Street } from "../engine/table.ts";

export interface SeatView {
  readonly index: number;
  readonly playerId: string | null;
  readonly name: string;
  readonly isBot: boolean;
  /** Persona id when a bot is sitting here; null for humans and empty seats. */
  readonly personaId: string | null;
  readonly stack: number;
  readonly committed: number;
  readonly streetCommitted: number;
  readonly folded: boolean;
  readonly allIn: boolean;
  readonly inHand: boolean;
  readonly isYou: boolean;
  /** Card strings, or null when they are hidden from this viewer. */
  readonly hole: string[] | null;
  readonly holeCount: number;
  readonly lastAction: string | null;
}

export interface AwardView {
  readonly potIndex: number;
  readonly amount: number;
  readonly winners: number[];
}

export interface ShowdownView {
  readonly seatIndex: number;
  readonly hole: string[];
  /** HandCategory number, so the client can name the hand in its own language. */
  readonly category: number;
  /** Ranks that break ties, most significant first. */
  readonly ranks: number[];
  /** The five card strings that actually made the hand. */
  readonly bestFive: string[];
}

export interface ResultView {
  readonly reason: "fold" | "showdown";
  readonly awards: AwardView[];
  readonly showdown: ShowdownView[];
  readonly netChange: number[];
  /** Chips actually paid out per seat index, before subtracting contributions. */
  readonly payouts: number[];
}

export interface LogEntryView {
  readonly street: Street;
  readonly text: string;
}

/** One archived hand, as shown in the history list. */
export interface HandHistorySummary {
  readonly handId: number;
  /** Tournament level the hand was played at. */
  readonly level: number;
  readonly smallBlind: number;
  readonly bigBlind: number;
  readonly board: string[];
  readonly reason: "fold" | "showdown";
  readonly potTotal: number;
  readonly winners: Array<{ seatIndex: number; name: string; amount: number }>;
}

/**
 * The full record of a hand.
 *
 * Only information that was public at the time is archived: a player who folded
 * has `hole: null` here exactly as they did at the table. Archiving mucked cards
 * would quietly undo the hidden-information guarantee.
 */
export interface HandHistoryEntry extends HandHistorySummary {
  readonly buttonIndex: number;
  readonly seats: Array<{
    seatIndex: number;
    name: string;
    hole: string[] | null;
    net: number;
    folded: boolean;
  }>;
  readonly log: LogEntryView[];
}

export type GameMode = "cash" | "tournament";

/** What a host may change about the room, and what everyone is told. */
export interface RoomSettingsPatch {
  readonly seats?: number;
  readonly smallBlind?: number;
  readonly bigBlind?: number;
  readonly startingStack?: number;
  readonly actionTimeoutMs?: number;
  readonly mode?: GameMode;
  /** Tournament: how many hands each blind level lasts. */
  readonly blindLevelHands?: number;
  /** Tournament: multiplier applied to the blinds each level. */
  readonly blindGrowth?: number;
  /** Seconds after a hand ends before the next one is dealt; 0 disables it. */
  readonly autoStartSeconds?: number;
  /** Whether a bot that goes broke buys back in automatically in a cash game. */
  readonly botAutoRebuy?: boolean;
}

export interface RoomSettingsView extends Required<Omit<RoomSettingsPatch, "seats">> {
  readonly seats: number;
  /** 1-based tournament level; always 1 in a cash game. */
  readonly level: number;
  /** Hands left before the next increase; null in a cash game. */
  readonly handsUntilNextLevel: number | null;
}

export const SETTINGS_BOUNDS = {
  seats: { min: 2, max: 9 },
  smallBlind: { min: 1, max: 100_000 },
  bigBlind: { min: 2, max: 200_000 },
  startingStack: { min: 20, max: 1_000_000 },
  actionTimeoutMs: { min: 0, max: 600_000 },
  blindLevelHands: { min: 1, max: 100 },
  blindGrowth: { min: 1, max: 10 },
  autoStartSeconds: { min: 0, max: 120 },
} as const;

export const DEFAULT_SETTINGS: Required<RoomSettingsPatch> = {
  seats: 6,
  smallBlind: 1,
  bigBlind: 2,
  startingStack: 200,
  actionTimeoutMs: 60_000,
  mode: "cash",
  blindLevelHands: 8,
  blindGrowth: 2,
  autoStartSeconds: 6,
  botAutoRebuy: true,
};

export interface TableView {
  readonly roomCode: string;
  readonly handId: number;
  readonly street: Street;
  readonly board: string[];
  readonly pot: number;
  readonly buttonIndex: number;
  readonly smallBlind: number;
  readonly bigBlind: number;
  readonly toActIndex: number | null;
  readonly seats: SeatView[];
  readonly legal: LegalActions | null;
  readonly result: ResultView | null;
  readonly log: LogEntryView[];
  /** Epoch milliseconds by which the seat on turn must act; null when untimed. */
  readonly actionDeadlineMs: number | null;
  /** Epoch milliseconds when the next hand is dealt automatically; null if off. */
  readonly nextHandAtMs: number | null;
  /** True when the viewer may start the next hand. */
  readonly canStartHand: boolean;
  /** True when the viewer owns the room and may change settings. */
  readonly isHost: boolean;
  readonly settings: RoomSettingsView;
  /** Archived hands, newest last. Details are fetched on demand. */
  readonly history: HandHistorySummary[];
}

export type ClientMessage =
  | { readonly t: "hello"; readonly room?: string; readonly name?: string; readonly token?: string }
  | { readonly t: "sit"; readonly seat: number; readonly buyIn?: number }
  | { readonly t: "stand" }
  | { readonly t: "addBot"; readonly seat: number; readonly persona: string }
  | { readonly t: "removeBot"; readonly seat: number }
  | { readonly t: "action"; readonly action: PlayerAction }
  | { readonly t: "startHand" }
  | { readonly t: "rebuy"; readonly buyIn?: number }
  | { readonly t: "configure"; readonly settings: RoomSettingsPatch }
  | { readonly t: "handHistory"; readonly handId: number }
  | { readonly t: "chat"; readonly text: string }
  | { readonly t: "ping" };

export type ServerMessage =
  | { readonly t: "welcome"; readonly playerId: string; readonly token: string; readonly roomCode: string; readonly name: string }
  | { readonly t: "state"; readonly view: TableView }
  | { readonly t: "handHistory"; readonly entry: HandHistoryEntry | null }
  | { readonly t: "chat"; readonly from: string; readonly text: string }
  | { readonly t: "error"; readonly message: string }
  | { readonly t: "pong" };

export const STARTING_STACK_DEFAULT = DEFAULT_SETTINGS.startingStack;

/** Room codes avoid characters that are easy to misread out loud. */
export const ROOM_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export function parseClientMessage(raw: string): ClientMessage | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const message = parsed as { t?: unknown };
  if (typeof message.t !== "string") return null;

  switch (message.t) {
    case "hello": {
      const source = parsed as { room?: unknown; name?: unknown; token?: unknown };
      return {
        t: "hello",
        ...(typeof source.room === "string" ? { room: source.room } : {}),
        ...(typeof source.name === "string" ? { name: source.name } : {}),
        ...(typeof source.token === "string" ? { token: source.token } : {}),
      };
    }
    case "sit": {
      const source = parsed as { seat?: unknown; buyIn?: unknown };
      if (!Number.isInteger(source.seat)) return null;
      return {
        t: "sit",
        seat: source.seat as number,
        ...(typeof source.buyIn === "number" ? { buyIn: source.buyIn } : {}),
      };
    }
    case "addBot": {
      const source = parsed as { seat?: unknown; persona?: unknown };
      if (!Number.isInteger(source.seat) || typeof source.persona !== "string") return null;
      return { t: "addBot", seat: source.seat as number, persona: source.persona };
    }
    case "removeBot": {
      const source = parsed as { seat?: unknown };
      if (!Number.isInteger(source.seat)) return null;
      return { t: "removeBot", seat: source.seat as number };
    }
    case "action": {
      const source = parsed as { action?: unknown };
      const action = parseAction(source.action);
      return action === null ? null : { t: "action", action };
    }
    case "configure": {
      const source = parsed as { settings?: unknown };
      const settings = parseSettingsPatch(source.settings);
      return settings === null ? null : { t: "configure", settings };
    }
    case "handHistory": {
      const source = parsed as { handId?: unknown };
      if (!Number.isInteger(source.handId)) return null;
      return { t: "handHistory", handId: source.handId as number };
    }
    case "chat": {
      const source = parsed as { text?: unknown };
      if (typeof source.text !== "string") return null;
      return { t: "chat", text: source.text.slice(0, 500) };
    }
    case "rebuy": {
      const source = parsed as { buyIn?: unknown };
      return {
        t: "rebuy",
        ...(typeof source.buyIn === "number" ? { buyIn: source.buyIn } : {}),
      };
    }
    case "stand":
    case "startHand":
    case "ping":
      return { t: message.t };
    default:
      return null;
  }
}

const NUMERIC_SETTING_KEYS = [
  "seats",
  "smallBlind",
  "bigBlind",
  "startingStack",
  "actionTimeoutMs",
  "blindLevelHands",
  "blindGrowth",
  "autoStartSeconds",
] as const;

/** Rejects anything that is not a plain, finite number or a known mode. */
export function parseSettingsPatch(value: unknown): RoomSettingsPatch | null {
  if (typeof value !== "object" || value === null) return null;
  const source = value as Record<string, unknown>;
  const patch: Record<string, number | GameMode> = {};

  for (const key of NUMERIC_SETTING_KEYS) {
    const raw = source[key];
    if (raw === undefined) continue;
    if (typeof raw !== "number" || !Number.isFinite(raw)) return null;
    patch[key] = raw;
  }

  if (source.mode !== undefined) {
    if (source.mode !== "cash" && source.mode !== "tournament") return null;
    patch.mode = source.mode;
  }

  return Object.keys(patch).length === 0 ? null : (patch as RoomSettingsPatch);
}

function parseAction(value: unknown): PlayerAction | null {
  if (typeof value !== "object" || value === null) return null;
  const action = value as { type?: unknown; to?: unknown };
  switch (action.type) {
    case "fold":
    case "check":
    case "call":
      return { type: action.type };
    case "raise":
      return typeof action.to === "number" ? { type: "raise", to: action.to } : null;
    default:
      return null;
  }
}
