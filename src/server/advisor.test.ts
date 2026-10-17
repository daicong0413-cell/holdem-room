import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";

import { cardsFromString, seededRng } from "../engine/cards.ts";
import type { LegalActions, PlayerAction } from "../engine/table.ts";
import {
  type Advisor,
  type AdvisorRequest,
  type ChatRequest,
  type ChatResponse,
  type ChatTransport,
  DeepSeekAdvisor,
  buildSystemPrompt,
  buildUserPrompt,
  extractJsonObject,
  extractUsage,
  parseVerdict,
} from "./advisor.ts";
import { PERSONAS, buildCandidates, makeBotDecider } from "./bots.ts";
import type { BotContext, BotOpponent } from "./room.ts";

const GTO = PERSONAS[0]!;

function legal(overrides: Partial<LegalActions> = {}): LegalActions {
  return {
    seatIndex: 0,
    toCall: 0,
    canFold: true,
    canCheck: true,
    canCall: false,
    callCost: 0,
    canRaise: true,
    canAllIn: true,
    minRaiseTo: 4,
    maxRaiseTo: 200,
    ...overrides,
  };
}

function opponent(overrides: Partial<BotOpponent> = {}): BotOpponent {
  return { seatIndex: 1, stack: 200, committed: 0, folded: false, allIn: false, lastAction: null, ...overrides };
}

function context(overrides: Partial<BotContext> = {}): BotContext {
  return {
    seatIndex: 0,
    handId: 1,
    hole: cardsFromString("AsKd"),
    board: cardsFromString("2c3d4h"),
    street: "flop",
    stack: 200,
    committed: 0,
    pot: 100,
    toCall: 0,
    potOdds: 0,
    bigBlind: 2,
    legal: legal(),
    opponents: [opponent(), opponent({ seatIndex: 2, folded: true })],
    history: [],
    ...overrides,
  };
}

function request(overrides: Partial<AdvisorRequest> = {}): AdvisorRequest {
  const ctx = overrides.context ?? context();
  return {
    persona: GTO,
    context: ctx,
    candidates: buildCandidates(ctx),
    equity: 0.55,
    requiredEquity: 0.3,
    reasons: ["底池已达 50 个大盲"],
    ...overrides,
  };
}

function completion(content: string, promptTokens = 120, completionTokens = 24): unknown {
  return {
    id: "chatcmpl-test",
    choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
    usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens },
  };
}

function fakeTransport(payload: unknown, ok = true, status = 200): { transport: ChatTransport; seen: ChatRequest[] } {
  const seen: ChatRequest[] = [];
  return {
    seen,
    transport: async (chatRequest: ChatRequest): Promise<ChatResponse> => {
      seen.push(chatRequest);
      return { ok, status, json: payload };
    },
  };
}

// ------------------------------------------------------------------ prompting

test("the system prompt carries the persona and forbids inventing actions", () => {
  const prompt = buildSystemPrompt(GTO);
  assert.ok(prompt.includes(GTO.name));
  assert.ok(prompt.includes(GTO.description ?? ""));
  assert.ok(prompt.includes("只能从候选动作里选一个"));
  assert.ok(prompt.includes("JSON"));
});

test("the user prompt describes the spot and lists every candidate", () => {
  const built = buildUserPrompt(request());
  assert.ok(built.includes("As Kd"), "the hero's own cards belong in the prompt");
  assert.ok(built.includes("2c 3d 4h"));
  assert.ok(built.includes("底池：100"));
  for (const candidate of buildCandidates(context())) {
    assert.ok(built.includes(candidate.id), `candidate ${candidate.id} missing from prompt`);
  }
});

test("the prompt leaks no card that is not the hero's or the board's", () => {
  const ctx = context({
    hole: cardsFromString("AsKd"),
    board: cardsFromString("2c3d4h"),
    opponents: [opponent({ seatIndex: 1 }), opponent({ seatIndex: 2 })],
  });
  const built = buildUserPrompt(request({ context: ctx }));

  const mentioned = new Set(built.match(/\b[2-9TJQKA][shdc]\b/g) ?? []);
  const expected = new Set([...ctx.hole, ...ctx.board].map((card) => `${"23456789TJQKA"[card >> 2]}${"shdc"[card & 3]}`));
  assert.deepEqual([...mentioned].sort(), [...expected].sort(), "the model must only ever see public cards plus its own");
});

