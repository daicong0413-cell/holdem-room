/**
 * Poker hand evaluation.
 *
 * Every evaluated hand collapses into a single integer score so comparisons are
 * a plain `>` — fast enough for Monte Carlo equity, and trivially serializable
 * across the wire:
 *
 *     score = category * 15^5 + k1*15^4 + k2*15^3 + k3*15^2 + k4*15 + k5
 *
 * `category` dominates, and the five tiebreaker slots are the ranks that matter
 * for that category, padded with zeros. Ranks are 0..12, so each tiebreaker
 * needs 4 bits and the whole score stays inside a small int.
 */

import { type Card, rankOf, suitOf, RANK_CHARS } from "./cards.ts";

export const HandCategory = {
  HighCard: 0,
  Pair: 1,
  TwoPair: 2,
  Trips: 3,
  Straight: 4,
  Flush: 5,
  FullHouse: 6,
  Quads: 7,
  StraightFlush: 8,
} as const;
export type HandCategory = (typeof HandCategory)[keyof typeof HandCategory];

export const CATEGORY_NAMES = [
  "High Card",
  "Pair",
  "Two Pair",
  "Three of a Kind",
  "Straight",
  "Flush",
  "Full House",
  "Four of a Kind",
  "Straight Flush",
] as const;

const KICKER_BASE = 15;
const CATEGORY_SHIFT = KICKER_BASE ** 5; // 759375
const TIEBREAKER_WEIGHTS = [KICKER_BASE ** 4, KICKER_BASE ** 3, KICKER_BASE ** 2, KICKER_BASE, 1];

// Scratch buffers: evaluate5 runs millions of times during equity simulation,
// so it must not allocate per call.
const counts = new Int8Array(13);
const order = new Int32Array(7);

/** Highest rank that completes a 5-card straight, or -1. Handles the wheel. */
function straightHigh(rankMask: number): number {
  for (let high = 12; high >= 4; high--) {
    const needed = 0b11111 << (high - 4);
    if ((rankMask & needed) === needed) return high;
  }
  const wheel = (1 << 12) | 0b1111; // A 2 3 4 5 — the ace plays low
  if ((rankMask & wheel) === wheel) return 3;
  return -1;
}

function scoreOf(category: HandCategory, ranks: ArrayLike<number>, length: number): number {
  let score = category * CATEGORY_SHIFT;
  for (let i = 0; i < 5; i++) {
    const rank = i < length ? ranks[i]! : 0;
    score += rank * TIEBREAKER_WEIGHTS[i]!;
  }
  return score;
}

/**
 * Scores exactly five cards. Higher is better; equal scores are exact ties.
 */
export function evaluate5(cards: ArrayLike<Card>): number {
  if (cards.length !== 5) throw new RangeError(`evaluate5 needs 5 cards, got ${cards.length}`);

  counts.fill(0);
  let rankMask = 0;
  const firstSuit = suitOf(cards[0]!);
  let isFlush = true;

  for (let i = 0; i < 5; i++) {
    const card = cards[i]!;
    const rank = rankOf(card);
    counts[rank]!++;
    rankMask |= 1 << rank;
    if (suitOf(card) !== firstSuit) isFlush = false;
  }

  const straight = straightHigh(rankMask);
  if (isFlush && straight >= 0) return scoreOf(HandCategory.StraightFlush, [straight], 1);

  // Distinct ranks, ordered by count desc then rank desc. With that single
  // ordering every category's tiebreakers are just a prefix of this array.
  let n = 0;
  for (let rank = 12; rank >= 0; rank--) if (counts[rank]! > 0) order[n++] = rank;
  for (let i = 1; i < n; i++) {
    const value = order[i]!;
    const valueCount = counts[value]!;
    let j = i - 1;
    while (j >= 0 && (counts[order[j]!]! < valueCount || (counts[order[j]!]! === valueCount && order[j]! < value))) {
      order[j + 1] = order[j]!;
      j--;
    }
    order[j + 1] = value;
  }

  if (isFlush) return scoreOf(HandCategory.Flush, order, 5);

  const topCount = counts[order[0]!]!;
  if (topCount === 4) return scoreOf(HandCategory.Quads, order, 2);
  if (topCount === 3) {
    if (n > 1 && counts[order[1]!]! >= 2) return scoreOf(HandCategory.FullHouse, order, 2);
    return scoreOf(HandCategory.Trips, order, 3);
  }
  // Two pair needs a *second* rank with count 2 — with seven cards there can be
  // three pairs, and then order[2] is the third pair's rank, which correctly
  // becomes the best kicker for the top two pairs.
  if (n > 1 && counts[order[1]!]! === 2) return scoreOf(HandCategory.TwoPair, order, 3);
  if (topCount === 2) return scoreOf(HandCategory.Pair, order, 4);
  if (straight >= 0) return scoreOf(HandCategory.Straight, [straight], 1);
  return scoreOf(HandCategory.HighCard, order, 5);
}

