/** Check HTTP, production admin protection and a real two-human hand. No bots/API calls. */
import assert from "node:assert/strict";
import { WebSocket } from "ws";

const base = new URL(process.argv[2] ?? "http://127.0.0.1:8787");
if (!["http:", "https:"].includes(base.protocol) || base.pathname !== "/" || base.username || base.password) {
  throw new Error("Usage: npm run check:deploy -- https://poker.example.com (subdomain root, no credentials)");
}
const sockets = [];
const get = (path, options = {}) => fetch(new URL(path, base), { ...options, signal: AbortSignal.timeout(10_000) });
async function getApi(path) {
  const response = await get(path);
  if (response.status !== 200 || !response.headers.get("content-type")?.includes("application/json")) {
    throw new Error(`Game backend unavailable: ${path} returned HTTP ${response.status}. Start the Node server and proxy /api/*, /ws and /healthz to it; uploading dist/web alone cannot run games.`);
  }
  return response.json();
}

try {
  const health = await getApi("/healthz");
  assert.equal(health.ok, true);
  const page = await get("/");
  assert.equal(page.status, 200);
  const html = await page.text();
  const asset = html.match(/src="([^"]+\.js)"/u)?.[1];
  assert.ok(asset, "built frontend script missing; run npm run build:web");
  const script = await get(asset);
  assert.equal(script.status, 200);
  assert.match(script.headers.get("content-type") ?? "", /javascript/u);
  console.log("OK: health and built frontend");

  const [status, catalog] = await Promise.all([getApi("/api/llm"), getApi("/api/personas")]);
  assert.equal(catalog.personas?.length, 5, "expected all five bot personas");
  console.log(`OK: five bots: ${catalog.personas.map((persona) => persona.name).join(", ")}`);
  console.log(`Model: ${status.enabled ? status.model + " configured (key decisions only)" : "not configured; local strategy bots available"}`);
  assert.equal(status.configurable, false, "public server must run with NODE_ENV=production");
  // An empty object cannot change any setting, even against an older server.
  const update = await get("/api/llm", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  assert.equal(update.status, 403, "public API configuration must be denied");
  console.log("OK: public model configuration is locked");

  const roomResponse = await get("/api/room", { method: "POST" });
  assert.equal(roomResponse.status, 201);
  const { code } = await roomResponse.json();
  const wsUrl = new URL("/ws", base);
  wsUrl.protocol = base.protocol === "https:" ? "wss:" : "ws:";

  await new Promise((resolve, reject) => {
    let started = false;
    let audited = 0;
    const players = [];
    const timer = setTimeout(() => finish(new Error("WebSocket/two-player hand timed out (30s)")), 30_000);
    let finished = false;
    function finish(error) {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      for (const socket of sockets) socket.close();
      if (error) reject(error);
      else {
        console.log(`OK: two players joined ${code}, completed a hand; ${audited} private-card checks`);
        resolve();
      }
    }
    for (let index = 0; index < 2; index++) {
      const socket = new WebSocket(wsUrl, { origin: base.origin });
      sockets.push(socket);
      const player = { socket, view: null, ready: false };
      players.push(player);
      const send = (message) => socket.send(JSON.stringify(message));
      socket.on("open", () => send({ t: "hello", room: code, name: `部署检查${index + 1}` }));
      socket.on("error", finish);
      socket.on("close", () => { if (!finished) finish(new Error("WebSocket closed before the hand completed")); });
      socket.on("message", (raw) => {
        if (finished) return;
        try {
          const message = JSON.parse(String(raw));
          if (message.t === "error") throw new Error(message.message);
          if (message.t === "welcome") {
            send({ t: "sit", seat: index });
            return;
          }
          if (message.t !== "state") return;
          const view = message.view;
          player.view = view;
          const own = view.seats.find((seat) => seat.isYou);
          if (!player.ready && own) {
            if (view.isHost) send({ t: "configure", settings: { autoStartSeconds: 0 } });
            player.ready = true;
          }
          if (!started && players.length === 2 && players.every((peer) => peer.ready) && view.canStartHand) {
            started = true;
            send({ t: "startHand" });
          }
          if (view.street !== "complete") {
            for (const seat of view.seats) {
              if (seat.isYou || seat.playerId === null) continue;
              assert.equal(seat.hole, null, "opponent hole cards leaked");
              assert.equal(seat.handCategory, null, "opponent private hand category leaked");
              audited++;
            }
          }
          if (view.result) {
            assert.equal(Object.values(view.result.netChange).reduce((sum, amount) => sum + amount, 0), 0);
            assert.ok(audited > 0);
            finish();
          } else if (started && view.legal) {
            send({ t: "action", action: { type: view.legal.canCheck ? "check" : "call" } });
          }
        } catch (error) { finish(error); }
      });
    }
  });
  console.log("Deployment check passed. Test seats remain in a disposable room until the server restarts.");
} catch (error) {
  console.error(`Deployment check failed: ${error.message}`);
  process.exitCode = 1;
} finally {
  for (const socket of sockets) socket.terminate();
}
