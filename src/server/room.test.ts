import { test } from "node:test";
import assert from "node:assert/strict";

import { seededRng } from "../engine/cards.ts";
import { type PlayerAction, legalActions } from "../engine/table.ts";
import { makeBotDecider, PERSONAS } from "./bots.ts";
import { DEFAULT_SETTINGS, SETTINGS_BOUNDS } from "./protocol.ts";
import { type BotContext, type RoomTimers, Room } from "./room.ts";

/** Collects scheduled callbacks so the room can be driven synchronously. */
interface Harness {
  readonly room: Room;
  /** Runs every short (bot) callback until the room settles. */
  drain(): Promise<void>;
  /** Fires the outstanding long-delay callback: the human action clock. */
  fireActionTimeout(): Promise<void>;
  /** Fires the timer armed with exactly this delay (used for auto-start). */
  fireTimer(delayMs: number): Promise<void>;
  /** How many long-delay callbacks are armed (0 or 1). */
  armedActionTimers(): number;
}

/** Bot delays in tests are 0; the action clock is always much larger. */
const BOT_DELAY_CEILING = 1000;

function makeRoom(options: { seats?: number; actionTimeoutMs?: number; autoStartSeconds?: number; tournament?: boolean } = {}): Harness {
  const scheduled = new Map<number, { fn: () => void; delayMs: number }>();
  let nextHandle = 1;
  let clock = 1_000;

  const timers: RoomTimers = {
    set: (fn, delayMs) => {
      const handle = nextHandle++;
      scheduled.set(handle, { fn, delayMs });
      return handle;
    },
    clear: (handle) => {
      scheduled.delete(handle);
    },
    now: () => clock,
  };

  const room = new Room({
    code: "TEST",
    settings: {
      seats: options.seats ?? 4,
      actionTimeoutMs: options.actionTimeoutMs ?? 0,
      // Off by default so each test drives the clock it cares about.
      autoStartSeconds: options.autoStartSeconds ?? 0,
      ...(options.tournament === true ? { mode: "tournament" as const, startingStack: 400 } : {}),
    },
    personas: PERSONAS.map((persona) => ({ id: persona.id, name: persona.name })),
    botDecider: makeBotDecider(PERSONAS[0]!, seededRng(5)),
    botDelay: () => 0,
    timers,
    rng: seededRng(1234),
  });

  const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
  const longTimers = (): Array<[number, { fn: () => void; delayMs: number }]> =>
    [...scheduled.entries()].filter(([, entry]) => entry.delayMs > BOT_DELAY_CEILING);

  return {
    room,
    armedActionTimers: () => longTimers().length,
    async drain(): Promise<void> {
      for (let guard = 0; guard < 500; guard++) {
        const due = [...scheduled.entries()].filter(([, entry]) => entry.delayMs <= BOT_DELAY_CEILING);
        if (due.length === 0) return;
        for (const [handle, entry] of due) {
          scheduled.delete(handle);
          entry.fn();
        }
        await tick();
      }
      throw new Error("room never settled");
    },
    async fireActionTimeout(): Promise<void> {
      const entry = longTimers()[0];
      if (!entry) throw new Error("no action clock is armed");
      scheduled.delete(entry[0]);
      clock += entry[1].delayMs;
      entry[1].fn();
      await tick();
    },
    async fireTimer(delayMs: number): Promise<void> {
      const entry = [...scheduled.entries()].find(([, candidate]) => candidate.delayMs === delayMs);
      if (!entry) throw new Error(`no timer armed with a ${delayMs}ms delay`);
      scheduled.delete(entry[0]);
      clock += entry[1].delayMs;
      entry[1].fn();
      await tick();
    },
  };
}

/** Plays out a live hand, letting humans check/call and bots use their brain. */
async function playOut(harness: Harness): Promise<void> {
  for (let guard = 0; guard < 500; guard++) {
    const hand = harness.room.table.hand;
    if (!hand || hand.street === "complete" || hand.toActIndex === null) return;
    const member = harness.room.memberAtSeat(hand.toActIndex);
    if (!member) return;

    if (member.isBot) {
      await harness.drain();
      continue;
    }
    const legal = legalActions(harness.room.table)!;
    const action: PlayerAction = legal.canCheck ? { type: "check" } : { type: "call" };
    harness.room.act(member.playerId, action);
  }
  throw new Error("hand never finished");
}

