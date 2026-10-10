/**
 * Bet-sizing maths for the action bar.
 *
 * Kept away from the component so the numbers can be tested directly — the
 * presets were quietly wrong for a while precisely because nothing checked
 * them.
 */

export interface PotBetInput {
  /** Chips already in the middle, including this street's bets. */
  readonly pot: number;
  /** What it costs to stay in. */
  readonly toCall: number;
  readonly minRaiseTo: number;
  readonly maxRaiseTo: number;
}

/**
 * The raise-to amount for a "half pot" / "pot" preset.
 *
 * Anchored on the call amount, not on the minimum legal raise. With an 8 chip
 * pot and nothing to call, a half-pot bet is 4; anchoring on the minimum raise
 * produced 6, because the minimum raise happens to equal the big blind.
 *
 * Facing a bet it reads as "call, then bet a fraction of the pot", which is the
 * usual convention: call 2 into a pot of 8, half pot on top → raise to 6.
 */
export function potBetAmount(input: PotBetInput, fraction: number): number {
  const raw = input.toCall + Math.round(input.pot * fraction);
  return Math.min(input.maxRaiseTo, Math.max(input.minRaiseTo, raw));
}

/**
 * Whether a separate "all in" button adds anything.
 *
 * When calling already commits every chip, the two buttons are the same action
 * twice — and the second one reads like a raise the player cannot afford.
 */
export function allInIsDistinct(input: { callCost: number; stack: number; canAllIn: boolean }): boolean {
  return input.canAllIn && input.callCost < input.stack;
}
