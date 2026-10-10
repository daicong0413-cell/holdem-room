/**
 * Range model.
 *
 * A range is expressed as three weight tables rather than one 13x13 grid, so a
 * lookup never has to reconstruct whether a combo was suited or not:
 *
 *   - `pair[rank]`            — 13 entries
 *   - `suited[hi * 13 + lo]`  — 169 entries, only `hi >= lo` is meaningful
 *   - `offsuit[hi * 13 + lo]` — 169 entries, same indexing
 *
 * Weights are probabilities in 0..1, which makes mixed strategies (“3-bet AKs
 * 70% of the time”) directly expressible and the notation parser trivial.
 */

import { type Card, RANK_CHARS, rankOf, suitOf } from "./cards.ts";

export interface HandRange {
  readonly pair: Float64Array;
  readonly suited: Float64Array;
  readonly offsuit: Float64Array;
}

/** Total distinct two-card combos: C(52,2) = 1326. */
export const TOTAL_COMBOS = 1326;

const CELLS = 13 * 13;

export function cellIndex(rankA: number, rankB: number): number {
  const hi = Math.max(rankA, rankB);
  const lo = Math.min(rankA, rankB);
  return hi * 13 + lo;
}

export function createRange(): HandRange {
  return { pair: new Float64Array(13), suited: new Float64Array(CELLS), offsuit: new Float64Array(CELLS) };
}

/** Every combo at full weight — the "any two cards" range. */
export function fullRange(): HandRange {
  const range = createRange();
  fillAll(range, 1);
  return range;
}

/**
 * Fills every *valid* cell. Only `hi > lo` is meaningful for suited/offsuit, so
 * the mirror half of the grid is deliberately left untouched — otherwise a
 * caller that scans all 169 cells would double-count the range.
 */
function fillAll(range: HandRange, weight: number): void {
  range.pair.fill(weight);
  for (let hi = 12; hi >= 0; hi--) {
    for (let lo = hi - 1; lo >= 0; lo--) {
      const cell = hi * 13 + lo;
      range.suited[cell] = weight;
      range.offsuit[cell] = weight;
    }
  }
}

export function cloneRange(range: HandRange): HandRange {
  return { pair: range.pair.slice(), suited: range.suited.slice(), offsuit: range.offsuit.slice() };
}

export function rangeWeight(range: HandRange, a: Card, b: Card): number {
  const rankA = rankOf(a);
  const rankB = rankOf(b);
  if (rankA === rankB) return range.pair[rankA]!;
  const cell = cellIndex(rankA, rankB);
  return suitOf(a) === suitOf(b) ? range.suited[cell]! : range.offsuit[cell]!;
}

/** Number of card combos a cell represents: 6 for a pair, 4 suited, 12 offsuit. */
function cellCombos(kind: "pair" | "suited" | "offsuit"): 6 | 4 | 12 {
  return kind === "pair" ? 6 : kind === "suited" ? 4 : 12;
}

/** Share of all 1326 combos the range covers, weighted (0..1). */
export function rangeShare(range: HandRange): number {
  let weighted = 0;
  for (let rank = 0; rank < 13; rank++) weighted += range.pair[rank]! * 6;
  for (let hi = 12; hi >= 0; hi--) {
    for (let lo = hi - 1; lo >= 0; lo--) {
      const cell = hi * 13 + lo;
      weighted += range.suited[cell]! * 4;
      weighted += range.offsuit[cell]! * 12;
    }
  }
  return weighted / TOTAL_COMBOS;
}

/** How many hand cells (of 169) carry any weight at all. */
export function rangeCellCount(range: HandRange): number {
  let count = 0;
  for (let rank = 0; rank < 13; rank++) if (range.pair[rank]! > 0) count++;
  for (let hi = 12; hi >= 0; hi--) {
    for (let lo = hi - 1; lo >= 0; lo--) {
      const cell = hi * 13 + lo;
      if (range.suited[cell]! > 0 || range.offsuit[cell]! > 0) count++;
    }
  }
  return count;
}

function parseRank(char: string): number {
  const rank = RANK_CHARS.indexOf(char.toUpperCase());
  if (rank < 0) throw new Error(`unknown rank "${char}" in range`);
  return rank;
}