test("a token resumes the same member and seat", () => {
  const { room } = makeRoom();
  const alice = room.join("Alice");
  room.sit(alice, 0);

  const resumed = room.join("Alice", alice.token);
  assert.equal(resumed.playerId, alice.playerId);
  assert.equal(resumed.seat, 0);
  assert.equal(room.memberAtSeat(0)?.playerId, alice.playerId);

  const stranger = room.join("Mallory");
  assert.notEqual(stranger.playerId, alice.playerId);
  assert.equal(stranger.seat, null);
  assert.equal(room.memberAtSeat(0)?.playerId, alice.playerId, "a second join must not steal the seat");
});

test("seats must be free and buy-ins within range", () => {
  const { room } = makeRoom();
  const alice = room.join("Alice");
  const bob = room.join("Bob");
  room.sit(alice, 0);
  assert.throws(() => room.sit(bob, 0), /已经被占用/);
  assert.throws(() => room.sit(bob, 99), /没有 99 号座位/);
  assert.throws(() => room.sit(bob, 1, 1), /买入必须/);
  assert.throws(() => room.sit(bob, 1, SETTINGS_BOUNDS.startingStack.max + 1), /买入必须/);
  assert.equal(room.table.seats[0]!.stack, DEFAULT_SETTINGS.startingStack, "the default buy-in comes from the settings");
});

test("a client cannot act out of turn", () => {
  const { room } = makeRoom();
  const alice = room.join("Alice");
  const bob = room.join("Bob");
  room.sit(alice, 0);
  room.sit(bob, 1);
  room.startHand();

  const toAct = room.table.hand!.toActIndex!;
  const waiting = room.memberAtSeat(toAct === 0 ? 1 : 0)!;
  assert.throws(() => room.act(waiting.playerId, { type: "check" }), /还没轮到你/);

  const acting = room.memberAtSeat(toAct)!;
  const legal = legalActions(room.table)!;
  room.act(acting.playerId, legal.canCheck ? { type: "check" } : { type: "call" });
  assert.ok(room.table.hand!.street !== "complete" || room.table.hand!.result !== null);
});

test("hole cards are hidden from opponents until showdown", async () => {
  const harness = makeRoom();
  const { room } = harness;
  const alice = room.join("Alice");
  const bob = room.join("Bob");
  room.sit(alice, 0);
  room.sit(bob, 1);
  room.startHand();

  const aliceView = room.viewFor(alice);
  const bobView = room.viewFor(bob);

  assert.equal(aliceView.seats[0]!.hole?.length, 2, "you always see your own cards");
  assert.equal(bobView.seats[1]!.hole?.length, 2);
  assert.equal(aliceView.seats[1]!.hole, null, "an opponent's cards must be withheld");
  assert.equal(bobView.seats[0]!.hole, null);
  assert.equal(aliceView.seats[1]!.holeCount, 2, "the count is public, the cards are not");

  await playOut(harness);

  const settled = room.viewFor(alice);
  assert.equal(settled.street, "complete");
  if (settled.result?.reason === "showdown") {
    assert.equal(settled.seats[1]!.hole?.length, 2, "cards are revealed at showdown");
  }
});

test("a spectator sees no hole cards at all", async () => {
  const harness = makeRoom();
  const { room } = harness;
  const alice = room.join("Alice");
  const bob = room.join("Bob");
  const watcher = room.join("Watcher");
  room.sit(alice, 0);
  room.sit(bob, 1);
  room.startHand();

  const view = room.viewFor(watcher);
  for (const seat of view.seats) {
    if (seat.holeCount > 0) assert.equal(seat.hole, null, "spectators never see hole cards");
  }
  assert.equal(view.legal, null, "a spectator has no actions");
});

test("a bot is given a filtered context with no access to other hole cards", () => {
  const { room } = makeRoom();
  const alice = room.join("Alice");
  room.sit(alice, 0);
  room.addBot(1, "gto");
  room.startHand();

  const botSeat = room.table.hand!.toActIndex!;
  const isBotTurn = room.isBotSeat(botSeat);
  const probeSeat = isBotTurn ? botSeat : 0;
  if (room.isBotSeat(probeSeat)) {
    const context: BotContext = room.buildBotContext(probeSeat);
    assert.equal(context.hole.length, 2, "the bot knows its own cards");
    for (const opponent of context.opponents) {
      assert.equal("hole" in opponent, false, "opponents must not carry hole cards");
    }
    for (const event of context.history) {
      assert.notEqual(event.type, "showdown", "a live hand has no showdown in its history");
    }
  }
});

