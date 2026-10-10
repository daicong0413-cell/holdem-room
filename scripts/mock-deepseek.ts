/**
 * A stand-in for the DeepSeek API.
 *
 * Speaks the same wire protocol, so the real `fetchTransport` and the real
 * server code path are exercised without a network or a credential. Used by the
 * end-to-end check and handy for developing without burning tokens.
 *
 * Usage:  node scripts/mock-deepseek.ts
 * Env:    MOCK_PORT (default 9099), MOCK_MODE = good | garbage | error | slow
 */

import { createServer } from "node:http";

const port = Number(process.env.MOCK_PORT ?? 9099);
const mode = process.env.MOCK_MODE ?? "good";

let requests = 0;
const seen: string[] = [];

/** Prefers a passive-continuing action so hands reach showdown and stay lively. */
function chooseFrom(ids: readonly string[]): string {
  for (const preferred of ["call", "check", "raise-small", "fold", "raise-big", "allin"]) {
    if (ids.includes(preferred)) return preferred;
  }
  return ids[0] ?? "fold";
}

const server = createServer((request, response) => {
  const chunks: Buffer[] = [];
  request.on("data", (chunk: Buffer) => chunks.push(chunk));
  request.on("end", () => {
    requests++;
    const raw = Buffer.concat(chunks).toString("utf8");

    let body: { model?: string; messages?: Array<{ role: string; content: string }> } = {};
    try {
      body = JSON.parse(raw) as typeof body;
    } catch {
      /* fall through to the ids scan below */
    }

    const user = body.messages?.find((message) => message.role === "user")?.content ?? "";
    const persona = body.messages?.find((message) => message.role === "system")?.content.match(/「(.+?)」/)?.[1] ?? "?";
    const ids = [...user.matchAll(/^- ([a-z-]+)：/gm)].map((match) => match[1]!);
    const choice = chooseFrom(ids);
    seen.push(`${persona}→${choice}`);
    console.log(`[mock] #${requests} ${persona}  候选=[${ids.join(",")}]  → ${choice}`);

    if (mode === "error") {
      response.writeHead(429, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: "rate limited" } }));
      return;
    }

    const content = mode === "garbage" ? "我觉得这手牌应该直接推了。" : JSON.stringify({ choice, talk: "嗯……" });
    const send = (): void => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          id: `chatcmpl-mock-${requests}`,
          choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
          usage: { prompt_tokens: 210, completion_tokens: 16 },
        }),
      );
    };

    if (mode === "slow") setTimeout(send, 30_000);
    else send();
  });
});

server.listen(port, "127.0.0.1", () => {
  console.log(`[mock] DeepSeek 替身在 http://127.0.0.1:${port}（模式：${mode}）`);
});

function report(): void {
  console.log(`\n[mock] 共收到 ${requests} 次请求`);
  if (seen.length > 0) console.log(`[mock] 最近：${seen.slice(-8).join("  ")}`);
  process.exit(0);
}

process.on("SIGINT", report);
process.on("SIGTERM", report);
