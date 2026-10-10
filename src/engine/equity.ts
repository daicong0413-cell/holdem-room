/**
 * Monte Carlo equity.
 *
 * Every opponent is sampled from a `HandRange`; "any two cards" is just the
 * full range, so there is a single rollout path instead of a fast path and a
 * slow path that could drift apart.
 *
 * The deal order is opponents-then-board, which is statistically identical to
 * board-then-opponents (the cards are exchangeable), and it lets a range
 * sampler work on precomputed combo pools rather than on raw cards.
 *
 * The result reports `equity` as expected pot share: a two-way chop counts 0.5,
 * a three-way chop counts 1/3. That is the number a decision layer wants — the
 * raw win/lose/tie tallies are exposed alongside it.
 */

import { type Card, DECK_SIZE, type Rng, rankOf, suitOf } from "./cards.ts";
import { evaluateBest } from "./hand.ts";
import { type HandRange, fullRange } from "./range.ts";

export interface RangeCombo {
  readonly a: Card;
  readonly b: Card;
  readonly weight: number;
}

export interface ComboPool {
  readonly combos: RangeCombo[];
  readonly totalWeight: number;
  /** Cumulative weights, for O(log n) weighted sampling. */
  readonly cumulative: Float64Array;
}

/**
 * Enumerates every two-card combo the range allows, dropping any combo that
 * collides with a known card (hero, board, or explicitly dead cards).
 */
export function buildComboPool(range: HandRange, dead: ArrayLike<Card> = []): ComboPool {
  const isDead = new Uint8Array(DECK_SIZE);
  for (let i = 0; i < dead.length; i++) isDead[dead[i]!] = 1;

  const combos: RangeCombo[] = [];
  const push = (a: Card, b: Card, rawWeight: number): void => {
    if (rawWeight <= 0) return;
    if (isDead[a] === 1 || isDead[b] === 1) return;
    combos.push({ a, b, weight: Math.min(1, rawWeight) });
  };

  for (let rank = 0; rank < 13; rank++) {
    const weight = range.pair[rank]!;
    if (weight <= 0) continue;
    for (let s1 = 0; s1 < 4; s1++) {
      for (let s2 = s1 + 1; s2 < 4; s2++) push(rank * 4 + s1, rank * 4 + s2, weight);
    }
  }

  for (let hi = 12; hi >= 0; hi--) {
    for (let lo = hi - 1; lo >= 0; lo--) {
      const cell = hi * 13 + lo;
      const suited = range.suited[cell]!;
      const offsuit = range.offsuit[cell]!;
      if (suited > 0) for (let suit = 0; suit < 4; suit++) push(hi * 4 + suit, lo * 4 + suit, suited);
      if (offsuit > 0) {
        for (let sa = 0; sa < 4; sa++) {
          for (let sb = 0; sb < 4; sb++) {
            if (sa === sb) continue;
            push(hi * 4 + sa, lo * 4 + sb, offsuit);
          }
        }
      }
    }
  }

  const cumulative = new Float64Array(combos.length);
  let running = 0;
  for (let i = 0; i < combos.length; i++) {
    running += combos[i]!.weight;
    cumulative[i] = running;
  }

  return { combos, totalWeight: running, cumulative };
}

