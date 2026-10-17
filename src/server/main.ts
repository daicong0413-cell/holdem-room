/**
 * HTTP + WebSocket entry point.
 *
 * One process serves both the built React client and the game socket, which
 * keeps local play and a public deployment identical: whatever the browser
 * loaded the page from is also where it opens `/ws`.
 *
 * Rooms are created on demand keyed by a short code, so "invite a friend" is
 * just "send them the link".
 */

import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { networkInterfaces } from "node:os";
import { extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { WebSocket, WebSocketServer } from "ws";

import { canManageLlm } from "./admin-access.ts";
import { type AdvisorStatsView, DEFAULT_BASE_URL, DEFAULT_MODEL, DeepSeekAdvisor, connectionTestRequest } from "./advisor.ts";
import { type EnvUpdates, updateEnvFile } from "./env-file.ts";
import { type BotBrain, PERSONAS, findPersona, makeBotDecider, personaInfos } from "./bots.ts";
import {
  DEFAULT_SETTINGS,
  ROOM_CODE_ALPHABET,
  SETTINGS_BOUNDS,
  type ClientMessage,
  type ServerMessage,
  parseClientMessage,
} from "./protocol.ts";
import { type RoomMember, type RoomSocket, Room } from "./room.ts";

/**
 * Reads `.env` if it is there, so a clone only has to fill in a file instead of
 * exporting variables in the right shell. Deliberately tiny: no dependency, and
 * a real environment variable always wins over the file.
 *
 * Runs before the constants below, because they read `process.env` on load.
 */
const ENV_PATH = resolve(process.cwd(), ".env");

function loadDotEnv(path: string): void {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return;
  }
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#")) continue;
    const equals = trimmed.indexOf("=");
    if (equals < 1) continue;
    const key = trimmed.slice(0, equals).trim();
    let value = trimmed.slice(equals + 1).trim();
    if (value.length > 1 && (value.startsWith('"') || value.startsWith("'")) && value.endsWith(value[0]!)) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

loadDotEnv(ENV_PATH);

const PORT = Number(process.env.PORT ?? 8787);
const HOST = process.env.HOST ?? "0.0.0.0";
const PROJECT_ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const WEB_ROOT = resolve(PROJECT_ROOT, "dist/web");

// ---------------------------------------------------------------- room registry

/**
 * Reads a non-negative number from the environment.
 *
 * `Number(process.env.X ?? "")` is `0`, not NaN, so an unset variable would look
 * like an explicit zero — which silently switched the action clock off.
 */
function envNumber(name: string, fallback: number, minimum = 0): number {
  const raw = process.env[name]?.trim();
  if (raw === undefined || raw.length === 0) return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value >= minimum ? value : fallback;
}

/**
 * How long a human has to act before the table moves on without them. Without
 * this, one closed tab freezes the table for everybody. 0 disables it.
 */
const ACTION_TIMEOUT_MS = envNumber("ACTION_TIMEOUT_MS", 60_000);

/**
 * How long a bot "thinks" before acting.
 *
 * The default is deliberately human-paced — 5 to 10 seconds — so a hand
 * breathes instead of resolving the instant you look at it. Two overrides:
 * `BOT_THINK_MS` sets a symmetric range (and `0` makes bots instant, which is
 * what the demos and tests want), or set MIN/MAX for an exact window.
 */
const BOT_THINK_MS_RAW = process.env.BOT_THINK_MS?.trim();
const BOT_THINK_MS_SET = BOT_THINK_MS_RAW !== undefined && BOT_THINK_MS_RAW.length > 0;
const BOT_THINK_MIN_MS = BOT_THINK_MS_SET ? envNumber("BOT_THINK_MS", 0) : envNumber("BOT_THINK_MIN_MS", 5000);
const BOT_THINK_MAX_MS = BOT_THINK_MS_SET
  ? BOT_THINK_MIN_MS * 2
  : Math.max(BOT_THINK_MIN_MS, envNumber("BOT_THINK_MAX_MS", 10_000));

/** Seconds between hands; the host can still change it per room. 0 = manual. */
const AUTO_START_SECONDS = envNumber("AUTO_START_SECONDS", DEFAULT_SETTINGS.autoStartSeconds);

// ---------------------------------------------------------------- room registry

const rooms = new Map<string, Room>();

/**
 * The language-model layer is optional by design. Without a key the bots still
 * play a full, personality-driven local game. With a key, the model chooses
 * every bot action, with a local fallback if the request fails.
 */
function createAdvisorFromEnv(): DeepSeekAdvisor | null {
  const apiKey = process.env.DEEPSEEK_API_KEY?.trim();
  if (apiKey === undefined || apiKey.length === 0) return null;

  const model = process.env.DEEPSEEK_MODEL?.trim();
  const baseUrl = process.env.DEEPSEEK_BASE_URL?.trim();
  const timeout = envNumber("DEEPSEEK_TIMEOUT_MS", 0);
  return new DeepSeekAdvisor({
    apiKey,
    ...(model !== undefined && model.length > 0 ? { model } : {}),
    ...(baseUrl !== undefined && baseUrl.length > 0 ? { baseUrl } : {}),
    ...(timeout > 0 ? { timeoutMs: timeout } : {}),
  });
}

/** Mutable: the operator can point it at another backend without a restart. */
let advisor = createAdvisorFromEnv();

/**
 * What the model backend is set to, for display. The key itself is never sent
 * anywhere — only whether one has been configured.
 */
function llmStatus(configurable: boolean): {
  enabled: boolean;
  model: string;
  baseUrl: string;
  configurable: boolean;
  stats: AdvisorStatsView | null;
} {
  // Report the model actually in use, not "unset": the whole point of showing
  // it is to answer "which model are the bots talking to?".
  return {
    enabled: advisor !== null,
    model: process.env.DEEPSEEK_MODEL?.trim() || DEFAULT_MODEL,
    baseUrl: process.env.DEEPSEEK_BASE_URL?.trim() || DEFAULT_BASE_URL,
    configurable,
    stats: advisor?.stats() ?? null,
  };
}

async function readJsonBody(request: IncomingMessage, limit = 8192): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > limit) throw new Error("请求体太大");
    chunks.push(buffer);
  }
  if (size === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

/**
 * Applies a backend change from the operator's machine: updates the live
 * environment, rewrites `.env` so it survives a restart, and swaps in a fresh
 * advisor. An empty string clears a setting.
 */
function applyLlmSettings(input: { apiKey?: unknown; baseUrl?: unknown; model?: unknown }): void {
  const updates: EnvUpdates = {};

  const put = (name: string, raw: unknown): void => {
    if (typeof raw !== "string") return;
    const value = raw.trim();
    updates[name] = value.length === 0 ? null : value;
    if (value.length === 0) delete process.env[name];
    else process.env[name] = value;
  };

  put("DEEPSEEK_API_KEY", input.apiKey);
  put("DEEPSEEK_BASE_URL", input.baseUrl);
  put("DEEPSEEK_MODEL", input.model);

  if (Object.keys(updates).length === 0) throw new Error("没有要修改的配置");

  updateEnvFile(ENV_PATH, updates);
  advisor = createAdvisorFromEnv();
}

function createRoomCode(): string {
  for (let attempt = 0; attempt < 100; attempt++) {
    const bytes = randomBytes(4);
    let code = "";
    for (const byte of bytes) code += ROOM_CODE_ALPHABET[byte % ROOM_CODE_ALPHABET.length];
    if (!rooms.has(code)) return code;
  }
  throw new Error("could not allocate a free room code");
}

function createRoom(requestedCode?: string): Room {
  let code = requestedCode?.toUpperCase() ?? "";
  if (code.length === 0 || rooms.has(code)) code = createRoomCode();

  // One brain per persona per room; the configured model chooses every action.
  const brains = new Map<string, BotBrain>();
  const room = new Room({
    code,
    settings: { ...DEFAULT_SETTINGS, actionTimeoutMs: ACTION_TIMEOUT_MS, autoStartSeconds: AUTO_START_SECONDS },
    botDelay: () => BOT_THINK_MIN_MS + Math.random() * Math.max(0, BOT_THINK_MAX_MS - BOT_THINK_MIN_MS),
    personas: personaInfos(),
    onClose: (closedRoom) => {
      if (rooms.get(code) === closedRoom) rooms.delete(code);
      console.log(`[room] closed ${code}`);
    },
    botDecider: (context, personaId) => {
      let brain = brains.get(personaId);
      if (brain === undefined) {
        const persona = findPersona(personaId);
        brain = makeBotDecider(persona, Math.random, {
          getAdvisor: () => advisor,
        });
        brains.set(personaId, brain);
      }
      return brain(context);
    },
  });
  rooms.set(code, room);
  console.log(`[room] created ${code}`);
  return room;
}

function findRoom(code: string): Room | null {
  return rooms.get(code.toUpperCase()) ?? null;
}

function isRoomCode(value: string): boolean {
  if (value.length !== 4) return false;
  for (const char of value.toUpperCase()) if (!ROOM_CODE_ALPHABET.includes(char)) return false;
  return true;
}

// --------------------------------------------------------------------- HTTP

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".woff2": "font/woff2",
  ".ico": "image/x-icon",
};

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(payload) });
  response.end(payload);
}

