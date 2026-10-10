import { test } from "node:test";
import assert from "node:assert/strict";

import { cardFromString, cardsFromString, seededRng } from "./cards.ts";
import { buildComboPool, callExpectedValue, equity, potOddsRequiredEquity, stackToPotRatio } from "./equity.ts";
import { cellIndex, createRange, fullRange, parseRange, rangeShare, rangeToString, rangeWeight } from "./range.ts";

const cards = cardsFromString;

test("a five-card board royal flush chops the pot for everyone", () => {
  const result = equity({
    hero: cards("2c3d"),
    board: cards("AhKhQhJhTh"),
    opponents: 1,
    iterations: 40,
    rng: seededRng(1),
  });
  assert.equal(result.win, 0);
  assert.equal(result.tie, 1);
  assert.equal(result.lose, 0);
  assert.equal(result.equity, 0.5, "a two-way chop is exactly half the pot");
});

test("chop equity scales with the number of players sharing the pot", () => {
  const three = equity({
    hero: cards("2c3d"),
    board: cards("AhKhQhJhTh"),
    opponents: 2,
    iterations: 40,
    rng: seededRng(2),
  });
  assert.ok(Math.abs(three.equity - 1 / 3) < 1e-9, `expected 1/3, got ${three.equity}`);
});

test("quad aces on a dry board never lose", () => {
  const result = equity({
    hero: cards("AsAd"),
    board: cards("AhAcKdKs2c"),
    opponents: 2,
    iterations: 300,
    rng: seededRng(3),
  });
  assert.equal(result.win, 1);
  assert.equal(result.equity, 1);
});

test("aces are roughly an 85% favourite against one random hand", () => {
  const result = equity({ hero: cards("AsAh"), opponents: 1, iterations: 20000, rng: seededRng(11) });
  assert.ok(result.equity > 0.82 && result.equity < 0.88, `AA equity was ${result.equity}`);
});

test("the worst hand in poker still wins about a third of the time heads up", () => {
  const result = equity({ hero: cards("7c2d"), opponents: 1, iterations: 20000, rng: seededRng(12) });
  assert.ok(result.equity > 0.30 && result.equity < 0.39, `72o equity was ${result.equity}`);
});

test("equity falls as opponents are added", () => {
  const rng = seededRng(13);
  const heads = equity({ hero: cards("AsAh"), opponents: 1, iterations: 8000, rng });
  const six = equity({ hero: cards("AsAh"), opponents: 5, iterations: 8000, rng });
  assert.ok(heads.equity > six.equity, "aces must be worth less against more players");
  assert.ok(six.equity > 0.40, `AA vs 5 should still be strong, got ${six.equity}`);
});

test("aces beat kings at the documented rate when the range is known", () => {
  const result = equity({
    hero: cards("AsAd"),
    opponents: 1,
    ranges: [parseRange("KK")],
    iterations: 8000,
    rng: seededRng(21),
  });
  assert.ok(result.equity > 0.78 && result.equity < 0.86, `AA vs KK was ${result.equity}`);
});

test("a suited big ace is a coin flip against queens", () => {
  const result = equity({
    hero: cards("AhKh"),
    opponents: 1,
    ranges: [parseRange("QQ")],
    iterations: 8000,
    rng: seededRng(22),
  });
  assert.ok(result.equity > 0.42 && result.equity < 0.50, `AKs vs QQ was ${result.equity}`);
});

test("a tighter opponent range is worth more to the hero than a loose one", () => {
  const rng = seededRng(23);
  const versusNuts = equity({ hero: cards("7c2d"), opponents: 1, ranges: [parseRange("AA")], iterations: 4000, rng });
  const versusLoose = equity({ hero: cards("7c2d"), opponents: 1, ranges: [parseRange("*")], iterations: 4000, rng });
  assert.ok(versusNuts.equity < versusLoose.equity, "72o should fare worse against aces-only than against anything");
});

test("the same seed reproduces the same equity", () => {
  const run = (): number => equity({ hero: cards("QsJs"), opponents: 2, iterations: 3000, rng: seededRng(99) }).equity;
  assert.equal(run(), run());
});

test("board cards are honoured: a made flush on the turn needs no further luck", () => {
  const result = equity({
    hero: cards("AhKh"),
    board: cards("Qh9h2h"),
    opponents: 1,
    iterations: 3000,
    rng: seededRng(31),
  });
  assert.ok(result.equity > 0.90, `nut flush draw completed should dominate, got ${result.equity}`);
});

