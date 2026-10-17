import {
  type CSSProperties,
  type FormEvent,
  type ReactElement,
  type RefObject,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { allInIsDistinct, potBetAmount } from "./betting.ts";
import { readBackendJson } from "./backend.ts";
import { displayCard, displayRank, handLabelEn, handNameZh, isRedSuit, money, streetLabelZh, SUIT_SYMBOLS } from "../shared/format.ts";
import type { AdvisorStatsView } from "../server/advisor.ts";
import type {
  ClientMessage,
  GameMode,
  HandHistoryEntry,
  RoomSettingsPatch,
  SeatView,
  ServerMessage,
  TableView,
} from "../server/protocol.ts";

const TOKEN_KEY = "holdem.token";
const NAME_KEY = "holdem.name";

interface PersonaInfo {
  id: string;
  name: string;
  description?: string;
}

/** What the server has configured for the model backend. Never the key. */
interface LlmStatus {
  enabled: boolean;
  /** Always the model actually in use, defaults resolved by the server. */
  model: string;
  baseUrl: string;
  /** True only when this browser is on the machine running the server. */
  configurable: boolean;
  stats?: AdvisorStatsView | null;
}

function LlmActivity({ status, onUpdate }: { status: LlmStatus; onUpdate: (next: LlmStatus) => void }): ReactElement | null {
  const [testing, setTesting] = useState(false);
  const [testError, setTestError] = useState<string | null>(null);
  if (!status.enabled) return null;
  const stats = status.stats;
  const calls = stats?.calls ?? 0;
  const failures = stats?.failures ?? 0;
  const successes = stats?.successes ?? 0;
  const pending = Math.max(0, calls - failures - successes);

  const test = async (): Promise<void> => {
    setTesting(true);
    setTestError(null);
    try {
      const response = await fetch("/api/llm/test", { method: "POST", headers: { "content-type": "application/json" } });
      const payload = await response.json() as { ok?: boolean; error?: string; status?: LlmStatus };
      if (payload.status) onUpdate(payload.status);
      if (!response.ok || (!payload.ok && !payload.status)) setTestError(payload.error ?? "连接测试失败");
    } catch {
      setTestError("无法连接游戏服务");
    } finally {
      setTesting(false);
    }
  };

  return (
    <div className="llm-activity">
      <div className="llm-activity-head">
        <strong>API 调用</strong>
        <span>{calls === 0 ? "等待关键决策" : pending > 0 ? `${pending} 次请求中` : stats?.lastError ? "最近调用失败" : "已成功调用"}</span>
      </div>
      <div className="llm-counts"><span>总计 {calls}</span><span>成功 {successes}</span><span>失败 {failures}</span></div>
      <div className="llm-tokens" title="接口返回的累计 token；重启服务或更换配置后清零。包含格式不合法但接口已返回的响应。">
        Token · 输入 {(stats?.promptTokens ?? 0).toLocaleString("en-US")} / 输出 {(stats?.completionTokens ?? 0).toLocaleString("en-US")}
      </div>
      {testError || stats?.lastError ? <p className="llm-diagnostic" role="status">{testError ?? stats?.lastError}</p> : null}
      {status.configurable ? <button type="button" className="ghost llm-test" onClick={() => void test()} disabled={testing}
        title="测试当前已保存的配置，会产生一次请求和少量 token 用量。">{testing ? "正在测试…" : "测试连接"}</button> : null}
    </div>
  );
}

interface SettingsBounds {
  [key: string]: { min: number; max: number };
}

interface ServerConfig {
  defaults: Required<RoomSettingsPatch>;
  bounds: SettingsBounds;
}

interface ChatLine {
  from: string;
  text: string;
}

type Status = "idle" | "connecting" | "open" | "closed";

const FALLBACK_BOUNDS: SettingsBounds = {
  seats: { min: 2, max: 9 },
  smallBlind: { min: 1, max: 100_000 },
  bigBlind: { min: 2, max: 200_000 },
  startingStack: { min: 20, max: 1_000_000 },
  actionTimeoutMs: { min: 0, max: 600_000 },
  blindLevelHands: { min: 1, max: 100 },
  blindGrowth: { min: 1, max: 10 },
};

// ---------------------------------------------------------------------- cards

function Card({
  card,
  size = "md",
  isBest = false,
  dealIndex = 0,
}: {
  card: string;
  size?: "sm" | "md" | "lg";
  /** Part of the five cards that actually made the winning hand. */
  isBest?: boolean;
  /** Position on the board, used to fan the flop out instead of dealing it flat. */
  dealIndex?: number;
}): ReactElement {
  const rank = displayRank(card[0] ?? "?");
  const suit = SUIT_SYMBOLS[card[1]?.toLowerCase() ?? ""] ?? "?";
  const red = isRedSuit(card);
  // The flop fans out; later streets just turn over one card at a time.
  const dealDelay = dealIndex < 3 ? dealIndex * 110 : 0;

  return (
    <span
      className={`card card-${size}${isBest ? " is-best" : ""}`}
      style={{ "--deal-delay": `${dealDelay}ms` } as CSSProperties}
    >
      {/* Dealt face down, then turned over to reveal the rank and suit. */}
      <span className="card-inner">
        <span className="flip-face flip-back" aria-hidden="true" />
        <span className={`flip-face flip-front ${red ? "is-red" : "is-black"}`}>
          <span className="card-corner card-corner-tl">
            <span className="card-rank">{rank}</span>
            <span className="card-suit">{suit}</span>
          </span>
          <span className="card-pip">{suit}</span>
          <span className="card-corner card-corner-br">
            <span className="card-rank">{rank}</span>
            <span className="card-suit">{suit}</span>
          </span>
        </span>
      </span>
    </span>
  );
}

function CardBack({ size = "sm" }: { size?: "sm" | "md" | "lg" }): ReactElement {
  return <span className={`card card-${size} card-back`} aria-label="暗牌" />;
}

// ------------------------------------------------------------------ geometry

/** The felt is laid out once at this size, then scaled to fit the window. */
const FELT_BASE_WIDTH = 980;
const FELT_BASE_HEIGHT = 605;
/** Room left around the felt for the wooden rail and its shadow. */
const FELT_RAIL = 22;

/**
 * Scales the whole table — felt, seats, cards, text — to fill the space the
 * window gives it, so going fullscreen actually makes the table bigger.
 *
 * Two things make this stable in both directions (grow *and* shrink):
 * the box being measured is the table area itself, whose size comes from the
 * app shell and not from its contents; and the scaled felt is absolutely
 * positioned, so it can never feed its own size back into the measurement.
 */
function useFeltScale(): { ref: RefObject<HTMLElement | null>; scale: number } {
  const ref = useRef<HTMLElement>(null);
  const [scale, setScale] = useState(1);

  useEffect(() => {
    const area = ref.current;
    if (!area) return;

    const measure = (): void => {
      const rect = area.getBoundingClientRect();
      const style = getComputedStyle(area);
      const available = {
        width:
          rect.width -
          parseFloat(style.paddingLeft) -
          parseFloat(style.paddingRight) -
          FELT_RAIL * 2,
        height:
          rect.height -
          parseFloat(style.paddingTop) -
          parseFloat(style.paddingBottom) -
          FELT_RAIL * 2,
      };
      if (available.width <= 0 || available.height <= 0) return;
      const fit = Math.min(available.width / FELT_BASE_WIDTH, available.height / FELT_BASE_HEIGHT);
      setScale(Math.max(0.2, Math.min(fit, 2.4)));
    };

    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(area);
    window.addEventListener("resize", measure);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, []);

  return { ref, scale };
}

function seatSlot(viewerSeat: number | null, seatIndex: number, total: number): number {
  if (viewerSeat === null || viewerSeat < 0) return seatIndex;
  return (seatIndex - viewerSeat + total) % total;
}

function slotPosition(slot: number, total: number, radiusX: number, radiusY: number): { left: string; top: string } {
  const angle = Math.PI / 2 + (slot * 2 * Math.PI) / total;
  return { left: `${50 + radiusX * Math.cos(angle)}%`, top: `${50 + radiusY * Math.sin(angle)}%` };
}

function blindSeats(view: TableView): { small: number | null; big: number | null } {
  const active = view.seats.filter((seat) => seat.inHand).map((seat) => seat.index);
  if (active.length < 2) return { small: null, big: null };

  const total = view.seats.length;
  const after = (from: number, skip = 0): number | null => {
    let seen = 0;
    for (let step = 1; step <= total; step++) {
      const index = (from + step) % total;
      if (!active.includes(index)) continue;
      if (seen === skip) return index;
      seen++;
    }
    return null;
  };

  if (active.length === 2) return { small: view.buttonIndex, big: after(view.buttonIndex) };
  const small = after(view.buttonIndex);
  return { small, big: small === null ? null : after(small) };
}

// -------------------------------------------------------------------- socket

function useGame(): {
  status: Status;
  view: TableView | null;
  notice: string | null;
  connectionError: string | null;
  chat: ChatLine[];
  historyEntry: HandHistoryEntry | null;
  send: (message: ClientMessage) => void;
  connect: (room: string, name: string) => void;
  disconnect: () => void;
  requestHistory: (handId: number) => void;
  closeHistory: () => void;
  dismissNotice: () => void;
} {
  const [status, setStatus] = useState<Status>("idle");
  const [view, setView] = useState<TableView | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [connectionError, setConnectionError] = useState<string | null>(null);

  // Notices used to stay up until dismissed by hand. A few seconds is enough to
  // read one, and a new notice replaces it.
  useEffect(() => {
    if (notice === null) return;
    const timer = setTimeout(() => setNotice(null), 3000);
    return () => clearTimeout(timer);
  }, [notice]);
  const [chat, setChat] = useState<ChatLine[]>([]);
  const [historyEntry, setHistoryEntry] = useState<HandHistoryEntry | null>(null);
  const socketRef = useRef<WebSocket | null>(null);
  /** Non-null while we intend to be connected; drives automatic reconnection. */
  const retry = useRef<{ room: string; name: string; attempt: number; timer: number | null; hasConnected: boolean } | null>(null);
  const openRef = useRef<(room: string, name: string) => void>(() => undefined);

  const send = useCallback((message: ClientMessage) => {
    const socket = socketRef.current;
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
  }, []);

  openRef.current = (room: string, name: string): void => {
    const scheme = window.location.protocol === "https:" ? "wss" : "ws";
    const socket = new WebSocket(`${scheme}://${window.location.host}/ws`);
    socketRef.current = socket;
    const connectTimeout = window.setTimeout(() => {
      if (socketRef.current === socket) socket.close();
    }, 8000);

    socket.onopen = () => {
      if (socketRef.current !== socket) return;
      const token = localStorage.getItem(TOKEN_KEY);
      socket.send(JSON.stringify({ t: "hello", room, name, ...(token ? { token } : {}) }));
    };

    socket.onmessage = (event) => {
      if (socketRef.current !== socket) return;
      let message: ServerMessage;
      try {
        message = JSON.parse(String(event.data)) as ServerMessage;
      } catch {
        return;
      }
      switch (message.t) {
        case "welcome":
          window.clearTimeout(connectTimeout);
          setConnectionError(null);
          localStorage.setItem(TOKEN_KEY, message.token);
          if (retry.current) {
            retry.current.room = message.roomCode;
            retry.current.name = message.name;
            retry.current.attempt = 0;
            retry.current.hasConnected = true;
          }
          setStatus("open");
          window.history.replaceState(null, "", `?room=${message.roomCode}`);
          break;
        case "state":
          setView(message.view);
          break;
        case "handHistory":
          setHistoryEntry(message.entry);
          break;
        case "error":
          setNotice(message.message);
          break;
        case "chat":
          setChat((previous) => [...previous.slice(-59), { from: message.from, text: message.text }]);
          break;
        default:
          break;
      }
    };

    socket.onclose = () => {
      window.clearTimeout(connectTimeout);
      if (socketRef.current !== socket) return;
      socketRef.current = null;
      const state = retry.current;
      if (state === null) {
        setStatus("idle");
        return;
      }
      if (!state.hasConnected && state.attempt >= 2) {
        retry.current = null;
        setStatus("idle");
        setConnectionError("无法连接牌桌，请重试或联系网站管理员检查游戏服务连接。");
        return;
      }
      // Reconnect on our own: a dropped socket used to leave the page frozen on
      // stale state until the player thought to refresh it.
      setStatus("closed");
      const delay = Math.min(6000, 400 * 2 ** state.attempt);
      state.attempt += 1;
      state.timer = window.setTimeout(() => {
        if (retry.current !== null) openRef.current(state.room, state.name);
      }, delay);
    };

    socket.onerror = () => {
      /* onclose runs next and owns the retry */
    };
  };

  const connect = useCallback((room: string, name: string) => {
    const previous = retry.current;
    if (previous?.timer != null) window.clearTimeout(previous.timer);
    const previousSocket = socketRef.current;
    socketRef.current = null;
    previousSocket?.close();
    retry.current = { room, name, attempt: 0, timer: null, hasConnected: false };
    setConnectionError(null);
    setStatus("connecting");
    setView(null);
    setChat([]);
    setHistoryEntry(null);
    openRef.current(room, name);
  }, []);

  const disconnect = useCallback(() => {
    const state = retry.current;
    if (state?.timer != null) window.clearTimeout(state.timer);
    retry.current = null;
    socketRef.current?.close();
    socketRef.current = null;
    setStatus("idle");
    setConnectionError(null);
    setView(null);
  }, []);

  useEffect(() => () => {
    const state = retry.current;
    if (state?.timer != null) window.clearTimeout(state.timer);
    retry.current = null;
    const socket = socketRef.current;
    socketRef.current = null;
    socket?.close();
  }, []);

  return {
    status,
    view,
    notice,
    connectionError,
    chat,
    historyEntry,
    send,
    connect,
    disconnect,
    requestHistory: (handId: number) => send({ t: "handHistory", handId }),
    closeHistory: () => setHistoryEntry(null),
    dismissNotice: () => setNotice(null),
  };
}

function useCountdown(deadline: number | null): number | null {
  const [remaining, setRemaining] = useState<number | null>(null);

  useEffect(() => {
    if (deadline === null) {
      setRemaining(null);
      return;
    }
    const update = (): void => setRemaining(Math.max(0, Math.ceil((deadline - Date.now()) / 1000)));
    update();
    const timer = setInterval(update, 500);
    return () => clearInterval(timer);
  }, [deadline]);

  return remaining;
}

// --------------------------------------------------------------------- seats

function Seat({
  seat,
  position,
  isTurn,
  isButton,
  isSmallBlind,
  isBigBlind,
  betPosition,
  canManage,
  personas,
  showResult,
  winnings,
  bestCards,
  defaultBuyIn,
  takenPersonas,
  expanded,
  onToggle,
  onSit,
  onStand,
  onRemoveBot,
  onAddBot,
}: {
  seat: SeatView;
  position: { left: string; top: string };
  isTurn: boolean;
  isButton: boolean;
  isSmallBlind: boolean;
  isBigBlind: boolean;
  betPosition: { left: string; top: string };
  canManage: boolean;
  personas: PersonaInfo[];
  /** True once a hand has finished, so wins and losses can be shown. */
  showResult: boolean;
  /** Chips this seat collected from the pots; 0 for everybody else. */
  winnings: number;
  /** This seat's winning five, if they showed down a winner. */
  bestCards: ReadonlySet<string> | undefined;
  /** Personas already sitting at this table. */
  takenPersonas: ReadonlySet<string>;
  expanded: boolean;
  onToggle: () => void;
  /** Pre-filled buy-in for this seat's amount box. */
  defaultBuyIn: number;
  onSit: (seat: number, buyIn: number) => void;
  /** Give up the seat; the server defers it until the hand settles. */
  onStand: () => void;
  /** Takes a bot off the table; only offered between hands. */
  onRemoveBot: (seat: number) => void;
  onAddBot: (seat: number, persona: string) => void;
}): ReactElement {
  const [persona, setPersona] = useState(personas[0]?.id ?? "gto");
  const [buyIn, setBuyIn] = useState(defaultBuyIn);
  // One of each persona: a table with three GTOpros is a bug, not a feature.
  const available = personas.filter((option) => !takenPersonas.has(option.id));
  const chosen = available.some((option) => option.id === persona) ? persona : (available[0]?.id ?? "");

  if (seat.playerId === null) {
    return (
      <div className={`seat is-empty${expanded ? " is-selecting" : ""}`} style={position}>
        <button
          type="button"
          className="empty-seat-trigger"
          onClick={onToggle}
          aria-expanded={expanded}
          aria-label={`选择空位 ${seat.index + 1}`}
        >
          <span className="empty-seat-plus" aria-hidden="true">+</span>
          <span>空位 {seat.index + 1}</span>
        </button>
        {/* Taking a seat is always possible: mid-hand you simply wait for the
            next deal, which the server handles by not dealing you in. */}
        {expanded ? (
          <div className={`seat-picker${parseFloat(position.top) > 60 ? " above" : ""}`}>
            <div className="seat-picker-head">
              <strong>空位 {seat.index + 1}</strong>
              <button type="button" onClick={onToggle} aria-label="收起座位选项">×</button>
            </div>
            <div className="seat-actions">
          <label className="buyin" title="上桌筹码">
            <span>$</span>
            <input
              type="number"
              min={20}
              step={10}
              value={buyIn}
              onChange={(event) => setBuyIn(Math.max(0, Math.floor(Number(event.target.value) || 0)))}
              aria-label={`空位 ${seat.index + 1} 的买入筹码`}
            />
          </label>
          <button type="button" onClick={() => onSit(seat.index, buyIn)}>
            入座
          </button>
          {canManage ? (
            <>
              <select aria-label={`空位 ${seat.index + 1} 的对手人格`} value={chosen} onChange={(event) => setPersona(event.target.value)} disabled={available.length === 0}>
                {available.map((option) => (
                  <option key={option.id} value={option.id}>
                    {option.name}
                  </option>
                ))}
              </select>
              <button type="button" onClick={() => onAddBot(seat.index, chosen)} disabled={available.length === 0}>
                加机器人
              </button>
            </>
          ) : null}
            </div>
            {!canManage ? <div className="seat-note">下一手发牌</div> : null}
          </div>
        ) : null}
      </div>
    );
  }

  const classes = ["seat"];
  const isWinner = showResult && winnings > 0;
  if (seat.isYou) classes.push("is-hero");
  if (seat.folded) classes.push("is-folded");
  if (isTurn) classes.push("is-turn");
  if (isWinner) classes.push("is-winner");
  if (showResult && !isWinner) classes.push("is-loser");

  const cardSize = seat.isYou ? "lg" : "sm";
  // Hang the action label on the outside of the table: pointing it inward
  // would put it on top of the bet chips, which sit between player and pot.
  const labelOnLeft = parseFloat(position.left) < 50;

  return (
    <>
      <div className={classes.join(" ")} style={position}>
        {isTurn ? <span className="turn-ring" /> : null}
        <div className="seat-cards-row">
          <div className="seat-cards">
            {seat.hole
              ? seat.hole.map((card, index) => (
                  <Card key={`${card}-${index}`} card={card} size={cardSize} isBest={bestCards?.has(card) ?? false} />
                ))
              : seat.holeCount > 0
                ? Array.from({ length: seat.holeCount }, (_, index) => <CardBack key={index} size={cardSize} />)
                : null}
          </div>
          {/* What this player just did. Absolutely placed: an in-flow label
              would push the cards off-centre and the bet chip would land on
              top of them. */}
          {seat.lastAction ? (
            <span className={`seat-action ${labelOnLeft ? "on-left" : "on-right"}`}>{seat.lastAction}</span>
          ) : null}
        </div>
        <div className="seat-plate">
          <span className="seat-row">
            <span className="seat-name">{seat.name}</span>
            {seat.isYou && seat.handCategory != null ? (
              <span className="seat-hand" title="Your best hand with the current board">{handLabelEn(seat.handCategory)}</span>
            ) : seat.isYou ? <span className="you-label">You</span> : null}
            <span className="seat-badges">
            {isButton ? <span className="badge dealer" title="庄家按钮">D</span> : null}
            {isSmallBlind ? <span className="badge blind">SB</span> : null}
            {isBigBlind ? <span className="badge blind">BB</span> : null}
            {seat.allIn ? <span className="badge allin">All-in</span> : null}
            {seat.folded ? <span className="badge folded">Fold</span> : null}
            </span>
          </span>
          {/* Chips live on their own line, under the name. */}
          <span className="seat-row">
            <span className="seat-stack">{money(seat.stack)}</span>
            {seat.isYou ? (
              <button type="button" className="stand-btn" onClick={onStand} title="离座，把筹码收回来">
                离座
              </button>
            ) : null}
            {!seat.isYou && seat.isBot && canManage ? (
              <button
                type="button"
                className="stand-btn"
                onClick={() => onRemoveBot(seat.index)}
                title="让这个机器人离桌"
              >
                离桌
              </button>
            ) : null}
          </span>
        </div>
        {/* Below the plate, never over the cards. */}
        {isWinner ? <span className="win-badge">WIN +{money(winnings)}</span> : null}
      </div>

      {seat.streetCommitted > 0 && !showResult ? (
        <div className="bet-chip" style={betPosition}>
          <span className="coins" aria-hidden="true">
            <i className="coin coin-back" />
            <i className="coin coin-front" />
          </span>
          <span className="bet-amount">{money(seat.streetCommitted)}</span>
        </div>
      ) : null}
    </>
  );
}

// --------------------------------------------------------------- action dock

function ActionBar({
  view,
  onAction,
  countdown,
}: {
  view: TableView;
  onAction: (action: ClientMessage & { t: "action" }) => void;
  countdown: number | null;
}): ReactElement | null {
  const legal = view.legal;
  const [target, setTarget] = useState(legal?.minRaiseTo ?? 0);
  /** Raw text while the player is typing an amount, so we do not fight them. */
  const [typed, setTyped] = useState<string | null>(null);

  const decisionKey = `${view.handId}:${view.street}:${legal?.seatIndex ?? -1}:${legal?.minRaiseTo ?? 0}:${legal?.maxRaiseTo ?? 0}`;
  const lastKey = useRef(decisionKey);
  useEffect(() => {
    if (lastKey.current !== decisionKey) {
      lastKey.current = decisionKey;
      setTarget(legal?.minRaiseTo ?? 0);
      setTyped(null);
    }
  }, [decisionKey, legal?.minRaiseTo]);

  if (!legal) return null;

  const clamped = Math.min(Math.max(Math.round(target), legal.minRaiseTo), legal.maxRaiseTo);
  const hero = view.seats[legal.seatIndex]!;
  const totalPot = view.pot + view.seats.reduce((sum, seat) => sum + seat.streetCommitted, 0);
  const potBet = (fraction: number): number =>
    potBetAmount(
      { pot: totalPot, toCall: legal.toCall, streetCommitted: hero.streetCommitted, minRaiseTo: legal.minRaiseTo, maxRaiseTo: legal.maxRaiseTo },
      fraction,
    );

  // Calling already uses every chip, so a second "all in" button would be the
  // same action twice — and it reads like a raise they cannot afford.
  const heroStack = view.seats.find((seat) => seat.index === legal.seatIndex)?.stack ?? 0;
  const showAllIn = allInIsDistinct({ canAllIn: legal.canAllIn, callCost: legal.callCost, stack: heroStack });

  return (
    <div className="action-cluster">
      <div className="decision-summary">
        <strong>Your turn</strong>
        <span>{legal.canCheck ? "Check is free" : `Call ${money(legal.callCost)} · Pot after call ${money(totalPot + legal.callCost)}`}</span>
        {countdown !== null ? <span className={`decision-clock${countdown <= 10 ? " urgent" : ""}`}>{countdown}s</span> : null}
      </div>
      {legal.canRaise ? (
        <div className="raise-row">
          <input
            type="range"
            min={legal.minRaiseTo}
            max={legal.maxRaiseTo}
            value={clamped}
            onChange={(event) => {
              setTyped(null);
              setTarget(Number(event.target.value));
            }}
            aria-label="加注额"
          />
          <label className="buyin raise-buyin" title="加注金额">
            <span>$</span>
            <input
              type="number"
              className="raise-input"
              value={typed ?? String(clamped)}
              min={legal.minRaiseTo}
              max={legal.maxRaiseTo}
              step={1}
              onChange={(event) => {
                setTyped(event.target.value);
                const parsed = Number(event.target.value);
                if (Number.isFinite(parsed) && parsed > 0) setTarget(parsed);
              }}
              onBlur={() => setTyped(null)}
              aria-label="手动输入加注金额"
            />
          </label>
          <div className="raise-presets">
            <button type="button" onClick={() => { setTyped(null); setTarget(potBet(1 / 3)); }}>⅓ Pot</button>
            <button type="button" onClick={() => { setTyped(null); setTarget(potBet(0.5)); }}>
              ½ Pot
            </button>
            <button type="button" onClick={() => { setTyped(null); setTarget(potBet(1)); }}>
              Pot
            </button>
            <button type="button" onClick={() => { setTyped(null); setTarget(legal.maxRaiseTo); }}>
              All-in
            </button>
          </div>
        </div>
      ) : null}

      <div className="action-buttons">
        <button type="button" className="danger" onClick={() => onAction({ t: "action", action: { type: "fold" } })}>
          Fold
        </button>

        {legal.canCheck ? (
          <button type="button" onClick={() => onAction({ t: "action", action: { type: "check" } })}>
            Check
          </button>
        ) : null}

        {legal.canCall ? (
          <button type="button" onClick={() => onAction({ t: "action", action: { type: "call" } })}>
            Call {money(legal.callCost)}
            {legal.callCost < legal.toCall ? " (All-in)" : ""}
          </button>
        ) : null}

        {legal.canRaise ? (
          <button
            type="button"
            className="primary"
            onClick={() => onAction({ t: "action", action: { type: "raise", to: clamped } })}
          >
            {legal.toCall > 0 ? `Raise to ${money(clamped)}` : `Bet ${money(clamped)}`}
          </button>
        ) : showAllIn ? (
          <button
            type="button"
            className="primary"
            onClick={() => onAction({ t: "action", action: { type: "raise", to: legal.maxRaiseTo } })}
          >
            All-in {money(legal.maxRaiseTo)}
          </button>
        ) : null}

      </div>
    </div>
  );
}

function ChatBox({
  chat,
  onSend,
}: {
  chat: ChatLine[];
  onSend: (text: string) => void;
}): ReactElement {
  const [draft, setDraft] = useState("");
  const linesRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const element = linesRef.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [chat.length]);

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    const text = draft.trim();
    if (text.length === 0) return;
    onSend(text);
    setDraft("");
  };

  return (
    <section className="chat-box">
      <div className="chat-lines" ref={linesRef}>
        {chat.length === 0 ? (
          <span className="chat-empty">桌边聊天</span>
        ) : (
          chat.map((line, index) => (
            <div key={index} className="chat-line">
              <strong>{line.from}</strong>
              <span>{line.text}</span>
            </div>
          ))
        )}
      </div>
      <form className="chat-form" onSubmit={submit}>
        <input
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          maxLength={200}
          placeholder="说点什么…"
          aria-label="聊天输入框"
        />
        <button type="submit" disabled={draft.trim().length === 0}>
          发送
        </button>
      </form>
    </section>
  );
}

