/**
 * Card primitives.
 *
 * A card is a plain integer `rank * 4 + suit`, so a whole deck is 0..51 and the
 * hot paths (equity simulation) can work on typed arrays without allocating
 * objects. Rank 0 is a deuce, rank 12 is an ace; suits are unordered.
 */

/** A card encoded as `rank * 4 + suit`. */
export type Card = number;

export const RANK_CHARS = "23456789TJQKA";
export const SUIT_CHARS = "shdc";

export const RANK_COUNT = 13;
export const SUIT_COUNT = 4;
export const DECK_SIZE = RANK_COUNT * SUIT_COUNT;

/** Deterministic-by-injection random source: returns a float in [0, 1). */
export type Rng = () => number;

export function makeCard(rank: number, suit: number): Card {
  if (!Number.isInteger(rank) || rank < 0 || rank >= RANK_COUNT) {
    throw new RangeError(`rank out of range: ${rank}`);
  }
  if (!Number.isInteger(suit) || suit < 0 || suit >= SUIT_COUNT) {
    throw new RangeError(`suit out of range: ${suit}`);
  }
  return rank * SUIT_COUNT + suit;
}

/** 0 = deuce … 12 = ace. */
export function rankOf(card: Card): number {
  return card >> 2;
}

/** 0 = spades, 1 = hearts, 2 = diamonds, 3 = clubs. */
export function suitOf(card: Card): number {
  return card & 3;
}

export function cardToString(card: Card): string {
  return RANK_CHARS[rankOf(card)] + SUIT_CHARS[suitOf(card)];
}

/** Accepts both `As` and `AS`; the suit letter is case-insensitive. */
export function cardFromString(text: string): Card {
  if (text.length !== 2) throw new Error(`card must be 2 characters, got "${text}"`);
  const rank = RANK_CHARS.indexOf(text[0]!.toUpperCase());
  const suit = SUIT_CHARS.indexOf(text[1]!.toLowerCase());
  if (rank < 0) throw new Error(`unknown rank "${text[0]}" in "${text}"`);
  if (suit < 0) throw new Error(`unknown suit "${text[1]}" in "${text}"`);
  return makeCard(rank, suit);
}

/** Parses `"AsKd"`, `"As Kd"` or `"As,Kd"` into a card list. */
export function cardsFromString(text: string): Card[] {
  const compact = text.replace(/[\s,]+/g, "");
  if (compact.length % 2 !== 0) throw new Error(`odd card string: "${text}"`);
  const cards: Card[] = [];
  for (let i = 0; i < compact.length; i += 2) cards.push(cardFromString(compact.slice(i, i + 2)));
  return cards;
}

export function cardsToString(cards: ArrayLike<Card>): string {
  let text = "";
  for (let i = 0; i < cards.length; i++) text += cardToString(cards[i]!);
  return text;
}

/** A fresh 52-card deck in canonical order. */
export function fullDeck(): Card[] {
  const deck: Card[] = new Array(DECK_SIZE);
  for (let i = 0; i < DECK_SIZE; i++) deck[i] = i;
  return deck;
}

/** Fisher–Yates on a copy; the input is left untouched. */
export function shuffle<T>(items: readonly T[], rng: Rng = Math.random): T[] {
  const out = items.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const swap = out[i]!;
    out[i] = out[j]!;
    out[j] = swap;
  }
  return out;
}

/** Mulberry32: tiny, fast, seedable — used so simulated hands are reproducible. */
export function seededRng(seed: number): Rng {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Deals `count` cards off the top of a shuffled deck without mutating it twice. */
export function draw(deck: Card[], count: number): Card[] {
  if (count < 0 || count > deck.length) throw new RangeError(`cannot draw ${count} from ${deck.length}`);
  return deck.splice(0, count);
}
