/**
 * The language-model layer.
 *
 * Design rule: **the model chooses, it does not calculate.** By the time a
 * request is built, the maths layer has already computed equity, pot odds and a
 * set of concrete legal candidates. The model's entire job is to pick one of
 * them, in character. Bots never post model output in the chat. That keeps the
 * prompt small (~200 tokens), the answer validatable, and the poker correct.
 *
 * The transport is injectable so the whole thing is testable without a network,
 * and every failure path returns `null` so the caller falls back to the local
 * decision. The bot must never stall because an API is down.
 *
 * The API key is only ever placed in a request header. It is never logged, never
 * included in an error message, and never sent to the client.
 */

import { cardToString } from "../engine/cards.ts";
import type { PlayerAction } from "../engine/table.ts";
import type { BotContext } from "./room.ts";

/** The subset of a persona the prompt actually needs. */
export interface AdvisorPersona {
  readonly id: string;
  readonly name: string;
  readonly description?: string;
  readonly aggression: number;
  readonly tightness: number;
  readonly bluff: number;
}

export interface CandidateAction {
  readonly id: string;
  /** Human-readable label handed to the model, e.g. "加注到 120". */
  readonly label: string;
  readonly action: PlayerAction;
}

export interface AdvisorRequest {
  readonly persona: AdvisorPersona;
  readonly context: BotContext;
  readonly candidates: readonly CandidateAction[];
  readonly equity: number;
  readonly requiredEquity: number;
  readonly reasons: readonly string[];
}

export interface AdvisorVerdict {
  readonly choiceId: string;
  readonly action: PlayerAction;
  readonly talk: string | null;
  readonly model: string;
  readonly promptTokens: number;
  readonly completionTokens: number;
}

export interface AdvisorStatsView {
  readonly enabled: boolean;
  readonly model: string;
  readonly calls: number;
  readonly failures: number;
  readonly successes: number;
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly lastError: string | null;
}

export interface Advisor {
  review(request: AdvisorRequest): Promise<AdvisorVerdict | null>;
  stats(): AdvisorStatsView;
}

export interface ChatRequest {
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: unknown;
}

export interface ChatResponse {
  readonly ok: boolean;
  readonly status: number;
  readonly json: unknown;
}

export type ChatTransport = (request: ChatRequest, signal: AbortSignal) => Promise<ChatResponse>;

export interface DeepSeekConfig {
  readonly apiKey: string;
  readonly model?: string;
  readonly baseUrl?: string;
  readonly timeoutMs?: number;
  readonly maxTokens?: number;
  readonly temperature?: number;
}

interface ResolvedConfig {
  readonly apiKey: string;
  readonly model: string;
  readonly baseUrl: string;
  readonly timeoutMs: number;
  readonly maxTokens: number;
  readonly temperature: number;
}

export const DEFAULT_MODEL = "deepseek-chat";
export const DEFAULT_BASE_URL = "https://api.deepseek.com";

/** Real transport: a single POST, with the caller owning cancellation. */
export const fetchTransport: ChatTransport = async (request, signal) => {
  const response = await fetch(request.url, {
    method: "POST",
    headers: { ...request.headers },
    body: JSON.stringify(request.body),
    signal,
  });
  let json: unknown = null;
  try {
    json = await response.json();
  } catch {
    json = null;
  }
  return { ok: response.ok, status: response.status, json };
};

export class DeepSeekAdvisor implements Advisor {
  private readonly config: ResolvedConfig;
  private readonly transport: ChatTransport;
  private counters = { calls: 0, failures: 0, successes: 0, promptTokens: 0, completionTokens: 0 };
  private lastError: string | null = null;

  constructor(config: DeepSeekConfig, transport: ChatTransport = fetchTransport) {
    this.config = {
      apiKey: config.apiKey,
      model: config.model ?? DEFAULT_MODEL,
      baseUrl: (config.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, ""),
      timeoutMs: config.timeoutMs ?? 6000,
      maxTokens: config.maxTokens ?? 160,
      temperature: config.temperature ?? 0.9,
    };
    this.transport = transport;
  }

  stats(): AdvisorStatsView {
    return {
      enabled: true,
      model: this.config.model,
      calls: this.counters.calls,
      failures: this.counters.failures,
      successes: this.counters.successes,
      promptTokens: this.counters.promptTokens,
      completionTokens: this.counters.completionTokens,
      lastError: this.lastError,
    };
  }

