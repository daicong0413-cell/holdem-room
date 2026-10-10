import { test } from "node:test";
import assert from "node:assert/strict";

import { type Card, cardsFromString, fullDeck, type Rng, seededRng } from "./cards.ts";
import {
  type LegalActions,
  type PlayerAction,
  type TableState,
  applyAction,
  buildPots,
  createTable,
  isLegalAction,
  legalActions,
  seatPlayer,
  startHand,
  totalPot,
} from "./table.ts";

/** Overwrites the hole cards and the deck so a hand plays out deterministically. */
function stackDeck(table: TableState, board: string, holes: string[]): void {
  const hand = table.hand!;
  const boardCards = cardsFromString(board);
  const holeCards = holes.map((text) => cardsFromString(text));
  const used = new Set<Card>([...boardCards, ...holeCards.flat()]);

  holes.forEach((_, seat) => {
    table.seats[seat]!.hole = holeCards[seat]!;
  });
  hand.deck = [...boardCards, ...fullDeck().filter((card) => !used.has(card))];
  hand.board = [];
}

function tableWith(stacks: number[], blinds: { smallBlind: number; bigBlind: number } = { smallBlind: 1, bigBlind: 2 }): TableState {
  const table = createTable({ seats: stacks.length, ...blinds });
  stacks.forEach((stack, index) => {
    seatPlayer(table, index, { playerId: `p${index}`, name: `P${index}`, stack });
  });
  return table;
}

test("blinds are posted and action starts left of the big blind", () => {
  const table = tableWith([200, 200, 200, 200]);
  startHand(table, seededRng(1));

  assert.equal(table.buttonIndex, 0);
  assert.equal(table.seats[1]!.streetCommitted, 1, "small blind");
  assert.equal(table.seats[2]!.streetCommitted, 2, "big blind");
  assert.equal(table.hand!.currentBet, 2);
  assert.equal(table.hand!.minRaiseTo, 4);
  assert.equal(table.hand!.toActIndex, 3, "under the gun acts first preflop");
  assert.equal(table.seats.filter((seat) => seat.inHand).length, 4);
  assert.equal(table.seats[0]!.hole.length, 2);
});

test("heads-up: the button posts the small blind and acts first preflop", () => {
  const table = tableWith([100, 100]);
  startHand(table, seededRng(2));

  assert.equal(table.buttonIndex, 0);
  assert.equal(table.seats[0]!.streetCommitted, 1, "button is the small blind");
  assert.equal(table.seats[1]!.streetCommitted, 2);
  assert.equal(table.hand!.toActIndex, 0);

  applyAction(table, { type: "call" });
  applyAction(table, { type: "check" });
  assert.equal(table.hand!.street, "flop");
  assert.equal(table.hand!.toActIndex, 1, "the big blind acts first postflop heads-up");
});

test("the big blind keeps the option to raise after everyone limps", () => {
  const table = tableWith([100, 100, 100]);
  startHand(table, seededRng(3));
  assert.equal(table.hand!.toActIndex, 0);

  applyAction(table, { type: "call" });
  applyAction(table, { type: "call" });
  assert.equal(table.hand!.toActIndex, 2, "the big blind still has an option");

  applyAction(table, { type: "check" });
  assert.equal(table.hand!.street, "flop");
  assert.equal(table.hand!.toActIndex, 1, "the small blind acts first postflop");
  assert.equal(totalPot(table), 6);
});

test("a raise below the minimum is rejected", () => {
  const table = tableWith([100, 100, 100]);
  startHand(table, seededRng(4));
  assert.throws(() => applyAction(table, { type: "raise", to: 3 }), /at least 4/);
  assert.equal(table.seats[0]!.streetCommitted, 0, "a rejected action must not move chips");
});

test("checking while facing a bet is rejected", () => {
  const table = tableWith([100, 100, 100]);
  startHand(table, seededRng(5));
  assert.throws(() => applyAction(table, { type: "check" }), /cannot check/);
});

test("raising more than the stack is rejected", () => {
  const table = tableWith([100, 100, 100]);
  startHand(table, seededRng(6));
  assert.throws(() => applyAction(table, { type: "raise", to: 101 }), /cannot afford/);
});

