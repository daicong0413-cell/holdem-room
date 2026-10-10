/**
 * No-limit Texas Hold'em state machine.
 *
 * The whole rulebook lives here as plain data plus pure-ish functions: every
 * mutator takes the table, validates, and either throws `IllegalActionError` or
 * completes. Authorship matters — a WebSocket server must never trust a client
 * action, so this module re-derives legality from the table itself and treats
 * anything the client sends as a *request*.
 *
 * Money invariants this implementation upholds (and tests assert):
 *   - chips are conserved: the sum of stacks plus committed equals the buy-ins
 *   - a street ends only when nobody still owes chips and everyone has acted
 *   - an all-in for less than a full raise does NOT reopen the betting
 *   - an uncalled bet is returned before pots are built
 */

import { type Card, type Rng, fullDeck, shuffle } from "./cards.ts";
import { bestFive, evaluateBest, handName } from "./hand.ts";

export type Street = "preflop" | "flop" | "turn" | "river" | "complete";

export interface SeatState {
  readonly index: number;
  playerId: string | null;
  name: string;
  /** Chips behind, not counting anything already committed this hand. */
  stack: number;
  /** Stack when the current hand began, used for exact net-result reporting. */
  stackAtHandStart: number;
  hole: Card[];
  /** Total committed across the whole hand. */
  committed: number;
  /** Committed during the current betting round. */
  streetCommitted: number;
  folded: boolean;
  allIn: boolean;
  hasActedThisStreet: boolean;
  /**
   * False once an all-in for less than a full raise has priced this seat in but
   * left it without the right to raise again this street.
   */
  canRaiseThisStreet: boolean;
  /** True while dealt into the current hand. */
  inHand: boolean;
  /** Temporarily not playing (e.g. sat out mid-session). */
  sittingOut: boolean;
}

export type PlayerAction =
  | { readonly type: "fold" }
  | { readonly type: "check" }
  | { readonly type: "call" }
  | { readonly type: "raise"; readonly to: number };

export interface Pot {
  readonly amount: number;
  /** Seat indices that may win this pot; folded seats are excluded. */
  readonly eligible: number[];
}

export interface ShowdownEntry {
  readonly seatIndex: number;
  readonly hole: Card[];
  readonly score: number;
  readonly handName: string;
  /** The five cards that actually made the hand, for highlighting at the table. */
  readonly best: Card[];
}

export interface PotAward {
  readonly potIndex: number;
  readonly amount: number;
  readonly winners: number[];
}

export interface HandResult {
  readonly reason: "fold" | "showdown";
  readonly pots: Pot[];
  readonly awards: PotAward[];
  readonly showdown: ShowdownEntry[];
  /** Chips won or lost per seat index; always sums to zero. */
  readonly netChange: number[];
  /** Chips actually paid out per seat, before subtracting what they put in. */
  readonly payouts: number[];
}

export type HandEvent =
  | { readonly type: "blinds"; readonly smallBlind: { seat: number; amount: number }; readonly bigBlind: { seat: number; amount: number } }
  | { readonly type: "action"; readonly seat: number; readonly action: PlayerAction; readonly committed: number; readonly previousBet: number }
  | { readonly type: "street"; readonly street: Street; readonly board: Card[] }
  | { readonly type: "showdown"; readonly entries: ShowdownEntry[] }
  | { readonly type: "award"; readonly awards: PotAward[] }
  | { readonly type: "handEnd"; readonly reason: "fold" | "showdown"; readonly netChange: number[] };

export interface HandState {
  readonly handId: number;
  street: Street;
  board: Card[];
  deck: Card[];
  buttonIndex: number;
  currentBet: number;
  /** Smallest legal "raise to" total for the next raiser. */
  minRaiseTo: number;
  /** Size of the last full raise; drives the minimum raise and reopening. */
  lastFullRaiseSize: number;
  toActIndex: number | null;
  events: HandEvent[];
  result: HandResult | null;
}

export interface TableState {
  readonly seats: SeatState[];
  /** Mutable so tournaments can escalate blinds between hands. */
  smallBlind: number;
  bigBlind: number;
  buttonIndex: number;
  handId: number;
  hand: HandState | null;
}

export class IllegalActionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IllegalActionError";
  }
}

export interface TableOptions {
  seats?: number;
  smallBlind?: number;
  bigBlind?: number;
}