function resolveStaticPath(urlPath: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return null;
  }
  const relative = decoded === "/" ? "index.html" : decoded.replace(/^\/+/, "");
  const target = resolve(WEB_ROOT, relative);
  // Refuse anything that escapes the web root.
  if (target !== WEB_ROOT && !target.startsWith(WEB_ROOT + sep)) return null;
  return target;
}

const MISSING_BUILD_PAGE = `<!doctype html>
<html lang="zh-CN"><meta charset="utf-8">
<title>德州扑克 — 需要先构建前端</title>
<style>
  body{background:#0d1117;color:#e6edf3;font:15px/1.7 system-ui,-apple-system,"Segoe UI",sans-serif;
       display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0}
  main{max-width:620px;padding:32px}
  h1{font-size:20px;margin:0 0 12px}
  code{background:#161b22;border:1px solid #30363d;border-radius:6px;padding:2px 7px;font-size:13px}
  pre{background:#161b22;border:1px solid #30363d;border-radius:8px;padding:14px 16px;overflow:auto}
  p{color:#8b949e}
</style>
<main>
  <h1>前端还没有构建</h1>
  <p>服务端已经跑起来了，但 <code>dist/web</code> 里还没有界面文件。任选一种方式：</p>
  <pre>npm run build:web   # 构建一次，然后刷新本页
npm run dev:web     # 或者启动 Vite 开发服务器（带热更新）</pre>
  <p>WebSocket 地址：<code>ws://本机地址/ws</code></p>
</main>
</html>`;