test("bots play their own turns and hands reach a result", async () => {
  const harness = makeRoom();
  const { room } = harness;
  const alice = room.join("Alice");
  room.sit(alice, 0);
  room.addBot(1, "lag");
  room.addBot(2, "rock");

  for (let hand = 0; hand < 12; hand++) {
    if (!room.canStartHand()) break;
    room.startHand();
    await playOut(harness);

    const result = room.table.hand!.result;
    assert.ok(result, `hand ${hand} produced no result`);
    assert.equal(
      result.netChange.reduce((sum, value) => sum + value, 0),
      0,
      `hand ${hand} did not balance`,
    );
    assert.equal(room.lastBotFailure(), null, `bot failed: ${room.lastBotFailure()}`);
  }
});

test("a second hand cannot start while one is live", () => {
  const { room } = makeRoom();
  const alice = room.join("Alice");
  const bob = room.join("Bob");
  room.sit(alice, 0);
  room.sit(bob, 1);
  room.startHand();
  assert.throws(() => room.startHand(), /已经有一手牌/);
  assert.equal(room.canStartHand(), false);
});

test("standing during a live hand only takes effect afterwards", () => {
  const { room } = makeRoom();
  const alice = room.join("Alice");
  const bob = room.join("Bob");
  room.sit(alice, 0);
  room.sit(bob, 1);
  room.startHand();

  const seatIndex = alice.seat!;
  room.stand(alice);
  assert.equal(alice.seat, seatIndex, "still seated for the current hand");
  assert.equal(room.table.seats[seatIndex]!.sittingOut, true);
  assert.equal(room.table.seats[seatIndex]!.playerId, alice.playerId);
});

test("only funded seats are dealt in", () => {
  const { room } = makeRoom();
  const alice = room.join("Alice");
  const bob = room.join("Bob");
  const carol = room.join("Carol");
  room.sit(alice, 0);
  room.sit(bob, 1);
  room.sit(carol, 2);
  room.table.seats[2]!.stack = 0;

  room.startHand();
  assert.equal(room.table.seats[2]!.inHand, false, "a broke player is not dealt in");
  assert.equal(room.table.seats[2]!.hole.length, 0);
});

test("every persona is a complete, distinct configuration", () => {
  const ids = new Set<string>();
  for (const persona of PERSONAS) {
    assert.equal(ids.has(persona.id), false, `duplicate persona id ${persona.id}`);
    ids.add(persona.id);
    for (const key of ["tightness", "aggression", "bluff", "iterations", "callThreshold"] as const) {
      const value = persona[key];
      assert.ok(Number.isFinite(value), `${persona.id}.${key} must be a number`);
    }
    assert.ok(persona.iterations >= 500, `${persona.id} needs enough trials to be stable`);
  }
  assert.ok(ids.has("gto") && ids.has("lag"), "the two archetypes the brief asked for must exist");
});

// ----------------------------------------------------------- the action clock

test("a silent player is folded when their clock runs out", async () => {
  const harness = makeRoom({ actionTimeoutMs: 30_000 });
  const { room } = harness;
  const alice = room.join("Alice");
  const bob = room.join("Bob");
  room.sit(alice, 0);
  room.sit(bob, 1);
  room.startHand();

  assert.equal(room.table.hand!.toActIndex, 0);
  assert.equal(harness.armedActionTimers(), 1, "a human on turn must be on the clock");
  assert.notEqual(room.viewFor(alice).actionDeadlineMs, null, "the client has to know the deadline");

  await harness.fireActionTimeout();

  assert.equal(room.table.seats[0]!.folded, true, "someone who never acts is folded");
  assert.equal(room.table.hand!.street, "complete", "the table must not wait forever");
  assert.equal(room.viewFor(alice).actionDeadlineMs, null, "the clock is disarmed once the hand ends");
  assert.equal(harness.armedActionTimers(), 0);
});

test("checking is preferred to folding when the clock runs out", async () => {
  const harness = makeRoom({ actionTimeoutMs: 30_000 });
  const { room } = harness;
  const alice = room.join("Alice");
  const bob = room.join("Bob");
  room.sit(alice, 0);
  room.sit(bob, 1);
  room.startHand();

  room.act(alice.playerId, { type: "call" });
  room.act(bob.playerId, { type: "check" });
  assert.equal(room.table.hand!.street, "flop");
  assert.equal(room.table.hand!.toActIndex, 1, "heads-up the big blind acts first postflop");

  await harness.fireActionTimeout();

  assert.equal(room.table.seats[1]!.folded, false, "checking is free, so a timeout should never fold here");
  assert.equal(room.table.seats[1]!.hasActedThisStreet, true, "the seat still acted");
});

