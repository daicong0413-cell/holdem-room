/**
 * Seats bots in an existing room and starts a hand, then leaves.
 *
 * Useful for demos and for manual testing of the web client: a human can join
 * the room in a browser, and this script provides opponents.
 *
 * Usage:  node scripts/seed-bots.ts <ROOM> [persona ...]
 */

import { WebSocket } from "ws";

import type { ClientMessage, ServerMessage } from "../src/server/protocol.ts";

const room = (process.argv[2] ?? "").toUpperCase();
const personas = process.argv.slice(3);
const seatsToFill = personas.length > 0 ? personas : ["gto", "lag", "tanxuan", "elton"];

if (room.length === 0) {
  console.error("用法: node scripts/seed-bots.ts <房间码> [人格 ...]");
  process.exit(1);
}

const socket = new WebSocket(process.env.HOLDEM_URL ?? "ws://127.0.0.1:8787/ws");
let started = false;
let seated = 0;
const wanted = seatsToFill.length;
/** Seats we have already asked for; state messages can arrive out of order. */
const requested = new Set<number>();

const send = (message: ClientMessage): void => socket.send(JSON.stringify(message));

socket.on("open", () => send({ t: "hello", name: "房间管理员", room }));

socket.on("message", (raw) => {
  const message = JSON.parse(String(raw)) as ServerMessage;

  if (message.t === "error") {
    console.error(`服务端错误：${message.message}`);
    return;
  }
  if (message.t !== "state") return;

  const view = message.view;

  // Take the lowest free seat we have not already claimed, skipping seat 0 in
  // case a human is sitting there.
  if (seated < wanted) {
    const seat = view.seats.find(
      (candidate) => candidate.playerId === null && candidate.index !== 0 && !requested.has(candidate.index),
    );
    if (seat) {
      const persona = seatsToFill[seated]!;
      requested.add(seat.index);
      send({ t: "addBot", seat: seat.index, persona });
      console.log(`  ${seat.index + 1} 号位 → ${persona}`);
      seated++;
      return;
    }
  }

  // A spectator has no view-level "can start" flag, so decide from public state.
  const funded = view.seats.filter((seat) => seat.playerId !== null && seat.stack > 0).length;
  if (!started && seated >= wanted && view.street === "complete" && funded >= 2) {
    started = true;
    send({ t: "startHand" });
    console.log(`房间 ${room} 已开局（${funded} 人），机器人会自行行动。`);
    setTimeout(() => {
      socket.close();
      process.exit(0);
    }, 400);
  }
});

socket.on("error", (error) => {
  console.error(`套接字错误：${error.message}`);
  process.exit(1);
});

setTimeout(() => {
  console.error("超时：没能布置好机器人");
  process.exit(1);
}, 30_000);
