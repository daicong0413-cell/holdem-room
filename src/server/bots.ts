/**
 * Personality-driven bot brains.
 *
 * A persona is a small set of numbers, not a prompt. Every decision starts in
 * the maths layer: equity against the live opponents, compared with what the pot
 * is charging. That answer is always available and always cheap.
 *
 * When configured, the model chooses every action from the legal candidates.
 * If the model is slow, down, rate-limited
 * or returns nonsense, the local answer is used and play continues.
 *
 * Keeping the character in parameters also means a bot plays consistently
 * between model calls instead of re-inventing itself every street.
 */

import type { Rng } from "../engine/cards.ts";
import { equity } from "../engine/equity.ts";
import type { PlayerAction } from "../engine/table.ts";
import type { Advisor, AdvisorRequest, AdvisorVerdict, CandidateAction } from "./advisor.ts";
import type { BotContext, PersonaInfo } from "./room.ts";
import { classifySpot } from "./spots.ts";

export interface PersonaConfig extends PersonaInfo {
  /** 0 = plays almost everything, 1 = only premium holdings. */
  readonly tightness: number;
  /** 0 = passive caller, 1 = raises and re-raises relentlessly. */
  readonly aggression: number;
  /** 0 = never bluffs, 1 = fires often with nothing. */
  readonly bluff: number;
  /** Monte Carlo trials per decision; higher is steadier and slower. */
  readonly iterations: number;
  /** Multiplies how patiently the character waits for a call. */
  readonly callThreshold: number;
}

export const PERSONAS: readonly PersonaConfig[] = [
  {
    id: "gto",
    name: "GTOpro",
    description: "以底池赔率为基准的稳健型，几乎不情绪化，边缘牌处理得很克制。",
    tightness: 0.62,
    aggression: 0.45,
    bluff: 0.28,
    iterations: 2500,
    callThreshold: 1.0,
  },
  {
    id: "lag",
    name: "Fish",
    description: "入池范围极宽，翻后持续施压，会用大量半诈唬把对手逼到墙角。",
    tightness: 0.18,
    aggression: 0.9,
    bluff: 0.72,
    iterations: 2000,
    callThreshold: 0.82,
  },
  {
    id: "rock",
    name: "Rock",
    description: "只玩强牌，被加注就跑，赢小输更小。",
    tightness: 0.88,
    aggression: 0.18,
    bluff: 0.05,
    iterations: 1500,
    callThreshold: 1.35,
  },
  {
    id: "tanxuan",
    name: "Tang Xuan",
    description: "大尺度、高压制，敢于在河牌用超池下注代表两极化范围。",
    tightness: 0.34,
    aggression: 0.82,
    bluff: 0.6,
    iterations: 2200,
    callThreshold: 0.9,
  },
  {
    id: "elton",
    name: "Alton",
    description: "读牌细腻，擅长小额控池与精准的价值下注，很少失控。",
    tightness: 0.55,
    aggression: 0.5,
    bluff: 0.22,
    iterations: 2600,
    callThreshold: 1.05,
  },
];

export function findPersona(id: string): PersonaConfig {
  const persona = PERSONAS.find((candidate) => candidate.id === id);
  if (!persona) throw new Error(`未知的人格：${id}`);
  return persona;
}

export interface BotDeciderOptions {
  /** When present, every decision is put to the language model. */
  readonly advisor?: Advisor | undefined;
  /** Resolves the current backend after an operator changes live configuration. */
  readonly getAdvisor?: () => Advisor | null;
}

export type BotBrain = (context: BotContext) => PlayerAction | Promise<PlayerAction>;

export function makeBotDecider(
  config: PersonaConfig,
  rng: Rng,
  options: BotDeciderOptions = {},
): BotBrain {
  return (context: BotContext): PlayerAction | Promise<PlayerAction> => {
    const liveOpponents = Math.max(1, context.opponents.filter((opponent) => !opponent.folded).length);

    const simulation = equity({
      hero: context.hole,
      board: context.board,
      opponents: liveOpponents,
      iterations: config.iterations,
      rng,
      tolerance: 0.012,
    });
    const strength = simulation.equity;

    // What the pot is charging, adjusted for temperament: a loose-aggressive
    // character needs less, a rock needs a lot more.
    const required = context.potOdds * config.callThreshold * (1.15 - config.aggression * 0.3);
    const local = chooseLocally(context, config, strength, required, rng);

    const advisor = options.getAdvisor ? options.getAdvisor() : options.advisor;
    if (advisor == null || context.signal?.aborted) return local;

    const spot = classifySpot({
      street: context.street,
      pot: context.pot,
      toCall: context.legal.callCost,
      stack: context.stack,
      bigBlind: context.bigBlind,
      opponents: liveOpponents,
      legal: context.legal,
      equity: strength,
      requiredEquity: required,
    });
    const request: AdvisorRequest = {
      persona: config,
      context,
      candidates: buildCandidates(context),
      equity: strength,
      requiredEquity: required,
      reasons: spot.reasons.length > 0 ? spot.reasons : ["常规行动；所有行动均由模型决策"],
    };
    return consult(advisor, request, local);
  };
}