test("bots are never put on the human clock", async () => {
  const harness = makeRoom({ actionTimeoutMs: 30_000 });
  const { room } = harness;
  const alice = room.join("Alice");
  room.sit(alice, 0);
  room.addBot(1, "gto");
  room.startHand();

  assert.equal(room.table.hand!.toActIndex, 0);
  assert.equal(harness.armedActionTimers(), 1);

  room.act(alice.playerId, { type: "call" });
  assert.equal(room.table.hand!.toActIndex, 1, "it is the bot's turn now");
  assert.equal(harness.armedActionTimers(), 0, "the bot runs on its own schedule");
  assert.equal(room.viewFor(alice).actionDeadlineMs, null);

  await harness.drain();
});

test("no clock is armed when the feature is switched off", () => {
  const harness = makeRoom();
  const { room } = harness;
  const alice = room.join("Alice");
  const bob = room.join("Bob");
  room.sit(alice, 0);
  room.sit(bob, 1);
  room.startHand();

  assert.equal(room.table.hand!.toActIndex, 0);
  assert.equal(harness.armedActionTimers(), 0);
  assert.equal(room.viewFor(alice).actionDeadlineMs, null);
});

// ------------------------------------------------------------- room settings

test("only the host may change the settings", () => {
  const { room } = makeRoom();
  const alice = room.join("Alice");
  const bob = room.join("Bob");
  assert.equal(room.isHost(alice.playerId), true, "the first human in owns the room");
  assert.equal(room.isHost(bob.playerId), false);

  assert.throws(() => room.configure(bob.playerId, { bigBlind: 4 }), /只有房主/);
  room.configure(alice.playerId, { bigBlind: 4 });
  assert.equal(room.table.bigBlind, 4);
  assert.equal(room.viewFor(alice).isHost, true);
  assert.equal(room.viewFor(bob).isHost, false);
});

test("blinds and the starting stack reach the table and the view", () => {
  const { room } = makeRoom();
  const alice = room.join("Alice");
  room.configure(alice.playerId, { smallBlind: 5, bigBlind: 10, startingStack: 1000 });

  const settings = room.viewFor(alice).settings;
  assert.equal(settings.smallBlind, 5);
  assert.equal(settings.bigBlind, 10);
  assert.equal(settings.startingStack, 1000);
  assert.equal(settings.mode, "cash");
  assert.equal(settings.level, 1);
  assert.equal(settings.handsUntilNextLevel, null, "a cash game has no blind levels");

  room.sit(alice, 0);
  assert.equal(room.table.seats[0]!.stack, 1000, "a new seat gets the configured stack");
  assert.equal(room.table.smallBlind, 5);
});

test("nonsense settings are refused with a readable reason", () => {
  const { room } = makeRoom();
  const alice = room.join("Alice");

  assert.throws(() => room.configure(alice.playerId, { smallBlind: 5, bigBlind: 5 }), /大盲必须大于小盲/);
  assert.throws(() => room.configure(alice.playerId, { seats: 99 }), /座位数 必须在/);
  assert.throws(() => room.configure(alice.playerId, { smallBlind: 0 }), /小盲 必须在/);
  assert.throws(() => room.configure(alice.playerId, { startingStack: 10, smallBlind: 5, bigBlind: 20 }), /起始筹码/);
  assert.throws(() => room.configure(alice.playerId, { actionTimeoutMs: -5 }), /行动限时 必须在/);

  assert.equal(room.table.bigBlind, 2, "a refused change leaves the table untouched");
});

test("the seat count can only change while the table is empty", () => {
  const { room } = makeRoom();
  const alice = room.join("Alice");
  room.configure(alice.playerId, { seats: 8 });
  assert.equal(room.table.seats.length, 8);

  room.sit(alice, 0);
  assert.throws(() => room.configure(alice.playerId, { seats: 4 }), /有人入座时不能修改座位数/);
  assert.equal(room.table.seats.length, 8);

  room.stand(alice);
  room.configure(alice.playerId, { seats: 4 });
  assert.equal(room.table.seats.length, 4);
});

