/**
 * Decides whether a decision is worth spending a language-model call on.
 *
 * This is the whole cost story of the project in one function. A model call is
 * slow (seconds) and costs money, so it must be reserved for spots where the
 * arithmetic genuinely does not settle the question — big commitments, all-ins,
 * rivers in bloated pots, and genuinely marginal prices. Routine checks and
 * clear folds never leave the machine.
 *
 * The classifier is deliberately independent of the model so it can be tested,
 * tuned and reasoned about on its own.
 */

import type { LegalActions, Street } from "../engine/table.ts";

export interface SpotInput {
  readonly street: Street;
  readonly pot: number;
  readonly toCall: number;
  /** Chips still behind. */
  readonly stack: number;
  readonly bigBlind: number;
  readonly opponents: number;
  readonly legal: LegalActions;
  /** Monte Carlo equity for the hero, 0..1. */
  readonly equity: number;
  /** Equity the pot is charging, 0..1. */
  readonly requiredEquity: number;
}

export interface SpotVerdict {
  readonly important: boolean;
  readonly reasons: readonly string[];
}

export interface SpotThresholds {
  /** Pot relative to the effective stack at which the hand is getting big. */
  readonly potToStack: number;
  /** Call cost relative to the effective stack. */
  readonly callToStack: number;
  /** How close equity must be to the break-even price to count as marginal. */
  readonly closeMargin: number;
  /** Pot size in big blinds that counts as "bloated". */
  readonly bigPotBlinds: number;
}

export const DEFAULT_THRESHOLDS: SpotThresholds = {
  potToStack: 0.35,
  callToStack: 0.25,
  closeMargin: 0.05,
  // 25 big blinds, not 8: a 10bb pot is an ordinary pot, and treating it as a
  // key decision made the classifier fire on ~80% of all decisions.
  bigPotBlinds: 25,
};

const percent = (value: number): string => `${Math.round(value * 100)}%`;

export function classifySpot(input: SpotInput, thresholds: SpotThresholds = DEFAULT_THRESHOLDS): SpotVerdict {
  const strong: string[] = [];
  const weak: string[] = [];

  // What is actually at stake: chips behind plus what a call would add.
  const basis = Math.max(1, input.stack + input.toCall);

  if (input.pot >= thresholds.potToStack * basis) {
    strong.push(`底池 ${input.pot} 已达有效筹码 ${basis} 的 ${percent(input.pot / basis)}`);
  }

  if (input.toCall > 0 && input.toCall >= input.stack) {
    strong.push("面对全下");
  }

  if (input.toCall >= thresholds.callToStack * basis) {
    weak.push(`跟注需投入筹码的 ${percent(input.toCall / basis)}`);
  }

  if (input.street === "river" && input.toCall > 0) {
    weak.push("河牌面对下注");
  }

  if (input.toCall > 0 && Math.abs(input.equity - input.requiredEquity) <= thresholds.closeMargin) {
    weak.push(
      `胜率 ${percent(input.equity)} 与底池赔率要求 ${percent(input.requiredEquity)} 相差在 ${percent(
        thresholds.closeMargin,
      )} 以内`,
    );
  }

  if (input.pot >= thresholds.bigPotBlinds * input.bigBlind && input.toCall > 0) {
    weak.push(`底池已达 ${Math.round(input.pot / input.bigBlind)} 个大盲`);
  }

  // Only two things justify a model call on their own: an all-in, or a pot that
  // already dwarfs the chips behind. Everything else has to be corroborated —
  // which is what keeps the trigger rate (and the bill) low.
  const important = strong.length > 0 || weak.length >= 2;
  return { important, reasons: [...strong, ...weak] };
}

/** Rough trigger-rate estimate, used by the tests to keep tuning honest. */
export function classifyMany(inputs: readonly SpotInput[], thresholds?: SpotThresholds): number {
  if (inputs.length === 0) return 0;
  const triggered = inputs.filter((input) => classifySpot(input, thresholds).important).length;
  return triggered / inputs.length;
}
