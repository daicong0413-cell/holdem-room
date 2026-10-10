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
import { displayCard, displayRank, handNameZh, isRedSuit, money, streetLabelZh, SUIT_SYMBOLS } from "../shared/format.ts";
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
  model: string | null;
  baseUrl: string | null;
  /** True only when this browser is on the machine running the server. */
  configurable: boolean;
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
      setScale(Math.max(0.35, Math.min(fit, 2.4)));
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
  const [chat, setChat] = useState<ChatLine[]>([]);
  const [historyEntry, setHistoryEntry] = useState<HandHistoryEntry | null>(null);
  const socketRef = useRef<WebSocket | null>(null);
  /** Non-null while we intend to be connected; drives automatic reconnection. */
  const retry = useRef<{ room: string; name: string; attempt: number; timer: number | null } | null>(null);
  const openRef = useRef<(room: string, name: string) => void>(() => undefined);

  const send = useCallback((message: ClientMessage) => {
    const socket = socketRef.current;
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
  }, []);

  openRef.current = (room: string, name: string): void => {
    const scheme = window.location.protocol === "https:" ? "wss" : "ws";
    const socket = new WebSocket(`${scheme}://${window.location.host}/ws`);
    socketRef.current = socket;

    socket.onopen = () => {
      setStatus("open");
      const token = localStorage.getItem(TOKEN_KEY);
      socket.send(JSON.stringify({ t: "hello", room, name, ...(token ? { token } : {}) }));
    };

    socket.onmessage = (event) => {
      let message: ServerMessage;
      try {
        message = JSON.parse(String(event.data)) as ServerMessage;
      } catch {
        return;
      }
      switch (message.t) {
        case "welcome":
          localStorage.setItem(TOKEN_KEY, message.token);
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
      socketRef.current = null;
      const state = retry.current;
      if (state === null) {
        setStatus("idle");
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
    retry.current = { room, name, attempt: 0, timer: null };
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
    setView(null);
  }, []);

  return {
    status,
    view,
    notice,
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
  onSit,
  onStand,
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
  /** Pre-filled buy-in for this seat's amount box. */
  defaultBuyIn: number;
  onSit: (seat: number, buyIn: number) => void;
  /** Give up the seat; the server defers it until the hand settles. */
  onStand: () => void;
  onAddBot: (seat: number, persona: string) => void;
}): ReactElement {
  const [persona, setPersona] = useState(personas[0]?.id ?? "gto");
  const [buyIn, setBuyIn] = useState(defaultBuyIn);
  // One of each persona: a table with three GTOpros is a bug, not a feature.
  const available = personas.filter((option) => !takenPersonas.has(option.id));
  const chosen = available.some((option) => option.id === persona) ? persona : (available[0]?.id ?? "");

  if (seat.playerId === null) {
    return (
      <div className="seat is-empty" style={position}>
        <div className="seat-name">空位 {seat.index + 1}</div>
        {/* Taking a seat is always possible: mid-hand you simply wait for the
            next deal, which the server handles by not dealing you in. */}
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
              <select value={chosen} onChange={(event) => setPersona(event.target.value)} disabled={available.length === 0}>
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
            <span className="seat-badges">
            {isButton ? <span className="badge dealer" title="庄家按钮">D</span> : null}
            {isSmallBlind ? <span className="badge blind">SB</span> : null}
            {isBigBlind ? <span className="badge blind">BB</span> : null}
            {seat.allIn ? <span className="badge allin">全下</span> : null}
            {seat.folded ? <span className="badge folded">弃牌</span> : null}
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

  const clamped = Math.min(Math.max(target, legal.minRaiseTo), legal.maxRaiseTo);
  const potBet = (fraction: number): number =>
    potBetAmount(
      { pot: view.pot, toCall: legal.toCall, minRaiseTo: legal.minRaiseTo, maxRaiseTo: legal.maxRaiseTo },
      fraction,
    );

  // Calling already uses every chip, so a second "all in" button would be the
  // same action twice — and it reads like a raise they cannot afford.
  const heroStack = view.seats.find((seat) => seat.index === legal.seatIndex)?.stack ?? 0;
  const showAllIn = allInIsDistinct({ canAllIn: legal.canAllIn, callCost: legal.callCost, stack: heroStack });

  return (
    <div className="action-cluster">
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
            <button type="button" onClick={() => setTarget(potBet(0.5))}>
              半池
            </button>
            <button type="button" onClick={() => setTarget(potBet(1))}>
              底池
            </button>
            <button type="button" onClick={() => setTarget(legal.maxRaiseTo)}>
              全下
            </button>
          </div>
        </div>
      ) : null}

      <div className="action-buttons">
        <button type="button" className="danger" onClick={() => onAction({ t: "action", action: { type: "fold" } })}>
          弃牌
        </button>

        {legal.canCheck ? (
          <button type="button" onClick={() => onAction({ t: "action", action: { type: "check" } })}>
            过牌
          </button>
        ) : null}

        {legal.canCall ? (
          <button type="button" onClick={() => onAction({ t: "action", action: { type: "call" } })}>
            跟注 {money(legal.callCost)}
            {legal.callCost < legal.toCall ? "（全下）" : ""}
          </button>
        ) : null}

        {legal.canRaise ? (
          <button
            type="button"
            className="primary"
            onClick={() => onAction({ t: "action", action: { type: "raise", to: clamped } })}
          >
            {legal.toCall > 0 ? `加注到 ${money(clamped)}` : `下注 ${money(clamped)}`}
          </button>
        ) : showAllIn ? (
          <button
            type="button"
            className="primary"
            onClick={() => onAction({ t: "action", action: { type: "raise", to: legal.maxRaiseTo } })}
          >
            全下 {money(legal.maxRaiseTo)}
          </button>
        ) : null}

        {countdown !== null ? (
          <span className={countdown <= 10 ? "countdown urgent" : "countdown"}>⏱ {countdown}s</span>
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

  const number = (key: keyof typeof draft, boundKey: string) => (
    <input
      type="number"
      min={bound(boundKey).min}
      max={bound(boundKey).max}
      value={draft[key] as number}
      onChange={(event) => setDraft({ ...draft, [key]: Number(event.target.value) })}
    />
  );

  const save = (): void => {
    onSave({
      seats: draft.seats,
      smallBlind: draft.smallBlind,
      bigBlind: draft.bigBlind,
      startingStack: draft.startingStack,
      actionTimeoutMs: Math.round(draft.actionTimeoutSeconds * 1000),
      mode: draft.mode,
      blindLevelHands: draft.blindLevelHands,
      blindGrowth: draft.blindGrowth,
      autoStartSeconds: draft.autoStartSeconds,
      botAutoRebuy: draft.botAutoRebuy,
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
            {number("seats", "seats")}
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

          <label className={gameStarted ? "disabled" : ""}>
            <span>起始筹码{gameStarted ? "（开局后不能改）" : ""}</span>
            {number("startingStack", "startingStack")}
          </label>

          <label className={handInProgress ? "disabled" : ""}>
            <span>行动限时（秒，0 = 关闭）</span>
            {number("actionTimeoutSeconds", "actionTimeoutMs")}
          </label>

          <label className={handInProgress ? "disabled" : ""}>
            <span>小盲</span>
            {number("smallBlind", "smallBlind")}
          </label>

          <label className={handInProgress ? "disabled" : ""}>
            <span>大盲</span>
            {number("bigBlind", "bigBlind")}
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
                {number("blindLevelHands", "blindLevelHands")}
              </label>
              <label className={gameStarted ? "disabled" : ""}>
                <span>每次盲注倍数{gameStarted ? "（开局后不能改）" : ""}</span>
                {number("blindGrowth", "blindGrowth")}
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
  status,
  chat,
  onSend,
  onLeave,
  onRequestHistory,
}: {
  view: TableView;
  personas: PersonaInfo[];
  bounds: SettingsBounds;
  status: Status;
  chat: ChatLine[];
  onSend: (message: ClientMessage) => void;
  onLeave: () => void;
  onRequestHistory: (handId: number) => void;
}): ReactElement {
  const [copied, setCopied] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [tab, setTab] = useState<"live" | "history">("live");
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

  const modeChip =
    view.settings.mode === "tournament"
      ? `锦标赛 第 ${view.settings.level} 级${
          view.settings.handsUntilNextLevel === null ? "" : ` · 还有 ${view.settings.handsUntilNextLevel} 手升盲`
        }`
      : "现金局";

  return (
    <div className="room" style={{ "--ui-scale": uiScale } as CSSProperties}>
      <header className="topbar">
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
        <div className="pot-chip">
          底池 <strong>{money(view.pot)}</strong>
        </div>
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
        <div
          className="felt-scale"
          style={{ width: FELT_BASE_WIDTH * felt.scale, height: FELT_BASE_HEIGHT * felt.scale }}
        >
          <div className="felt" style={{ transform: `scale(${felt.scale})` }}>
          <div className="table-center">
            <div className="center-pot">底池 {money(view.pot)}</div>
            <div className="board">
              {view.board.length === 0 ? (
                <span className="board-hint">等待发牌</span>
              ) : (
                view.board.map((card, index) => (
                  <Card key={`${card}-${index}`} card={card} size="md" isBest={bestOnBoard.has(card)} dealIndex={index} />
                ))
              )}
            </div>
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
                onSit={(index, amount) => onSend({ t: "sit", seat: index, buyIn: amount })}
                onStand={() => onSend({ t: "stand" })}
                onAddBot={(index, persona) => onSend({ t: "addBot", seat: index, persona })}
              />
            );
          })}
        </div>
        </div>
      </main>

      <aside className="sidebar">
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
                    <span className="hl-pot">底池 {summary.potTotal}</span>
                  </span>
                  <span className="hl-board">
                    {summary.board.length > 0 ? summary.board.map(displayCard).join(" ") : "翻前结束"}
                  </span>
                  <span className="hl-win">
                    {summary.winners.map((winner) => `${winner.name} +${winner.amount}`).join("、")}
                  </span>
                </button>
              </li>
            ))}
          </ol>
        )}
      </aside>

      <footer className="action-dock">
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

        <div className="dock-row">
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

            {!heroSeated ? <span className="hint">点空位入座，或直接加几个机器人开局。</span> : null}

            {view.legal ? (
              <ActionBar view={view} onAction={onSend} countdown={countdown} />
            ) : view.toActIndex !== null && view.street !== "complete" ? (
              <span className="hint">
                等待 {view.seats[view.toActIndex]?.name ?? "对手"} 行动…
                {countdown !== null ? ` 剩余 ${countdown} 秒` : ""}
              </span>
            ) : (
              <span className="hint">{streetLabelZh(view.street)}</span>
            )}
          </div>
        </div>
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
}: {
  personas: PersonaInfo[];
  llm: LlmStatus | null;
  onLlm: (next: LlmStatus) => void;
  onJoin: (room: string, name: string) => void;
}): ReactElement {
  const [llmOpen, setLlmOpen] = useState(false);
  const [name, setName] = useState(() => localStorage.getItem(NAME_KEY) ?? "");
  const [room, setRoom] = useState(() => (new URLSearchParams(window.location.search).get("room") ?? "").toUpperCase());

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    const trimmed = name.trim();
    if (trimmed.length === 0) return;
    localStorage.setItem(NAME_KEY, trimmed);
    onJoin(room.trim().toUpperCase(), trimmed);
  };

  return (
    <div className="lobby">
      <form className="lobby-card" onSubmit={submit}>
        <h1>德州扑克 · NPC 牌桌</h1>
        <p className="lobby-sub">和朋友用房间码同桌，随时往空位加几个性格不同的机器人。</p>

        <label>
          <span>你的昵称</span>
          <input value={name} onChange={(event) => setName(event.target.value)} maxLength={16} placeholder="例如：阿伟" autoFocus />
        </label>

        <label>
          <span>房间码（留空则创建新房间）</span>
          <input
            value={room}
            onChange={(event) => setRoom(event.target.value.toUpperCase())}
            maxLength={4}
            placeholder="ABCD"
            className="code-input"
          />
        </label>

        <button className="primary" type="submit" disabled={name.trim().length === 0}>
          {room.trim().length > 0 ? "加入房间" : "创建房间"}
        </button>
      </form>

      <div className="persona-gallery">
        <h2>可用机器人人格</h2>
        <ul>
          {personas.map((persona) => (
            <li key={persona.id}>
              <strong>{persona.name}</strong>
              {persona.description ? <span>{persona.description}</span> : null}
            </li>
          ))}
        </ul>
        <p className="fine-print">
          {llm?.enabled
            ? `大模型已接入：${llm.model ?? "默认模型"}${llm.baseUrl ? ` @ ${llm.baseUrl}` : ""}。常规决策仍在本地完成，只有关键决策点才调用它。`
            : "大模型未接入，机器人完全靠本地蒙特卡洛 + 人格参数决策，不消耗 token。"}
        </p>
        {llm?.configurable ? (
          <button type="button" className="ghost llm-open" onClick={() => setLlmOpen(true)}>
            {llm.enabled ? "修改大模型配置" : "配置大模型"}
          </button>
        ) : (
          <p className="fine-print">大模型配置只能在运行服务器的那台机器上修改。</p>
        )}
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
  const { connect } = game;
  const autoJoined = useRef(false);

  useEffect(() => {
    if (autoJoined.current) return;
    const room = new URLSearchParams(window.location.search).get("room")?.toUpperCase();
    const savedName = localStorage.getItem(NAME_KEY);
    if (room && room.length > 0 && savedName) {
      autoJoined.current = true;
      connect(room, savedName);
    }
  }, [connect]);

  useEffect(() => {
    let cancelled = false;
    void fetch("/api/config")
      .then((response) => response.json())
      .then((payload: Partial<ServerConfig>) => {
        if (!cancelled && payload.bounds) setBounds(payload.bounds);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    void fetch("/api/personas")
      .then((response) => response.json())
      .then((payload: { personas?: PersonaInfo[]; llm?: LlmStatus }) => {
        if (!cancelled && Array.isArray(payload.personas)) setPersonas(payload.personas);
        if (!cancelled && payload.llm) setLlm(payload.llm);
      })
      .catch(() => {
        if (!cancelled) setPersonas([{ id: "gto", name: "GTOpro" }]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

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
          status={game.status}
          chat={game.chat}
          onSend={game.send}
          onLeave={game.disconnect}
          onRequestHistory={game.requestHistory}
        />
      ) : (
        <Lobby personas={personas} llm={llm} onLlm={setLlm} onJoin={game.connect} />
      )}

      {game.historyEntry ? <HistoryDialog entry={game.historyEntry} onClose={game.closeHistory} /> : null}
    </>
  );
}
