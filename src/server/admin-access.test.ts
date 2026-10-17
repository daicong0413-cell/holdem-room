import assert from "node:assert/strict";
import type { IncomingMessage } from "node:http";
import test from "node:test";

import { canManageLlm } from "./admin-access.ts";

function request(headers: IncomingMessage["headers"] = {}, address = "127.0.0.1"): IncomingMessage {
  return { headers: { host: "localhost:8787", ...headers }, socket: { remoteAddress: address } } as IncomingMessage;
}

test("direct loopback development can manage the backend", () => {
  assert.equal(canManageLlm(request(), "development"), true);
  assert.equal(canManageLlm(request({ origin: "http://localhost:8787", "sec-fetch-site": "same-origin" }), "development"), true);
  assert.equal(canManageLlm(request({ host: "[::1]:8787" }, "::1"), "development"), true);
});

test("production never exposes model configuration or billable connection tests", () => {
  assert.equal(canManageLlm(request(), "production"), false);
  assert.equal(canManageLlm(request({ origin: "http://localhost:8787" }), "production"), false);
});

test("a reverse proxy on loopback is not an administrator", () => {
  for (const headers of [
    { host: "poker.example.com" },
    { "x-forwarded-for": "198.51.100.8" },
    { "x-forwarded-host": "poker.example.com" },
    { "x-forwarded-proto": "https" },
    { forwarded: "for=198.51.100.8" },
    { "cf-connecting-ip": "198.51.100.8" },
    { via: "1.1 proxy" },
  ]) assert.equal(canManageLlm(request(headers), "development"), false);
});

test("remote connections and browser cross-origin requests cannot manage the backend", () => {
  assert.equal(canManageLlm(request({}, "192.168.1.9"), "development"), false);
  for (const headers of [
    { origin: "https://untrusted.example" },
    { origin: "null" },
    { "sec-fetch-site": "cross-site" },
    { host: "localhost.evil.example" },
    { host: "untrusted.example@localhost:8787" },
    { host: "localhost:8787/path" },
  ]) assert.equal(canManageLlm(request(headers), "development"), false);
});
