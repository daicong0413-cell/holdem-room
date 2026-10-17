import assert from "node:assert/strict";
import test from "node:test";

import { allInIsDistinct, potBetAmount } from "./betting.ts";

test("half pot with nothing to call is half the pot", () => {
  // Reported bug: an 8 chip pot offered 6 as a "half pot" bet.
  assert.equal(potBetAmount({ pot: 8, toCall: 0, streetCommitted: 0, minRaiseTo: 2, maxRaiseTo: 200 }, 0.5), 4);
  assert.equal(potBetAmount({ pot: 8, toCall: 0, streetCommitted: 0, minRaiseTo: 2, maxRaiseTo: 200 }, 1), 8);
  assert.equal(potBetAmount({ pot: 100, toCall: 0, streetCommitted: 0, minRaiseTo: 2, maxRaiseTo: 200 }, 0.5), 50);
});

test("facing a bet it calls first, then bets the fraction", () => {
  assert.equal(potBetAmount({ pot: 8, toCall: 2, streetCommitted: 0, minRaiseTo: 4, maxRaiseTo: 200 }, 0.5), 7);
  assert.equal(potBetAmount({ pot: 8, toCall: 2, streetCommitted: 0, minRaiseTo: 4, maxRaiseTo: 200 }, 1), 12);
});

test("pot raises include live bets and the player's existing contribution", () => {
  // Unopened 1/2 blinds: calling 2 makes a pot of 5, so a pot raise is to 7.
  assert.equal(potBetAmount({ pot: 3, toCall: 2, streetCommitted: 0, minRaiseTo: 4, maxRaiseTo: 200 }, 1), 7);
  // The small blind already has 1 in: call 1, then raise the resulting pot of 4.
  assert.equal(potBetAmount({ pot: 3, toCall: 1, streetCommitted: 1, minRaiseTo: 4, maxRaiseTo: 200 }, 1), 6);
  assert.equal(potBetAmount({ pot: 20, toCall: 4, streetCommitted: 2, minRaiseTo: 10, maxRaiseTo: 200 }, 0.5), 18);
});

test("the result always stays inside the legal raise range", () => {
  // A tiny pot against a big minimum raise is dragged up to the minimum.
  assert.equal(potBetAmount({ pot: 4, toCall: 0, streetCommitted: 0, minRaiseTo: 50, maxRaiseTo: 200 }, 0.5), 50);
  // A huge pot against a short stack is capped at the all-in.
  assert.equal(potBetAmount({ pot: 10_000, toCall: 0, streetCommitted: 0, minRaiseTo: 2, maxRaiseTo: 57 }, 1), 57);
});

test("a short stack facing a bigger all-in gets no separate all-in button", () => {
  // Calling already commits every chip, so the second button is the same move.
  assert.equal(allInIsDistinct({ canAllIn: true, callCost: 57, stack: 57 }), false);
  // With chips behind, the all-in button does something the call does not.
  assert.equal(allInIsDistinct({ canAllIn: true, callCost: 20, stack: 200 }), true);
  assert.equal(allInIsDistinct({ canAllIn: false, callCost: 20, stack: 200 }), false);
});
