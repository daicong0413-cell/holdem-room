/**
 * Plays a run of hands with bots only, then reports what happened.
 *
 * Useful for exercising the whole stack (engine + rooms + bot brains + the
 * language-model layer) without a browser, and for checking that the model is
 * only consulted on the spots that deserve it.
 *
 * Usage:  node scripts/play-session.ts [hands] [room]
 */

import { WebSocket } from "ws";

import type { ClientMessage, ServerMessage, TableView } from "../src/server/protocol.ts";

const targetHands = Number(process.argv[2] ?? 20);
const room = (process.argv[3] ?? "").toUpperCase();
const personas = ["gto", "lag", "tanxuan", "elton"];
const seatCount = personas.length;

const socket = new WebSocket(process.env.HOLDEM_URL ?? "ws://127.0.0.1:8787/ws");

let seated = 0;
let requestedHand = false;
let lastHandId = 0;
let accumulatedHandId = -1;
const netBySeat = new Map<number, number>();
/** Seats we have already asked for; state messages can arrive out of order. */
const requestedSeats = new Set<number>();

const send = (message: ClientMessage): void => socket.send(JSON.stringify(message));
const log = (line: string): void => console.log(line);

socket.on("open", () => send({ t: "hello", name: "自动牌局", room }));

socket.on("message", (raw) => {
  const message = JSON.parse(String(raw)) as ServerMessage;

  if (message.t === "error") {
    log(`服务端错误：${message.message}`);
    return;
  }
  if (message.t !== "state") return;

  const view: TableView = message.view;

  if (seated < seatCount) {
    const free = view.seats.find((seat) => seat.playerId === null && !requestedSeats.has(seat.index));
    if (free) {
      requestedSeats.add(free.index);
      send({ t: "addBot", seat: free.index, persona: personas[seated]! });
      seated++;
      return;
    }
  }

  if (seated < seatCount) return;

  // A finished hand is reported exactly once, keyed by its id.
  if (view.street === "complete" && view.result !== null && view.handId !== accumulatedHandId) {
    accumulatedHandId = view.handId;
    accumulate(view);
  }

  // A fresh hand id means the previous hand is finished; start the next one.
  if (view.handId !== lastHandId) {
    lastHandId = view.handId;
    requestedHand = false;
  }

  if (view.street === "complete" && !requestedHand) {
    if (view.handId >= targetHands) {
      finish(view);
      return;
    }
    requestedHand = true;
    send({ t: "startHand" });
    return;
  }

  if (view.handId === 0 && !requestedHand) {
    requestedHand = true;
    send({ t: "startHand" });
  }
});

function accumulate(view: TableView): void {
  const result = view.result;
  if (!result) return;
  result.netChange.forEach((change, seat) => {
    netBySeat.set(seat, (netBySeat.get(seat) ?? 0) + change);
  });
}

function finish(view: TableView): void {
  log(`\n完成 ${view.handId} 手牌（${seatCount} 个机器人）`);
  let sum = 0;
  for (const seat of view.seats) {
    if (seat.playerId === null) continue;
    const net = netBySeat.get(seat.index) ?? 0;
    sum += net;
    log(`  ${seat.name.padEnd(10)} 筹码 ${String(seat.stack).padStart(4)}  累计 ${net >= 0 ? "+" : ""}${net}`);
  }
  log(`\n累计净变化合计：${sum}${sum === 0 ? " ✓ 筹码守恒" : " ✗ 不守恒！"}`);
  socket.close();
  setTimeout(() => process.exit(sum === 0 ? 0 : 1), 100);
}

socket.on("error", (error) => {
  log(`套接字错误：${error.message}`);
  process.exit(1);
});

setTimeout(() => {
  log(`超时：只完成了 ${lastHandId} 手`);
  process.exit(1);
}, 240_000);