/** Awaits the model; any failure falls back to the locally computed action. */
async function consult(
  advisor: Advisor,
  request: AdvisorRequest,
  local: PlayerAction,
): Promise<PlayerAction> {
  try {
    const verdict: AdvisorVerdict | null = await advisor.review(request);
    return verdict?.action ?? local;
  } catch {
    return local;
  }
}

/**
 * The menu handed to the model: only legal actions, with sizes derived from the
 * pot so the choices are meaningfully different rather than arbitrary numbers.
 */
export function buildCandidates(context: BotContext): CandidateAction[] {
  const { legal } = context;
  const candidates: CandidateAction[] = [{ id: "fold", label: "弃牌", action: { type: "fold" } }];

  if (legal.canCheck) candidates.push({ id: "check", label: "过牌", action: { type: "check" } });
  if (legal.canCall) {
    candidates.push({
      id: "call",
      label: `跟注 ${legal.callCost}${legal.callCost < legal.toCall ? "（全下，不足额）" : ""}`,
      action: { type: "call" },
    });
  }

  if (legal.canRaise) {
    const size = (fraction: number): number =>
      Math.min(legal.maxRaiseTo, Math.max(legal.minRaiseTo, Math.round(legal.minRaiseTo + context.pot * fraction)));

    const small = size(0.4);
    const big = size(1.1);
    candidates.push({ id: "raise-small", label: `加注到 ${small}（约四成底池）`, action: { type: "raise", to: small } });
    if (big > small) {
      candidates.push({ id: "raise-big", label: `加注到 ${big}（约一个底池）`, action: { type: "raise", to: big } });
    }
    if (legal.maxRaiseTo > big) {
      candidates.push({ id: "allin", label: `全下 ${legal.maxRaiseTo}`, action: { type: "raise", to: legal.maxRaiseTo } });
    }
  }

  return candidates;
}

/** The pure, always-available decision. No I/O, no model, fully deterministic. */
export function chooseLocally(
  context: BotContext,
  config: PersonaConfig,
  strength: number,
  required: number,
  rng: Rng,
): PlayerAction {
  const roll = rng();

  if (context.legal.canCheck) {
    const wantsValue = strength > 0.62 + config.tightness * 0.1;
    const wantsBluff = strength < 0.38 && roll < config.bluff * 0.22;
    if (context.legal.canRaise && ((wantsValue && roll < config.aggression) || wantsBluff)) {
      return { type: "raise", to: betSize(context, config, wantsBluff ? 0.75 : 0.6) };
    }
    return { type: "check" };
  }

  const canContinue = strength >= required;
  const wantsRaise = strength > required + 0.18 && roll < 0.35 + config.aggression * 0.35;
  const bluffRaise = !canContinue && context.legal.canRaise && roll < config.bluff * 0.16;

  if (context.legal.canRaise && (wantsRaise || bluffRaise)) {
    return { type: "raise", to: betSize(context, config, bluffRaise ? 0.85 : 0.65) };
  }
  if (canContinue && context.legal.canCall) return { type: "call" };
  if (!canContinue && roll < config.bluff * 0.08 && context.legal.canCall) return { type: "call" };
  return { type: "fold" };
}

/** Chooses a legal raise target around a fraction of the pot. */
function betSize(context: BotContext, config: PersonaConfig, potFraction: number): number {
  const { legal } = context;
  if (legal.maxRaiseTo <= legal.minRaiseTo) return legal.maxRaiseTo;
  const raw = legal.minRaiseTo + context.pot * potFraction * (0.8 + config.aggression * 0.6);
  return Math.min(legal.maxRaiseTo, Math.max(legal.minRaiseTo, Math.round(raw)));
}

export function personaInfos(): PersonaInfo[] {
  return PERSONAS.map((persona) => ({
    id: persona.id,
    name: persona.name,
    ...(persona.description === undefined ? {} : { description: persona.description }),
  }));
}