/** Index combinations of 5 from n, precomputed (C(5,5)=1, C(6,5)=6, C(7,5)=21). */
const COMBINATIONS: number[][][] = (() => {
  const table: number[][][] = [];
  for (let n = 5; n <= 7; n++) {
    const combos: number[][] = [];
    const pick: number[] = [];
    const walk = (start: number): void => {
      if (pick.length === 5) {
        combos.push(pick.slice());
        return;
      }
      for (let i = start; i <= n - (5 - pick.length); i++) {
        pick.push(i);
        walk(i + 1);
        pick.pop();
      }
    };
    walk(0);
    table[n] = combos;
  }
  return table;
})();

const comboHand = new Int32Array(5);

/** Best five-card score available from 5, 6 or 7 cards. */
export function evaluateBest(cards: ArrayLike<Card>): number {
  const n = cards.length;
  if (n === 5) return evaluate5(cards);
  if (n < 5 || n > 7) throw new RangeError(`evaluateBest needs 5-7 cards, got ${n}`);

  const combos = COMBINATIONS[n]!;
  let best = -1;
  for (let c = 0; c < combos.length; c++) {
    const combo = combos[c]!;
    comboHand[0] = cards[combo[0]!]!;
    comboHand[1] = cards[combo[1]!]!;
    comboHand[2] = cards[combo[2]!]!;
    comboHand[3] = cards[combo[3]!]!;
    comboHand[4] = cards[combo[4]!]!;
    const score = evaluate5(comboHand);
    if (score > best) best = score;
  }
  return best;
}

export function categoryOf(score: number): HandCategory {
  return Math.floor(score / CATEGORY_SHIFT) as HandCategory;
}

/**
 * The five cards that actually make the best hand, out of 5–7 candidates.
 *
 * `evaluateBest` throws away *which* cards won; this keeps them, so the table
 * can show a player why they won — including the case where the board plays and
 * none of their hole cards matter.
 */
export function bestFive(cards: ArrayLike<Card>): Card[] {
  const n = cards.length;
  if (n === 5) return [cards[0]!, cards[1]!, cards[2]!, cards[3]!, cards[4]!];
  if (n < 5 || n > 7) throw new RangeError(`bestFive needs 5-7 cards, got ${n}`);

  const combos = COMBINATIONS[n]!;
  let best = -1;
  let bestCombo: number[] | null = null;

  for (const combo of combos) {
    comboHand[0] = cards[combo[0]!]!;
    comboHand[1] = cards[combo[1]!]!;
    comboHand[2] = cards[combo[2]!]!;
    comboHand[3] = cards[combo[3]!]!;
    comboHand[4] = cards[combo[4]!]!;
    const score = evaluate5(comboHand);
    if (score > best) {
      best = score;
      bestCombo = combo;
    }
  }

  const chosen = bestCombo!;
  return [cards[chosen[0]!]!, cards[chosen[1]!]!, cards[chosen[2]!]!, cards[chosen[3]!]!, cards[chosen[4]!]!];
}
/** The ranks that decide ties within a category, most significant first. */
export function tiebreakersOf(score: number): number[] {
  let rest = score % CATEGORY_SHIFT;
  const ranks: number[] = [];
  for (const weight of TIEBREAKER_WEIGHTS) {
    const rank = Math.floor(rest / weight);
    rest -= rank * weight;
    ranks.push(rank);
  }
  return ranks;
}

function rankLabel(rank: number): string {
  return rank >= 0 && rank < 13 ? RANK_CHARS[rank]! : "?";
}

export interface HandDescription {
  category: HandCategory;
  /** English name suitable for logs; the UI maps `category` for other locales. */
  name: string;
  /** Ranks that break ties, most significant first (zeros trimmed by `name`). */
  ranks: number[];
}

export function describe(score: number): HandDescription {
  const category = categoryOf(score);
  const ranks = tiebreakersOf(score);
  const counts = new Map<number, number>();
  for (const rank of ranks) {
    if (rank === 0) continue;
    counts.set(rank, (counts.get(rank) ?? 0) + 1);
  }

  let name = CATEGORY_NAMES[category] as string;
  const label = (rank: number): string => rankLabel(rank);

  switch (category) {
    case HandCategory.StraightFlush:
      name = ranks[0] === 12 ? "Royal Flush" : `${label(ranks[0]!)}-high Straight Flush`;
      break;
    case HandCategory.Quads:
      name = `Four ${label(ranks[0]!)}s`;
      break;
    case HandCategory.FullHouse:
      name = `${label(ranks[0]!)}s full of ${label(ranks[1]!)}s`;
      break;
    case HandCategory.Flush:
      name = `${label(ranks[0]!)}-high Flush`;
      break;
    case HandCategory.Straight:
      name = `${label(ranks[0]!)}-high Straight`;
      break;
    case HandCategory.Trips:
      name = `Three ${label(ranks[0]!)}s`;
      break;
    case HandCategory.TwoPair:
      name = `${label(ranks[0]!)}s and ${label(ranks[1]!)}s`;
      break;
    case HandCategory.Pair:
      name = `Pair of ${label(ranks[0]!)}s`;
      break;
    default:
      name = `${label(ranks[0]!)}-high`;
      break;
  }

  return { category, name, ranks };
}

/** Convenience wrapper used by hand histories and the UI. */
export function handName(score: number): string {
  return describe(score).name;
}
