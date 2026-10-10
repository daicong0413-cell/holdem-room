import { test } from "node:test";
import assert from "node:assert/strict";

import { cardFromString, cardsFromString, fullDeck, seededRng, shuffle } from "./cards.ts";
import {
  CATEGORY_NAMES,
  bestFive,
  categoryOf,
  describe,
  evaluate5,
  evaluateBest,
  HandCategory,
  handName,
  tiebreakersOf,
} from "./hand.ts";

const score = (text: string): number => evaluate5(cardsFromString(text));
const best = (text: string): number => evaluateBest(cardsFromString(text));

test("every five-card category is classified correctly", () => {
  assert.equal(categoryOf(score("AsKsQsJsTs")), HandCategory.StraightFlush);
  assert.equal(categoryOf(score("AcAdAhAsKd")), HandCategory.Quads);
  assert.equal(categoryOf(score("KcKdKh2s2d")), HandCategory.FullHouse);
  assert.equal(categoryOf(score("Ah9h7h5h3h")), HandCategory.Flush);
  assert.equal(categoryOf(score("9c8d7h6s5c")), HandCategory.Straight);
  assert.equal(categoryOf(score("QcQdQh7s2d")), HandCategory.Trips);
  assert.equal(categoryOf(score("JcJd4h4sKd")), HandCategory.TwoPair);
  assert.equal(categoryOf(score("TcTdAs7h3c")), HandCategory.Pair);
  assert.equal(categoryOf(score("AcKd9h5s3c")), HandCategory.HighCard);
});

test("category names are human readable", () => {
  assert.equal(handName(score("AsKsQsJsTs")), "Royal Flush");
  assert.equal(handName(score("9h8h7h6h5h")), "9-high Straight Flush");
  assert.equal(handName(score("AcAdAhAsKd")), "Four As");
  assert.equal(handName(score("KcKdKh2s2d")), "Ks full of 2s");
  assert.equal(handName(score("Ah9h7h5h3h")), "A-high Flush");
  assert.equal(handName(score("9c8d7h6s5c")), "9-high Straight");
  assert.equal(handName(score("QcQdQh7s2d")), "Three Qs");
  assert.equal(handName(score("JcJd4h4sKd")), "Js and 4s");
  assert.equal(handName(score("TcTdAs7h3c")), "Pair of Ts");
  assert.equal(handName(score("AcKd9h5s3c")), "A-high");
});

test("describe exposes the category and tiebreaker ranks", () => {
  const described = describe(score("KcKdKh2s2d"));
  assert.equal(described.category, HandCategory.FullHouse);
  assert.equal(CATEGORY_NAMES[described.category], "Full House");
  assert.deepEqual(described.ranks, [11, 0, 0, 0, 0]);
  assert.deepEqual(tiebreakersOf(score("JcJd4h4sKd")), [9, 2, 11, 0, 0]);
});

test("categories are strictly ordered: any flush beats any straight", () => {
  const worstFlush = score("7h5h4h3h2h");
  const bestStraight = score("AsKdQhJcTs");
  assert.ok(worstFlush > bestStraight, "flush must outrank a straight");
});

test("the wheel is the lowest straight and loses to a six-high straight", () => {
  const wheel = score("Ac2d3h4s5c");
  const sixHigh = score("6c5d4h3s2c");
  assert.equal(categoryOf(wheel), HandCategory.Straight);
  assert.equal(handName(wheel), "5-high Straight");
  assert.ok(sixHigh > wheel, "six-high straight must beat the wheel");
});

test("the wheel also counts as a straight flush and ranks below a six-high one", () => {
  const steelWheel = score("Ah2h3h4h5h");
  const sixHighFlush = score("6h5h4h3h2h");
  assert.equal(categoryOf(steelWheel), HandCategory.StraightFlush);
  assert.equal(categoryOf(sixHighFlush), HandCategory.StraightFlush);
  assert.ok(sixHighFlush > steelWheel);
});

test("the ace plays high in a broadway straight", () => {
  const broadway = score("AsKdQhJcTc");
  assert.equal(categoryOf(broadway), HandCategory.Straight);
  assert.equal(handName(broadway), "A-high Straight");
  assert.ok(broadway > score("KdQhJcTs9d"), "broadway beats a king-high straight");
});

test("kickers decide ties inside a category", () => {
  assert.ok(score("TcTdAs7h3c") > score("TcTdKs7h3c"), "ace kicker beats king kicker");
  assert.ok(score("JcJd4h4sKd") > score("JcJd4h4sQd"), "two pair kicker decides");
  assert.ok(score("9c8d7h6s5c") > score("8c7d6h5s4c"), "higher straight wins");
  assert.ok(score("AhKd9h5s3c") > score("AhQd9h5s3c"), "high card kicker decides");
  assert.ok(score("QcQdQhAs2d") > score("QcQdQhKs2d"), "trips kicker decides");
});

test("identical hands from different suits score exactly equal", () => {
  assert.equal(score("AcKdQhJsTc"), score("AdKhQsJcTd"));
});

test("a full house beats a flush and quads beat a full house", () => {
  assert.ok(score("2c2d2h3s3d") > score("AhKhQhJh9h"));
  assert.ok(score("2c2d2h2s3d") > score("AcAdAhKsKd"));
});

test("evaluate5 rejects the wrong number of cards", () => {
  assert.throws(() => evaluate5(cardsFromString("AsKd")), RangeError);
  assert.throws(() => evaluate5(cardsFromString("AsKdQhJsTc9d")), RangeError);
});