  async review(request: AdvisorRequest): Promise<AdvisorVerdict | null> {
    this.counters.calls++;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.timeoutMs);

    try {
      const body = {
        model: this.config.model,
        messages: [
          { role: "system", content: buildSystemPrompt(request.persona) },
          { role: "user", content: buildUserPrompt(request) },
        ],
        temperature: this.config.temperature,
        max_tokens: this.config.maxTokens,
        response_format: { type: "json_object" },
      };

      const response = await this.transport(
        {
          url: `${this.config.baseUrl}/chat/completions`,
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${this.config.apiKey}`,
          },
          body,
        },
        request.context.signal ? AbortSignal.any([controller.signal, request.context.signal]) : controller.signal,
      );

      // The provider can bill a response even when its action fails validation.
      const usage = extractUsage(response.json);
      this.counters.promptTokens += usage.promptTokens;
      this.counters.completionTokens += usage.completionTokens;

      if (!response.ok) {
        this.counters.failures++;
        this.lastError = `HTTP ${response.status}`;
        return null;
      }

      const content = extractMessageContent(response.json);
      if (content === null) {
        this.counters.failures++;
        this.lastError = "响应里没有可用的文本";
        return null;
      }

      const parsed = parseVerdict(
        content,
        request.candidates.map((candidate) => candidate.id),
      );
      if (parsed === null) {
        this.counters.failures++;
        this.lastError = "模型没有给出合法的候选动作";
        return null;
      }

      this.lastError = null;

      const chosen = request.candidates.find((candidate) => candidate.id === parsed.choiceId);
      if (!chosen) {
        this.counters.failures++;
        return null;
      }
      this.counters.successes++;

      return {
        choiceId: chosen.id,
        action: chosen.action,
        talk: parsed.talk,
        model: this.config.model,
        promptTokens: usage.promptTokens,
        completionTokens: usage.completionTokens,
      };
    } catch (error) {
      this.counters.failures++;
      // Deliberately narrow: a network error message must never carry the key.
      this.lastError = describeTransportError(error);
      return null;
    } finally {
      clearTimeout(timer);
    }
  }
}

/** Reports only known error codes; transport messages can contain credentials. */
export function describeTransportError(error: unknown): string {
  if (error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError")) return "请求超时";
  if (typeof error !== "object" || error === null) return "请求失败";
  const record = error as { code?: unknown; cause?: { code?: unknown } };
  const code = record.cause?.code ?? record.code;
  switch (code) {
    case "EACCES": case "EPERM": return `运行环境禁止网络访问（${code}）`;
    case "ENOTFOUND": case "EAI_AGAIN": return `域名解析失败（${code}）`;
    case "ECONNREFUSED": return "连接被拒绝（ECONNREFUSED）";
    case "ETIMEDOUT": case "UND_ERR_CONNECT_TIMEOUT": return "网络连接超时";
    case "ECONNRESET": return "网络连接中断（ECONNRESET）";
    case "CERT_HAS_EXPIRED": case "UNABLE_TO_VERIFY_LEAF_SIGNATURE": return "接口证书验证失败";
    default: return "请求失败";
  }
}

/** A synthetic one-choice probe, independent of any room or player's cards. */
export function connectionTestRequest(): AdvisorRequest {
  return {
    persona: { id: "connection-test", name: "连接测试", description: "这是接口测试，请选择 check。", aggression: 0, tightness: 0, bluff: 0 },
    context: {
      seatIndex: 0, handId: 0, hole: [], board: [], street: "preflop", stack: 0,
      committed: 0, pot: 0, toCall: 0, potOdds: 0, bigBlind: 2, opponents: [], history: [],
      legal: { seatIndex: 0, toCall: 0, callCost: 0, canFold: true, canCheck: true, canCall: false, canRaise: false, canAllIn: false, minRaiseTo: 0, maxRaiseTo: 0 },
    },
    candidates: [{ id: "check", label: "Check", action: { type: "check" } }],
    equity: 0, requiredEquity: 0, reasons: ["测试接口连接，无实际对局数据"],
  };
}

export function buildSystemPrompt(persona: AdvisorPersona): string {
  const description = persona.description ?? "风格中性的稳健牌手";
  return [
    `你是一位德州扑克牌手，代号「${persona.name}」。`,
    `你的打法特征：${description}`,
    `参数（0 到 1）：激进度 ${persona.aggression}，紧度 ${persona.tightness}，诈唬倾向 ${persona.bluff}。`,
    "",
    "要求：",
    "1. 只能从候选动作里选一个，不能发明新的下注额。",
    "2. 必须以 JSON 回复，格式：{\"choice\": \"<候选 id>\"}",
    "3. 不要输出聊天、对白或赔率解释，不要输出 JSON 以外的任何内容。",
  ].join("\n");
}

export function buildUserPrompt(request: AdvisorRequest): string {
  const { context, persona } = request;
  const board = context.board.length > 0 ? context.board.map(cardToString).join(" ") : "（还没发公共牌）";
  const hole = context.hole.map(cardToString).join(" ");
  const live = context.opponents.filter((opponent) => !opponent.folded);

  const lines = [
    "当前牌局（无限注德州扑克）",
    `街道：${streetName(context.street)}`,
    `你的底牌：${hole}`,
    `公共牌：${board}`,
    `底池：${context.pot}`,
    `需要跟注：${context.toCall}${context.toCall > 0 ? `（底池赔率要求胜率 ${rate(request.requiredEquity)}）` : "（无需跟注）"}`,
    `你的筹码：${context.stack}`,
    `仍在局中的对手：${live.length} 人${
      live.length > 0 ? `（筹码 ${live.map((opponent) => opponent.stack).join(" / ")}）` : ""
    }`,
    "",
    `本地蒙特卡洛估算你的胜率：${rate(request.equity)}`,
    `行动背景：${request.reasons.join("；")}`,
    "",
    "候选动作：",
    ...request.candidates.map((candidate) => `- ${candidate.id}：${candidate.label}`),
    "",
    `请以「${persona.name}」的身份从上面选一个，只回复 JSON。`,
  ];
  return lines.join("\n");
}

function streetName(street: string): string {
  switch (street) {
    case "preflop":
      return "翻牌前";
    case "flop":
      return "翻牌圈";
    case "turn":
      return "转牌圈";
    case "river":
      return "河牌圈";
    default:
      return street;
  }
}

const rate = (value: number): string => `${(value * 100).toFixed(1)}%`;

/** Pulls `choices[0].message.content` out of an OpenAI-compatible payload. */
export function extractMessageContent(payload: unknown): string | null {
  if (typeof payload !== "object" || payload === null) return null;
  const choices = (payload as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) return null;
  const message = (choices[0] as { message?: unknown }).message;
  if (typeof message !== "object" || message === null) return null;
  const content = (message as { content?: unknown }).content;
  return typeof content === "string" && content.trim().length > 0 ? content : null;
}

export function extractUsage(payload: unknown): { promptTokens: number; completionTokens: number } {
  if (typeof payload !== "object" || payload === null) return { promptTokens: 0, completionTokens: 0 };
  const usage = (payload as { usage?: unknown }).usage;
  if (typeof usage !== "object" || usage === null) return { promptTokens: 0, completionTokens: 0 };
  const prompt = (usage as { prompt_tokens?: unknown }).prompt_tokens;
  const completion = (usage as { completion_tokens?: unknown }).completion_tokens;
  return {
    promptTokens: typeof prompt === "number" ? prompt : 0,
    completionTokens: typeof completion === "number" ? completion : 0,
  };
}

/** Finds the first JSON object in a string, tolerating code fences and prose. */
export function extractJsonObject(text: string): Record<string, unknown> | null {
  const direct = tryParse(text);
  if (direct !== null) return direct;

  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  return tryParse(text.slice(start, end + 1));
}

function tryParse(text: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(text.trim());
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/**
 * Validates a model reply against the candidate list. Anything that is not an
 * exact (case-insensitive) candidate id is rejected, so a hallucinated bet size
 * can never reach the table.
 */
export function parseVerdict(
  text: string,
  validIds: readonly string[],
): { choiceId: string; talk: string | null } | null {
  const json = extractJsonObject(text);
  if (json === null) return null;

  const rawChoice = typeof json.choice === "string" ? json.choice.trim() : "";
  const match = validIds.find((id) => id.toLowerCase() === rawChoice.toLowerCase());
  if (match === undefined) return null;

  const rawTalk = typeof json.talk === "string" ? json.talk.trim() : "";
  const talk = rawTalk.length > 0 ? rawTalk.slice(0, 40) : null;
  return { choiceId: match, talk };
}