test("a full raise reopens the action for everyone who already acted", () => {
  const table = tableWith([200, 200, 200]);
  startHand(table, seededRng(7));

  applyAction(table, { type: "raise", to: 6 }); // seat 0
  assert.equal(table.hand!.toActIndex, 1);
  applyAction(table, { type: "call" }); // seat 1
  assert.equal(table.hand!.toActIndex, 2);
  applyAction(table, { type: "raise", to: 10 }); // seat 2

  assert.equal(table.hand!.toActIndex, 0, "the original raiser must act again");
  assert.equal(table.seats[0]!.canRaiseThisStreet, true);
  assert.equal(table.hand!.minRaiseTo, 14, "the last full raise was four chips");
});

test("an all-in short raise does not reopen betting for players who already acted", () => {
  const table = tableWith([200, 200, 9]);
  startHand(table, seededRng(8));
  assert.equal(table.hand!.toActIndex, 0);

  applyAction(table, { type: "raise", to: 6 }); // seat 0
  applyAction(table, { type: "call" }); // seat 1
  assert.equal(table.hand!.toActIndex, 2);

  const shortStacked = legalActions(table)!;
  assert.equal(shortStacked.canRaise, false, "an all-in below the minimum is not a raise");
  assert.equal(shortStacked.canAllIn, true);
  applyAction(table, { type: "raise", to: 9 }); // seat 2, all-in for less than a full raise

  assert.equal(table.hand!.currentBet, 9);
  const facing = legalActions(table)!;
  assert.equal(facing.seatIndex, 0);
  assert.equal(facing.toCall, 3, "seat 0 is priced in for the difference");
  assert.equal(facing.canRaise, false, "but may not re-raise");
  assert.equal(facing.canCall, true);
  assert.throws(() => applyAction(table, { type: "raise", to: 13 }), /not reopened/);

  applyAction(table, { type: "call" }); // seat 0
  assert.equal(legalActions(table)!.seatIndex, 1);
  assert.equal(legalActions(table)!.canRaise, false, "seat 1 is equally barred");
  applyAction(table, { type: "call" }); // seat 1

  assert.equal(table.hand!.street, "flop");
  assert.equal(table.seats[2]!.allIn, true);
  assert.equal(totalPot(table), 27);
  assert.equal(table.hand!.board.length, 3);
});

test("an uncalled bet is returned and folding out wins without a showdown", () => {
  const table = tableWith([100, 100, 100]);
  startHand(table, seededRng(9));

  applyAction(table, { type: "raise", to: 6 }); // seat 0
  applyAction(table, { type: "fold" }); // seat 1
  applyAction(table, { type: "fold" }); // seat 2

  const result = table.hand!.result!;
  assert.equal(table.hand!.street, "complete");
  assert.equal(result.reason, "fold");
  assert.equal(result.showdown.length, 0, "no cards are shown when everyone folds");

  // Seat 0's extra four chips came back; it wins the one and two chip blinds.
  assert.equal(table.seats[0]!.stack, 103);
  assert.equal(table.seats[1]!.stack, 99);
  assert.equal(table.seats[2]!.stack, 98);
  assert.deepEqual(result.netChange, [3, -1, -2]);
  assert.equal(result.pots.reduce((sum, pot) => sum + pot.amount, 0), 5);
});

test("side pots form layers per commitment level", () => {
  const table = tableWith([100, 50, 20]);
  startHand(table, seededRng(10));
  stackDeck(table, "AhKsQd7c2c", ["AdAc", "9s9d", "JhTh"]);

  applyAction(table, { type: "raise", to: 100 }); // seat 0 all-in
  applyAction(table, { type: "call" }); // seat 1 all-in for 50
  applyAction(table, { type: "call" }); // seat 2 all-in for 20

  const result = table.hand!.result!;
  assert.equal(result.reason, "showdown");
  assert.equal(table.hand!.board.length, 5);

  // 100 uncalled chips go back, leaving 50 + 50 + 20 in the middle.
  assert.deepEqual(
    result.pots.map((pot) => ({ amount: pot.amount, eligible: pot.eligible })),
    [
      { amount: 60, eligible: [0, 1, 2] },
      { amount: 60, eligible: [0, 1] },
    ],
  );

  // Seat 2 makes broadway and takes the main pot; seat 1's nines win nothing.
  assert.deepEqual(result.awards, [
    { potIndex: 0, amount: 60, winners: [2] },
    { potIndex: 1, amount: 60, winners: [0] },
  ]);
  assert.equal(table.seats[0]!.stack, 110);
  assert.equal(table.seats[1]!.stack, 0);
  assert.equal(table.seats[2]!.stack, 60);
  assert.deepEqual(result.netChange, [10, -50, 40]);
});

