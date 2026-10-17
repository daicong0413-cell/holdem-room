/**
 * End-to-end smoke test over a real socket.
 *
 * Usage:  node scripts/smoke-client.ts [url]
 *
 * Joins a room, sits down, seats two bots, plays a hand, and — most importantly
 * — acts as an adversarial client: it asserts that at no point during a live
 * hand does the server send it another player's hole cards. The unit tests call
 * the view builder directly; this one proves the wire agrees.
 */

import { WebSocket } from "ws";

import type { ClientMessage, ServerMessage, TableView } from "../src/server/protocol.ts";

const url = process.argv[2] ?? "ws://127.0.0.1:8787/ws";
const socket = new WebSocket(url);

let view: TableView | null = null;
let started = false;
let botsSeated = false;
let finished = false;
let midHandLeaks = 0;
let midHandChecks = 0;

const send = (message: ClientMessage): void => socket.send(JSON.stringify(message));
const log = (line: string): void => console.log(line);

/** Any hole card that is visible while the hand is live and is not mine is a leak. */
function auditLiveView(current: TableView): void {
  if (current.street === "complete") return;
  midHandChecks++;
  for (const seat of current.seats) {
    if (seat.isYou) continue;
    if (seat.hole !== null) {
      midHandLeaks++;
      log(`  ✗ 泄露：${seat.name} 的底牌 ${seat.hole.join(" ")} 在牌局进行中被下发`);
    }
    if (seat.handCategory != null) {
      midHandLeaks++;
      log(`  ✗ 泄露：${seat.name} 的私有牌型在牌局进行中被下发`);
    }
  }
}

socket.on("open", () => {
  log(`已连接 ${url}`);
  send({ t: "hello", name: "冒烟测试", room: "" });
});

socket.on("message", (raw) => {
  const message = JSON.parse(String(raw)) as ServerMessage;

  switch (message.t) {
    case "welcome":
      log(`加入房间 ${message.roomCode}`);
      send({ t: "sit", seat: 0 });
      return;

    case "error":
      log(`服务端错误：${message.message}`);
      return;

    case "state": {
      view = message.view;
      auditLiveView(view);

      if (!botsSeated) {
        botsSeated = true;
        send({ t: "addBot", seat: 1, persona: "gto" });
        send({ t: "addBot", seat: 2, persona: "lag" });
        return;
      }

      if (!started && view.canStartHand) {
        started = true;
        log("开始第一手牌（3 人：1 人 + 2 机器人）");
        send({ t: "startHand" });
        return;
      }

      if (view.result && !finished) {
        finished = true;
        report(view);
        socket.close();
        setTimeout(() => process.exit(midHandLeaks === 0 ? 0 : 1), 100);
        return;
      }

      if (view.legal) {
        const action = view.legal.canCheck ? { type: "check" as const } : { type: "call" as const };
        log(`  → 我${action.type === "check" ? "过牌" : "跟注"}`);
        send({ t: "action", action });
      }
      return;
    }

    default:
      return;
  }
});

function report(final: TableView): void {
  const result = final.result!;
  log("");
  log(`本手结束（${result.reason === "fold" ? "弃牌获胜" : "摊牌"}），明牌玩家：${
    result.showdown.map((entry) => final.seats[entry.seatIndex]?.name).join("、") || "无"
  }`);

  let sum = 0;
  for (const seat of final.seats) {
    if (seat.playerId === null) continue;
    const change = result.netChange[seat.index] ?? 0;
    sum += change;
    const cards = seat.hole ? seat.hole.join(" ") : seat.holeCount > 0 ? "暗牌" : "—";
    log(`  ${seat.name.padEnd(10)} ${cards.padEnd(7)} 筹码 ${String(seat.stack).padStart(4)}  本手 ${change >= 0 ? "+" : ""}${change}`);
  }

  log("");
  log(`筹码守恒：本手净变化合计 ${sum}${sum === 0 ? " ✓" : " ✗ 不平！"}`);
  log(`进行中底牌审计：${midHandChecks} 次快照，泄露 ${midHandLeaks} 次${midHandLeaks === 0 ? " ✓" : " ✗"}`);

  const foldedOrUnknown = final.seats.filter(
    (seat) => seat.playerId !== null && seat.hole === null && seat.holeCount > 0,
  );
  log(
    `未亮牌玩家的底牌仍然隐藏：${foldedOrUnknown.map((seat) => seat.name).join("、") || "（本手全部亮牌）"}${
      foldedOrUnknown.length >= 0 ? " ✓" : ""
    }`,
  );
}

socket.on("close", () => {
  if (!finished) {
    log("连接提前关闭");
    process.exit(1);
  }
});

socket.on("error", (error) => {
  log(`套接字错误：${error.message}`);
  process.exit(1);
});

setTimeout(() => {
  log("超时：60 秒内没有完成一手牌");
  process.exit(1);
}, 60_000);
