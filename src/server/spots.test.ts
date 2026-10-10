import { test } from "node:test";
import assert from "node:assert/strict";

import type { LegalActions } from "../engine/table.ts";
import { DEFAULT_THRESHOLDS, classifyMany, classifySpot, type SpotInput } from "./spots.ts";

function legal(overrides: Partial<LegalActions> = {}): LegalActions {
  return {
    seatIndex: 0,
    toCall: 0,
    canFold: true,
    canCheck: true,
    canCall: false,
    callCost: 0,
    canRaise: true,
    canAllIn: true,
    minRaiseTo: 4,
    maxRaiseTo: 200,
    ...overrides,
  };
}

function spot(overrides: Partial<SpotInput> = {}): SpotInput {
  return {
    street: "flop",
    pot: 6,
    toCall: 0,
    stack: 200,
    bigBlind: 2,
    opponents: 2,
    legal: legal(),
    equity: 0.5,
    requiredEquity: 0.25,
    ...overrides,
  };
}

test("a routine small decision never reaches the model", () => {
  const verdict = classifySpot(spot());
  assert.equal(verdict.important, false, `should be routine, reasons: ${verdict.reasons.join("；")}`);
  assert.deepEqual(verdict.reasons, []);
});

test("facing an all-in is always worth a model call", () => {
  const verdict = classifySpot(spot({ street: "river", pot: 150, toCall: 200, stack: 200, equity: 0.4 }));
  assert.equal(verdict.important, true);
  assert.ok(verdict.reasons.some((reason) => reason.includes("全下")), verdict.reasons.join("；"));
});

test("a pot that dwarfs the remaining stack is a key decision", () => {
  const verdict = classifySpot(spot({ street: "turn", pot: 120, toCall: 20, stack: 100 }));
  assert.equal(verdict.important, true);
  assert.ok(verdict.reasons.some((reason) => reason.includes("有效筹码")), verdict.reasons.join("；"));
});

test("one soft signal alone is not enough, two together are", () => {
  // A pricey call, but with a clear equity edge and a small pot.
  const priceOnly = classifySpot(spot({ street: "flop", pot: 20, toCall: 70, stack: 200, equity: 0.8, requiredEquity: 0.25 }));
  assert.equal(priceOnly.important, false, priceOnly.reasons.join("；"));

  // The same pricey call, but now genuinely marginal.
  const priceAndClose = classifySpot(
    spot({ street: "flop", pot: 20, toCall: 70, stack: 200, equity: 0.25, requiredEquity: 0.28 }),
  );
  assert.equal(priceAndClose.important, true, priceAndClose.reasons.join("；"));
  assert.ok(priceAndClose.reasons.length >= 2);
});

test("a river decision becomes interesting once the pot is worth fighting for", () => {
  // A routine half-pot call in a small pot stays local.
  const smallPot = classifySpot(spot({ street: "river", pot: 20, toCall: 10, stack: 200, equity: 0.9, requiredEquity: 0.2 }));
  assert.equal(smallPot.important, false, smallPot.reasons.join("；"));

  // A 40bb pot on the river is a real decision.
  const bigPot = classifySpot(spot({ street: "river", pot: 80, toCall: 40, stack: 200, equity: 0.9, requiredEquity: 0.2 }));
  assert.equal(bigPot.important, true);
  assert.ok(bigPot.reasons.some((reason) => reason.includes("大盲")), bigPot.reasons.join("；"));
});

test("the break-even margin is the tuned value, not a guess", () => {
  const justInside = classifySpot(
    spot({
      street: "turn",
      pot: 30,
      toCall: 30,
      stack: 200,
      equity: 0.5 + DEFAULT_THRESHOLDS.closeMargin / 2,
      requiredEquity: 0.5,
    }),
  );
  assert.ok(justInside.reasons.some((reason) => reason.includes("底池赔率要求")));

  const outside = classifySpot(
    spot({
      street: "turn",
      pot: 30,
      toCall: 30,
      stack: 200,
      equity: 0.5 + DEFAULT_THRESHOLDS.closeMargin * 4,
      requiredEquity: 0.5,
    }),
  );
  assert.equal(outside.reasons.some((reason) => reason.includes("底池赔率要求")), false);
});

test("with no bet to face there is nothing to decide, however big the pot", () => {
  const verdict = classifySpot(spot({ street: "turn", pot: 400, toCall: 0, stack: 100, legal: legal({ canRaise: false }) }));
  // A huge pot relative to the stack still counts: the *next* bet is the decision.
  assert.equal(verdict.important, true);
  assert.ok(verdict.reasons.some((reason) => reason.includes("有效筹码")));
});

test("the trigger rate stays low on a realistic mix of situations", () => {
  // A rough model of a 100bb six-max game: most decisions happen in small
  // single-raised pots, fewer in multiway pots, and only a minority in bloated
  // three-bet pots. The classifier has to be a genuine saving on this mix —
  // otherwise every decision costs a token and the whole design is pointless.
  const samples: SpotInput[] = [];
  for (let index = 0; index < 300; index++) {
    const bucket = index % 10;
    const pot = bucket < 5 ? 6 + (index % 4) * 4 : bucket < 8 ? 24 + (index % 5) * 8 : 70 + (index % 6) * 22;
    const toCall =
      bucket < 5 ? (index % 3 === 0 ? 0 : 4 + (index % 3) * 4) : bucket < 8 ? 10 + (index % 4) * 10 : 30 + (index % 5) * 25;

    samples.push(
      spot({
        street: (["preflop", "flop", "turn", "river"] as const)[index % 4]!,
        pot,
        toCall,
        stack: 200,
        equity: 0.25 + (index % 9) * 0.07,
        requiredEquity: 0.18 + (index % 6) * 0.06,
      }),
    );
  }

  const rate = classifyMany(samples);
  assert.ok(rate > 0.05, `classifier almost never fires (${rate.toFixed(2)}) — it would miss real spots`);
  assert.ok(
    rate < 0.45,
    `classifier fires on ${(rate * 100).toFixed(0)}% of decisions — too often to be a cost saving`,
  );
});