test("a three-way chop sends the odd chip to the first winner clockwise from the button", () => {
  const table = tableWith([25, 25, 25, 25]);
  startHand(table, seededRng(11));
  assert.equal(table.buttonIndex, 0);
  stackDeck(table, "2c3d4h5s8c", ["KsQd", "KhQc", "KdQs", "JsTd"]);

  applyAction(table, { type: "raise", to: 25 }); // seat 3 (under the gun) all-in
  applyAction(table, { type: "call" }); // seat 0
  applyAction(table, { type: "call" }); // seat 1
  applyAction(table, { type: "call" }); // seat 2

  const result = table.hand!.result!;
  assert.equal(result.pots.length, 1);
  assert.equal(result.pots[0]!.amount, 100);
  assert.deepEqual(result.awards[0]!.winners, [0, 1, 2], "all three king-queens play the board");

  assert.equal(table.seats[0]!.stack, 34, "seat 0 is first from the button and takes the odd chip");
  assert.equal(table.seats[1]!.stack, 33);
  assert.equal(table.seats[2]!.stack, 33);
  assert.equal(table.seats[3]!.stack, 0);
  assert.deepEqual(result.netChange, [9, 8, 8, -25]);
});

test("buildPots isolates a folded player's chips without granting them equity", () => {
  const table = tableWith([100, 100, 100]);
  startHand(table, seededRng(12));
  table.seats[0]!.committed = 100;
  table.seats[1]!.committed = 100;
  table.seats[2]!.committed = 40;
  table.seats[2]!.folded = true;

  const pots = buildPots(table.seats);
  assert.equal(pots.reduce((sum, pot) => sum + pot.amount, 0), 240);
  assert.deepEqual(pots[0]!.eligible, [0, 1], "the folded seat cannot win anything");
});

test("a hand runs through all four streets and shows down", () => {
  const table = tableWith([100, 100, 100]);
  startHand(table, seededRng(13));

  applyAction(table, { type: "call" });
  applyAction(table, { type: "call" });
  applyAction(table, { type: "check" });
  assert.equal(table.hand!.street, "flop");

  for (const street of ["flop", "turn", "river"] as const) {
    assert.equal(table.hand!.street, street);
    applyAction(table, { type: "check" });
    applyAction(table, { type: "check" });
    applyAction(table, { type: "check" });
  }

  assert.equal(table.hand!.street, "complete");
  assert.equal(table.hand!.board.length, 5);
  assert.equal(table.hand!.result!.reason, "showdown");
  assert.equal(table.hand!.result!.showdown.length, 3);
  for (const entry of table.hand!.result!.showdown) assert.ok(entry.handName.length > 0);
});

test("an all-in before the flop still deals a full five-card board", () => {
  const table = tableWith([50, 50]);
  startHand(table, seededRng(14));
  applyAction(table, { type: "raise", to: 50 });
  applyAction(table, { type: "call" });

  assert.equal(table.hand!.street, "complete");
  assert.equal(table.hand!.board.length, 5);
  assert.equal(table.hand!.result!.reason, "showdown");
  assert.equal(table.seats[0]!.stack + table.seats[1]!.stack, 100);
});

test("actions are rejected once the hand is over", () => {
  const table = tableWith([100, 50]);
  startHand(table, seededRng(15));
  applyAction(table, { type: "fold" });
  assert.equal(table.hand!.street, "complete");
  assert.throws(() => applyAction(table, { type: "check" }), /already over/);
  assert.equal(legalActions(table), null);
});

test("starting a hand needs two funded players", () => {
  const table = createTable({ seats: 3, smallBlind: 1, bigBlind: 2 });
  seatPlayer(table, 0, { playerId: "p0", name: "P0", stack: 100 });
  assert.throws(() => startHand(table, seededRng(16)), /at least two funded players/);
});