// ------------------------------------------------------------------ settings

function SettingsDialog({
  view,
  bounds,
  onClose,
  onSave,
}: {
  view: TableView;
  bounds: SettingsBounds;
  onClose: () => void;
  onSave: (patch: RoomSettingsPatch) => void;
}): ReactElement {
  /** Remembers the interval so toggling auto-start off and on is not lossy. */
  const [autoStartLast, setAutoStartLast] = useState(
    view.settings.autoStartSeconds > 0 ? view.settings.autoStartSeconds : 6,
  );
  const [draft, setDraft] = useState({
    seats: view.settings.seats,
    smallBlind: view.settings.smallBlind,
    bigBlind: view.settings.bigBlind,
    startingStack: view.settings.startingStack,
    actionTimeoutSeconds: Math.round(view.settings.actionTimeoutMs / 1000),
    mode: view.settings.mode as GameMode,
    blindLevelHands: view.settings.blindLevelHands,
    blindGrowth: view.settings.blindGrowth,
    autoStartSeconds: view.settings.autoStartSeconds,
    botAutoRebuy: view.settings.botAutoRebuy,
  });

  const handInProgress = view.street !== "complete";
  const gameStarted = view.handId > 0;
  const anyoneSeated = view.seats.some((seat) => seat.playerId !== null);
  const bound = (key: string): { min: number; max: number } => bounds[key] ?? FALLBACK_BOUNDS[key] ?? { min: 0, max: 1e9 };

  /**
   * `locked` greys the field *and* stops it accepting input.
   *
   * It used to only grey the label, so a field captioned "开局后不能改" was
   * still editable — a stray click or scroll changed it, and the server then
   * rejected the save for editing a setting nobody meant to touch.
   */
  const number = (key: keyof typeof draft, boundKey: string, locked = false) => (
    <input
      type="number"
      min={bound(boundKey).min}
      max={key === "actionTimeoutSeconds" ? bound(boundKey).max / 1000 : bound(boundKey).max}
      disabled={locked}
      value={draft[key] as number}
      onChange={(event) => setDraft({ ...draft, [key]: Number(event.target.value) })}
    />
  );

  /**
   * Sends only what actually differs from the server's view.
   *
   * Sending every field back meant any value that did not survive the round
   * trip — seconds vs milliseconds, say — looked like an edit, and tripped
   * guards for settings the player never touched.
   */
  const save = (): void => {
    const current = view.settings;
    const timeoutMs = Math.round(draft.actionTimeoutSeconds * 1000);

    // Never send a field the server refuses to change right now, even if a
    // stale draft says it differs — the guards are unreachable this way.
    const canSeats = !anyoneSeated;
    const canMode = !gameStarted;
    const canBlinds = !handInProgress;

    onSave({
      ...(canSeats && draft.seats !== current.seats ? { seats: draft.seats } : {}),
      ...(canBlinds && draft.smallBlind !== current.smallBlind ? { smallBlind: draft.smallBlind } : {}),
      ...(canBlinds && draft.bigBlind !== current.bigBlind ? { bigBlind: draft.bigBlind } : {}),
      ...(draft.startingStack !== current.startingStack ? { startingStack: draft.startingStack } : {}),
      ...(timeoutMs !== current.actionTimeoutMs ? { actionTimeoutMs: timeoutMs } : {}),
      ...(canMode && draft.mode !== current.mode ? { mode: draft.mode } : {}),
      ...(canMode && draft.blindLevelHands !== current.blindLevelHands ? { blindLevelHands: draft.blindLevelHands } : {}),
      ...(canMode && draft.blindGrowth !== current.blindGrowth ? { blindGrowth: draft.blindGrowth } : {}),
      ...(draft.autoStartSeconds !== current.autoStartSeconds ? { autoStartSeconds: draft.autoStartSeconds } : {}),
      ...(draft.botAutoRebuy !== current.botAutoRebuy ? { botAutoRebuy: draft.botAutoRebuy } : {}),
    });
    onClose();
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(event) => event.stopPropagation()}>
        <header>
          <h2>房间设置</h2>
          <button type="button" className="ghost" onClick={onClose}>
            ✕
          </button>
        </header>

        <div className="settings-grid">
          <label className={anyoneSeated ? "disabled" : ""}>
            <span>座位数{anyoneSeated ? "（有人入座后不能改）" : ""}</span>
            {number("seats", "seats", anyoneSeated)}
          </label>

          <label className={gameStarted ? "disabled" : ""}>
            <span>模式{gameStarted ? "（开局后不能改）" : ""}</span>
            <select
              value={draft.mode}
              disabled={gameStarted}
              onChange={(event) => setDraft({ ...draft, mode: event.target.value as GameMode })}
            >
              <option value="cash">现金局（盲注固定）</option>
              <option value="tournament">锦标赛（盲注递增）</option>
            </select>
          </label>

          <label>
            <span>起始筹码（每个新入座玩家的默认买入）</span>
            {number("startingStack", "startingStack")}
          </label>

          <label>
            <span>行动限时（秒，0 = 关闭）</span>
            {number("actionTimeoutSeconds", "actionTimeoutMs")}
          </label>

          <label className={handInProgress ? "disabled" : ""}>
            <span>小盲{handInProgress ? "（本手结束可改）" : ""}</span>
            {number("smallBlind", "smallBlind", handInProgress)}
          </label>

          <label className={handInProgress ? "disabled" : ""}>
            <span>大盲{handInProgress ? "（本手结束可改）" : ""}</span>
            {number("bigBlind", "bigBlind", handInProgress)}
          </label>

          {/* Same shape as every other field: title on top, control below. */}
          <div className="switch-field">
            <span>自动开始下一手牌</span>
            <label className="switch">
              <input
                type="checkbox"
                checked={draft.autoStartSeconds > 0}
                onChange={(event) =>
                  setDraft({ ...draft, autoStartSeconds: event.target.checked ? autoStartLast : 0 })
                }
              />
              <span className="track" aria-hidden="true" />
              <span className="switch-state">{draft.autoStartSeconds > 0 ? "开启" : "关闭"}</span>
            </label>
            {draft.autoStartSeconds > 0 ? (
              <label className="switch-sub">
                <span>间隔（秒）</span>
                <input
                  type="number"
                  min={bound("autoStartSeconds").min}
                  max={bound("autoStartSeconds").max}
                  value={draft.autoStartSeconds}
                  onChange={(event) => {
                    const value = Number(event.target.value);
                    setDraft({ ...draft, autoStartSeconds: value });
                    if (value > 0) setAutoStartLast(value);
                  }}
                />
              </label>
            ) : (
              <em className="switch-note">手动开始：每手结束点「开始下一手」</em>
            )}
          </div>

          <div className="switch-field">
            <span>机器人输光后自动重新买入</span>
            <label className="switch">
              <input
                type="checkbox"
                checked={draft.botAutoRebuy}
                onChange={(event) => setDraft({ ...draft, botAutoRebuy: event.target.checked })}
              />
              <span className="track" aria-hidden="true" />
              <span className="switch-state">{draft.botAutoRebuy ? "开启" : "关闭"}</span>
            </label>
            <em className="switch-note">
              {draft.botAutoRebuy ? "输光的机器人会自动补齐筹码" : "输光的机器人坐着看戏，不再补筹码"}
            </em>
          </div>

          {draft.mode === "tournament" ? (
            <>
              <label className={gameStarted ? "disabled" : ""}>
                <span>每多少手升盲{gameStarted ? "（开局后不能改）" : ""}</span>
                {number("blindLevelHands", "blindLevelHands", gameStarted)}
              </label>
              <label className={gameStarted ? "disabled" : ""}>
                <span>每次盲注倍数{gameStarted ? "（开局后不能改）" : ""}</span>
                {number("blindGrowth", "blindGrowth", gameStarted)}
              </label>
            </>
          ) : null}
        </div>

        <p className="fine-print">
          {draft.mode === "tournament"
            ? `锦标赛：当前第 ${view.settings.level} 级，盲注 ${view.smallBlind}/${view.bigBlind}${
                view.settings.handsUntilNextLevel === null ? "" : `，还有 ${view.settings.handsUntilNextLevel} 手升级`
              }。`
            : "现金局：盲注保持不变，可以随时调整。"}
        </p>

        <footer>
          <button type="button" onClick={onClose}>
            取消
          </button>
          <button type="button" className="primary" onClick={save}>
            保存
          </button>
        </footer>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------- history

function HistoryDialog({ entry, onClose }: { entry: HandHistoryEntry; onClose: () => void }): ReactElement {
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal history-modal" onClick={(event) => event.stopPropagation()}>
        <header>
          <h2>
            第 {entry.handId} 手
            <span className="history-meta">
              盲注 {entry.smallBlind}/{entry.bigBlind}
              {entry.level > 1 ? ` · 第 ${entry.level} 级` : ""} · {entry.reason === "fold" ? "弃牌结束" : "摊牌"}
            </span>
          </h2>
          <button type="button" className="ghost" onClick={onClose}>
            ✕
          </button>
        </header>

        <div className="history-board">
          {entry.board.length === 0 ? (
            <span className="board-hint">没有公共牌</span>
          ) : (
            entry.board.map((card, index) => <Card key={`${card}-${index}`} card={card} size="md" />)
          )}
        </div>

        <ul className="history-seats">
          {entry.seats.map((seat) => (
            <li key={seat.seatIndex}>
              <span className="hs-name">{seat.name}</span>
              <span className="hs-cards">
                {seat.hole
                  ? seat.hole.map(displayCard).join(" ")
                  : seat.folded
                    ? "已弃牌（底牌不入档）"
                    : "未亮牌"}
              </span>
              <span className={seat.net >= 0 ? "hs-net up" : "hs-net down"}>
                {seat.net > 0 ? "+" : ""}
                {seat.net}
              </span>
            </li>
          ))}
        </ul>

        <h3 className="history-sub">行动记录</h3>
        <ol className="log history-log">
          {entry.log.map((line, index) => (
            <li key={index} className={`log-${line.street}`}>
              {line.text}
            </li>
          ))}
        </ol>
      </div>
    </div>
  );
}