test("opponents are reduced to public information", () => {
  const built = buildUserPrompt(request());
  assert.ok(built.includes("仍在局中的对手：1 人"), "a folded opponent should not count as live");
  assert.ok(!built.includes("hole"), "no field names from the internal context should appear");
});

// -------------------------------------------------------------------- parsing

test("a clean JSON reply is accepted", () => {
  assert.deepEqual(parseVerdict('{"choice":"call","talk":"跟上"}', ["fold", "call"]), {
    choiceId: "call",
    talk: "跟上",
  });
});

test("code fences and surrounding prose are tolerated", () => {
  const fenced = '```json\n{"choice":"raise-big","talk":""}\n```';
  assert.equal(parseVerdict(fenced, ["fold", "raise-big"])?.choiceId, "raise-big");

  const chatty = '好的，我选择：{"choice":"fold","talk":"这把我不要了"} 就这样。';
  const parsed = parseVerdict(chatty, ["fold", "call"]);
  assert.equal(parsed?.choiceId, "fold");
  assert.equal(parsed?.talk, "这把我不要了");
});

test("a hallucinated action is rejected outright", () => {
  assert.equal(parseVerdict('{"choice":"raise-to-9999"}', ["fold", "call"]), null);
  assert.equal(parseVerdict('{"choice":""}', ["fold"]), null);
  assert.equal(parseVerdict("我不会玩", ["fold"]), null);
  assert.equal(parseVerdict("", ["fold"]), null);
});

test("choice matching is case-insensitive but never fuzzy", () => {
  assert.equal(parseVerdict('{"choice":"CALL"}', ["fold", "call"])?.choiceId, "call");
  assert.equal(parseVerdict('{"choice":"cal"}', ["fold", "call"]), null);
});

test("over-long table talk is truncated rather than trusted", () => {
  const long = "啊".repeat(200);
  const parsed = parseVerdict(`{"choice":"fold","talk":"${long}"}`, ["fold"]);
  assert.equal(parsed?.talk?.length, 40);
});

test("extractJsonObject survives malformed input", () => {
  assert.equal(extractJsonObject("{not json"), null);
  assert.equal(extractJsonObject("[]"), null);
  assert.deepEqual(extractJsonObject('{"a":1}'), { a: 1 });
});

test("usage is read defensively", () => {
  assert.deepEqual(extractUsage(completion("x", 10, 5)), { promptTokens: 10, completionTokens: 5 });
  assert.deepEqual(extractUsage({}), { promptTokens: 0, completionTokens: 0 });
  assert.deepEqual(extractUsage(null), { promptTokens: 0, completionTokens: 0 });
});

// ------------------------------------------------------------------ the client

test("a good reply becomes a concrete, legal action", async () => {
  const ctx = context({ legal: legal({ canCheck: false, canCall: true, toCall: 50, callCost: 50 }) });
  const { transport, seen } = fakeTransport(completion('{"choice":"call","talk":"我跟"}'));
  const advisor = new DeepSeekAdvisor({ apiKey: "sk-test-key" }, transport);

  const verdict = await advisor.review(request({ context: ctx }));
  assert.equal(verdict?.choiceId, "call");
  assert.deepEqual(verdict?.action, { type: "call" });
  assert.equal(verdict?.talk, "我跟");
  assert.equal(verdict?.promptTokens, 120);

  assert.equal(seen.length, 1);
  assert.equal(seen[0]!.url, "https://api.deepseek.com/chat/completions");
  assert.equal(advisor.stats().calls, 1);
  assert.equal(advisor.stats().failures, 0);
});

test("the key travels in the header and never in the body", async () => {
  const { transport, seen } = fakeTransport(completion('{"choice":"fold"}'));
  const advisor = new DeepSeekAdvisor({ apiKey: "sk-secret-value" }, transport);
  await advisor.review(request());

  assert.equal(seen[0]!.headers.authorization, "Bearer sk-secret-value");
  assert.equal(JSON.stringify(seen[0]!.body).includes("sk-secret-value"), false);
});

test("stats never expose the key", async () => {
  const { transport } = fakeTransport(completion('{"choice":"fold"}'));
  const advisor = new DeepSeekAdvisor({ apiKey: "sk-secret-value" }, transport);
  await advisor.review(request());
  assert.equal(JSON.stringify(advisor.stats()).includes("sk-secret-value"), false);
});