export function createTable(options: TableOptions = {}): TableState {
  const seatCount = options.seats ?? 6;
  const smallBlind = options.smallBlind ?? 1;
  const bigBlind = options.bigBlind ?? 2;
  if (seatCount < 2 || seatCount > 10) throw new RangeError(`seat count must be 2..10, got ${seatCount}`);
  if (smallBlind <= 0 || bigBlind <= smallBlind) throw new RangeError("blinds must satisfy 0 < small < big");

  return {
    seats: Array.from({ length: seatCount }, (_, index) => emptySeat(index)),
    smallBlind,
    bigBlind,
    buttonIndex: -1,
    handId: 0,
    hand: null,
  };
}

/**
 * Changes the blinds between hands.
 *
 * Tournaments escalate on a schedule; cash games rarely change at all. This is
 * refused while a hand is live because the current street's minimum raise and
 * the posted blinds were both derived from the old values.
 */
export function setBlinds(table: TableState, smallBlind: number, bigBlind: number): void {
  if (table.hand !== null && table.hand.street !== "complete") {
    throw new IllegalActionError("牌局进行中不能修改盲注");
  }
  if (!Number.isInteger(smallBlind) || !Number.isInteger(bigBlind)) {
    throw new RangeError(`blinds must be integers, got ${smallBlind}/${bigBlind}`);
  }
  if (smallBlind <= 0 || bigBlind <= smallBlind) {
    throw new RangeError("blinds must satisfy 0 < small < big");
  }
  table.smallBlind = smallBlind;
  table.bigBlind = bigBlind;
}

function emptySeat(index: number): SeatState {
  return {
    index,
    playerId: null,
    name: "",
    stack: 0,
    stackAtHandStart: 0,
    hole: [],
    committed: 0,
    streetCommitted: 0,
    folded: false,
    allIn: false,
    hasActedThisStreet: false,
    canRaiseThisStreet: true,
    inHand: false,
    sittingOut: false,
  };
}

export function seatPlayer(
  table: TableState,
  index: number,
  player: { playerId: string; name: string; stack: number },
): void {
  const seat = table.seats[index];
  if (!seat) throw new RangeError(`no seat ${index}`);
  if (seat.playerId !== null) throw new Error(`seat ${index} is taken by ${seat.playerId}`);
  if (player.stack <= 0) throw new RangeError("buy-in must be positive");
  seat.playerId = player.playerId;
  seat.name = player.name;
  seat.stack = player.stack;
  seat.stackAtHandStart = player.stack;
  seat.sittingOut = false;
}

export function removePlayer(table: TableState, index: number): void {
  const seat = table.seats[index];
  if (!seat) throw new RangeError(`no seat ${index}`);
  const replacement = emptySeat(index);
  Object.assign(seat, replacement);
}

export function seatedPlayers(table: TableState): SeatState[] {
  return table.seats.filter((seat) => seat.playerId !== null);
}

/** Total chips in the middle, derived rather than tracked to avoid drift. */
export function totalPot(table: TableState): number {
  return table.seats.reduce((sum, seat) => sum + seat.committed, 0);
}

/**
 * What the pot is *displayed* as: chips already collected, i.e. everything bet
 * on previous streets.
 *
 * Bets still live this street are drawn in front of their own player, so
 * counting them in the pot as well would show the same chips twice — and it
 * would make the half/full-pot presets size off money the bettor has already
 * put in. When the street closes, `streetCommitted` rolls into `committed` and
 * the pot grows by exactly that amount.
 */
export function collectedPot(table: TableState): number {
  return totalPot(table) - table.seats.reduce((sum, seat) => sum + seat.streetCommitted, 0);
}

export function potIfFolded(table: TableState): number {
  return totalPot(table);
}

function nextSeat(table: TableState, from: number, predicate: (seat: SeatState) => boolean): number | null {
  const count = table.seats.length;
  for (let step = 1; step <= count; step++) {
    const index = (from + step + count) % count;
    const seat = table.seats[index]!;
    if (predicate(seat)) return index;
  }
  return null;
}

const canBeDealt = (seat: SeatState): boolean => seat.playerId !== null && seat.stack > 0 && !seat.sittingOut;

function contenders(table: TableState): SeatState[] {
  return table.seats.filter((seat) => seat.inHand && !seat.folded);
}