// --------------------------------------------------------------------- table

function TableScreen({
  view,
  personas,
  bounds,
  llm,
  status,
  chat,
  onSend,
  onLeave,
  onRequestHistory,
  onLlm,
}: {
  view: TableView;
  personas: PersonaInfo[];
  bounds: SettingsBounds;
  /** Shown in the sidebar footer so the model setup is visible while playing. */
  llm: LlmStatus | null;
  status: Status;
  chat: ChatLine[];
  onSend: (message: ClientMessage) => void;
  onLeave: () => void;
  onRequestHistory: (handId: number) => void;
  onLlm: (next: LlmStatus) => void;
}): ReactElement {
  const [copied, setCopied] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [tab, setTab] = useState<"live" | "history">("live");
  const [selectedSeat, setSelectedSeat] = useState<number | null>(null);
  const countdown = useCountdown(view.actionDeadlineMs);
  const nextHandCountdown = useCountdown(view.nextHandAtMs);
  const felt = useFeltScale();
  const takenPersonas = useMemo(
    () => new Set(view.seats.map((seat) => seat.personaId).filter((id): id is string => id !== null)),
    [view.seats],
  );
  // The dock follows the table, but only part of the way: a fullscreen table
  // should not turn the buttons into billboards.
  const uiScale = Math.min(1.45, Math.max(0.9, felt.scale));
  const [rebuyAmount, setRebuyAmount] = useState(view.settings.startingStack);

  const heroSeat = view.seats.find((seat) => seat.isYou)?.index ?? -1;
  const heroSeated = heroSeat >= 0;
  const heroStack = heroSeated ? (view.seats[heroSeat]?.stack ?? 0) : 0;
  const seatTotal = view.seats.length;
  const blinds = useMemo(() => blindSeats(view), [view]);
  const canManageSeats = view.street === "complete" || view.handId === 0;
  const showResult = view.result !== null;
  const occupiedSeats = view.seats.filter((seat) => seat.playerId !== null).length;
  const liveBets = view.seats.reduce((sum, seat) => sum + seat.streetCommitted, 0);
  const payoutOf = (seatIndex: number): number => view.result?.payouts[seatIndex] ?? 0;

  /** The exact five cards that won, per seat; and the union for the board. */
  const bestBySeat = useMemo(() => {
    const map = new Map<number, Set<string>>();
    for (const entry of view.result?.showdown ?? []) map.set(entry.seatIndex, new Set(entry.bestFive));
    return map;
  }, [view.result]);

  const bestOnBoard = useMemo(() => {
    const winners = new Set((view.result?.awards ?? []).flatMap((award) => award.winners));
    const cards = new Set<string>();
    for (const entry of view.result?.showdown ?? []) {
      if (!winners.has(entry.seatIndex)) continue;
      for (const card of entry.bestFive) cards.add(card);
    }
    return cards;
  }, [view.result]);

  const inviteUrl = useMemo(() => {
    const url = new URL(window.location.href);
    url.search = `?room=${view.roomCode}`;
    return url.toString();
  }, [view.roomCode]);

  const copyInvite = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(inviteUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      window.prompt("复制这个邀请链接发给朋友：", inviteUrl);
    }
  };

  const quickStart = (): void => {
    const empty = view.seats.filter((seat) => seat.playerId === null);
    if (!heroSeated) {
      const seat = empty.shift();
      if (!seat) return;
      onSend({ t: "sit", seat: seat.index, buyIn: view.settings.startingStack });
    }
    const opponents = personas.filter((persona) => !takenPersonas.has(persona.id)).slice(0, 3);
    for (const persona of opponents) {
      const seat = empty.shift();
      if (!seat) break;
      onSend({ t: "addBot", seat: seat.index, persona: persona.id });
    }
    setSelectedSeat(null);
    onSend({ t: "startHand" });
  };

  const modeChip =
    view.settings.mode === "tournament"
      ? `锦标赛 第 ${view.settings.level} 级${
          view.settings.handsUntilNextLevel === null ? "" : ` · 还有 ${view.settings.handsUntilNextLevel} 手升盲`
        }`
      : "现金局";

  return (
    <div className="room" style={{ "--ui-scale": uiScale } as CSSProperties}>
      <header className="topbar">
        <div className="table-brand">
          <span aria-hidden="true">♠</span>
          <div><strong>德州扑克</strong><small>NPC 牌桌</small></div>
        </div>
        <div className="room-chip">
          房间 <strong>{view.roomCode}</strong>
        </div>
        <button type="button" onClick={copyInvite}>
          {copied ? "已复制 ✓" : "复制邀请链接"}
        </button>
        <div className="blinds-chip">
          盲注 <strong>{view.smallBlind}/{view.bigBlind}</strong>
        </div>
        <div className="mode-chip">{modeChip}</div>
        {view.isHost ? (
          <button type="button" onClick={() => setSettingsOpen(true)}>
            ⚙ 房间设置
          </button>
        ) : null}
        <span className={`conn conn-${status}`}>
          {status === "open" ? "已连接" : status === "connecting" ? "连接中…" : status === "closed" ? "重连中…" : "未连接"}
        </span>
        <button type="button" className="ghost" onClick={onLeave}>
          离开
        </button>
      </header>

      <main className="table-area" ref={felt.ref}>
        <div className="table-caption">
          <span>{modeChip} · {occupiedSeats}/{seatTotal} 人</span>
          <span>{view.handId > 0 ? `第 ${view.handId} 手` : "准备开桌"}</span>
        </div>
        <div
          className="felt-scale"
          style={{ width: FELT_BASE_WIDTH * felt.scale, height: FELT_BASE_HEIGHT * felt.scale }}
        >
          <div className="felt" style={{ transform: `scale(${felt.scale})` }}>
          <div className="table-center">
            {view.handId === 0 ? (
              <div className="table-welcome">
                <span className="welcome-suits" aria-hidden="true">♠ <i>♥</i> ♣ <i>♦</i></span>
                <h2>好对手，就位。</h2>
                <p>选一个空位坐下，或直接开始一桌。</p>
                <button type="button" className="primary" onClick={quickStart} disabled={status !== "open" || (!heroSeated && occupiedSeats === seatTotal)}>
                  快速开桌 <span aria-hidden="true">↗</span>
                </button>
                <small>自动入座 · 最多 3 位机器人陪练</small>
              </div>
            ) : <>
            <div className="center-pot"><span>底池</span><strong>{money(view.pot)}</strong></div>
            <div className="board">
              {view.board.length === 0 ? (
                Array.from({ length: 5 }, (_, index) => <span className="board-placeholder" key={index} aria-hidden="true">♠</span>)
              ) : (
                view.board.map((card, index) => (
                  <Card key={`${card}-${index}`} card={card} size="md" isBest={bestOnBoard.has(card)} dealIndex={index} />
                ))
              )}
            </div>
            <div className="live-bets">
              {liveBets > 0
                ? `本轮下注 ${money(liveBets)} · 总底池 ${money(view.pot + liveBets)}`
                : view.result ? "本手已结算" : "筹码已收进底池"}
            </div>
            </>}
          </div>

          {view.seats.map((seat) => {
            const slot = seatSlot(heroSeated ? heroSeat : null, seat.index, seatTotal);
            // The bottom seat carries the viewer's own (large) cards plus a name
            // plate, so it sits further inside the felt to stay clear of the dock.
            const position = slotPosition(slot, seatTotal, 43, slot === 0 ? 29 : 36);
            return (
              <Seat
                key={seat.index}
                seat={seat}
                position={position}
                betPosition={slotPosition(slot, seatTotal, 31, slot === 0 ? 15 : 26)}
                isTurn={view.toActIndex === seat.index}
                isButton={view.buttonIndex === seat.index}
                isSmallBlind={blinds.small === seat.index}
                isBigBlind={blinds.big === seat.index}
                canManage={canManageSeats}
                personas={personas}
                showResult={showResult}
                winnings={payoutOf(seat.index)}
                bestCards={bestBySeat.get(seat.index)}
                defaultBuyIn={view.settings.startingStack}
                takenPersonas={takenPersonas}
                expanded={selectedSeat === seat.index}
                onToggle={() => setSelectedSeat(selectedSeat === seat.index ? null : seat.index)}
                onSit={(index, amount) => { setSelectedSeat(null); onSend({ t: "sit", seat: index, buyIn: amount }); }}
                onStand={() => onSend({ t: "stand" })}
                onRemoveBot={(index) => onSend({ t: "removeBot", seat: index })}
                onAddBot={(index, persona) => { setSelectedSeat(null); onSend({ t: "addBot", seat: index, persona }); }}
              />
            );
          })}
        </div>
        </div>
      </main>

      <aside className="sidebar">
        <div className="sidebar-heading"><span className="eyebrow">TABLE NOTES</span><strong>牌局动态</strong></div>
        <div className="sidebar-tabs">
          <button type="button" className={tab === "live" ? "active" : ""} onClick={() => setTab("live")}>
            本手
          </button>
          <button type="button" className={tab === "history" ? "active" : ""} onClick={() => setTab("history")}>
            历史 {view.history.length > 0 ? view.history.length : ""}
          </button>
        </div>

        {tab === "live" ? (
          <ol className="log">
            {view.log.length === 0 ? <li className="log-empty"><span aria-hidden="true">♧</span><strong>故事从第一手开始</strong><p>盲注、下注和结算会记录在这里。</p></li> : null}
            {view.log.map((entry, index) => (
              <li key={index} className={`log-${entry.street}`}>
                {entry.text}
              </li>
            ))}
          </ol>
        ) : view.history.length === 0 ? (
          <p className="hint">还没有打完的牌局。每手结束后会自动归档，随时点开回看。</p>
        ) : (
          <ol className="history-list">
            {[...view.history].reverse().map((summary) => (
              <li key={summary.handId}>
                <button type="button" onClick={() => onRequestHistory(summary.handId)}>
                  <span className="hl-top">
                    <span className="hl-no">第 {summary.handId} 手</span>
                    <span className="hl-pot">底池 {money(summary.potTotal)}</span>
                  </span>
                  <span className="hl-board">
                    {summary.board.length > 0 ? summary.board.map(displayCard).join(" ") : "翻前结束"}
                  </span>
                  <span className="hl-win">
                    {summary.winners.map((winner) => `${winner.name} +${money(winner.amount)}`).join("、")}
                  </span>
                </button>
              </li>
            ))}
          </ol>
        )}

        {/* Facts that are useful while playing but do not deserve top-bar space. */}
        <div className="sidebar-foot">
          {llm ? <LlmActivity status={llm} onUpdate={onLlm} /> : null}
          <div className="foot-row">
            <span>大模型</span>
            <strong className={llm?.enabled ? "on" : undefined}>
              {llm?.enabled ? llm.model : "未接入 · 本地决策"}
            </strong>
          </div>
          <div className="foot-row">
            <span>房间码</span>
            <strong>{view.roomCode}</strong>
          </div>
          <div className="foot-row">
            <span>盲注</span>
            <strong>
              {view.smallBlind}/{view.bigBlind}
              {view.settings.level > 1 ? ` · 第 ${view.settings.level} 级` : ""}
            </strong>
          </div>
          <div className="foot-row">
            <span>你的位置</span>
            <strong>{heroSeated ? `${heroSeat + 1} 号位` : "旁观"}</strong>
          </div>
        </div>
      </aside>

      <footer className="action-dock">
        {heroSeated && view.seats[heroSeat]?.hole?.length ? (
          <div className="mobile-hand">
            <div className="mobile-hand-cards">
              {view.seats[heroSeat]!.hole!.map((card) => <Card key={card} card={card} size="sm" />)}
            </div>
            <div>
              <span>你的手牌{view.seats[heroSeat]?.folded ? " · 已弃牌" : ""}</span>
              <strong>{money(heroStack)} <small>{(heroStack / view.bigBlind).toFixed(1)} BB</small></strong>
            </div>
          </div>
        ) : null}
        {view.result ? (
          <div className="result">
            <div className="result-head">
              <strong>{view.result.reason === "fold" ? "其余玩家弃牌" : "摊牌"}</strong>
              <span className="net">
                {view.seats.map((seat) => {
                  const change = view.result?.netChange[seat.index] ?? 0;
                  if (change === 0) return null;
                  return (
                    <span key={seat.index} className={change > 0 ? "up" : "down"}>
                      {seat.name} {change > 0 ? "+" : "-"}
                      {money(Math.abs(change))}
                    </span>
                  );
                })}
              </span>
            </div>
            <ul>
              {view.result.showdown.map((entry) => (
                <li key={entry.seatIndex} className="showdown-line">
                  <strong>{view.seats[entry.seatIndex]?.name}</strong>
                  <span className="showdown-cards">
                    {entry.hole
                      .map((card) => `${displayRank(card[0]!)}${SUIT_SYMBOLS[card[1]!.toLowerCase()] ?? ""}`)
                      .join(" ")}
                  </span>
                  <em>{handNameZh(entry.category, entry.ranks)}</em>
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        <fieldset className="dock-row" disabled={status !== "open"}>
          <ChatBox chat={chat} onSend={(text) => onSend({ t: "chat", text })} />

          <div className="dock-actions">
            {view.canStartHand ? (
              <button type="button" className="primary start" onClick={() => onSend({ t: "startHand" })}>
                开始下一手
              </button>
            ) : null}
            {view.canStartHand && nextHandCountdown !== null ? (
              <span className="hint">{nextHandCountdown} 秒后自动开始</span>
            ) : null}

            {heroSeated && heroStack === 0 && view.street === "complete" ? (
              view.settings.mode === "cash" ? (
                <>
                  <label className="buyin" title="重新买入的筹码">
                    <span>$</span>
                    <input
                      type="number"
                      min={20}
                      step={10}
                      value={rebuyAmount}
                      onChange={(event) => setRebuyAmount(Math.max(0, Math.floor(Number(event.target.value) || 0)))}
                      aria-label="重新买入的筹码"
                    />
                  </label>
                  <button type="button" className="primary" onClick={() => onSend({ t: "rebuy", buyIn: rebuyAmount })}>
                    重新买入
                  </button>
                </>
              ) : (
                <span className="hint">你在锦标赛出局了，可以留下来观战。</span>
              )
            ) : null}

            {!heroSeated ? <span className="hint">你正在观战 · 选择一个空位入座</span> : null}

            {view.legal ? (
              <ActionBar view={view} onAction={onSend} countdown={countdown} />
            ) : view.toActIndex !== null && view.street !== "complete" ? (
              <div className="waiting-turn" role="status">
                <span className="thinking-dots" aria-hidden="true"><i /><i /><i /></span>
                <div><strong>{view.seats[view.toActIndex]?.name ?? "Opponent"} is {view.seats[view.toActIndex]?.isBot ? "thinking" : "acting"}…</strong>
                  <span>{countdown !== null ? `${countdown}s remaining` : "Waiting for the next move."}</span></div>
              </div>
            ) : (
              view.handId > 0 ? <span className="hint">{streetLabelZh(view.street)}</span> : null
            )}
          </div>
        </fieldset>
      </footer>

      {settingsOpen ? (
        <SettingsDialog
          view={view}
          bounds={bounds}
          onClose={() => setSettingsOpen(false)}
          onSave={(patch) => onSend({ t: "configure", settings: patch })}
        />
      ) : null}
    </div>
  );
}

// --------------------------------------------------------------------- lobby

/**
 * Lets whoever is running the server point the bots at a model backend.
 *
 * The key is write-only: the server never sends it back, so the field starts
 * empty and leaving it empty keeps whatever is already saved.
 */
function LlmDialog({
  status,
  onClose,
  onSaved,
}: {
  status: LlmStatus;
  onClose: () => void;
  onSaved: (next: LlmStatus) => void;
}): ReactElement {
  const [apiKey, setApiKey] = useState("");
  const [baseUrl, setBaseUrl] = useState(status.baseUrl ?? "");
  const [model, setModel] = useState(status.model ?? "");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = (clearKey: boolean): void => {
    setBusy(true);
    setError(null);
    const body = clearKey
      ? { apiKey: "", baseUrl, model }
      : {
          ...(apiKey.trim().length > 0 ? { apiKey: apiKey.trim() } : {}),
          baseUrl,
          model,
        };
    void fetch("/api/llm", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    })
      .then(async (response) => {
        const payload = (await response.json()) as LlmStatus & { error?: string };
        if (!response.ok) throw new Error(payload.error ?? "保存失败");
        onSaved(payload);
        onClose();
      })
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : "保存失败"))
      .finally(() => setBusy(false));
  };

  return (
    <div className="llm-overlay" onClick={onClose}>
      <div className="llm-dialog" onClick={(event) => event.stopPropagation()}>
        <h2>大模型配置</h2>
        <p className="llm-note">
          只在这台机器上可用（服务器所在的那台）。填了就写进项目根目录的 <code>.env</code>，
          重启也在；不填就让机器人只用本地蒙特卡洛决策，一分钱不花。
        </p>

        <label className="llm-field">
          <span>API Key{status.enabled ? "（已配置，留空则不改）" : ""}</span>
          <input
            type="password"
            value={apiKey}
            placeholder={status.enabled ? "保持原样" : "sk-..."}
            onChange={(event) => setApiKey(event.target.value)}
            autoComplete="off"
          />
        </label>

        <label className="llm-field">
          <span>接口地址（留空 = 默认）</span>
          <input
            value={baseUrl}
            placeholder="https://api.deepseek.com"
            onChange={(event) => setBaseUrl(event.target.value)}
          />
        </label>

        <label className="llm-field">
          <span>模型名（留空 = 默认）</span>
          <input value={model} placeholder="deepseek-chat" onChange={(event) => setModel(event.target.value)} />
        </label>

        <p className="llm-note">
          任何兼容 OpenAI <code>/chat/completions</code> 的服务都行：OpenAI、月之暗面、本地 Ollama 都可以。
        </p>

        {error ? <p className="llm-error">{error}</p> : null}

        <div className="llm-actions">
          <button type="button" onClick={onClose} disabled={busy}>
            取消
          </button>
          {status.enabled ? (
            <button type="button" className="danger" onClick={() => submit(true)} disabled={busy}>
              关闭大模型
            </button>
          ) : null}
          <button type="button" className="primary" onClick={() => submit(false)} disabled={busy}>
            保存
          </button>
        </div>
      </div>
    </div>
  );
}

function Lobby({
  personas,
  llm,
  onLlm,
  onJoin,
  status,
  serviceState,
  serviceError,
  connectionError,
  onRetry,
  onCancel,
}: {
  personas: PersonaInfo[];
  llm: LlmStatus | null;
  onLlm: (next: LlmStatus) => void;
  onJoin: (room: string, name: string) => void;
  status: Status;
  serviceState: "loading" | "ready" | "error";
  serviceError: string | null;
  connectionError: string | null;
  onRetry: () => void;
  onCancel: () => void;
}): ReactElement {
  const [llmOpen, setLlmOpen] = useState(false);
  const [name, setName] = useState(() => localStorage.getItem(NAME_KEY) ?? "");
  const [room, setRoom] = useState(() => (new URLSearchParams(window.location.search).get("room") ?? "").toUpperCase());
  const [mode, setMode] = useState<"create" | "join">(() => room ? "join" : "create");
  const connecting = status === "connecting" || status === "closed";

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    const trimmed = name.trim();
    if (trimmed.length === 0) return;
    if (serviceState !== "ready") return;
    localStorage.setItem(NAME_KEY, trimmed);
    onJoin(mode === "join" ? room.trim().toUpperCase() : "", trimmed);
  };

  return (
    <div className="lobby">
      <header className="lobby-intro">
        <div className="lobby-brand"><span aria-hidden="true">♠</span> 德州扑克 <small>NPC 牌桌</small></div>
        <span className="eyebrow">A SEAT FOR EVERY PERSONALITY</span>
        <h1>牌桌已备好。<br /><em>就等你入座。</em></h1>
        <p>约上朋友，或会会五位个性鲜明的对手。<br />从一手好牌，开始今晚的故事。</p>
        <div className="lobby-facts">
          <span><strong>2–9</strong> 人同桌</span>
          <span><strong>5</strong> 种对手</span>
          <span><strong>∞</strong> 种可能</span>
        </div>
      </header>
      <form className="lobby-card" onSubmit={submit}>
        <div className="lobby-card-head">
          <span className="eyebrow">TAKE YOUR SEAT</span>
          <h2>来一局？</h2>
          <p className="lobby-sub">一个昵称，就能上桌。</p>
        </div>
        <div className="lobby-tabs" aria-label="开桌方式">
          <button type="button" aria-pressed={mode === "create"} onClick={() => setMode("create")}>创建房间</button>
          <button type="button" aria-pressed={mode === "join"} onClick={() => setMode("join")}>加入朋友</button>
        </div>

        <label>
          <span>你的昵称</span>
          <input value={name} onChange={(event) => setName(event.target.value)} maxLength={16} placeholder="牌桌上怎么称呼你？" autoComplete="nickname" required autoFocus />
        </label>

        {mode === "join" ? <label>
          <span>朋友的房间码</span>
          <input
            value={room}
            onChange={(event) => setRoom(event.target.value.toUpperCase())}
            maxLength={4}
            minLength={4}
            pattern="[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{4}"
            required
            autoComplete="off"
            placeholder="ABCD"
            className="code-input"
          />
        </label> : <p className="create-note">创建后可复制邀请链接，也可以直接和机器人练习。</p>}

        {serviceState === "error" ? <div className="service-error" role="alert">
          <strong>游戏服务未连接</strong>
          <p>暂时无法创建或加入房间，请稍后重试。</p>
          <details><summary>给部署者的诊断</summary>
            <p>请启动 Node 游戏服务，并转发 API 和 WebSocket 请求。</p>
            <code>{serviceError}</code>
          </details>
          <button type="button" className="ghost" onClick={onRetry}>重新检查</button>
        </div> : serviceState === "loading" ? <p className="fine-print" role="status">正在检查游戏服务…</p> : null}
        {connectionError ? <p className="llm-error" role="alert">{connectionError}</p> : null}
        <button className="primary lobby-submit" type="submit" disabled={name.trim().length === 0 || connecting || serviceState !== "ready"}>
          {connecting ? "正在连接…" : mode === "join" ? "加入房间" : "创建房间"}<span aria-hidden="true">↗</span>
        </button>
        {connecting ? <button className="ghost" type="button" onClick={onCancel}>取消连接</button> : null}
        <span className="lobby-card-foot">现金局 / 锦标赛 · 仅使用虚拟筹码</span>
      </form>

      <div className="persona-gallery">
        <div className="gallery-heading">
          <div><span className="eyebrow">MEET THE TABLE</span><h2>五种个性，同一张牌桌。</h2></div>
          <span className="gallery-note">你会遇到怎样的对手？</span>
        </div>
        {personas.length > 0 ? <ul>
          {personas.map((persona) => (
            <li key={persona.id}>
              <div className={`persona-monogram persona-${persona.id}`} aria-hidden="true">
                {persona.name.slice(0, 1)}
              </div>
              <strong>{persona.name}</strong>
              {persona.description ? <span>{persona.description}</span> : null}
            </li>
          ))}
        </ul> : <p className="fine-print">连接游戏服务后显示全部对手。</p>}
        <div className="model-status">
          <span className={`model-dot${llm?.enabled ? " enabled" : ""}`} />
          <p className="fine-print">
          {serviceState !== "ready"
            ? "游戏服务未连接 · AI 状态暂不可用"
            : llm === null ? "AI 状态暂不可用，正在重新检查…"
            : llm.enabled
            ? `AI 已配置 · ${llm.model} · 关键决策由大模型参与`
            : "本地策略机器人 · 管理员配置 API Key 后启用大模型"}
          </p>
        {llm?.configurable ? (
          <button type="button" className="ghost llm-open" onClick={() => setLlmOpen(true)}>
            {llm.enabled ? "修改大模型配置" : "配置大模型"}
          </button>
        ) : null}
        </div>
        {llm ? <LlmActivity status={llm} onUpdate={onLlm} /> : null}
      </div>

      {llmOpen && llm ? <LlmDialog status={llm} onClose={() => setLlmOpen(false)} onSaved={onLlm} /> : null}
    </div>
  );
}