test("an HTTP error, a bad payload and a bad choice all degrade to null", async () => {
  const cases: Array<[string, ChatTransport]> = [
    ["http 500", fakeTransport({ error: "boom" }, false, 500).transport],
    ["empty payload", fakeTransport({}).transport],
    ["prose answer", fakeTransport(completion("我觉得应该加注")).transport],
    ["hallucinated action", fakeTransport(completion('{"choice":"shove-9999"}')).transport],
  ];

  for (const [label, transport] of cases) {
    const advisor = new DeepSeekAdvisor({ apiKey: "sk-test" }, transport);
    const verdict = await advisor.review(request());
    assert.equal(verdict, null, `${label} should not produce a verdict`);
    assert.equal(advisor.stats().failures, 1, `${label} should be counted as a failure`);
    assert.equal(advisor.stats().calls, 1);
  }
});

test("a transport that throws is contained and reported without the key", async () => {
  const transport: ChatTransport = async () => {
    throw new Error("socket hang up");
  };
  const advisor = new DeepSeekAdvisor({ apiKey: "sk-secret-value" }, transport);
  assert.equal(await advisor.review(request()), null);
  assert.equal(advisor.stats().failures, 1);
  assert.equal(advisor.stats().lastError, "请求失败");
  assert.equal(JSON.stringify(advisor.stats()).includes("sk-secret-value"), false);
});

test("network permission failures are diagnosed without exposing transport messages", async () => {
  const advisor = new DeepSeekAdvisor({ apiKey: "sk-secret-value" }, async () => {
    throw new Error("request containing sk-secret-value", { cause: { code: "EACCES" } });
  });
  assert.equal(await advisor.review(request()), null);
  assert.equal(advisor.stats().lastError, "运行环境禁止网络访问（EACCES）");
  assert.equal(advisor.stats().successes, 0);
  assert.ok(!JSON.stringify(advisor.stats()).includes("sk-secret-value"));
});

test("a slow model is aborted by the timeout instead of stalling the table", async () => {
  let aborted = false;
  const transport: ChatTransport = (_chatRequest, signal) =>
    new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => {
        aborted = true;
        reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
      });
    });

  const advisor = new DeepSeekAdvisor({ apiKey: "sk-test", timeoutMs: 20 }, transport);
  const started = Date.now();
  const verdict = await advisor.review(request());
  assert.equal(verdict, null);
  assert.equal(aborted, true, "the transport must actually be cancelled");
  assert.ok(Date.now() - started < 2000);
  assert.equal(advisor.stats().lastError, "请求超时");
});

// ------------------------------------------------------- decision integration

function stubAdvisor(choiceId: string | null, talk: string | null = null): { advisor: Advisor; calls: () => number } {
  let calls = 0;
  return {
    calls: () => calls,
    advisor: {
      async review(advisorRequest: AdvisorRequest) {
        calls++;
        if (choiceId === null) return null;
        const candidate = advisorRequest.candidates.find((entry) => entry.id === choiceId);
        if (!candidate) return null;
        return {
          choiceId,
          action: candidate.action,
          talk,
          model: "stub",
          promptTokens: 1,
          completionTokens: 1,
        };
      },
      stats: () => ({
        enabled: true,
        model: "stub",
        calls,
        failures: 0,
        successes: calls,
        promptTokens: calls,
        completionTokens: calls,
        lastError: null,
      }),
    },
  };
}

test("the model is consulted on a key spot and can override the local answer", async () => {
  const { advisor, calls } = stubAdvisor("fold");
  const brain = makeBotDecider(GTO, seededRng(1), { advisor });

  // Facing an all-in: unambiguously a key spot.
  const ctx = context({
    street: "river",
    pot: 150,
    toCall: 200,
    stack: 200,
    legal: legal({ canCheck: false, canCall: true, toCall: 200, callCost: 200, canRaise: false, minRaiseTo: 0, maxRaiseTo: 200 }),
  });

  const action = (await brain(ctx)) as PlayerAction;
  assert.equal(calls(), 1, "the advisor should have been asked");
  assert.deepEqual(action, { type: "fold" }, "the model's choice must be used");
});

