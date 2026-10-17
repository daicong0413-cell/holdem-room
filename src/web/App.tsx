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

import { useI18n, LanguageSwitch } from "./i18n.tsx";
import { actionLabel, handLabel, streetLabel, PERSONA_EN } from "./locale.ts";
import { BotManager, BuyInDialog, Dialog, SeatPicker } from "./RoomControls.tsx";

import { allInIsDistinct, potBetAmount } from "./betting.ts";
import { readBackendJson } from "./backend.ts";
import { displayCard, displayRank, isRedSuit, money, SUIT_SYMBOLS } from "../shared/format.ts";
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
  const { t, language } = useI18n();
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
      if (!response.ok || (!payload.ok && !payload.status)) setTestError(payload.error ?? t("连接测试失败"));
    } catch {
      setTestError(t("无法连接游戏服务"));
    } finally {
      setTesting(false);
    }
  };

  return (
    <div className="llm-activity">
      <div className="llm-activity-head">
        <strong>{t("API 调用")}</strong>
        <span>{calls === 0 ? t("等待机器人行动") : pending > 0 ? t(`${pending} 次请求中`, `${pending} pending`) : stats?.lastError ? t("最近调用失败") : t("已成功调用")}</span>
      </div>
      <div className="llm-counts"><span>{t("总计", "Total")} {calls}</span><span>{t("成功", "Succeeded")} {successes}</span><span>{t("失败", "Failed")} {failures}</span></div>
      <div className="llm-tokens" title={t("接口返回的累计 token；重启服务或更换配置后清零。包含格式不合法但接口已返回的响应。")}>
        Token · {t("输入", "In")} {(stats?.promptTokens ?? 0).toLocaleString("en-US")} / {t("输出", "Out")} {(stats?.completionTokens ?? 0).toLocaleString("en-US")}
      </div>
      {testError || stats?.lastError ? <p className="llm-diagnostic" role="status">{t(testError ?? stats?.lastError ?? "")}</p> : null}
      {status.configurable ? <button type="button" className="ghost llm-test" onClick={() => void test()} disabled={testing}
        title={t("测试当前已保存的配置，会产生一次请求和少量 token 用量。")}>{testing ? t("正在测试…") : t("测试连接")}</button> : null}
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
  const { t, language } = useI18n();
  return <span className={`card card-${size} card-back`} aria-label={t("暗牌")} />;
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
function useFeltScale(): { ref: RefObject<HTMLElement | null>; scale: number; compact: boolean; width: number; height: number } {
  const ref = useRef<HTMLElement>(null);
  const [layout, setLayout] = useState({ scale: 1, compact: false, width: FELT_BASE_WIDTH, height: FELT_BASE_HEIGHT });

  useEffect(() => {
    const area = ref.current;
    if (!area) return;

    const measure = (): void => {
      const rect = area.getBoundingClientRect();
      const style = getComputedStyle(area);
      const compact = rect.width <= 600;
      const width = compact ? 340 : FELT_BASE_WIDTH;
      const height = compact ? 400 : FELT_BASE_HEIGHT;
      const rail = compact ? 12 : FELT_RAIL;
      const available = {
        width:
          rect.width -
          parseFloat(style.paddingLeft) -
          parseFloat(style.paddingRight) -
          rail * 2,
        height:
          rect.height -
          parseFloat(style.paddingTop) -
          parseFloat(style.paddingBottom) -
          rail * 2,
      };
      if (available.width <= 0 || available.height <= 0) return;
      const fit = Math.min(available.width / width, available.height / height);
      setLayout({ scale: Math.max(0.2, Math.min(fit, 2.4)), compact, width, height });
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

  return { ref, ...layout };
}

function seatSlot(viewerSeat: number | null, seatIndex: number, total: number): number {
  if (viewerSeat === null || viewerSeat < 0) return seatIndex;
  return (seatIndex - viewerSeat + total) % total;
}

function slotPosition(slot: number, total: number, radiusX: number, radiusY: number): { left: string; top: string } {
  const angle = Math.PI / 2 + (slot * 2 * Math.PI) / total;
  return { left: `${50 + radiusX * Math.cos(angle)}%`, top: `${50 + radiusY * Math.sin(angle)}%` };
}

function phoneSeatPosition(slot: number, total: number): { left: string; top: string } {
  if (slot === 0) return { left: "50%", top: "88%" };
  const positions: Record<number, Array<[number, number]>> = {
    2: [[50, 12]],
    3: [[18, 25], [82, 25]],
    4: [[15, 48], [50, 12], [85, 48]],
    5: [[15, 65], [22, 18], [78, 18], [85, 65]],
    6: [[14, 69], [14, 29], [50, 12], [86, 29], [86, 69]],
    7: [[14, 71], [14, 42], [34, 12], [66, 12], [86, 42], [86, 71]],
    8: [[14, 73], [14, 45], [18, 18], [50, 10], [82, 18], [86, 45], [86, 73]],
    9: [[14, 75], [14, 49], [14, 23], [37, 8], [68, 8], [86, 28], [86, 53], [86, 78]],
  };
  const [left, top] = positions[total]?.[slot - 1] ?? [50, 12];
  return { left: `${left}%`, top: `${top}%` };
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
        case "roomClosed":
          if (retry.current?.timer != null) window.clearTimeout(retry.current.timer);
          retry.current = null;
          socketRef.current = null;
          socket.close();
          setStatus("idle");
          setView(null);
          setHistoryEntry(null);
          setNotice("所有真人已离桌，牌桌已自动关闭。");
          window.history.replaceState(null, "", window.location.pathname);
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
    if (socketRef.current?.readyState === WebSocket.OPEN) socketRef.current.send(JSON.stringify({ t: "leave" }));
    socketRef.current?.close();
    socketRef.current = null;
    window.history.replaceState(null, "", window.location.pathname);
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
  minBuyIn,
  canSit,
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
  minBuyIn: number;
  canSit: boolean;
  onSit: (seat: number, buyIn: number) => void;
  /** Give up the seat; the server defers it until the hand settles. */
  onStand: () => void;
  /** Takes a bot off the table after the current hand settles. */
  onRemoveBot: (seat: number) => void;
  onAddBot: (seat: number, persona: string, buyIn: number) => void;
}): ReactElement {
  const { t, language } = useI18n();
  const available = personas.filter((option) => !takenPersonas.has(option.id));

  if (seat.playerId === null) {
    return (
      <div className={`seat is-empty${expanded ? " is-selecting" : ""}`} style={position}>
        <button
          type="button"
          className="empty-seat-trigger"
          onClick={onToggle}
          aria-expanded={expanded}
          aria-label={t(`选择空位 ${seat.index + 1}`, `Choose open seat ${seat.index + 1}`)}
        >
          <span className="empty-seat-plus" aria-hidden="true">+</span>
          <span>{t(`空位 ${seat.index + 1}`, `Seat ${seat.index + 1}`)}</span>
        </button>
        {/* Taking a seat is always possible: mid-hand you simply wait for the
            next deal, which the server handles by not dealing you in. */}
        {expanded ? (
          <div className={`seat-picker${parseFloat(position.top) > 60 ? " above" : ""}`}>
            <div className="seat-picker-head">
              <strong>{t(`空位 ${seat.index + 1}`, `Open seat ${seat.index + 1}`)}</strong>
              <button type="button" onClick={onToggle} aria-label={t("收起座位选项")}>×</button>
            </div>
            <SeatPicker index={seat.index} defaultBuyIn={defaultBuyIn} minBuyIn={minBuyIn} personas={available}
              canManage={canManage} canSit={canSit} onSit={onSit} onAddBot={onAddBot} />
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
            <span className={`seat-action ${labelOnLeft ? "on-left" : "on-right"}`}>{actionLabel(seat.lastAction, language)}</span>
          ) : null}
        </div>
        <div className="seat-plate">
          <span className="seat-row">
            <span className="seat-name">{seat.name}</span>
            {seat.isYou && seat.handCategory != null ? (
              <span className="seat-hand" title={t("你的最佳牌型")}>{handLabel(seat.handCategory, language)}</span>
            ) : seat.isYou ? <span className="you-label">{t("You")}</span> : null}
            <span className="seat-badges">
            {isButton ? <span className="badge dealer" title={t("庄家按钮")}>D</span> : null}
            {isSmallBlind ? <span className="badge blind">SB</span> : null}
            {isBigBlind ? <span className="badge blind">BB</span> : null}
            {seat.allIn ? <span className="badge allin">{t("All-in")}</span> : null}
            {seat.folded ? <span className="badge folded">{t("Fold")}</span> : null}
            </span>
          </span>
          {/* Chips live on their own line, under the name. */}
          <span className="seat-row">
            <span className="seat-stack">{money(seat.stack)}</span>
            {seat.isYou ? (
              <button type="button" className="stand-btn" disabled={seat.leaving} onClick={onStand} title={t("离座，把筹码收回来")}>
                {t("离座")}
              </button>
            ) : null}
            {!seat.isYou && seat.isBot && canManage ? (
              <button
                type="button"
                className="stand-btn"
                disabled={seat.leaving}
                onClick={() => onRemoveBot(seat.index)}
                title={t("让这个机器人离桌")}
              >
                {t("离桌")}
              </button>
            ) : null}
          </span>
          {seat.streetCommitted > 0 && !showResult ? <span className="mobile-contribution">{t("下注")} {money(seat.streetCommitted)}</span> : null}
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
  const { t, language } = useI18n();
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
        <strong>{t("Your turn")}</strong>
        <span>{legal.canCheck ? t("Check is free") : t(`跟注 ${money(legal.callCost)} · 跟注后底池 ${money(totalPot + legal.callCost)}`, `Call ${money(legal.callCost)} · Pot after call ${money(totalPot + legal.callCost)}`)}</span>
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
            aria-label={t("加注额")}
          />
          <label className="buyin raise-buyin" title={t("加注金额")}>
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
              aria-label={t("手动输入加注金额")}
            />
          </label>
          <div className="raise-presets">
            <button type="button" onClick={() => { setTyped(null); setTarget(potBet(1 / 3)); }}>{t("⅓ Pot")}</button>
            <button type="button" onClick={() => { setTyped(null); setTarget(potBet(0.5)); }}>
              {t("½ Pot")}
            </button>
            <button type="button" onClick={() => { setTyped(null); setTarget(potBet(1)); }}>
              {t("Pot")}
            </button>
            <button type="button" onClick={() => { setTyped(null); setTarget(legal.maxRaiseTo); }}>
              {t("All-in")}
            </button>
          </div>
        </div>
      ) : null}

      <div className="action-buttons">
        <button type="button" className="danger" onClick={() => onAction({ t: "action", action: { type: "fold" } })}>
          {t("Fold")}
        </button>

        {legal.canCheck ? (
          <button type="button" onClick={() => onAction({ t: "action", action: { type: "check" } })}>
            {t("Check")}
          </button>
        ) : null}

        {legal.canCall ? (
          <button type="button" onClick={() => onAction({ t: "action", action: { type: "call" } })}>
            {t("跟注")} {money(legal.callCost)}
            {legal.callCost < legal.toCall ? t("（全下）", " (All-in)") : ""}
          </button>
        ) : null}

        {legal.canRaise ? (
          <button
            type="button"
            className="primary"
            onClick={() => onAction({ t: "action", action: { type: "raise", to: clamped } })}
          >
            {legal.toCall > 0 ? t(`加注到 ${money(clamped)}`, `Raise to ${money(clamped)}`) : t(`下注 ${money(clamped)}`, `Bet ${money(clamped)}`)}
          </button>
        ) : showAllIn ? (
          <button
            type="button"
            className="primary"
            onClick={() => onAction({ t: "action", action: { type: "raise", to: legal.maxRaiseTo } })}
          >
            {t("全下")} {money(legal.maxRaiseTo)}
          </button>
        ) : null}

      </div>
    </div>
  );
}

function ChatBox({
  chat,
  onSend,
  compact = false,
}: {
  chat: ChatLine[];
  onSend: (text: string) => void;
  compact?: boolean;
}): ReactElement {
  const { t, language } = useI18n();
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

  const content = <>
      <div className="chat-lines" ref={linesRef}>
        {chat.length === 0 ? (
          <span className="chat-empty">{t("桌边聊天")}</span>
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
          placeholder={t("说点什么…")}
          aria-label={t("聊天输入框")}
        />
        <button type="submit" disabled={draft.trim().length === 0}>
          {t("发送")}
        </button>
      </form>
    </>;
  return compact ? <details className="chat-box compact-chat"><summary>{t("桌边聊天")} · {chat.length}</summary>{content}</details>
    : <section className="chat-box">{content}</section>;
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
  const { t, language } = useI18n();
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
          <h2>{t("房间设置")}</h2>
          <button type="button" className="ghost" onClick={onClose}>
            ✕
          </button>
        </header>

        <div className="settings-grid">
          <label className={anyoneSeated ? "disabled" : ""}>
            <span>{t("座位数")}{anyoneSeated ? t("（有人入座后不能改）") : ""}</span>
            {number("seats", "seats", anyoneSeated)}
          </label>

          <label className={gameStarted ? "disabled" : ""}>
            <span>{t("模式")}{gameStarted ? t("（开局后不能改）") : ""}</span>
            <select
              value={draft.mode}
              disabled={gameStarted}
              onChange={(event) => setDraft({ ...draft, mode: event.target.value as GameMode })}
            >
              <option value="cash">{t("现金局（盲注固定）")}</option>
              <option value="tournament">{t("锦标赛（盲注递增）")}</option>
            </select>
          </label>

          <label>
            <span>{t("起始筹码（每个新入座玩家的默认买入）")}</span>
            {number("startingStack", "startingStack")}
          </label>

          <label>
            <span>{t("行动限时（秒，0 = 关闭）")}</span>
            {number("actionTimeoutSeconds", "actionTimeoutMs")}
          </label>

          <label className={handInProgress ? "disabled" : ""}>
            <span>{t("小盲")}{handInProgress ? t("（本手结束可改）") : ""}</span>
            {number("smallBlind", "smallBlind", handInProgress)}
          </label>

          <label className={handInProgress ? "disabled" : ""}>
            <span>{t("大盲")}{handInProgress ? t("（本手结束可改）") : ""}</span>
            {number("bigBlind", "bigBlind", handInProgress)}
          </label>

          {/* Same shape as every other field: title on top, control below. */}
          <div className="switch-field">
            <span>{t("自动开始下一手牌")}</span>
            <label className="switch">
              <input
                type="checkbox"
                checked={draft.autoStartSeconds > 0}
                onChange={(event) =>
                  setDraft({ ...draft, autoStartSeconds: event.target.checked ? autoStartLast : 0 })
                }
              />
              <span className="track" aria-hidden="true" />
              <span className="switch-state">{draft.autoStartSeconds > 0 ? t("开启") : t("关闭")}</span>
            </label>
            {draft.autoStartSeconds > 0 ? (
              <label className="switch-sub">
                <span>{t("间隔（秒）")}</span>
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
              <em className="switch-note">{t("手动开始：每手结束点「开始下一手」")}</em>
            )}
          </div>

          <div className="switch-field">
            <span>{t("机器人输光后自动重新买入")}</span>
            <label className="switch">
              <input
                type="checkbox"
                checked={draft.botAutoRebuy}
                onChange={(event) => setDraft({ ...draft, botAutoRebuy: event.target.checked })}
              />
              <span className="track" aria-hidden="true" />
              <span className="switch-state">{draft.botAutoRebuy ? t("开启") : t("关闭")}</span>
            </label>
            <em className="switch-note">
              {draft.botAutoRebuy ? t("输光的机器人会按各自买入金额重新买入") : t("输光的机器人坐着看戏，不再补筹码")}
            </em>
          </div>

          {draft.mode === "tournament" ? (
            <>
              <label className={gameStarted ? "disabled" : ""}>
                <span>{t("每多少手升盲")}{gameStarted ? t("（开局后不能改）") : ""}</span>
                {number("blindLevelHands", "blindLevelHands", gameStarted)}
              </label>
              <label className={gameStarted ? "disabled" : ""}>
                <span>{t("每次盲注倍数")}{gameStarted ? t("（开局后不能改）") : ""}</span>
                {number("blindGrowth", "blindGrowth", gameStarted)}
              </label>
            </>
          ) : null}
        </div>

        <p className="fine-print">
          {draft.mode === "tournament"
            ? t(`锦标赛：当前第 ${view.settings.level} 级，盲注 ${view.smallBlind}/${view.bigBlind}${
                view.settings.handsUntilNextLevel === null ? "" : `，还有 ${view.settings.handsUntilNextLevel} 手升级`
              }。`, `Tournament · Level ${view.settings.level} · Blinds ${view.smallBlind}/${view.bigBlind} · ${view.settings.handsUntilNextLevel ?? 0} hands to next level`)
            : t("现金局：盲注保持不变，可以随时调整。")}
        </p>

        <footer>
          <button type="button" onClick={onClose}>
            {t("取消")}
          </button>
          <button type="button" className="primary" onClick={save}>
            {t("保存")}
          </button>
        </footer>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------- history

function HistoryDialog({ entry, onClose }: { entry: HandHistoryEntry; onClose: () => void }): ReactElement {
  const { t, language } = useI18n();
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal history-modal" onClick={(event) => event.stopPropagation()}>
        <header>
          <h2>
            {t(`第 ${entry.handId} 手`, `Hand #${entry.handId}`)}
            <span className="history-meta">
              {t("盲注")} {entry.smallBlind}/{entry.bigBlind}
              {entry.level > 1 ? t(` · 第 ${entry.level} 级`, ` · Level ${entry.level}`) : ""} · {entry.reason === "fold" ? t("弃牌结束") : t("摊牌")}
            </span>
          </h2>
          <button type="button" className="ghost" onClick={onClose}>
            ✕
          </button>
        </header>

        <div className="history-board">
          {entry.board.length === 0 ? (
            <span className="board-hint">{t("没有公共牌")}</span>
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
                    ? t("已弃牌（底牌不入档）")
                    : t("未亮牌")}
              </span>
              <span className={seat.net >= 0 ? "hs-net up" : "hs-net down"}>
                {seat.net > 0 ? "+" : ""}
                {seat.net}
              </span>
            </li>
          ))}
        </ul>

        <h3 className="history-sub">{t("行动记录")}</h3>
        <ol className="log history-log">
          {entry.log.map((line, index) => (
            <li key={index} className={`log-${line.street}`}>
              {language === "en" ? line.textEn ?? line.text : line.text}
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
  const { t, language } = useI18n();
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
  const [buyInOpen, setBuyInOpen] = useState(false);
  const [botsOpen, setBotsOpen] = useState(false);

  const heroSeat = view.seats.find((seat) => seat.isYou)?.index ?? -1;
  const heroSeated = heroSeat >= 0;
  const hero = view.seats.find((seat) => seat.isYou);
  const heroStack = heroSeated ? (view.seats[heroSeat]?.stack ?? 0) : 0;
  const seatTotal = view.seats.length;
  const blinds = useMemo(() => blindSeats(view), [view]);
  const canManageSeats = view.isHost;
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
      window.prompt(t("复制这个邀请链接发给朋友："), inviteUrl);
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
      if (view.isHost) onSend({ t: "addBot", seat: seat.index, persona: persona.id, buyIn: view.settings.startingStack });
    }
    setSelectedSeat(null);
    onSend({ t: "startHand" });
  };

  const modeChip =
    view.settings.mode === "tournament"
      ? t(`锦标赛 第 ${view.settings.level} 级${
          view.settings.handsUntilNextLevel === null ? "" : ` · 还有 ${view.settings.handsUntilNextLevel} 手升盲`
        }`, `Tournament · Level ${view.settings.level} · ${view.settings.handsUntilNextLevel ?? 0} hands to next level`)
      : t("现金局");

  return (
    <div className={`room${felt.compact ? " compact-room" : ""}`} style={{ "--ui-scale": uiScale } as CSSProperties}>
      <header className="topbar">
        <LanguageSwitch />
        <div className="table-brand">
          <span aria-hidden="true">♠</span>
          <div><strong>{t("德州扑克")}</strong><small>{t("NPC 牌桌")}</small></div>
        </div>
        <div className="room-chip">
          {t("房间")} <strong>{view.roomCode}</strong>
        </div>
        <button type="button" onClick={copyInvite}>
          {copied ? t("已复制 ✓") : t("复制邀请链接")}
        </button>
        <div className="blinds-chip">
          {t("盲注")} <strong>{view.smallBlind}/{view.bigBlind}</strong>
        </div>
        <div className="mode-chip">{modeChip}</div>
        {view.isHost ? (
          <button type="button" onClick={() => setSettingsOpen(true)}>
            {t("⚙ 房间设置")}
          </button>
        ) : null}
        {view.isHost ? <button type="button" onClick={() => setBotsOpen(true)}>{t("机器人管理", "Manage bots")}</button> : null}
        {heroSeated && view.settings.mode === "cash" ? <button type="button" disabled={hero?.leaving} onClick={() => setBuyInOpen(true)}>{t("追加买入", "Add chips")}</button> : null}
        {heroSeated ? <button type="button" className="mobile-stand" disabled={hero?.leaving} onClick={() => onSend({ t: "stand" })}>{t("离座")}</button> : null}
        <span className={`conn conn-${status}`}>
          {status === "open" ? t("已连接") : status === "connecting" ? t("连接中…") : status === "closed" ? t("重连中…") : t("未连接")}
        </span>
        <button type="button" className="ghost" onClick={onLeave}>
          {t("离开")}
        </button>
      </header>

      <main className="table-area" ref={felt.ref}>
        <div className="table-caption">
          <span>{modeChip} · {occupiedSeats}/{seatTotal} {t("人", "players")}</span>
          <span>{view.handId > 0 ? t(`第 ${view.handId} 手`, `Hand #${view.handId}`) : t("准备开桌")}</span>
        </div>
        <div
          className="felt-scale"
          style={{ width: felt.width * felt.scale, height: felt.height * felt.scale }}
        >
          <div className={`felt${felt.compact ? " compact-felt" : ""}`} style={{ width: felt.width, height: felt.height, transform: `scale(${felt.scale})` }}>
          <div className="table-center">
            {view.handId === 0 ? (
              <div className="table-welcome">
                <span className="welcome-suits" aria-hidden="true">♠ <i>♥</i> ♣ <i>♦</i></span>
                <h2>{t("好对手，就位。")}</h2>
                <p>{t("选一个空位坐下，或直接开始一桌。")}</p>
                <button type="button" className="primary" onClick={quickStart} disabled={status !== "open" || (!heroSeated && occupiedSeats === seatTotal)}>
                  {t("快速开桌")} <span aria-hidden="true">↗</span>
                </button>
                <small>{t("自动入座 · 最多 3 位机器人陪练")}</small>
              </div>
            ) : <>
            <div className="center-pot"><span>{t("底池")}</span><strong>{money(view.pot)}</strong></div>
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
                ? t(`本轮下注 ${money(liveBets)} · 总底池 ${money(view.pot + liveBets)}`, `Live bets ${money(liveBets)} · Total pot ${money(view.pot + liveBets)}`)
                : view.result ? t("本手已结算") : t("筹码已收进底池")}
            </div>
            </>}
          </div>

          {view.seats.map((seat) => {
            const slot = seatSlot(heroSeated ? heroSeat : null, seat.index, seatTotal);
            // The bottom seat carries the viewer's own (large) cards plus a name
            // plate, so it sits further inside the felt to stay clear of the dock.
            const position = felt.compact ? phoneSeatPosition(slot, seatTotal) : slotPosition(slot, seatTotal, 43, slot === 0 ? 29 : 36);
            return (
              <Seat
                key={seat.index}
                seat={seat}
                position={position}
                betPosition={felt.compact ? { left: `${50 + (parseFloat(position.left) - 50) * 0.64}%`, top: `${50 + (parseFloat(position.top) - 50) * 0.75}%` } : slotPosition(slot, seatTotal, 31, slot === 0 ? 15 : 26)}
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
                minBuyIn={Math.max(20, view.bigBlind * 2)}
                canSit={!heroSeated}
                takenPersonas={takenPersonas}
                expanded={!felt.compact && selectedSeat === seat.index}
                onToggle={() => setSelectedSeat(selectedSeat === seat.index ? null : seat.index)}
                onSit={(index, amount) => { setSelectedSeat(null); onSend({ t: "sit", seat: index, buyIn: amount }); }}
                onStand={() => onSend({ t: "stand" })}
                onRemoveBot={(index) => onSend({ t: "removeBot", seat: index })}
                onAddBot={(index, persona, buyIn) => { setSelectedSeat(null); onSend({ t: "addBot", seat: index, persona, buyIn }); }}
              />
            );
          })}
        </div>
        </div>
      </main>

      <aside className="sidebar">
        <div className="sidebar-heading"><span className="eyebrow">{t("TABLE NOTES")}</span><strong>{t("牌局动态")}</strong></div>
        <div className="sidebar-tabs">
          <button type="button" className={tab === "live" ? "active" : ""} onClick={() => setTab("live")}>
            {t("本手")}
          </button>
          <button type="button" className={tab === "history" ? "active" : ""} onClick={() => setTab("history")}>
            {t("历史")} {view.history.length > 0 ? view.history.length : ""}
          </button>
        </div>

        {tab === "live" ? (
          <ol className="log">
            {view.log.length === 0 ? <li className="log-empty"><span aria-hidden="true">♧</span><strong>{t("故事从第一手开始")}</strong><p>{t("盲注、下注和结算会记录在这里。")}</p></li> : null}
            {view.log.map((entry, index) => (
              <li key={index} className={`log-${entry.street}`}>
                {language === "en" ? entry.textEn ?? entry.text : entry.text}
              </li>
            ))}
          </ol>
        ) : view.history.length === 0 ? (
          <p className="hint">{t("还没有打完的牌局。每手结束后会自动归档，随时点开回看。")}</p>
        ) : (
          <ol className="history-list">
            {[...view.history].reverse().map((summary) => (
              <li key={summary.handId}>
                <button type="button" onClick={() => onRequestHistory(summary.handId)}>
                  <span className="hl-top">
                    <span className="hl-no">{t(`第 ${summary.handId} 手`, `Hand #${summary.handId}`)}</span>
                    <span className="hl-pot">{t("底池")} {money(summary.potTotal)}</span>
                  </span>
                  <span className="hl-board">
                    {summary.board.length > 0 ? summary.board.map(displayCard).join(" ") : t("翻前结束")}
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
            <span>{t("大模型")}</span>
            <strong className={llm?.enabled ? "on" : undefined}>
              {llm?.enabled ? llm.model : t("未接入 · 本地决策")}
            </strong>
          </div>
          <div className="foot-row">
            <span>{t("房间码")}</span>
            <strong>{view.roomCode}</strong>
          </div>
          <div className="foot-row">
            <span>{t("盲注")}</span>
            <strong>
              {view.smallBlind}/{view.bigBlind}
              {view.settings.level > 1 ? t(` · 第 ${view.settings.level} 级`, ` · Level ${view.settings.level}`) : ""}
            </strong>
          </div>
          <div className="foot-row">
            <span>{t("你的位置")}</span>
            <strong>{heroSeated ? t(`${heroSeat + 1} 号位`, `Seat ${heroSeat + 1}`) : t("旁观")}</strong>
          </div>
        </div>
      </aside>

      <footer className="action-dock">
        {view.paused ? <p className="presence-note" role="status">{t("没有在线真人玩家入座，牌局已暂停。", "No human player is online and seated. Play is paused.")}</p> : null}
        {hero && hero.pendingBuyIn > 0 ? <p className="presence-note" role="status">{t(`待到账买入 ${money(hero.pendingBuyIn)} · 本手结算后到账`, `Pending buy-in ${money(hero.pendingBuyIn)} · Arrives after this hand`)}</p> : null}
        {hero?.leaving ? <p className="presence-note">{t("本手结束后离座", "Standing up after this hand")}</p> : null}
        {heroSeated && view.seats[heroSeat]?.hole?.length ? (
          <div className="mobile-hand">
            <div className="mobile-hand-cards">
              {view.seats[heroSeat]!.hole!.map((card) => <Card key={card} card={card} size="sm" />)}
            </div>
            <div>
              {hero?.handCategory != null ? <span className="seat-hand">{handLabel(hero.handCategory, language)}</span> : null}
              <span>{t("你的手牌")}{view.seats[heroSeat]?.folded ? t(" · 已弃牌") : ""}</span>
              <strong>{money(heroStack)} <small>{(heroStack / view.bigBlind).toFixed(1)} BB</small></strong>
            </div>
          </div>
        ) : null}
        {view.result ? (
          <div className="result">
            <div className="result-head">
              <strong>{view.result.reason === "fold" ? t("其余玩家弃牌") : t("摊牌")}</strong>
              {view.canShowCards ? <button type="button" className="show-cards" disabled={status !== "open"} onClick={() => onSend({ t: "showCards", handId: view.handId })}>{t("亮出底牌", "Show cards")}</button> : null}
              {view.cardsShown ? <span className="hint">{t("底牌已公开", "Cards shown")}</span> : null}
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
                  <em>{handLabel(entry.category, language, entry.ranks)}</em>
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        <fieldset className="dock-row" disabled={status !== "open"}>
          <ChatBox chat={chat} compact={felt.compact} onSend={(text) => onSend({ t: "chat", text })} />

          <div className="dock-actions">
            {view.canStartHand ? (
              <button type="button" className="primary start" onClick={() => onSend({ t: "startHand" })}>
                {t("开始下一手")}
              </button>
            ) : null}
            {view.canStartHand && nextHandCountdown !== null ? (
              <span className="hint">{t(`${nextHandCountdown} 秒后自动开始`, `Next deal in ${nextHandCountdown}s`)}</span>
            ) : null}

            {heroSeated && heroStack === 0 && view.settings.mode === "tournament" ? <span className="hint">{t("你在锦标赛出局了，可以留下来观战。")}</span> : null}

            {!heroSeated ? <span className="hint">{t("你正在观战 · 选择一个空位入座")}</span> : null}

            {view.legal ? (
              <ActionBar view={view} onAction={onSend} countdown={countdown} />
            ) : view.toActIndex !== null && view.street !== "complete" ? (
              <div className="waiting-turn" role="status">
                <span className="thinking-dots" aria-hidden="true"><i /><i /><i /></span>
                <div><strong>{view.seats[view.toActIndex]?.name ?? "Opponent"} · {view.seats[view.toActIndex]?.isBot ? t("思考中…", "Thinking…") : t("行动中…", "Acting…")}</strong>
                  <span>{countdown !== null ? t(`剩余 ${countdown} 秒`, `${countdown}s remaining`) : t("等待下一步行动。")}</span></div>
              </div>
            ) : (
              view.handId > 0 ? <span className="hint">{streetLabel(view.street, language)}</span> : null
            )}
          </div>
        </fieldset>
      </footer>

      {buyInOpen && hero ? <BuyInDialog view={view} onSend={onSend} onClose={() => setBuyInOpen(false)} /> : null}
      {botsOpen && view.isHost ? <BotManager view={view} personas={personas} onSend={onSend} onClose={() => setBotsOpen(false)} /> : null}
      {felt.compact && selectedSeat !== null && !view.seats[selectedSeat]?.playerId ? <Dialog title={t(`空位 ${selectedSeat + 1}`, `Open seat ${selectedSeat + 1}`)} onClose={() => setSelectedSeat(null)}>
        <SeatPicker key={selectedSeat} index={selectedSeat} defaultBuyIn={view.settings.startingStack} minBuyIn={Math.max(20, view.bigBlind * 2)}
          personas={personas.filter((persona) => !takenPersonas.has(persona.id))} canManage={view.isHost} canSit={!heroSeated}
          onSit={(seat, buyIn) => { onSend({ t: "sit", seat, buyIn }); setSelectedSeat(null); }}
          onAddBot={(seat, persona, buyIn) => { onSend({ t: "addBot", seat, persona, buyIn }); setSelectedSeat(null); }} />
      </Dialog> : null}
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
  const { t, language } = useI18n();
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
        if (!response.ok) throw new Error(payload.error ?? t("保存失败"));
        onSaved(payload);
        onClose();
      })
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : t("保存失败")))
      .finally(() => setBusy(false));
  };

  return (
    <div className="llm-overlay" onClick={onClose}>
      <div className="llm-dialog" onClick={(event) => event.stopPropagation()}>
        <h2>{t("大模型配置")}</h2>
        <p className="llm-note">
          {t("设置保存在服务器本机，API Key 不会发给浏览器。配置后每次机器人行动都会调用模型，失败时使用本地策略。", "Settings stay on the server; the API key is never sent to browsers. Every bot action uses the configured model, with a local fallback on failure.")}
        </p>

        <label className="llm-field">
          <span>API Key{status.enabled ? t("（已配置，留空则不改）", " (configured; blank keeps current key)") : ""}</span>
          <input
            type="password"
            value={apiKey}
            placeholder={status.enabled ? t("保持原样") : "sk-..."}
            onChange={(event) => setApiKey(event.target.value)}
            autoComplete="off"
          />
        </label>

        <label className="llm-field">
          <span>{t("接口地址（留空 = 默认）")}</span>
          <input
            value={baseUrl}
            placeholder="https://api.deepseek.com"
            onChange={(event) => setBaseUrl(event.target.value)}
          />
        </label>

        <label className="llm-field">
          <span>{t("模型名（留空 = 默认）")}</span>
          <input value={model} placeholder="deepseek-chat" onChange={(event) => setModel(event.target.value)} />
        </label>

        <p className="llm-note">
          {t("支持兼容 OpenAI /chat/completions 的服务。", "Supports OpenAI-compatible /chat/completions endpoints.")}
        </p>

        {error ? <p className="llm-error">{t(error)}</p> : null}

        <div className="llm-actions">
          <button type="button" onClick={onClose} disabled={busy}>
            {t("取消")}
          </button>
          {status.enabled ? (
            <button type="button" className="danger" onClick={() => submit(true)} disabled={busy}>
              {t("关闭大模型")}
            </button>
          ) : null}
          <button type="button" className="primary" onClick={() => submit(false)} disabled={busy}>
            {t("保存")}
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
  const { t, language } = useI18n();
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
        <LanguageSwitch />
        <div className="lobby-brand"><span aria-hidden="true">♠</span> {t("德州扑克")} <small>{t("NPC 牌桌")}</small></div>
        <span className="eyebrow">{t("A SEAT FOR EVERY PERSONALITY")}</span>
        <h1>{t("牌桌已备好。", "The table is set.")}<br /><em>{t("就等你入座。", "Your seat is waiting.")}</em></h1>
        <p>{t("约上朋友，或会会五位个性鲜明的对手。", "Invite friends or face five distinct opponents.")}<br />{t("从一手好牌，开始今晚的故事。", "Your next good story starts with a hand.")}</p>
        <div className="lobby-facts">
          <span><strong>2–9</strong> {t("人同桌", "players")}</span>
          <span><strong>5</strong> {t("种对手", "personalities")}</span>
          <span><strong>∞</strong> {t("种可能", "possibilities")}</span>
        </div>
      </header>
      <form className="lobby-card" onSubmit={submit}>
        <div className="lobby-card-head">
          <span className="eyebrow">{t("TAKE YOUR SEAT")}</span>
          <h2>{t("来一局？")}</h2>
          <p className="lobby-sub">{t("一个昵称，就能上桌。")}</p>
        </div>
        <div className="lobby-tabs" aria-label={t("开桌方式")}>
          <button type="button" aria-pressed={mode === "create"} onClick={() => setMode("create")}>{t("创建房间")}</button>
          <button type="button" aria-pressed={mode === "join"} onClick={() => setMode("join")}>{t("加入朋友")}</button>
        </div>

        <label>
          <span>{t("你的昵称")}</span>
          <input value={name} onChange={(event) => setName(event.target.value)} maxLength={16} placeholder={t("牌桌上怎么称呼你？")} autoComplete="nickname" required autoFocus />
        </label>

        {mode === "join" ? <label>
          <span>{t("朋友的房间码")}</span>
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
        </label> : <p className="create-note">{t("创建后可复制邀请链接，也可以直接和机器人练习。")}</p>}

        {serviceState === "error" ? <div className="service-error" role="alert">
          <strong>{t("游戏服务未连接")}</strong>
          <p>{t("暂时无法创建或加入房间，请稍后重试。")}</p>
          <details><summary>{t("给部署者的诊断")}</summary>
            <p>{t("请启动 Node 游戏服务，并转发 API 和 WebSocket 请求。")}</p>
            <code>{serviceError}</code>
          </details>
          <button type="button" className="ghost" onClick={onRetry}>{t("重新检查")}</button>
        </div> : serviceState === "loading" ? <p className="fine-print" role="status">{t("正在检查游戏服务…")}</p> : null}
        {connectionError ? <p className="llm-error" role="alert">{t(connectionError)}</p> : null}
        <button className="primary lobby-submit" type="submit" disabled={name.trim().length === 0 || connecting || serviceState !== "ready"}>
          {connecting ? t("正在连接…") : mode === "join" ? t("加入房间") : t("创建房间")}<span aria-hidden="true">↗</span>
        </button>
        {connecting ? <button className="ghost" type="button" onClick={onCancel}>{t("取消连接")}</button> : null}
        <span className="lobby-card-foot">{t("现金局 / 锦标赛 · 仅使用虚拟筹码")}</span>
      </form>

      <div className="persona-gallery">
        <div className="gallery-heading">
          <div><span className="eyebrow">{t("MEET THE TABLE")}</span><h2>{t("五种个性，同一张牌桌。")}</h2></div>
          <span className="gallery-note">{t("你会遇到怎样的对手？")}</span>
        </div>
        {personas.length > 0 ? <ul>
          {personas.map((persona) => (
            <li key={persona.id}>
              <div className={`persona-monogram persona-${persona.id}`} aria-hidden="true">
                {persona.name.slice(0, 1)}
              </div>
              <strong>{persona.name}</strong>
              {persona.description ? <span>{language === "en" ? PERSONA_EN[persona.id] ?? persona.description : persona.description}</span> : null}
            </li>
          ))}
        </ul> : <p className="fine-print">{t("连接游戏服务后显示全部对手。")}</p>}
        <div className="model-status">
          <span className={`model-dot${llm?.enabled ? " enabled" : ""}`} />
          <p className="fine-print">
          {serviceState !== "ready"
            ? t("游戏服务未连接 · AI 状态暂不可用")
            : llm === null ? t("AI 状态暂不可用，正在重新检查…")
            : llm.enabled
            ? t(`AI 已配置 · ${llm.model} · 所有决策均由大模型参与`, `AI configured · ${llm.model} · Every action uses the model`)
            : t("本地策略机器人 · 管理员配置 API Key 后启用大模型")}
          </p>
        {llm?.configurable ? (
          <button type="button" className="ghost llm-open" onClick={() => setLlmOpen(true)}>
            {llm.enabled ? t("修改大模型配置") : t("配置大模型")}
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
  const { t, language } = useI18n();
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
        throw new Error(t("游戏服务配置数据不完整，请检查部署版本"));
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
      setServiceError(error instanceof Error && error.name !== "AbortError" ? error.message : t("游戏服务请求超时或不可达"));
    }).finally(() => window.clearTimeout(timeout));
    return () => { active = false; controller.abort(); window.clearTimeout(timeout); };
  }, [bootstrapAttempt]);

  return (
    <>
      {game.notice ? (
        <div className="notice" role="alert">
          <span>{t(game.notice)}</span>
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