export function App(): ReactElement {
  const game = useGame();
  const [personas, setPersonas] = useState<PersonaInfo[]>([]);
  const [llm, setLlm] = useState<LlmStatus | null>(null);
  const [bounds, setBounds] = useState<SettingsBounds>(FALLBACK_BOUNDS);
  const [serviceState, setServiceState] = useState<"loading" | "ready" | "error">("loading");
  const [serviceError, setServiceError] = useState<string | null>(null);
  const [bootstrapAttempt, setBootstrapAttempt] = useState(0);
  const { connect } = game;
  const autoJoined = useRef(false);

  useEffect(() => {
    if (serviceState !== "ready") return;
    let active = true;
    const controller = new AbortController();
    const refresh = (): void => {
      void readBackendJson<LlmStatus>("/api/llm", controller.signal)
        .then((next) => { if (active && typeof next.enabled === "boolean") setLlm(next); })
        .catch(() => { if (active) setLlm(null); });
    };
    const timer = window.setInterval(refresh, 5000);
    return () => { active = false; controller.abort(); window.clearInterval(timer); };
  }, [serviceState]);

  useEffect(() => {
    if (autoJoined.current || serviceState !== "ready") return;
    const room = new URLSearchParams(window.location.search).get("room")?.toUpperCase();
    const savedName = localStorage.getItem(NAME_KEY);
    if (room && room.length > 0 && savedName) {
      autoJoined.current = true;
      connect(room, savedName);
    }
  }, [connect, serviceState]);

  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 10_000);
    setServiceState("loading");
    setServiceError(null);
    void Promise.all([
      readBackendJson<{ personas: PersonaInfo[]; llm: LlmStatus }>("/api/personas", controller.signal),
      readBackendJson<ServerConfig>("/api/config", controller.signal),
    ]).then(([payload, config]) => {
      if (!Array.isArray(payload.personas) || payload.personas.length === 0 || typeof payload.llm?.enabled !== "boolean" || !config.bounds) {
        throw new Error("游戏服务配置数据不完整，请检查部署版本");
      }
      if (!active) return;
      setPersonas(payload.personas);
      setLlm(payload.llm);
      setBounds(config.bounds);
      setServiceState("ready");
    }).catch((error: unknown) => {
      if (!active) return;
      setPersonas([]);
      setLlm(null);
      setServiceState("error");
      setServiceError(error instanceof Error && error.name !== "AbortError" ? error.message : "游戏服务请求超时或不可达");
    }).finally(() => window.clearTimeout(timeout));
    return () => { active = false; controller.abort(); window.clearTimeout(timeout); };
  }, [bootstrapAttempt]);

  return (
    <>
      {game.notice ? (
        <div className="notice" role="alert">
          <span>{game.notice}</span>
          <button type="button" onClick={game.dismissNotice}>
            ✕
          </button>
        </div>
      ) : null}

      {game.view ? (
        <TableScreen
          view={game.view}
          personas={personas}
          bounds={bounds}
          llm={llm}
          status={game.status}
          chat={game.chat}
          onSend={game.send}
          onLeave={game.disconnect}
          onRequestHistory={game.requestHistory}
          onLlm={setLlm}
        />
      ) : (
        <Lobby personas={personas} llm={llm} onLlm={setLlm} onJoin={game.connect} status={game.status}
          serviceState={serviceState} serviceError={serviceError} connectionError={game.connectionError}
          onRetry={() => setBootstrapAttempt((value) => value + 1)} onCancel={game.disconnect} />
      )}

      {game.historyEntry ? <HistoryDialog entry={game.historyEntry} onClose={game.closeHistory} /> : null}
    </>
  );
}