test("a routine spot never reaches the model", async () => {
  const { advisor, calls } = stubAdvisor("fold");
  const brain = makeBotDecider(GTO, seededRng(2), { advisor });

  const ctx = context({
    street: "preflop",
    pot: 6,
    toCall: 0,
    stack: 200,
    board: [],
    potOdds: 0,
    legal: legal({ canCheck: true, canCall: false, canRaise: true, minRaiseTo: 4, maxRaiseTo: 200 }),
  });

  const action = (await brain(ctx)) as PlayerAction;
  assert.equal(calls(), 0, "a trivial decision must not cost a token");
  assert.ok(action.type === "check" || action.type === "raise");
});

test("an existing bot uses a newly configured advisor and stops using a disabled one", async () => {
  const first = stubAdvisor("fold");
  const replacement = stubAdvisor("call");
  let current: Advisor | null = null;
  const brain = makeBotDecider(GTO, seededRng(2), { getAdvisor: () => current });
  const ctx = context({
    street: "river", pot: 150, toCall: 200, stack: 200,
    legal: legal({ canCheck: false, canCall: true, toCall: 200, callCost: 200, canRaise: false }),
  });
  await brain(ctx);
  current = first.advisor;
  await brain({ ...ctx, handId: 2 });
  assert.equal(first.calls(), 1, "enabling a model must reach bots created before configuration");
  current = replacement.advisor;
  await brain({ ...ctx, handId: 3 });
  assert.equal(replacement.calls(), 1, "switching the provider must replace the cached backend");
  current = null;
  await brain({ ...ctx, handId: 4 });
  assert.equal(replacement.calls(), 1, "turning the model off must stop further requests");
});

test("token usage is counted even when a paid model response contains an invalid choice", async () => {
  const { transport } = fakeTransport(completion('{"choice":"not-a-candidate"}', 33, 7));
  const advisor = new DeepSeekAdvisor({ apiKey: "sk-test" }, transport);
  assert.equal(await advisor.review(request()), null);
  assert.equal(advisor.stats().promptTokens, 33);
  assert.equal(advisor.stats().completionTokens, 7);
});

test("a failing advisor leaves the local decision untouched", async () => {
  const { advisor, calls } = stubAdvisor(null);
  const brain = makeBotDecider(GTO, seededRng(3), { advisor });
  const ctx = context({
    street: "river",
    pot: 150,
    toCall: 200,
    stack: 200,
    legal: legal({ canCheck: false, canCall: true, toCall: 200, callCost: 200, canRaise: false, minRaiseTo: 0, maxRaiseTo: 200 }),
  });

  const action = (await brain(ctx)) as PlayerAction;
  assert.equal(calls(), 1, "it did ask");
  assert.ok(["fold", "call"].includes(action.type), `expected a legal local action, got ${action.type}`);
});

test("the per-hand call budget caps spending", async () => {
  const { advisor, calls } = stubAdvisor("fold");
  const brain = makeBotDecider(GTO, seededRng(4), { advisor, maxAdvisorCallsPerHand: 2 });
  const ctx = context({
    street: "river",
    pot: 150,
    toCall: 200,
    stack: 200,
    legal: legal({ canCheck: false, canCall: true, toCall: 200, callCost: 200, canRaise: false, minRaiseTo: 0, maxRaiseTo: 200 }),
  });

  for (let attempt = 0; attempt < 5; attempt++) await brain(ctx);
  assert.equal(calls(), 2, "the third and later key spots in a hand must stay local");

  // A new hand resets the budget.
  await brain({ ...ctx, handId: 2 });
  assert.equal(calls(), 3);
});

test("table talk from the model is surfaced exactly once", async () => {
  const { advisor } = stubAdvisor("fold", "这把你 bluff 我？");
  const heard: string[] = [];
  const brain = makeBotDecider(GTO, seededRng(5), { advisor, onTalk: (text) => heard.push(text) });
  const ctx = context({
    street: "river",
    pot: 150,
    toCall: 200,
    stack: 200,
    legal: legal({ canCheck: false, canCall: true, toCall: 200, callCost: 200, canRaise: false, minRaiseTo: 0, maxRaiseTo: 200 }),
  });

  await brain(ctx);
  assert.deepEqual(heard, ["这把你 bluff 我？"]);
});