test("evaluateBest searches all 21 five-card subsets of seven cards", () => {
  // The board offers both a straight and trip fives; the straight is stronger.
  const straightBeatsTrips = best("9c8d7h6s5c5h5d");
  assert.equal(categoryOf(straightBeatsTrips), HandCategory.Straight);

  // A flush is available alongside a straight; the flush must win.
  const flushBeatsStraight = best("AhKh9h5h2h6c7d");
  assert.equal(categoryOf(flushBeatsStraight), HandCategory.Flush);
});

test("evaluateBest picks the best two pair out of three pairs", () => {
  // As Ad Ks Kd Qs Qd 2c -> aces and kings with a queen kicker.
  const three = best("AsAdKsKdQsQd2c");
  assert.equal(categoryOf(three), HandCategory.TwoPair);
  assert.deepEqual(tiebreakersOf(three), [12, 11, 10, 0, 0]);
});

test("evaluateBest upgrades a one-pair holding into a full house", () => {
  // Ks Kd 2c 2d 2h 7s 9d -> deuces full of kings.
  const full = best("KsKd2c2d2h7s9d");
  assert.equal(categoryOf(full), HandCategory.FullHouse);
  assert.deepEqual(tiebreakersOf(full).slice(0, 2), [0, 11]);
});

test("evaluateBest on six cards matches a seven-card search that ignores the extra card", () => {
  const six = best("AhKhQhJhTh2c");
  assert.equal(categoryOf(six), HandCategory.StraightFlush);
  assert.equal(handName(six), "Royal Flush");
});

test("bestFive names the exact cards that won the hand", () => {
  // Ah Kh 9h 5h 2h is a flush; the 6c and 7d must not appear.
  const flush = bestFive(cardsFromString("AhKh9h5h2h6c7d"));
  assert.equal(flush.length, 5);
  assert.equal(evaluate5(flush), evaluateBest(cardsFromString("AhKh9h5h2h6c7d")));
  assert.equal(categoryOf(evaluate5(flush)), HandCategory.Flush);
  for (const card of flush) assert.notEqual(card, cardFromString("6c"));
});

test("bestFive handles a board that plays for everybody", () => {
  const board = cardsFromString("AhKhQhJhTh");
  const seven = [...cardsFromString("2c3d"), ...board];
  const best = bestFive(seven);
  assert.equal(best.length, 5);
  assert.deepEqual([...best].sort((a, b) => a - b), [...board].sort((a, b) => a - b));
});

test("bestFive picks the five relevant cards out of a busy board", () => {
  // Quads on board plus a kicker: the best five is the four aces and the king.
  const seven = cardsFromString("AcAdAhAsKd2c3c");
  const best = bestFive(seven);
  assert.equal(categoryOf(evaluate5(best)), HandCategory.Quads);
  assert.equal(best.includes(cardFromString("Kd")), true, "the king is the kicker");
  assert.equal(best.includes(cardFromString("2c")), false);
});

test("bestFive always agrees with evaluateBest, over random hands", () => {
  const rng = seededRng(31337);
  for (let i = 0; i < 2000; i++) {
    const seven = shuffle(fullDeck(), rng).slice(0, 7);
    const best = bestFive(seven);
    assert.equal(best.length, 5);
    assert.equal(new Set(best).size, 5, "the five cards must be distinct");
    for (const card of best) assert.ok(seven.includes(card), "they must come from the dealt cards");
    assert.equal(evaluate5(best), evaluateBest(seven), "and they must score exactly the same");
  }
});

test("bestFive rejects the wrong number of cards", () => {
  assert.throws(() => bestFive(cardsFromString("AsKd")), RangeError);
  assert.throws(() => bestFive(cardsFromString("AsKdQhJsTc9d8h7c")), RangeError);
});

test("category frequencies over random seven-card hands are statistically sane", () => {  const rng = seededRng(20240501);
  const iterations = 20000;
  const tally = new Array<number>(9).fill(0);

  for (let i = 0; i < iterations; i++) {
    const seven = shuffle(fullDeck(), rng).slice(0, 7);
    tally[categoryOf(evaluateBest(seven))]!++;
  }

  const share = (category: HandCategory): number => tally[category]! / iterations;

  assert.ok(share(HandCategory.Pair) > 0.38 && share(HandCategory.Pair) < 0.50, `pair share was ${share(HandCategory.Pair)}`);
  assert.ok(share(HandCategory.HighCard) > 0.12 && share(HandCategory.HighCard) < 0.23, `high-card share was ${share(HandCategory.HighCard)}`);
  assert.ok(share(HandCategory.TwoPair) > 0.18 && share(HandCategory.TwoPair) < 0.29, `two-pair share was ${share(HandCategory.TwoPair)}`);
  assert.ok(share(HandCategory.Quads) < 0.005, `quads share was ${share(HandCategory.Quads)}`);
  assert.ok(share(HandCategory.StraightFlush) < 0.001, `straight-flush share was ${share(HandCategory.StraightFlush)}`);

  // Every category except the rarest should show up at least once.
  for (const category of [HandCategory.Pair, HandCategory.TwoPair, HandCategory.Trips, HandCategory.Straight, HandCategory.Flush, HandCategory.FullHouse, HandCategory.Quads]) {
    assert.ok(tally[category]! > 0, `${CATEGORY_NAMES[category]} never appeared in ${iterations} hands`);
  }
});