const server = createServer((request, response) => {
  const url = new URL(request.url ?? "/", "http://localhost");

  if (url.pathname === "/healthz") {
    sendJson(response, 200, {
      ok: true,
      rooms: rooms.size,
      personas: PERSONAS.length,
      llm: advisor === null ? { enabled: false } : advisor.stats(),
    });
    return;
  }

  if (url.pathname === "/api/personas") {
    sendJson(response, 200, { personas: personaInfos(), llm: llmStatus(canManageLlm(request)) });
    return;
  }

  if (url.pathname === "/api/llm") {
    const local = canManageLlm(request);
    if (request.method === "GET") {
      sendJson(response, 200, llmStatus(local));
      return;
    }
    if (request.method === "POST") {
      if (!local) {
        sendJson(response, 403, { error: "网页管理已禁用或不是本机直连，请由部署者修改服务器 .env 并重启服务" });
        return;
      }
      void (async () => {
        try {
          const body = (await readJsonBody(request)) as {
            apiKey?: unknown;
            baseUrl?: unknown;
            model?: unknown;
          };
          applyLlmSettings(body);
          sendJson(response, 200, llmStatus(true));
        } catch (error) {
          sendJson(response, 400, { error: error instanceof Error ? error.message : "配置失败" });
        }
      })();
      return;
    }
  }

  if (url.pathname === "/api/llm/test" && request.method === "POST") {
    if (!canManageLlm(request)) {
      sendJson(response, 403, { error: "此连接不能测试大模型，请由部署者在服务器上检查 API 配置" });
      return;
    }
    const backend = advisor;
    if (!backend) {
      sendJson(response, 400, { error: "请先保存 API 配置" });
      return;
    }
    void backend.review(connectionTestRequest()).then((verdict) => {
      sendJson(response, 200, { ok: verdict !== null, error: backend.stats().lastError, status: llmStatus(true) });
    });
    return;
  }

  if (url.pathname === "/api/config") {
    sendJson(response, 200, { defaults: DEFAULT_SETTINGS, bounds: SETTINGS_BOUNDS });
    return;
  }

  if (url.pathname === "/api/room") {
    const room = createRoom();
    sendJson(response, 201, { code: room.code, seats: room.table.seats.length });
    return;
  }

  const roomLookup = url.pathname.match(/^\/api\/room\/([A-Za-z0-9]{1,8})$/);
  if (roomLookup) {
    const code = roomLookup[1]!.toUpperCase();
    const room = findRoom(code);
    sendJson(response, 200, {
      code,
      exists: room !== null,
      seats: room?.table.seats.length ?? DEFAULT_SETTINGS.seats,
      players: room?.members_().filter((member) => member.seat !== null).length ?? 0,
    });
    return;
  }

  void serveStatic(url.pathname, response);
});