function actors(table: TableState): SeatState[] {
  return table.seats.filter((seat) => seat.inHand && !seat.folded && !seat.allIn);
}

export function startHand(table: TableState, rng: Rng = Math.random): void {
  const eligible = table.seats.filter(canBeDealt);
  if (eligible.length < 2) throw new IllegalActionError("need at least two funded players to start a hand");

  const button = nextSeat(table, table.buttonIndex, canBeDealt);
  if (button === null) throw new IllegalActionError("no seat available for the button");
  table.buttonIndex = button;
  table.handId += 1;

  for (const seat of table.seats) {
    seat.hole = [];
    seat.committed = 0;
    seat.streetCommitted = 0;
    seat.folded = false;
    seat.allIn = false;
    seat.hasActedThisStreet = false;
    seat.canRaiseThisStreet = true;
    seat.inHand = canBeDealt(seat);
    seat.stackAtHandStart = seat.stack;
  }

  const deck = shuffle(fullDeck(), rng);
  const dealtIn = table.seats.filter((seat) => seat.inHand);
  for (const seat of dealtIn) seat.hole = deck.splice(0, 2);

  const hand: HandState = {
    handId: table.handId,
    street: "preflop",
    board: [],
    deck,
    buttonIndex: button,
    currentBet: 0,
    minRaiseTo: table.bigBlind * 2,
    lastFullRaiseSize: table.bigBlind,
    toActIndex: null,
    events: [],
    result: null,
  };
  table.hand = hand;

  // Heads-up: the button posts the small blind and acts first preflop.
  const smallBlindIndex =
    dealtIn.length === 2 ? button : (nextSeat(table, button, (seat) => seat.inHand) as number);
  const bigBlindIndex = nextSeat(table, smallBlindIndex, (seat) => seat.inHand) as number;

  const smallBlindAmount = commitChips(table.seats[smallBlindIndex]!, table.smallBlind);
  const bigBlindAmount = commitChips(table.seats[bigBlindIndex]!, table.bigBlind);
  hand.currentBet = Math.max(smallBlindAmount, bigBlindAmount);
  hand.lastFullRaiseSize = table.bigBlind;
  hand.minRaiseTo = hand.currentBet + hand.lastFullRaiseSize;
  hand.events.push({
    type: "blinds",
    smallBlind: { seat: smallBlindIndex, amount: smallBlindAmount },
    bigBlind: { seat: bigBlindIndex, amount: bigBlindAmount },
  });

  hand.toActIndex = nextSeat(table, bigBlindIndex, (seat) => seat.inHand && !seat.allIn);
  // Everyone all-in from the blinds is impossible with two funded players, but a
  // short stack can be; in that case there is nothing to bet and we run it out.
  if (hand.toActIndex === null || actors(table).length <= 1) {
    runOutBoard(table);
  }
}

/** Moves chips from a stack into the pot; returns how many actually moved. */
function commitChips(seat: SeatState, amount: number): number {
  const moved = Math.max(0, Math.min(amount, seat.stack));
  seat.stack -= moved;
  seat.committed += moved;
  seat.streetCommitted += moved;
  if (seat.stack === 0 && seat.inHand) seat.allIn = true;
  return moved;
}

export interface LegalActions {
  readonly seatIndex: number;
  readonly toCall: number;
  readonly canFold: boolean;
  readonly canCheck: boolean;
  readonly canCall: boolean;
  /** Chips actually added by calling — less than `toCall` for a short all-in. */
  readonly callCost: number;
  readonly canRaise: boolean;
  readonly canAllIn: boolean;
  readonly minRaiseTo: number;
  readonly maxRaiseTo: number;
}

export function legalActions(table: TableState): LegalActions | null {
  const hand = table.hand;
  if (!hand || hand.toActIndex === null || hand.street === "complete") return null;
  const seat = table.seats[hand.toActIndex]!;
  const toCall = hand.currentBet - seat.streetCommitted;
  const maxRaiseTo = seat.streetCommitted + seat.stack;
  const minRaiseTo = hand.currentBet === 0 ? Math.min(table.bigBlind, maxRaiseTo) : hand.minRaiseTo;
  const canCheck = toCall <= 0;
  // Without the right to raise, the most this seat may put in is a call.
  const maxAllowed = seat.canRaiseThisStreet ? maxRaiseTo : hand.currentBet;

  return {
    seatIndex: seat.index,
    toCall: Math.max(0, toCall),
    canFold: true,
    canCheck,
    canCall: toCall > 0,
    callCost: Math.min(Math.max(0, toCall), seat.stack),
    canRaise: seat.canRaiseThisStreet && maxRaiseTo > hand.currentBet && maxRaiseTo >= minRaiseTo,
    canAllIn: maxAllowed > seat.streetCommitted && seat.stack > 0,
    minRaiseTo,
    maxRaiseTo,
  };
}