test("isLegalAction agrees with legalActions", () => {
  const table = tableWith([100, 100, 100]);
  startHand(table, seededRng(17));
  const legal: LegalActions = legalActions(table)!;

  assert.equal(isLegalAction(table, { type: "fold" }), true);
  assert.equal(isLegalAction(table, { type: "check" }), false, "there is a bet to face");
  assert.equal(isLegalAction(table, { type: "call" }), true);
  assert.equal(isLegalAction(table, { type: "raise", to: 3 }), false, "below the minimum");
  assert.equal(isLegalAction(table, { type: "raise", to: 4 }), true);
  assert.equal(isLegalAction(table, { type: "raise", to: legal.maxRaiseTo + 1 }), false);
  assert.equal(isLegalAction(table, { type: "raise", to: legal.maxRaiseTo }), true, "all-in is always available");
});

/** A crude but legal bot, used to hammer the state machine. */
function autoPlay(table: TableState, rng: Rng, invariant: (table: TableState) => void): void {
  let guard = 0;
  while (table.hand && table.hand.street !== "complete") {
    if (guard++ > 400) throw new Error("hand failed to terminate");
    const legal = legalActions(table);
    if (!legal) break;

    const roll = rng();
    let action: PlayerAction;
    if (legal.canCheck) {
      action = roll < 0.3 && legal.canRaise ? { type: "raise", to: pickRaise(legal, rng) } : { type: "check" };
    } else if (roll < 0.18) {
      action = { type: "fold" };
    } else if (roll < 0.45 && legal.canRaise) {
      action = { type: "raise", to: pickRaise(legal, rng) };
    } else {
      action = { type: "call" };
    }

    applyAction(table, action);
    invariant(table);
  }
}

function pickRaise(legal: LegalActions, rng: Rng): number {
  if (legal.maxRaiseTo <= legal.minRaiseTo) return legal.maxRaiseTo;
  // Mostly a minimum raise, sometimes a big one, rarely a shove — otherwise the
  // fuzz bot busts everyone out within a handful of hands.
  const roll = rng();
  const factor = roll < 0.65 ? 1 : roll < 0.92 ? 2.5 : 6;
  const target = Math.round(legal.minRaiseTo * factor);
  return Math.min(legal.maxRaiseTo, Math.max(legal.minRaiseTo, target));
}

test("chips are conserved and no stack goes negative over 400 random hands", () => {
  const buyIn = 200;
  const table = tableWith([buyIn, buyIn, buyIn, buyIn, buyIn, buyIn]);
  let total = buyIn * table.seats.length;
  const rng = seededRng(4242);

  const invariant = (current: TableState): void => {
    const inPlay = current.seats.reduce((sum, seat) => sum + seat.stack + seat.committed, 0);
    assert.equal(inPlay, total, "chips appeared or vanished mid-hand");
    for (const seat of current.seats) {
      assert.ok(seat.stack >= 0, `seat ${seat.index} has a negative stack`);
      assert.ok(seat.committed >= 0, `seat ${seat.index} committed a negative amount`);
    }
  };

  for (let hand = 0; hand < 400; hand++) {
    // Busted players re-buy between hands so the fuzzer keeps exercising the
    // machine; the buy-in is added to the expected total.
    for (const seat of table.seats) {
      if (seat.stack === 0) {
        seat.stack = buyIn;
        total += buyIn;
      }
    }

    startHand(table, rng);
    autoPlay(table, rng, invariant);

    const settled = table.seats.reduce((sum, seat) => sum + seat.stack, 0);
    assert.equal(settled, total, `chips leaked on hand ${hand}`);
    const netChange = table.hand!.result!.netChange;
    assert.equal(
      netChange.reduce((sum, value) => sum + value, 0),
      0,
      `net results did not balance on hand ${hand}`,
    );
  }
});

test("every committed chip is either in a pot or back in a stack at showdown", () => {
  const table = tableWith([100, 100, 100]);
  const rng = seededRng(777);
  for (let hand = 0; hand < 60; hand++) {
    if (table.seats.filter((seat) => seat.stack > 0).length < 2) break;
    startHand(table, rng);
    autoPlay(table, rng, () => {});
    const result = table.hand!.result!;
    const awarded = result.awards.reduce((sum, award) => sum + award.amount, 0);
    const pots = result.pots.reduce((sum, pot) => sum + pot.amount, 0);
    assert.equal(awarded, pots, "every pot must be fully awarded");
  }
});