async function serveStatic(urlPath: string, response: ServerResponse): Promise<void> {
  const target = resolveStaticPath(urlPath);
  if (target === null) {
    response.writeHead(400).end("bad request");
    return;
  }

  try {
    const info = await stat(target);
    if (info.isDirectory()) throw new Error("directory");
    const body = await readFile(target);
    response.writeHead(200, {
      "content-type": CONTENT_TYPES[extname(target).toLowerCase()] ?? "application/octet-stream",
      "content-length": body.byteLength,
      "cache-control": "no-cache",
    });
    response.end(body);
    return;
  } catch {
    // A single-page app has exactly one real entry point; anything else that is
    // not a file falls back to it so deep links keep working.
    if (extname(target) === "") {
      try {
        const html = await readFile(resolve(WEB_ROOT, "index.html"));
        response.writeHead(200, { "content-type": CONTENT_TYPES[".html"]!, "content-length": html.byteLength });
        response.end(html);
        return;
      } catch {
        /* fall through to the build hint */
      }
    }
    const page = Buffer.from(MISSING_BUILD_PAGE);
    response.writeHead(200, { "content-type": CONTENT_TYPES[".html"]!, "content-length": page.byteLength });
    response.end(page);
  }
}

// ----------------------------------------------------------------- WebSocket

interface Connection {
  readonly socket: WebSocket;
  member: RoomMember | null;
  room: Room | null;
  alive: boolean;
  /** Consecutive heartbeats without a pong. */
  missedPings: number;
}

const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });

server.on("upgrade", (request, socket, head) => {
  const url = new URL(request.url ?? "/", "http://localhost");
  if (url.pathname !== "/ws") {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(request, socket, head, (ws) => wss.emit("connection", ws, request));
});

/**
 * Live connections, keyed by socket.
 *
 * Heartbeat state lives in exactly one place — this map. An earlier version
 * cast the raw socket and read `socket.alive`, while the pong handler wrote to
 * a *separate* wrapper object, so the flag was never reset and every client was
 * disconnected on a timer regardless of the network.
 */
const connections = new Map<WebSocket, Connection>();

wss.on("connection", (socket: WebSocket) => {
  const connection: Connection = { socket, member: null, room: null, alive: true, missedPings: 0 };
  connections.set(socket, connection);

  const adapter: RoomSocket = {
    send: (message: ServerMessage) => {
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
    },
  };

  socket.on("pong", () => {
    connection.alive = true;
    connection.missedPings = 0;
  });

  socket.on("message", (data) => {
    const text = typeof data === "string" ? data : data.toString("utf8");
    const message = parseClientMessage(text);
    if (message === null) {
      send(connection, { t: "error", message: "无法解析的消息" });
      return;
    }
    try {
      handleMessage(connection, message, adapter);
    } catch (error) {
      send(connection, { t: "error", message: error instanceof Error ? error.message : String(error) });
    }
  });

  socket.on("close", (code) => {
    connections.delete(socket);
    const name = connection.member?.name ?? "?";
    const room = connection.room?.code ?? "-";
    // Logged so a "random disconnect" complaint can be answered with evidence.
    if (connection.member) console.log(`[ws] 断开 ${name}@${room} code=${code}`);
    if (connection.room && connection.member) connection.room.detach(connection.member.playerId, adapter);
  });

  socket.on("error", () => {
    /* the close handler performs cleanup */
  });
});

function send(connection: Connection, message: ServerMessage): void {
  if (connection.socket.readyState === WebSocket.OPEN) connection.socket.send(JSON.stringify(message));
}

function handleMessage(connection: Connection, message: ClientMessage, adapter: RoomSocket): void {
  if (message.t === "ping") {
    send(connection, { t: "pong" });
    return;
  }

  if (message.t === "hello") {
    if (connection.member && connection.room) connection.room.detach(connection.member.playerId, adapter);

    const requested = message.room?.trim().toUpperCase() ?? "";
    let room: Room | null = null;
    if (requested.length > 0 && isRoomCode(requested)) room = findRoom(requested);
    if (room === null) room = createRoom(isRoomCode(requested) ? requested : undefined);

    const member = room.join(message.name ?? "玩家", message.token);
    room.attach(member.playerId, adapter);

    connection.room = room;
    connection.member = member;
    console.log(`[ws] 加入 ${member.name}@${room.code}`);
    send(connection, {
      t: "welcome",
      playerId: member.playerId,
      token: member.token,
      roomCode: room.code,
      name: member.name,
    });
    room.broadcast();
    return;
  }

  const { room, member } = connection;
  if (!room || !member) {
    send(connection, { t: "error", message: "请先发送 hello 加入房间" });
    return;
  }
  if (room.isClosed()) {
    send(connection, { t: "roomClosed" });
    return;
  }

  switch (message.t) {
    case "sit":
      room.sit(member, message.seat, message.buyIn ?? undefined);
      break;
    case "stand":
      room.stand(member);
      break;
    case "leave":
      room.leave(member);
      connection.room = null;
      connection.member = null;
      break;
    case "showCards":
      room.showCards(member, message.handId);
      break;
    case "addBot":
      room.addBotBy(member.playerId, message.seat, message.persona, message.buyIn);
      break;
    case "removeBot":
      room.removeBotBy(member.playerId, message.seat);
      break;
    case "action":
      room.act(member.playerId, message.action);
      break;
    case "startHand":
      room.startHand();
      break;
    case "rebuy":
      room.rebuy(member, message.buyIn ?? undefined);
      break;
    case "configure":
      room.configure(member.playerId, message.settings);
      break;
    case "handHistory":
      room.sendTo(member.playerId, { t: "handHistory", entry: room.historyEntry(message.handId) });
      break;
    case "chat":
      room.broadcastChat(member.name, message.text);
      break;
    default:
      break;
  }
}

// ------------------------------------------------------------------ lifecycle

/**
 * Two consecutive missed heartbeats (~90s) before a socket is dropped. A single
 * miss is normal for a window the OS has backgrounded or occluded.
 */
const heartbeat = setInterval(() => {
  for (const connection of connections.values()) {
    if (!connection.alive) {
      connection.missedPings += 1;
      if (connection.missedPings >= 2) {
        connection.socket.terminate();
        continue;
      }
    } else {
      connection.missedPings = 0;
    }
    connection.alive = false;
    connection.socket.ping();
  }
}, 30_000);

function localAddresses(): string[] {
  const addresses: string[] = [];
  for (const group of Object.values(networkInterfaces())) {
    for (const entry of group ?? []) {
      if (entry.family === "IPv4" && !entry.internal) addresses.push(entry.address);
    }
  }
  return addresses;
}

server.listen(PORT, HOST, () => {
  console.log(`\n  德州扑克服务已启动`);
  console.log(`  本机   http://localhost:${PORT}`);
  for (const address of localAddresses()) console.log(`  局域网 http://${address}:${PORT}   ← 同一 WiFi 下朋友可用`);
  if (advisor === null) {
    console.log(`  大模型 未启用（没有 DEEPSEEK_API_KEY）—— 机器人只用本地蒙特卡洛决策`);
  } else {
    const stats = advisor.stats();
    console.log(`  大模型 已启用：${stats.model}，每次机器人行动都会调用`);
  }
  console.log(
    ACTION_TIMEOUT_MS > 0
      ? `  行动限时 默认 ${Math.round(ACTION_TIMEOUT_MS / 1000)} 秒（房主可在牌桌上改）`
      : `  行动限时 已关闭（房主可在牌桌上开启）`,
  );
  console.log(`  房间设置 盲注 ${DEFAULT_SETTINGS.smallBlind}/${DEFAULT_SETTINGS.bigBlind}，起始筹码 ${DEFAULT_SETTINGS.startingStack}，现金局（房主可改）`);
  console.log(
    AUTO_START_SECONDS > 0
      ? `  自动开局 每手结束后 ${AUTO_START_SECONDS} 秒自动发下一手`
      : `  自动开局 已关闭（每手都要手动点「开始下一手」）`,
  );
  console.log(
    BOT_THINK_MIN_MS === 0 && BOT_THINK_MAX_MS === 0
      ? `  机器人思考 立即行动（BOT_THINK_MS=0）`
      : BOT_THINK_MAX_MS < 1000
        ? `  机器人思考 ${BOT_THINK_MIN_MS}–${BOT_THINK_MAX_MS} 毫秒`
        : `  机器人思考 ${(BOT_THINK_MIN_MS / 1000).toFixed(1)}–${(BOT_THINK_MAX_MS / 1000).toFixed(1)} 秒`,
  );
  console.log(`  （公网访问用 Cloudflare Tunnel 或部署到云服务器，见 docs/deploy.md）\n`);
});

function shutdown(signal: string): void {
  console.log(`\n收到 ${signal}，正在关闭…`);
  clearInterval(heartbeat);
  for (const socket of wss.clients) socket.close(1001, "server shutting down");
  wss.close();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
