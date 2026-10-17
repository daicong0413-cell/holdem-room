import { test } from "node:test";
import assert from "node:assert/strict";
import { cardsFromString, seededRng } from "../engine/cards.ts";
import { HandCategory } from "../engine/hand.ts";
import { createTable, seatPlayer, startHand } from "../engine/table.ts";
import { handLabelEn } from "../shared/format.ts";
import { DEFAULT_SETTINGS } from "./protocol.ts";
import { buildTableView, type ViewOptions } from "./view.ts";

function fixture() {
  const table = createTable();
  seatPlayer(table, 0, { playerId: "hero", name: "Hero", stack: 200 });
  seatPlayer(table, 1, { playerId: "other", name: "Other", stack: 200 });
  startHand(table, seededRng(1));
  const options: ViewOptions = {
    roomCode: "TEST", viewerSeat: 0, isBotAt: () => false, personaAt: () => null,
    settings: { ...DEFAULT_SETTINGS, level: 1, handsUntilNextLevel: null },
  };
  return { table, options, hero: table.seats[0]!, view: () => buildTableView(table, options) };
}

test("the hero's best hand upgrades with the flop, turn and river", () => {
  const { table, hero, view } = fixture();
  hero.hole = cardsFromString("9sAc");
  table.hand!.board = cardsFromString("9d2c3h");
  assert.equal(handLabelEn(view().seats[0]!.handCategory!), "Pair");
  table.hand!.board.push(...cardsFromString("9h"));
  assert.equal(handLabelEn(view().seats[0]!.handCategory!), "Triple");
  table.hand!.board.push(...cardsFromString("Ad"));
  assert.equal(handLabelEn(view().seats[0]!.handCategory!), "Full house");
});

test("the hand badge considers the board and distinguishes a preflop pocket pair", () => {
  const { table, hero, view } = fixture();
  hero.hole = cardsFromString("AsAh");
  assert.equal(view().seats[0]!.handCategory, HandCategory.Pair);
  hero.hole = cardsFromString("AsKd");
  assert.equal(view().seats[0]!.handCategory, HandCategory.HighCard);
  table.hand!.board = cardsFromString("2s2h9c");
  assert.equal(view().seats[0]!.handCategory, HandCategory.Pair);
});

test("opponents and spectators never receive private hand categories", () => {
  const { table, options, view } = fixture();
  table.hand!.board = cardsFromString("9d2c3h");
  assert.equal(view().seats[1]!.handCategory, null);
  const spectator = buildTableView(table, { ...options, viewerSeat: null });
  assert.ok(spectator.seats.every((seat) => seat.handCategory === null));
});
