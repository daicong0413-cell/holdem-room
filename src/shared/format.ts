/**
 * Display-only formatting, shared by the server (hand logs) and the client
 * (rendering).
 *
 * The wire format keeps the compact `Ts` spelling: two characters per card is
 * what makes parsing, the equity simulator and every test simple. Humans read
 * `10♠`, so that translation happens here and nowhere else.
 */

export const RANK_CHARS = "23456789TJQKA";
export const SUIT_SYMBOLS: Record<string, string> = { s: "♠", h: "♥", d: "♦", c: "♣" };
export const RED_SUITS = new Set(["h", "d"]);

/** `T` is a programmer's shorthand, not a card face. */
/** Chip amounts read better with a currency mark and thousands separators. */
export function money(amount: number): string {
  return `$${amount.toLocaleString("en-US")}`;
}

export function displayRank(rank: string): string {
  return rank.toUpperCase() === "T" ? "10" : rank.toUpperCase();
}

/** Rank from a 0..12 index, ready to display. */
export function rankLabel(rankIndex: number): string {
  return rankIndex >= 0 && rankIndex < 13 ? displayRank(RANK_CHARS[rankIndex]!) : "?";
}

/** `"Ts"` -> `"10♠"`. Unknown input is passed through unchanged. */
export function displayCard(card: string): string {
  if (card.length !== 2) return card;
  const suit = SUIT_SYMBOLS[card[1]!.toLowerCase()] ?? card[1]!;
  return `${displayRank(card[0]!)}${suit}`;
}

export function displayCards(cards: readonly string[], separator = " "): string {
  return cards.map(displayCard).join(separator);
}

export function isRedSuit(card: string): boolean {
  return RED_SUITS.has(card[1]?.toLowerCase() ?? "");
}

const HAND_CATEGORY = {
  highCard: 0,
  pair: 1,
  twoPair: 2,
  trips: 3,
  straight: 4,
  flush: 5,
  fullHouse: 6,
  quads: 7,
  straightFlush: 8,
} as const;

const HAND_LABELS_EN = [
  "High card", "Pair", "Two pair", "Triple", "Straight", "Flush", "Full house", "Four of a kind", "Straight flush",
] as const;

export function handLabelEn(category: number): string {
  return HAND_LABELS_EN[category] ?? "";
}

/**
 * Names a hand in Chinese from the engine's category + tiebreaker ranks, which
 * keeps the engine itself language-neutral.
 */
export function handNameZh(category: number, ranks: readonly number[]): string {
  const a = rankLabel(ranks[0] ?? 0);
  const b = rankLabel(ranks[1] ?? 0);

  switch (category) {
    case HAND_CATEGORY.straightFlush:
      return ranks[0] === 12 ? "皇家同花顺" : `${a} 高同花顺`;
    case HAND_CATEGORY.quads:
      return `四条 ${a}`;
    case HAND_CATEGORY.fullHouse:
      return `${a} 满 ${b} 葫芦`;
    case HAND_CATEGORY.flush:
      return `${a} 高同花`;
    case HAND_CATEGORY.straight:
      return `${a} 高顺子`;
    case HAND_CATEGORY.trips:
      return `三条 ${a}`;
    case HAND_CATEGORY.twoPair:
      return `${a} 和 ${b} 两对`;
    case HAND_CATEGORY.pair:
      return `一对 ${a}`;
    default:
      return `${a} 高牌`;
  }
}

/** Short street names used by the table log and the UI. */
export const STREET_LABELS_ZH: Record<string, string> = {
  preflop: "翻前",
  flop: "翻牌",
  turn: "转牌",
  river: "河牌",
  complete: "本手结束",
};

export function streetLabelZh(street: string): string {
  return STREET_LABELS_ZH[street] ?? street;
}