test("mode is locked once the first hand is dealt", async () => {
  const harness = makeRoom();
  const { room } = harness;
  const alice = room.join("Alice");
  room.sit(alice, 0);
  room.addBot(1, "gto");
  room.startHand();

  assert.throws(() => room.configure(alice.playerId, { mode: "tournament" }), /不能切换模式/);
  assert.throws(() => room.configure(alice.playerId, { blindLevelHands: 3 }), /不能修改升盲设置/);
  // Blinds stay adjustable between hands even mid-game.
  await playOut(harness);
  room.configure(alice.playerId, { smallBlind: 2, bigBlind: 4 });
  assert.equal(room.table.bigBlind, 4);

  // The starting stack is only a default now — players pick their own buy-in,
  // so changing it mid-game cannot take chips off anybody.
  const stackBefore = room.table.seats[0]!.stack;
  room.configure(alice.playerId, { startingStack: 999 });
  assert.equal(room.viewFor(alice).settings.startingStack, 999);
  assert.equal(room.table.seats[0]!.stack, stackBefore, "Alice keeps the chips she already has");
});

test("a cash game never moves the blinds", async () => {
  const harness = makeRoom();
  const { room } = harness;
  const alice = room.join("Alice");
  room.sit(alice, 0);
  room.addBot(1, "gto");
  room.configure(alice.playerId, { smallBlind: 1, bigBlind: 2 });

  for (let hand = 0; hand < 4; hand++) {
    if (!room.canStartHand()) break;
    room.startHand();
    await playOut(harness);
  }
  assert.equal(room.table.smallBlind, 1);
  assert.equal(room.table.bigBlind, 2);
  assert.equal(room.currentSettings().level, 1);
});

test("a tournament raises the blinds on schedule and says so in the view", async () => {
  const harness = makeRoom();
  const { room } = harness;
  const alice = room.join("Alice");
  room.configure(alice.playerId, {
    mode: "tournament",
    smallBlind: 10,
    bigBlind: 20,
    startingStack: 1000,
    blindLevelHands: 2,
    blindGrowth: 2,
  });
  room.sit(alice, 0);
  room.addBot(1, "gto");

  // Hands 1 and 2 are level 1.
  for (let hand = 0; hand < 2; hand++) {
    room.startHand();
    assert.equal(room.currentSettings().level, 1, `hand ${hand + 1} should still be level 1`);
    assert.equal(room.table.smallBlind, 10);
    await playOut(harness);
  }

  const beforeLevelUp = room.viewFor(alice).settings;
  assert.equal(beforeLevelUp.handsUntilNextLevel, 0, "the next hand triggers the increase");
  assert.equal(beforeLevelUp.mode, "tournament");

  // Hand 3 escalates: 10/20 -> 20/40.
  room.startHand();
  assert.equal(room.currentSettings().level, 2);
  assert.equal(room.table.smallBlind, 20);
  assert.equal(room.table.bigBlind, 40);
  assert.equal(room.viewFor(alice).settings.handsUntilNextLevel, 1);
});

test("switching back to cash mode resets the blind level", () => {
  const { room } = makeRoom();
  const alice = room.join("Alice");
  room.configure(alice.playerId, { mode: "tournament", smallBlind: 10, bigBlind: 20, startingStack: 1000 });
  assert.equal(room.currentSettings().level, 1);
  room.configure(alice.playerId, { mode: "cash", smallBlind: 1, bigBlind: 2 });
  assert.equal(room.currentSettings().level, 1);
  assert.equal(room.currentSettings().handsUntilNextLevel, null);
  assert.equal(room.table.bigBlind, 2);
});

test("completed hands are archived and can be fetched by id", async () => {
  const harness = makeRoom();
  const { room } = harness;
  const alice = room.join("Alice");
  room.sit(alice, 0);
  room.addBot(1, "gto");
  room.startHand();
  await playOut(harness);

  const summaries = room.historySummaries();
  assert.equal(summaries.length, 1, "exactly one hand should be on file");
  assert.equal(summaries[0]!.handId, 1);
  assert.ok(summaries[0]!.potTotal > 0, "the pot should be recorded");
  assert.ok(summaries[0]!.smallBlind === 1 && summaries[0]!.bigBlind === 2);
  assert.equal(summaries[0]!.board.length, 5, "the full board is archived");

  const entry = room.historyEntry(1);
  assert.ok(entry);
  assert.equal(entry.handId, 1);
  assert.ok(entry.seats.length >= 2);
  assert.ok(entry.log.length > 0, "the action log is archived with the hand");
  assert.equal(room.historyEntry(999), null, "an unknown hand id yields nothing");

  // The same hand must not be filed twice, however many state changes follow.
  room.broadcast();
  assert.equal(room.historySummaries().length, 1);
});