export function isLegalAction(table: TableState, action: PlayerAction): boolean {
  const legal = legalActions(table);
  if (!legal) return false;
  switch (action.type) {
    case "fold":
      return true;
    case "check":
      return legal.canCheck;
    case "call":
      return legal.canCall;
    case "raise": {
      if (!Number.isInteger(action.to)) return false;
      if (action.to <= (table.hand?.currentBet ?? 0)) return false;
      if (action.to > legal.maxRaiseTo) return false;
      return action.to >= legal.minRaiseTo || action.to === legal.maxRaiseTo;
    }
    default:
      return false;
  }
}

export function applyAction(table: TableState, action: PlayerAction): HandEvent[] {
  const hand = table.hand;
  if (!hand) throw new IllegalActionError("no hand in progress");
  if (hand.street === "complete") throw new IllegalActionError("the hand is already over");
  if (hand.toActIndex === null) throw new IllegalActionError("nobody is to act");

  const seat = table.seats[hand.toActIndex]!;
  const legal = legalActions(table)!;
  const before = seat.committed;
  const previousBet = hand.currentBet;

  switch (action.type) {
    case "fold":
      seat.folded = true;
      seat.hasActedThisStreet = true;
      break;

    case "check":
      if (!legal.canCheck) throw new IllegalActionError(`seat ${seat.index} cannot check facing ${legal.toCall}`);
      seat.hasActedThisStreet = true;
      break;

    case "call":
      if (!legal.canCall) throw new IllegalActionError(`seat ${seat.index} has nothing to call`);
      commitChips(seat, legal.toCall);
      seat.hasActedThisStreet = true;
      break;

    case "raise": {
      if (!seat.canRaiseThisStreet) {
        throw new IllegalActionError(`seat ${seat.index} may only call or fold: betting was not reopened`);
      }
      if (!Number.isInteger(action.to)) throw new IllegalActionError(`raise target must be an integer, got ${action.to}`);
      if (action.to > legal.maxRaiseTo) throw new IllegalActionError(`seat ${seat.index} cannot afford ${action.to}`);

      if (action.to <= previousBet) throw new IllegalActionError(`raise must exceed the current bet of ${previousBet}`);
      const isAllIn = action.to === legal.maxRaiseTo;
      if (action.to < legal.minRaiseTo && !isAllIn) {
        throw new IllegalActionError(`raise must be at least ${legal.minRaiseTo} (or all-in for ${legal.maxRaiseTo})`);
      }

      const increment = action.to - previousBet;
      const requiredIncrement = previousBet === 0 ? table.bigBlind : hand.lastFullRaiseSize;
      const isFullRaise = increment >= requiredIncrement;

      commitChips(seat, action.to - seat.streetCommitted);
      seat.hasActedThisStreet = true;
      hand.currentBet = action.to;

      if (isFullRaise) {
        hand.lastFullRaiseSize = increment;
        hand.minRaiseTo = action.to + increment;
        // A full raise reopens the action: everyone else must respond again and
        // regains the right to re-raise.
        for (const other of table.seats) {
          if (other.index === seat.index || !other.inHand || other.folded || other.allIn) continue;
          other.hasActedThisStreet = false;
          other.canRaiseThisStreet = true;
        }
      } else {
        // An all-in short raise does not reopen betting. Players who already
        // acted are priced in but may only call or fold from here.
        hand.minRaiseTo = action.to + requiredIncrement;
        for (const other of table.seats) {
          if (other.index === seat.index || !other.inHand || other.folded || other.allIn) continue;
          if (other.hasActedThisStreet) other.canRaiseThisStreet = false;
        }
      }
      break;
    }

    default:
      throw new IllegalActionError(`unknown action ${JSON.stringify(action)}`);
  }

  hand.events.push({ type: "action", seat: seat.index, action, committed: seat.committed - before, previousBet });
  const firstNewEvent = hand.events.length - 1;
  advance(table);
  return hand.events.slice(firstNewEvent);
}

