import { test } from "node:test";
import assert from "node:assert/strict";
import { parseClientMessage } from "./protocol.ts";

test("custom bot buy-ins and show requests survive the wire parser", () => {
  assert.deepEqual(parseClientMessage('{"t":"addBot","seat":2,"persona":"rock","buyIn":1500}'), { t: "addBot", seat: 2, persona: "rock", buyIn: 1500 });
  assert.equal(parseClientMessage('{"t":"addBot","seat":2,"persona":"rock","buyIn":"1500"}'), null);
  assert.deepEqual(parseClientMessage('{"t":"showCards","handId":3}'), { t: "showCards", handId: 3 });
  assert.equal(parseClientMessage('{"t":"showCards","seat":1}'), null, "clients cannot choose someone else's cards");
});

test("the bot auto-rebuy switch actually survives the settings wire parser", () => {
  assert.deepEqual(parseClientMessage('{"t":"configure","settings":{"botAutoRebuy":false}}'), { t: "configure", settings: { botAutoRebuy: false } });
  assert.equal(parseClientMessage('{"t":"configure","settings":{"botAutoRebuy":"false"}}'), null);
});