test("archived hands never contain a folded player's cards", async () => {
  const harness = makeRoom({ seats: 4 });
  const { room } = harness;
  const alice = room.join("Alice");
  room.sit(alice, 0);
  room.addBot(1, "lag");
  room.addBot(2, "rock");
  room.addBot(3, "gto");

  let handsPlayed = 0;
  for (let hand = 0; hand < 5; hand++) {
    if (!room.canStartHand()) break;
    room.startHand();
    await playOut(harness);
    handsPlayed++;
  }

  const entries = room.historySummaries().map((summary) => room.historyEntry(summary.handId)!);
  assert.equal(entries.length, handsPlayed, "every played hand is on file exactly once");

  let sawFold = false;
  for (const entry of entries) {
    for (const seat of entry.seats) {
      if (seat.folded) {
        sawFold = true;
        assert.equal(seat.hole, null, `${seat.name} 弃牌后的底牌不应该入库`);
      }
    }
    // Anything that was shown down must be recorded, otherwise the archive is lying.
    const total = entry.seats.reduce((sum, seat) => sum + seat.net, 0);
    assert.equal(total, 0, "each archived hand must balance");
  }
  assert.equal(sawFold, true, "no hand had a fold, so this test proved nothing");
});

// ------------------------------------------------------------ quality of life

test("the next hand is dealt automatically when the interval is set", async () => {
  const harness = makeRoom({ autoStartSeconds: 2 });
  const { room } = harness;
  const alice = room.join("Alice");
  room.sit(alice, 0);
  room.addBot(1, "gto");

  room.startHand();
  assert.equal(room.viewFor(alice).nextHandAtMs, null, "nothing is scheduled while a hand is live");

  await playOut(harness);
  assert.notEqual(room.viewFor(alice).nextHandAtMs, null, "the next hand should be on a timer");

  await harness.fireTimer(2000);
  assert.equal(room.table.handId, 2, "the next hand was dealt without anybody clicking");
});

test("auto-start stays off when the interval is zero", async () => {
  const harness = makeRoom({ autoStartSeconds: 0 });
  const { room } = harness;
  const alice = room.join("Alice");
  room.sit(alice, 0);
  room.addBot(1, "gto");

  room.startHand();
  await playOut(harness);

  assert.equal(room.viewFor(alice).nextHandAtMs, null);
  assert.equal(room.table.handId, 1, "nothing starts on its own");
});

test("starting a hand by hand cancels the pending auto-start", async () => {
  const harness = makeRoom({ autoStartSeconds: 5 });
  const { room } = harness;
  const alice = room.join("Alice");
  room.sit(alice, 0);
  room.addBot(1, "gto");

  room.startHand();
  await playOut(harness);
  room.startHand();

  assert.equal(room.viewFor(alice).nextHandAtMs, null, "the countdown is cleared once a hand is dealt");
  assert.equal(harness.armedActionTimers(), 0, "and no stale timer is left armed");
});

test("a busted bot buys back in during a cash game", async () => {
  const harness = makeRoom({ autoStartSeconds: 0 });
  const { room } = harness;
  const alice = room.join("Alice");
  room.sit(alice, 0);
  room.addBot(1, "gto");
  room.startHand();
  await playOut(harness);

  // Bust the bot, then let the next state change run the top-up.
  room.table.seats[1]!.stack = 0;
  room.configure(alice.playerId, { autoStartSeconds: 0 });
  assert.equal(room.table.seats[1]!.stack, 200, "a cash game never runs out of opponents");
});

test("a tournament eliminates busted bots instead of topping them up", async () => {
  const harness = makeRoom({ autoStartSeconds: 0, tournament: true });
  const { room } = harness;
  const alice = room.join("Alice");
  room.sit(alice, 0);
  room.addBot(1, "gto");
  room.startHand();
  await playOut(harness);

  room.table.seats[1]!.stack = 0;
  room.configure(alice.playerId, { autoStartSeconds: 0 });
  assert.equal(room.table.seats[1]!.stack, 0, "going broke is how a tournament eliminates you");
});