/** True when nobody still owes chips and every live player has acted. */
function streetIsComplete(table: TableState): boolean {
  const hand = table.hand!;
  for (const seat of table.seats) {
    if (!seat.inHand || seat.folded || seat.allIn) continue;
    if (!seat.hasActedThisStreet || seat.streetCommitted < hand.currentBet) return false;
  }
  return true;
}

function advance(table: TableState): void {
  const hand = table.hand!;

  if (contenders(table).length === 1) {
    settle(table, "fold");
    return;
  }

  if (!streetIsComplete(table)) {
    hand.toActIndex = nextSeat(
      table,
      hand.toActIndex!,
      (seat) => seat.inHand && !seat.folded && !seat.allIn && (!seat.hasActedThisStreet || seat.streetCommitted < hand.currentBet),
    );
    if (hand.toActIndex !== null) return;
  }

  // Street finished. With at most one player able to act there is no more
  // betting, so the remaining streets are dealt out and the hand is shown down.
  if (hand.street === "river" || actors(table).length <= 1) {
    runOutBoard(table);
    return;
  }

  advanceStreet(table);
}

const STREET_ORDER: Street[] = ["preflop", "flop", "turn", "river"];

function advanceStreet(table: TableState): void {
  const hand = table.hand!;
  const currentIndex = STREET_ORDER.indexOf(hand.street);
  const next = STREET_ORDER[currentIndex + 1];
  if (!next) throw new IllegalActionError(`cannot advance past ${hand.street}`);

  hand.street = next;
  hand.board.push(...hand.deck.splice(0, next === "flop" ? 3 : 1));
  for (const seat of table.seats) {
    seat.streetCommitted = 0;
    seat.hasActedThisStreet = false;
    seat.canRaiseThisStreet = true;
  }
  hand.currentBet = 0;
  hand.lastFullRaiseSize = table.bigBlind;
  hand.minRaiseTo = table.bigBlind;
  hand.toActIndex = nextSeat(
    table,
    hand.buttonIndex,
    (seat) => seat.inHand && !seat.folded && !seat.allIn,
  );
  hand.events.push({ type: "street", street: next, board: [...hand.board] });

  if (actors(table).length <= 1) runOutBoard(table);
}

/** Deals whatever board cards are missing, then shows the hand down. */
function runOutBoard(table: TableState): void {
  const hand = table.hand!;
  while (hand.board.length < 5) {
    const street = STREET_ORDER[hand.board.length === 0 ? 1 : hand.board.length === 3 ? 2 : 3]!;
    hand.street = street;
    hand.board.push(...hand.deck.splice(0, hand.board.length === 0 ? 3 : 1));
    hand.events.push({ type: "street", street, board: [...hand.board] });
  }
  if (hand.board.length === 5 && hand.street !== "river") hand.street = "river";
  settle(table, "showdown");
}

/**
 * Splits the chips into a main pot and side pots.
 *
 * Each distinct commitment level forms a layer: everybody who put in at least
 * that much contributes to it, and everybody who put in that much *and* has not
 * folded can win it. Folded players' chips stay in the layers they paid into.
 */
export function buildPots(seats: readonly SeatState[]): Pot[] {
  const inHand = seats.filter((seat) => seat.inHand);
  const levels = [...new Set(inHand.filter((seat) => seat.committed > 0).map((seat) => seat.committed))].sort(
    (a, b) => a - b,
  );

  const pots: Pot[] = [];
  let previousLevel = 0;
  for (const level of levels) {
    let amount = 0;
    const eligible: number[] = [];
    for (const seat of inHand) {
      amount += Math.min(seat.committed, level) - Math.min(seat.committed, previousLevel);
      if (seat.committed >= level && !seat.folded) eligible.push(seat.index);
    }
    if (amount <= 0) {
      previousLevel = level;
      continue;
    }
    const last = pots[pots.length - 1];
    if (last && sameSeatSet(last.eligible, eligible)) {
      pots[pots.length - 1] = { amount: last.amount + amount, eligible: last.eligible };
    } else {
      pots.push({ amount, eligible });
    }
    previousLevel = level;
  }
  return pots;
}

function sameSeatSet(left: readonly number[], right: readonly number[]): boolean {
  if (left.length !== right.length) return false;
  for (let i = 0; i < left.length; i++) if (left[i] !== right[i]) return false;
  return true;
}