function setPair(range: HandRange, rank: number, weight: number): void {
  range.pair[rank] = weight;
}

function setSuited(range: HandRange, a: number, b: number, weight: number): void {
  range.suited[cellIndex(a, b)] = weight;
}

function setOffsuit(range: HandRange, a: number, b: number, weight: number): void {
  range.offsuit[cellIndex(a, b)] = weight;
}

/**
 * Parses standard range notation:
 *
 *   `AA`      a single pair
 *   `TT+`     every pair from TT up to AA
 *   `AKs`     one suited combo
 *   `ATs+`    ATs, AJs, AQs, AKs (kicker climbs toward the high card)
 *   `ATo+`    the same for offsuit
 *   `A5s-A2s` an explicit suited span
 *
 * Tokens are separated by commas, spaces or newlines; `*` means any two cards.
 */
export function parseRange(text: string): HandRange {
  const range = createRange();
  const tokens = text
    .split(/[\s,]+/)
    .map((token) => token.trim())
    .filter((token) => token.length > 0);

  for (const token of tokens) {
    if (token === "*" || token.toLowerCase() === "any") {
      fillAll(range, 1);
      continue;
    }

    const span = token.match(/^(.+?)-(.+)$/);
    if (span) {
      applyToken(range, span[1]!, false, span[2]!);
      continue;
    }

    applyToken(range, token, token.endsWith("+"));
  }

  return range;
}

function applyToken(range: HandRange, token: string, plus: boolean, spanEnd?: string): void {
  const base = token.replace(/\+$/, "");
  if (base.length < 2 || base.length > 3) throw new Error(`cannot parse range token "${token}"`);

  const first = parseRank(base[0]!);
  const second = parseRank(base[1]!);
  const suffix = base.length === 3 ? base[2]!.toLowerCase() : "";
  if (suffix !== "" && suffix !== "s" && suffix !== "o") throw new Error(`unknown suffix in "${token}"`);
  if (spanEnd !== undefined && plus) throw new Error(`cannot combine '+' with a span: "${token}"`);

  // Pair, e.g. TT, 22+ or 22-66
  if (first === second) {
    if (suffix !== "") throw new Error(`pairs take no suited/offsuit suffix: "${token}"`);
    const top = spanEnd !== undefined ? parseRank(spanEnd[0]!) : plus ? 12 : first;
    for (let rank = Math.min(first, top); rank <= Math.max(first, top); rank++) setPair(range, rank, 1);
    return;
  }

  // Non-pair: the first character is the high card by convention (AKs, not KAs).
  const high = Math.max(first, second);
  const low = Math.min(first, second);
  if (suffix === "") throw new Error(`non-pair combos need an 's' or 'o' suffix: "${token}"`);

  // A span end like "A2s" carries its kicker as the second character.
  const endpoint = spanEnd !== undefined ? parseRank(spanEnd[1]!) : plus ? high - 1 : low;
  const step = endpoint >= low ? 1 : -1;
  for (let kicker = low; step > 0 ? kicker <= endpoint : kicker >= endpoint; kicker += step) {
    if (kicker === high) continue;
    if (suffix === "s") setSuited(range, high, kicker, 1);
    else setOffsuit(range, high, kicker, 1);
  }
}

/** Human-readable shorthand for logging and the UI, e.g. "AA,KK,AKs". */
export function rangeToString(range: HandRange, limit = 30): string {
  const parts: string[] = [];
  for (let rank = 12; rank >= 0; rank--) {
    if (range.pair[rank]! > 0) parts.push(`${RANK_CHARS[rank]}${RANK_CHARS[rank]}`);
  }
  for (let high = 12; high >= 0; high--) {
    for (let low = high - 1; low >= 0; low--) {
      const cell = cellIndex(high, low);
      if (range.suited[cell]! > 0) parts.push(`${RANK_CHARS[high]}${RANK_CHARS[low]}s`);
      if (range.offsuit[cell]! > 0) parts.push(`${RANK_CHARS[high]}${RANK_CHARS[low]}o`);
    }
  }
  if (parts.length <= limit) return parts.join(",");
  return `${parts.slice(0, limit).join(",")},+${parts.length - limit} more`;
}