test("a player who ran out of chips can buy back in between hands", async () => {
  const harness = makeRoom({ autoStartSeconds: 0 });
  const { room } = harness;
  const alice = room.join("Alice");
  room.sit(alice, 0);
  room.addBot(1, "gto");

  room.startHand();
  assert.throws(() => room.rebuy(alice), /牌局进行中/);
  await playOut(harness);

  room.table.seats[0]!.stack = 0;
  room.rebuy(alice);
  assert.equal(room.table.seats[0]!.stack, 200);
  assert.throws(() => room.rebuy(alice), /筹码还没用完/);
});

test("a tournament refuses re-buys outright", async () => {
  const harness = makeRoom({ autoStartSeconds: 0, tournament: true });
  const { room } = harness;
  const alice = room.join("Alice");
  room.sit(alice, 0);
  room.addBot(1, "gto");
  room.startHand();
  await playOut(harness);

  room.table.seats[0]!.stack = 0;
  assert.throws(() => room.rebuy(alice), /锦标赛不能重新买入/);
});

test("standing up frees the seat so you can sit somewhere else", () => {
  const harness = makeRoom({ autoStartSeconds: 0 });
  const { room } = harness;
  const alice = room.join("Alice");
  room.sit(alice, 0, 300);
  assert.throws(() => room.sit(alice, 2, 300), /离座/, "one seat at a time");

  room.stand(alice);
  assert.equal(room.table.seats[0]!.playerId, null, "the old seat is free");
  assert.equal(alice.bankroll, 300, "the chips come back off the table");

  room.sit(alice, 2, 500);
  assert.equal(room.table.seats[2]!.stack, 500, "and the new seat is hers");
});

test("leaving mid-hand waits for the hand to settle", async () => {
  const harness = makeRoom({ autoStartSeconds: 0 });
  const { room } = harness;
  const alice = room.join("Alice");
  room.sit(alice, 0, 300);
  room.addBot(1, "gto");
  room.startHand();

  room.stand(alice);
  assert.equal(alice.seat, 0, "still seated while the hand runs");
  assert.notEqual(room.table.seats[0]!.playerId, null, "seat is not released yet");

  await playOut(harness);
  assert.equal(room.table.seats[0]!.playerId, null, "released once the hand settled");
  assert.equal(alice.seat, null);
  // Whatever the hand left her with — the point is it came back off the table
  // rather than vanishing with the seat.
  assert.ok(alice.bankroll > 0, `the chips came back (got ${alice.bankroll})`);
});

test("saving the settings dialog mid-game does not trip the blind guard", async () => {
  const harness = makeRoom({ autoStartSeconds: 0 });
  const { room } = harness;
  const alice = room.join("Alice");
  room.sit(alice, 0);
  room.addBot(1, "gto");
  room.startHand();
  await playOut(harness);

  // The dialog sends every field back, exactly as the view reported it, with
  // only the two toggles actually changed. A lossy round-trip here made the
  // server think the blind schedule had been edited.
  const settings = room.viewFor(alice).settings;
  room.configure(alice.playerId, {
    seats: settings.seats,
    smallBlind: settings.smallBlind,
    bigBlind: settings.bigBlind,
    startingStack: settings.startingStack,
    actionTimeoutMs: Math.round(settings.actionTimeoutMs / 1000) * 1000,
    mode: settings.mode,
    blindLevelHands: settings.blindLevelHands,
    blindGrowth: settings.blindGrowth,
    autoStartSeconds: 12,
    botAutoRebuy: false,
  });

  const after = room.viewFor(alice).settings;
  assert.equal(after.autoStartSeconds, 12, "the toggle that was changed took effect");
  assert.equal(after.botAutoRebuy, false);
  assert.equal(after.blindLevelHands, settings.blindLevelHands, "and nothing else moved");
  assert.equal(after.blindGrowth, settings.blindGrowth);
});

test("a bot can be taken off the table, freeing its persona", () => {
  const harness = makeRoom({ autoStartSeconds: 0 });
  const { room } = harness;
  room.addBot(0, "gto");
  room.removeBot(0);
  assert.equal(room.table.seats[0]!.playerId, null, "the seat is free");
  assert.doesNotThrow(() => room.addBot(0, "gto"), "and the same persona can be seated again");
  assert.throws(() => room.removeBot(1), /没有机器人/, "an empty seat has nothing to remove");
});

