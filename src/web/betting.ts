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
  /** This player's chips already bet on the current street. */
  readonly streetCommitted: number;
  readonly minRaiseTo: number;
  readonly maxRaiseTo: number;
}

/**
 * The raise-to amount for a "half pot" / "pot" preset.
 *
 * Call first, size the raise against the pot after that call, then include the
 * player's existing street contribution to produce a raise-to amount. `pot`
 * includes all live bets, even though the table displays those chips separately.
 */
export function potBetAmount(input: PotBetInput, fraction: number): number {
  const raw = input.streetCommitted + input.toCall + Math.round((input.pot + input.toCall) * fraction);
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
