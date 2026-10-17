import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { once, EventEmitter } from "node:events";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";
import type { ClientMessage, ServerMessage, TableView } from "./protocol.ts";

class Client {
  readonly socket: WebSocket;
  private readonly events = new EventEmitter();
  private readonly messages: ServerMessage[] = [];
  constructor(url: string) {
    this.socket = new WebSocket(url);
    this.socket.on("message", (raw) => {
      this.messages.push(JSON.parse(String(raw)) as ServerMessage);
      this.events.emit("message");
    });
  }
  async request(message: ClientMessage, predicate: (message: ServerMessage) => boolean): Promise<ServerMessage> {
    const start = this.messages.length;
    this.socket.send(JSON.stringify(message));
    return this.wait(predicate, start);
  }
  async state(message: ClientMessage, predicate: (view: TableView) => boolean): Promise<TableView> {
    const result = await this.request(message, (reply) => reply.t === "state" && predicate(reply.view));
    assert.equal(result.t, "state");
    return result.view;
  }
  wait(predicate: (message: ServerMessage) => boolean, start = 0): Promise<ServerMessage> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.events.off("message", check); reject(new Error("WebSocket response timed out")); }, 5000);
      const check = () => {
        const reply = this.messages.slice(start).find(predicate);
        if (!reply) return;
        clearTimeout(timer); this.events.off("message", check); resolve(reply);
      };
      this.events.on("message", check); check();
    });
  }
}

test("production WebSocket enforces bot ownership, queues buy-ins, reveals only on request and deletes bot-only rooms", { timeout: 15_000 }, async () => {
  const reservation = createServer();
  reservation.listen(0, "127.0.0.1");
  await once(reservation, "listening");
  const address = reservation.address();
  assert.ok(address && typeof address !== "string");
  const port = address.port;
  await new Promise<void>((resolve) => reservation.close(() => resolve()));
  const root = fileURLToPath(new URL("../..", import.meta.url));
  const server = spawn(process.execPath, ["src/server/main.ts"], {
    cwd: root,
    env: { ...process.env, PORT: String(port), HOST: "127.0.0.1", NODE_ENV: "production", DEEPSEEK_API_KEY: "", BOT_THINK_MS: "10000", AUTO_START_SECONDS: "0" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const exited = once(server, "exit");
  const clients: Client[] = [];
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Test server did not start")), 5000);
      server.once("error", reject);
      server.stdout.on("data", (raw) => { if (String(raw).includes(`localhost:${port}`)) { clearTimeout(timer); resolve(); } });
    });
    const base = `http://127.0.0.1:${port}`;
    const status = await fetch(`${base}/api/llm`).then((response) => response.json());
    assert.equal(status.enabled, false, "the integration test cannot use a real local API key");
    const { code } = await fetch(`${base}/api/room`, { method: "POST" }).then((response) => response.json());
    const join = async (name: string) => {
      const client = new Client(`ws://127.0.0.1:${port}/ws`); clients.push(client);
      await once(client.socket, "open");
      await client.request({ t: "hello", room: code, name }, (message) => message.t === "welcome");
      return client;
    };
    const host = await join("Host");
    const guest = await join("Guest");
    await host.state({ t: "sit", seat: 0, buyIn: 500 }, (view) => view.seats[0]!.isYou);
    await guest.state({ t: "sit", seat: 1, buyIn: 500 }, (view) => view.seats[1]!.isYou);
    const denied = (message: ServerMessage) => message.t === "error" && message.message.includes("只有房主");
    await guest.request({ t: "addBot", seat: 2, persona: "gto", buyIn: 999 }, denied);
    await host.state({ t: "addBot", seat: 2, persona: "gto", buyIn: 777 }, (view) => view.seats[2]!.stack === 777);
    await guest.request({ t: "removeBot", seat: 2 }, denied);
    await host.state({ t: "removeBot", seat: 2 }, (view) => view.seats[2]!.playerId === null);
    const active = await host.state({ t: "startHand" }, (view) => !!view.legal);
    const stack = active.seats[0]!.stack;
    const queued = await host.state({ t: "rebuy", buyIn: 200 }, (view) => view.seats[0]!.pendingBuyIn === 200);
    assert.equal(queued.seats[0]!.stack, stack);
    const ended = await host.state({ t: "action", action: { type: "fold" } }, (view) => view.result?.reason === "fold");
    assert.equal(ended.seats[0]!.pendingBuyIn, 0);
    assert.equal(ended.seats.reduce((sum, seat) => sum + seat.stack, 0), 1200);
    assert.equal(ended.seats[1]!.hole, null);
    await host.request({ t: "showCards", handId: ended.handId }, (reply) => reply.t === "error");
    await guest.state({ t: "showCards", handId: ended.handId }, (view) => view.cardsShown);
    const revealed = await host.wait((reply) => reply.t === "state" && reply.view.seats[1]!.hole?.length === 2);
    assert.equal(revealed.t, "state");
    const archive = await host.request({ t: "handHistory", handId: ended.handId }, (reply) => reply.t === "handHistory");
    assert.equal(archive.t, "handHistory");
    assert.equal(archive.entry?.seats.find((seat) => seat.name === "Guest")?.hole?.length, 2);
    assert.equal(archive.entry?.seats.find((seat) => seat.name === "Host")?.hole, null);
    host.socket.send(JSON.stringify({ t: "leave" }));
    await guest.wait((reply) => reply.t === "state" && reply.view.isHost);
    await guest.state({ t: "addBot", seat: 2, persona: "rock", buyIn: 800 }, (view) => view.seats[2]!.stack === 800);
    await guest.request({ t: "stand" }, (reply) => reply.t === "roomClosed");
    const lookup = await fetch(`${base}/api/room/${code}`).then((response) => response.json());
    assert.equal(lookup.exists, false);
  } finally {
    for (const client of clients) client.socket.terminate();
    server.kill();
    await exited;
  }
});