test("candidates are always legal, distinct and ordered from passive to all-in", () => {
  const ctx = context({
    pot: 100,
    legal: legal({ canCheck: false, canCall: true, toCall: 50, callCost: 50, canRaise: true, minRaiseTo: 100, maxRaiseTo: 400 }),
  });
  const candidates = buildCandidates(ctx);
  const ids = candidates.map((candidate) => candidate.id);

  assert.deepEqual(ids, ["fold", "call", "raise-small", "raise-big", "allin"]);
  assert.equal(new Set(ids).size, ids.length, "ids must be unique or the model could pick twice");

  for (const candidate of candidates) {
    if (candidate.action.type !== "raise") continue;
    assert.ok(candidate.action.to >= 100 && candidate.action.to <= 400, `${candidate.id} is out of range`);
  }
  const raises = candidates.filter((c) => c.action.type === "raise").map((c) => (c.action as { to: number }).to);
  assert.deepEqual(raises, [...raises].sort((a, b) => a - b), "sizes must increase");
});

test("a short stack gets no impossible candidates", () => {
  const ctx = context({
    stack: 30,
    pot: 60,
    legal: legal({ canCheck: false, canCall: true, toCall: 20, callCost: 20, canRaise: false, canAllIn: true, minRaiseTo: 0, maxRaiseTo: 30 }),
  });
  const ids = buildCandidates(ctx).map((candidate) => candidate.id);
  assert.deepEqual(ids, ["fold", "call"], "with no raise available the menu is just fold or call");
});

// --------------------------------------------------------- real HTTP round trip

test("the full HTTP path works against an OpenAI-compatible endpoint", async () => {
  const received: Array<{ headers: Record<string, string | string[] | undefined>; body: string }> = [];

  // A stand-in for the real API: same shape, no network, no credentials.
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      received.push({ headers: request.headers, body: Buffer.concat(chunks).toString("utf8") });
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          id: "chatcmpl-mock",
          choices: [{ index: 0, message: { role: "assistant", content: '{"choice":"raise-big","talk":"加注。"}' } }],
          usage: { prompt_tokens: 210, completion_tokens: 18 },
        }),
      );
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;

  try {
    const advisor = new DeepSeekAdvisor({
      apiKey: "sk-integration-test",
      baseUrl: `http://127.0.0.1:${port}`,
      timeoutMs: 3000,
    });

    const ctx = context({
      pot: 120,
      stack: 400,
      legal: legal({ canCheck: false, canCall: true, toCall: 50, callCost: 50, canRaise: true, minRaiseTo: 100, maxRaiseTo: 400 }),
    });
    const verdict = await advisor.review(request({ context: ctx }));

    assert.equal(verdict?.choiceId, "raise-big");
    assert.equal(verdict?.action.type, "raise");
    assert.ok(verdict !== null && verdict.action.type === "raise" && verdict.action.to <= 400, "the action must stay legal");
    assert.equal(verdict?.talk, "加注。");
    assert.equal(verdict?.promptTokens, 210);
    assert.equal(verdict?.completionTokens, 18);

    // The wire format is what the real API expects.
    assert.equal(received.length, 1);
    assert.equal(received[0]!.headers.authorization, "Bearer sk-integration-test");
    assert.equal(received[0]!.headers["content-type"], "application/json");

    const body = JSON.parse(received[0]!.body) as {
      model: string;
      messages: Array<{ role: string; content: string }>;
      response_format: { type: string };
      max_tokens: number;
    };
    assert.equal(body.model, "deepseek-chat");
    assert.equal(body.messages.length, 2);
    assert.equal(body.messages[0]!.role, "system");
    assert.equal(body.messages[1]!.role, "user");
    assert.equal(body.response_format.type, "json_object");
    assert.ok(body.max_tokens <= 400, "the answer must stay short to stay cheap");
    assert.equal(received[0]!.body.includes("sk-integration-test"), false, "the key must not be in the body");

    assert.equal(advisor.stats().calls, 1);
    assert.equal(advisor.stats().failures, 0);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("a 429 from the provider degrades quietly", async () => {
  const server = createServer((_request, response) => {
    response.writeHead(429, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: { message: "rate limited" } }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;

  try {
    const advisor = new DeepSeekAdvisor({ apiKey: "sk-test", baseUrl: `http://127.0.0.1:${port}`, timeoutMs: 2000 });
    assert.equal(await advisor.review(request()), null);
    assert.equal(advisor.stats().failures, 1);
    assert.equal(advisor.stats().lastError, "HTTP 429");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
