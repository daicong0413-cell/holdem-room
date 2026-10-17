import assert from "node:assert/strict";
import test from "node:test";

import { readBackendJson } from "./backend.ts";

test("a static-only deployment must report API 404 instead of pretending local AI is ready", async () => {
  const request = async () => new Response("<html>404 Not Found</html>", { status: 404, headers: { "content-type": "text/html" } });
  await assert.rejects(readBackendJson("/api/personas", undefined, request), /\/api\/personas 返回 HTTP 404/u);
});

test("SPA HTML fallback at an API path is not a working backend", async () => {
  const request = async () => new Response("<!doctype html><html></html>", { headers: { "content-type": "text/html" } });
  await assert.rejects(readBackendJson("/api/llm", undefined, request), /未返回游戏服务数据/u);
});

test("working backend JSON and provider failures stay distinguishable", async () => {
  const payload = { enabled: false, configurable: false };
  const request = async () => Response.json(payload);
  assert.deepEqual(await readBackendJson("/api/llm", undefined, request), payload);
  await assert.rejects(readBackendJson("/api/llm", undefined, async () => { throw new Error("network offline"); }), /network offline/u);
});
