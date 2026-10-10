import { test } from "node:test";
import assert from "node:assert/strict";

import {
  type Card,
  cardFromString,
  cardToString,
  cardsFromString,
  cardsToString,
  DECK_SIZE,
  fullDeck,
  makeCard,
  rankOf,
  seededRng,
  shuffle,
  suitOf,
} from "./cards.ts";

test("card encoding round-trips rank and suit", () => {
  for (let rank = 0; rank < 13; rank++) {
    for (let suit = 0; suit < 4; suit++) {
      const card = makeCard(rank, suit);
      assert.equal(rankOf(card), rank);
      assert.equal(suitOf(card), suit);
      assert.ok(card >= 0 && card < DECK_SIZE);
    }
  }
});

test("makeCard rejects out-of-range ranks and suits", () => {
  assert.throws(() => makeCard(13, 0), RangeError);
  assert.throws(() => makeCard(-1, 0), RangeError);
  assert.throws(() => makeCard(0, 4), RangeError);
  assert.throws(() => makeCard(1.5, 0), RangeError);
});

test("card strings round-trip, including case insensitivity", () => {
  assert.equal(cardToString(cardFromString("As")), "As");
  assert.equal(cardToString(cardFromString("as")), "As");
  assert.equal(cardToString(cardFromString("TD")), "Td");
  assert.equal(rankOf(cardFromString("As")), 12);
  assert.equal(suitOf(cardFromString("As")), 0);
  assert.equal(rankOf(cardFromString("2c")), 0);
  assert.equal(cardsToString(cardsFromString("AsKd")), "AsKd");
});

test("card parsing accepts separators and rejects malformed input", () => {
  assert.equal(cardsFromString("As Kd").length, 2);
  assert.equal(cardsFromString("As,Kd,Qh").length, 3);
  assert.throws(() => cardFromString("A"), /2 characters/);
  assert.throws(() => cardFromString("Xs"), /unknown rank/);
  assert.throws(() => cardFromString("Ax"), /unknown suit/);
  assert.throws(() => cardsFromString("AsK"), /odd card string/);
});

test("the deck holds 52 distinct cards", () => {
  const deck = fullDeck();
  assert.equal(deck.length, DECK_SIZE);
  assert.equal(new Set(deck).size, DECK_SIZE);
  deck.sort((a, b) => a - b);
  for (let i = 0; i < DECK_SIZE; i++) assert.equal(deck[i], i);
});

test("shuffle is a permutation and leaves the input untouched", () => {
  const deck = fullDeck();
  const before = deck.slice();
  const shuffled = shuffle(deck, seededRng(42));
  assert.deepEqual(deck, before, "input deck must not be mutated");
  assert.equal(shuffled.length, DECK_SIZE);
  assert.deepEqual(shuffled.slice().sort((a, b) => a - b), before);
});

test("a seeded shuffle is reproducible and unseeded shuffles differ", () => {
  const a = shuffle(fullDeck(), seededRng(7));
  const b = shuffle(fullDeck(), seededRng(7));
  assert.deepEqual(a, b);

  const c = shuffle(fullDeck(), seededRng(8));
  assert.notDeepEqual(a, c);
});

test("seededRng produces values in [0, 1)", () => {
  const rng = seededRng(123);
  for (let i = 0; i < 1000; i++) {
    const value = rng();
    assert.ok(value >= 0 && value < 1, `out of range: ${value}`);
  }
});

test("shuffle can place every card anywhere (no positional bias)", () => {
  const rng = seededRng(99);
  const seenFirst = new Set<Card>();
  for (let i = 0; i < 3000; i++) seenFirst.add(shuffle(fullDeck(), rng)[0]!);
  assert.equal(seenFirst.size, DECK_SIZE, "every card should reach position 0 over enough shuffles");
});