test("dead cards are excluded from every sample", () => {
  const pool = buildComboPool(parseRange("AA"), cards("As"));
  assert.equal(pool.combos.length, 3, "one ace removed leaves three ace pairs");
  for (const combo of pool.combos) {
    assert.notEqual(combo.a, cardFromString("As"));
    assert.notEqual(combo.b, cardFromString("As"));
  }
});

test("a fully blocked range yields an empty pool and a clear error", () => {
  const pool = buildComboPool(parseRange("AA"), cards("AsAhAdAc"));
  assert.equal(pool.combos.length, 0);
  assert.equal(pool.totalWeight, 0);
  assert.throws(() => equity({ hero: cards("KsKd"), opponents: 1, ranges: [parseRange("AA")], dead: cards("AsAhAdAc"), iterations: 10 }), /no completed trials/);
});

test("range notation measures the combos it actually selects", () => {
  const share = (text: string): number => rangeShare(parseRange(text));
  assert.equal(share("AA"), 6 / 1326);
  assert.equal(share("TT+"), 30 / 1326);
  assert.equal(share("22+"), 78 / 1326, "all thirteen pairs");
  assert.equal(share("AKs"), 4 / 1326);
  assert.equal(share("AKo"), 12 / 1326);
  assert.equal(share("AJo+"), 36 / 1326, "AJo, AQo and AKo");
  assert.equal(share("ATs+"), 16 / 1326, "ATs through AKs");
  assert.equal(share("*"), 1);
});

test("range spans and the any-two-cards wildcard parse", () => {
  const span = parseRange("A5s-A2s");
  assert.equal(rangeShare(span), 16 / 1326, "four suited wheel aces");
  assert.equal(rangeShare(parseRange("any")), 1);
  assert.throws(() => parseRange("AK"), /s' or 'o' suffix/);
  assert.throws(() => parseRange("AXs"), /unknown rank/);
});

test("weighted combos look up the right table", () => {
  const range = createRange();
  range.pair[12] = 1; // AA
  range.suited[cellIndex(12, 11)] = 0.5; // AKs at half weight
  range.offsuit[cellIndex(12, 11)] = 1; // AKo at full weight

  assert.equal(rangeWeight(range, cardFromString("As"), cardFromString("Ah")), 1);
  assert.equal(rangeWeight(range, cardFromString("As"), cardFromString("Ks")), 0.5);
  assert.equal(rangeWeight(range, cardFromString("As"), cardFromString("Kd")), 1);
  assert.equal(rangeWeight(range, cardFromString("Qs"), cardFromString("Jh")), 0);
  assert.equal(rangeShare(range), (6 + 4 * 0.5 + 12) / 1326);
});

test("a full range prints as a range and every combo is legal", () => {
  const pool = buildComboPool(fullRange());
  assert.equal(pool.combos.length, 1326);
  assert.equal(pool.totalWeight, 1326);
  assert.equal(Math.round(rangeShare(fullRange()) * 1326), 1326);
  assert.ok(rangeToString(parseRange("AA,KK,AKs")).startsWith("AA,KK,AKs"));
});

test("pot odds helpers agree with the standard formulas", () => {
  assert.equal(potOddsRequiredEquity(50, 150), 0.25, "50 into 150 needs 25%");
  assert.equal(potOddsRequiredEquity(0, 100), 0);
  assert.equal(stackToPotRatio(100, 50), 2);
  assert.equal(stackToPotRatio(100, 0), Number.POSITIVE_INFINITY);
  assert.ok(callExpectedValue(0.6, 100, 100) > 0, "60% equity on an even-money call is profitable");
  assert.equal(callExpectedValue(0.5, 100, 100), 0, "50% equity on an even-money call exactly breaks even");
  assert.ok(callExpectedValue(0.4, 100, 100) < 0, "40% equity on an even-money call is not profitable");
});

test("five opponents simulate fast enough for a real decision", () => {
  const started = process.hrtime.bigint();
  const result = equity({ hero: cards("AsKs"), opponents: 5, iterations: 10000, rng: seededRng(41) });
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
  assert.ok(result.iterations === 10000);
  assert.ok(elapsedMs < 5000, `10000 iterations x 5 opponents took ${elapsedMs.toFixed(0)}ms`);
});

test("the tolerance option stops early without changing the answer much", () => {
  const started = process.hrtime.bigint();
  const precise = equity({ hero: cards("AsAh"), opponents: 1, iterations: 100000, rng: seededRng(51), tolerance: 0.005 });
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
  assert.ok(precise.iterations < 100000, "should have stopped before the iteration cap");
  assert.ok(precise.equity > 0.82 && precise.equity < 0.88, `equity was ${precise.equity}`);
  assert.ok(elapsedMs < 10000, `early exit took ${elapsedMs.toFixed(0)}ms`);
});