test("removing a bot mid-hand waits for the hand to settle", async () => {
  const harness = makeRoom({ autoStartSeconds: 0 });
  const { room } = harness;
  const alice = room.join("Alice");
  room.sit(alice, 0, 300);
  room.addBot(1, "gto");
  room.startHand();

  room.removeBot(1);
  assert.notEqual(room.table.seats[1]!.playerId, null, "still seated while the hand runs");

  await playOut(harness);
  assert.equal(room.table.seats[1]!.playerId, null, "gone once the hand settled");
  assert.doesNotThrow(() => room.addBot(1, "gto"), "persona freed");
});

test("everyone picks their own stack, within the table's limits", () => {
  const harness = makeRoom({ autoStartSeconds: 0 });
  const { room } = harness;
  const alice = room.join("Alice");
  room.configure(alice.playerId, { smallBlind: 50, bigBlind: 100, startingStack: 2000 });

  room.sit(alice, 0, 3000);
  assert.equal(room.table.seats[0]!.stack, 3000, "the buy-in is what the player asked for");

  const bob = room.join("Bob");
  assert.throws(() => room.sit(bob, 1, 100), /两个大盲/, "100 is only one big blind");
  room.sit(bob, 1, 200);
  assert.equal(room.table.seats[1]!.stack, 200);

  const carol = room.join("Carol");
  assert.throws(() => room.sit(carol, 2, 5), /买入必须在/, "below the absolute floor");
});

test("a rebuy can be a different size than the first buy-in", async () => {
  const harness = makeRoom({ autoStartSeconds: 0 });
  const { room } = harness;
  const alice = room.join("Alice");
  room.sit(alice, 0, 500);
  room.addBot(1, "gto");
  room.startHand();
  await playOut(harness);

  room.table.seats[0]!.stack = 0;
  room.rebuy(alice, 120);
  assert.equal(room.table.seats[0]!.stack, 120, "you choose how much to bring back");
});

test("the host can turn automatic bot re-buys off", async () => {
  const harness = makeRoom({ autoStartSeconds: 0 });
  const { room } = harness;
  const alice = room.join("Alice");
  room.sit(alice, 0);
  room.addBot(1, "gto");
  room.configure(alice.playerId, { botAutoRebuy: false });
  room.startHand();
  await playOut(harness);

  room.table.seats[1]!.stack = 0;
  room.configure(alice.playerId, { botAutoRebuy: false });
  assert.equal(room.table.seats[1]!.stack, 0, "a broke bot stays broke when the host says so");

  room.configure(alice.playerId, { botAutoRebuy: true });
  assert.equal(room.table.seats[1]!.stack, 200, "and buys back in once it is on again");
});

test("each persona can only be seated once", () => {
  const harness = makeRoom({ autoStartSeconds: 0 });
  const { room } = harness;
  room.addBot(0, "gto");
  assert.throws(() => room.addBot(1, "gto"), /已经有一个/, "a second GTOpro is refused");
  room.addBot(1, "lag");
  assert.notEqual(room.table.seats[1]!.playerId, null, "a different persona is fine");
});

test("somebody can take a seat mid-hand and is dealt in next hand", async () => {
  const harness = makeRoom({ autoStartSeconds: 0 });
  const { room } = harness;
  const alice = room.join("Alice");
  room.sit(alice, 0);
  room.addBot(1, "gto");
  room.startHand();

  const bob = room.join("Bob");
  room.sit(bob, 2, 300);
  assert.equal(room.table.seats[2]!.stack, 300, "the seat is theirs straight away");
  assert.equal(room.viewFor(bob).seats[2]!.holeCount, 0, "but not in the hand already running");

  await playOut(harness);
  room.startHand();
  assert.equal(room.viewFor(bob).seats[2]!.holeCount, 2, "dealt in on the next hand");
});

test("a tournament stack must be deep enough to play", () => {  const { room } = makeRoom();
  const alice = room.join("Alice");
  room.configure(alice.playerId, { mode: "tournament", startingStack: 40, smallBlind: 1, bigBlind: 2 });
  assert.equal(room.viewFor(alice).settings.startingStack, 40, "40 chips is 20bb, which is fine");

  // 30 chips clears the generic minimum but is only 15bb, so the tournament
  // rule is what rejects it.
  assert.throws(() => room.configure(alice.playerId, { startingStack: 30 }), /20 个大盲/);
  assert.equal(room.viewFor(alice).settings.startingStack, 40, "the refused change leaves it alone");
});
