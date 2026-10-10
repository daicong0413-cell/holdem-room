import { test } from "node:test";
import assert from "node:assert/strict";

import {
  displayCard,
  displayCards,
  displayRank,
  handNameZh,
  isRedSuit,
  rankLabel,
  streetLabelZh,
} from "./format.ts";

test("a ten is written as 10, never as T", () => {
  assert.equal(displayRank("T"), "10");
  assert.equal(displayRank("t"), "10");
  assert.equal(displayRank("A"), "A");
  assert.equal(displayRank("9"), "9");
  assert.equal(displayCard("Ts"), "10♠");
  assert.equal(displayCard("Th"), "10♥");
  assert.equal(displayCard("Td"), "10♦");
  assert.equal(displayCard("Tc"), "10♣");
});

test("every rank renders the way a player expects", () => {
  const expected = ["2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K", "A"];
  for (let index = 0; index < 13; index++) {
    assert.equal(rankLabel(index), expected[index], `rank index ${index}`);
    assert.equal(displayRank("23456789TJQKA"[index]!), expected[index]);
  }
});

test("cards render with a real suit symbol", () => {
  assert.equal(displayCards(["As", "Kh", "Qd", "Jc"]), "A♠ K♥ Q♦ J♣");
  assert.equal(displayCards(["As", "Kh"], ""), "A♠K♥");
  assert.equal(displayCard("??"), "??", "unknown input passes through");
});

test("the colour of a card follows its suit", () => {
  assert.equal(isRedSuit("Ah"), true);
  assert.equal(isRedSuit("Ad"), true);
  assert.equal(isRedSuit("As"), false);
  assert.equal(isRedSuit("Ac"), false);
});

test("hand names are Chinese and never leak a bare T", () => {
  assert.equal(handNameZh(1, [12, 0, 0, 0, 0]), "一对 A");
  assert.equal(handNameZh(1, [8, 0, 0, 0, 0]), "一对 10");
  assert.equal(handNameZh(0, [12, 0, 0, 0, 0]), "A 高牌");
  assert.equal(handNameZh(2, [9, 2, 11, 0, 0]), "J 和 4 两对");
  assert.equal(handNameZh(3, [10, 0, 0, 0, 0]), "三条 Q");
  assert.equal(handNameZh(4, [12, 0, 0, 0, 0]), "A 高顺子");
  assert.equal(handNameZh(4, [8, 0, 0, 0, 0]), "10 高顺子");
  assert.equal(handNameZh(5, [7, 0, 0, 0, 0]), "9 高同花");
  assert.equal(handNameZh(6, [11, 0, 0, 0, 0]), "K 满 2 葫芦");
  assert.equal(handNameZh(7, [12, 0, 0, 0, 0]), "四条 A");
  assert.equal(handNameZh(8, [12, 0, 0, 0, 0]), "皇家同花顺");
  assert.equal(handNameZh(8, [7, 0, 0, 0, 0]), "9 高同花顺");
});

test("no category can produce a stray T at any rank", () => {
  for (let category = 0; category <= 8; category++) {
    for (let rank = 0; rank < 13; rank++) {
      const name = handNameZh(category, [rank, rank, 0, 0, 0]);
      assert.equal(name.includes("T"), false, `category ${category} rank ${rank} produced "${name}"`);
    }
  }
});

test("streets have Chinese labels", () => {
  assert.equal(streetLabelZh("preflop"), "翻前");
  assert.equal(streetLabelZh("flop"), "翻牌");
  assert.equal(streetLabelZh("turn"), "转牌");
  assert.equal(streetLabelZh("river"), "河牌");
  assert.equal(streetLabelZh("weird"), "weird");
});