/** Returns the portion of the largest commitment that nobody matched. */
function refundUncalled(table: TableState): void {
  const contributors = table.seats.filter((seat) => seat.inHand && seat.committed > 0);
  if (contributors.length === 0) return;
  const sorted = contributors.map((seat) => seat.committed).sort((a, b) => b - a);
  const top = sorted[0]!;
  const second = sorted.length > 1 ? sorted[1]! : 0;
  const excess = top - second;
  if (excess <= 0) return;
  const owner = contributors.find((seat) => seat.committed === top);
  if (!owner) return;
  owner.committed -= excess;
  owner.stack += excess;
  owner.streetCommitted = Math.max(0, owner.streetCommitted - excess);
  if (owner.stack > 0) owner.allIn = false;
}

function settle(table: TableState, reason: "fold" | "showdown"): void {
  const hand = table.hand!;
  hand.toActIndex = null;
  refundUncalled(table);

  const pots = buildPots(table.seats);
  const showdown: ShowdownEntry[] = [];
  const awards: PotAward[] = [];
  const payouts = new Array<number>(table.seats.length).fill(0);

  if (reason === "showdown") {
    for (const seat of contenders(table)) {
      const seven = [...seat.hole, ...hand.board];
      const score = evaluateBest(seven);
      showdown.push({
        seatIndex: seat.index,
        hole: [...seat.hole],
        score,
        handName: handName(score),
        best: bestFive(seven),
      });
    }
    hand.events.push({ type: "showdown", entries: showdown });
  }

  for (let index = 0; index < pots.length; index++) {
    const pot = pots[index]!;
    const winners = rankWinners(table, pot, showdown, reason);
    const share = Math.floor(pot.amount / winners.length);
    let remainder = pot.amount - share * winners.length;

    // Odd chips go to the first winner clockwise from the button.
    const ordered = orderFromButton(table, winners);
    for (const seatIndex of ordered) {
      const bonus = remainder > 0 ? 1 : 0;
      remainder -= bonus;
      table.seats[seatIndex]!.stack += share + bonus;
      payouts[seatIndex] = (payouts[seatIndex] ?? 0) + share + bonus;
    }
    awards.push({ potIndex: index, amount: pot.amount, winners });
  }

  const netChange = table.seats.map((seat) => seat.stack - seat.stackAtHandStart);
  hand.result = { reason, pots, awards, showdown, netChange, payouts };
  hand.street = "complete";

  // The pot has been paid out, so nothing is committed any more. Leaving the
  // contributions on the seats would double-count them against the stacks.
  for (const seat of table.seats) {
    seat.committed = 0;
    seat.streetCommitted = 0;
  }

  hand.events.push({ type: "award", awards });
  hand.events.push({ type: "handEnd", reason, netChange });
}

function rankWinners(
  table: TableState,
  pot: Pot,
  showdown: readonly ShowdownEntry[],
  reason: "fold" | "showdown",
): number[] {
  if (pot.eligible.length === 1) return [...pot.eligible];
  if (reason === "fold") return [...pot.eligible];

  let best = -1;
  let winners: number[] = [];
  for (const seatIndex of pot.eligible) {
    const entry = showdown.find((candidate) => candidate.seatIndex === seatIndex);
    if (!entry) continue;
    if (entry.score > best) {
      best = entry.score;
      winners = [seatIndex];
    } else if (entry.score === best) {
      winners.push(seatIndex);
    }
  }
  if (winners.length === 0) throw new IllegalActionError("showdown produced no winner");
  return winners;
}

function orderFromButton(table: TableState, seatIndices: readonly number[]): number[] {
  const count = table.seats.length;
  return [...seatIndices].sort((left, right) => {
    const leftOffset = (left - table.buttonIndex + count) % count;
    const rightOffset = (right - table.buttonIndex + count) % count;
    return leftOffset - rightOffset;
  });
}

/** Net chips won or lost by a seat in the hand that just finished. */
export function lastResult(table: TableState): HandResult | null {
  return table.hand?.result ?? null;
}

/** Convenience for logging: the seat currently to act, if any. */
export function actingSeat(table: TableState): SeatState | null {
  const index = table.hand?.toActIndex;
  return index === null || index === undefined ? null : table.seats[index]!;
}