function sampleIndex(cumulative: Float64Array, totalWeight: number, rng: Rng): number {
  const target = rng() * totalWeight;
  let lo = 0;
  let hi = cumulative.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (cumulative[mid]! < target) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Weighted draw that skips combos colliding with already-used cards. */
function sampleCombo(pool: ComboPool, used: Uint8Array, rng: Rng, attempts = 64): RangeCombo | null {
  if (pool.totalWeight <= 0 || pool.combos.length === 0) return null;
  for (let attempt = 0; attempt < attempts; attempt++) {
    const combo = pool.combos[sampleIndex(pool.cumulative, pool.totalWeight, rng)]!;
    if (used[combo.a] !== 1 && used[combo.b] !== 1) return combo;
  }
  return null;
}

export interface EquityRequest {
  /** The hand being evaluated — normally exactly two cards. */
  hero: readonly Card[];
  /** 0, 3, 4 or 5 known board cards. */
  board?: readonly Card[];
  /** Live opponents still in the pot. */
  opponents?: number;
  /** Per-opponent ranges; omitted entries are treated as any two cards. */
  ranges?: ReadonlyArray<HandRange | undefined>;
  /** Cards known to be unavailable (folded hands, exposed cards). */
  dead?: readonly Card[];
  iterations?: number;
  rng?: Rng;
  /** 95%-confidence half-width that stops the simulation early; 0 disables. */
  tolerance?: number;
}

export interface EquityResult {
  /** Expected share of the pot, 0..1. */
  equity: number;
  win: number;
  tie: number;
  lose: number;
  iterations: number;
  standardError: number;
}

function validate(req: EquityRequest, opponents: number, boardLength: number): void {
  if (req.hero.length !== 2) throw new Error(`hero must hold exactly 2 cards, got ${req.hero.length}`);
  if (boardLength !== 0 && boardLength !== 3 && boardLength !== 4 && boardLength !== 5) {
    throw new Error(`board must hold 0, 3, 4 or 5 cards, got ${boardLength}`);
  }
  if (!Number.isInteger(opponents) || opponents < 1) throw new Error(`opponents must be >= 1, got ${opponents}`);
  const needed = req.hero.length + boardLength + (req.dead?.length ?? 0) + opponents * 2 + (5 - boardLength);
  if (needed > DECK_SIZE) throw new Error(`not enough cards in the deck: need ${needed}`);
}

export function equity(request: EquityRequest): EquityResult {
  const board = request.board ?? [];
  const opponents = request.opponents ?? 1;
  const iterations = Math.max(1, Math.floor(request.iterations ?? 20000));
  const rng = request.rng ?? Math.random;
  const tolerance = request.tolerance ?? 0;
  const dead = request.dead ?? [];

  validate(request, opponents, board.length);

  const hero = request.hero;
  const missingBoard = 5 - board.length;
  const known: Card[] = [hero[0]!, hero[1]!, ...board, ...dead];

  // A full range means "any two cards", which is just two random cards off the
  // live deck. Building a 1326-combo pool to emulate that was pure overhead —
  // and this runs once per bot decision, so the allocation churn was the main
  // source of stutter during play.
  const ranged = request.ranges?.some((range) => range !== undefined) ?? false;

  const pools: ComboPool[] = [];
  if (ranged) {
    for (let o = 0; o < opponents; o++) {
      pools.push(buildComboPool(request.ranges?.[o] ?? fullRange(), known));
    }
  }

  const knownFlags = new Uint8Array(DECK_SIZE);
  for (let i = 0; i < known.length; i++) knownFlags[known[i]!] = 1;

  const used = new Uint8Array(DECK_SIZE);
  const remaining = new Int32Array(DECK_SIZE);
  const boardBuffer = new Int32Array(5);
  const opponentCards = new Int32Array(opponents * 2);
  const heroSeven = new Int32Array(7);
  const opponentSeven = new Int32Array(7);
  const drawCount = opponents * 2 + missingBoard;

  heroSeven[0] = hero[0]!;
  heroSeven[1] = hero[1]!;

  let wins = 0;
  let ties = 0;
  let losses = 0;
  let completed = 0;
  let shareSum = 0;
  let shareSquareSum = 0;
  let standardError = 0;

  for (let iteration = 0; iteration < iterations; iteration++) {
    if (ranged) {
      used.fill(0);
      for (let i = 0; i < known.length; i++) used[known[i]!] = 1;

      let blocked = false;
      for (let o = 0; o < opponents; o++) {
        const combo = sampleCombo(pools[o]!, used, rng);
        if (combo === null) {
          blocked = true;
          break;
        }
        used[combo.a] = 1;
        used[combo.b] = 1;
        opponentCards[o * 2] = combo.a;
        opponentCards[o * 2 + 1] = combo.b;
      }
      if (blocked) continue;

      let liveCount = 0;
      for (let card = 0; card < DECK_SIZE; card++) if (used[card] !== 1) remaining[liveCount++] = card;
      for (let i = 0; i < missingBoard; i++) {
        const j = i + Math.floor(rng() * (liveCount - i));
        const swap = remaining[i]!;
        remaining[i] = remaining[j]!;
        remaining[j] = swap;
      }
      for (let i = 0; i < missingBoard; i++) boardBuffer[board.length + i] = remaining[i]!;
    } else {
      // One partial Fisher-Yates pass deals every unknown card we need:
      // opponent hands first, then the rest of the board.
      let liveCount = 0;
      for (let card = 0; card < DECK_SIZE; card++) if (knownFlags[card] === 0) remaining[liveCount++] = card;
      for (let i = 0; i < drawCount; i++) {
        const j = i + Math.floor(rng() * (liveCount - i));
        const swap = remaining[i]!;
        remaining[i] = remaining[j]!;
        remaining[j] = swap;
      }
      for (let o = 0; o < opponents; o++) {
        opponentCards[o * 2] = remaining[o * 2]!;
        opponentCards[o * 2 + 1] = remaining[o * 2 + 1]!;
      }
      for (let i = 0; i < missingBoard; i++) boardBuffer[board.length + i] = remaining[opponents * 2 + i]!;
    }

    for (let i = 0; i < board.length; i++) boardBuffer[i] = board[i]!;

    for (let i = 0; i < 5; i++) heroSeven[2 + i] = boardBuffer[i]!;
    const heroScore = evaluateBest(heroSeven);

    let tied = 1;
    let beaten = false;
    for (let o = 0; o < opponents; o++) {
      opponentSeven[0] = opponentCards[o * 2]!;
      opponentSeven[1] = opponentCards[o * 2 + 1]!;
      for (let i = 0; i < 5; i++) opponentSeven[2 + i] = boardBuffer[i]!;
      const score = evaluateBest(opponentSeven);
      if (score > heroScore) {
        beaten = true;
        break;
      }
      if (score === heroScore) tied++;
    }

    let share: number;
    if (beaten) {
      losses++;
      share = 0;
    } else if (tied > 1) {
      ties++;
      share = 1 / tied;
    } else {
      wins++;
      share = 1;
    }

    completed++;
    shareSum += share;
    shareSquareSum += share * share;

    if (tolerance > 0 && completed >= 400 && completed % 200 === 0) {
      standardError = computeStandardError(shareSum, shareSquareSum, completed);
      if (1.96 * standardError <= tolerance) break;
    }
  }

  if (completed === 0) throw new Error("equity simulation produced no completed trials");

  standardError ||= computeStandardError(shareSum, shareSquareSum, completed);

  return {
    equity: shareSum / completed,
    win: wins / completed,
    tie: ties / completed,
    lose: losses / completed,
    iterations: completed,
    standardError,
  };
}

function computeStandardError(sum: number, squareSum: number, count: number): number {
  const mean = sum / count;
  const variance = Math.max(0, squareSum / count - mean * mean);
  return Math.sqrt(variance / count);
}

/** Required equity for a call to break even: `call / (pot + call)`. */
export function potOddsRequiredEquity(callAmount: number, potBeforeCall: number): number {
  if (callAmount <= 0) return 0;
  return callAmount / (potBeforeCall + callAmount);
}

/** Stack-to-pot ratio, the standard measure of how committed a player is. */
export function stackToPotRatio(effectiveStack: number, pot: number): number {
  if (pot <= 0) return Number.POSITIVE_INFINITY;
  return effectiveStack / pot;
}

/** Equity minus the break-even threshold; positive means calling is +EV. */
export function callExpectedValue(equityShare: number, callAmount: number, potBeforeCall: number): number {
  const finalPot = potBeforeCall + callAmount;
  return equityShare * finalPot - callAmount;
}

/** Convenience used by bot logs: how often a hand is suited. */
export function isSuited(a: Card, b: Card): boolean {
  return suitOf(a) === suitOf(b);
}

/** Convenience used by bot logs: true for a pocket pair. */
export function isPair(a: Card, b: Card): boolean {
  return rankOf(a) === rankOf(b);
}
