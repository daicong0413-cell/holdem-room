/**
 * Builds the per-viewer snapshot of a table.
 *
 * This is the single place where hidden information is filtered. The engine
 * holds every hole card; a client must never receive one it is not entitled to,
 * so the server never serialises `TableState` directly.
 */

import { cardToString, rankOf } from "../engine/cards.ts";
import { categoryOf, evaluateBest, HandCategory, tiebreakersOf } from "../engine/hand.ts";
import {
  type HandResult,
  type Street,
  type TableState,
  collectedPot,
  legalActions,
  totalPot,
} from "../engine/table.ts";
import { displayCard, handNameZh } from "../shared/format.ts";
import type {
  HandHistoryEntry,
  HandHistorySummary,
  LogEntryView,
  ResultView,
  RoomSettingsView,
  SeatView,
  TableView,
} from "./protocol.ts";

export interface ViewOptions {
  readonly roomCode: string;
  /** Seat index of the viewer, or null for a spectator. */
  readonly viewerSeat: number | null;
  readonly isBotAt: (seatIndex: number) => boolean;
  /** Persona id of the bot in this seat, or null for humans and empty seats. */
  readonly personaAt: (seatIndex: number) => string | null;
  /** Cards to reveal regardless of showdown, keyed by seat index. */
  readonly reveal?: ReadonlyMap<number, string[]>;
  readonly canStartHand?: boolean;
  readonly actionDeadlineMs?: number | null;
  readonly nextHandAtMs?: number | null;
  readonly isHost?: boolean;
  readonly settings: RoomSettingsView;
  readonly history?: readonly HandHistorySummary[];
}

export function buildTableView(table: TableState, options: ViewOptions): TableView {
  const hand = table.hand;
  const handResult = hand?.result ?? null;
  const showdownHoles = new Map<number, string[]>();
  if (handResult) {
    for (const entry of handResult.showdown) {
      showdownHoles.set(entry.seatIndex, entry.hole.map(cardToString));
    }
  }

  const lastActions = new Map<number, string>();
  if (hand) {
    for (const event of hand.events) {
      if (event.type === "action") lastActions.set(event.seat, describeAction(event.action, event.previousBet));
    }
  }

  const seats: SeatView[] = table.seats.map((seat) => {
    const isYou = options.viewerSeat === seat.index;
    const revealed = options.reveal?.get(seat.index);
    const shownAtShowdown = showdownHoles.get(seat.index);

    let hole: string[] | null = null;
    if (seat.hole.length > 0) {
      if (isYou) hole = seat.hole.map(cardToString);
      else if (revealed) hole = revealed;
      else if (shownAtShowdown) hole = shownAtShowdown;
    }

    return {
      index: seat.index,
      playerId: seat.playerId,
      name: seat.name,
      isBot: options.isBotAt(seat.index),
      personaId: options.personaAt(seat.index),
      stack: seat.stack,
      committed: seat.committed,
      streetCommitted: seat.streetCommitted,
      folded: seat.folded,
      allIn: seat.allIn,
      inHand: seat.inHand,
      isYou,
      hole,
      holeCount: seat.hole.length,
      lastAction: lastActions.get(seat.index) ?? null,
      handCategory: isYou && seat.hole.length === 2
        ? (hand?.board.length ?? 0) >= 3
          ? categoryOf(evaluateBest([...seat.hole, ...hand!.board]))
          : rankOf(seat.hole[0]!) === rankOf(seat.hole[1]!) ? HandCategory.Pair : HandCategory.HighCard
        : null,
    };
  });

  const legal = options.viewerSeat !== null && hand?.toActIndex === options.viewerSeat ? legalActions(table) : null;

  return {
    roomCode: options.roomCode,
    handId: hand?.handId ?? 0,
    street: hand?.street ?? "complete",
    board: hand?.board.map(cardToString) ?? [],
    pot: collectedPot(table),
    buttonIndex: table.buttonIndex,
    smallBlind: table.smallBlind,
    bigBlind: table.bigBlind,
    toActIndex: hand?.toActIndex ?? null,
    seats,
    legal,
    result: handResult === null ? null : toResultView(handResult),
    log: buildLog(table),
    actionDeadlineMs: options.actionDeadlineMs ?? null,
    nextHandAtMs: options.nextHandAtMs ?? null,
    canStartHand: options.canStartHand ?? false,
    isHost: options.isHost ?? false,
    settings: options.settings,
    history: [...(options.history ?? [])],
  };
}

function toResultView(result: HandResult): ResultView {
  return {
    reason: result.reason,
    awards: result.awards.map((award) => ({ potIndex: award.potIndex, amount: award.amount, winners: award.winners })),
    showdown: result.showdown.map((entry) => ({
      seatIndex: entry.seatIndex,
      hole: entry.hole.map(cardToString),
      category: categoryOf(entry.score),
      ranks: tiebreakersOf(entry.score),
      bestFive: entry.best.map(cardToString),
    })),
    netChange: [...result.netChange],
    payouts: [...result.payouts],
  };
}

/** A card as it should read to a human: the wire keeps `Ts`, people read `10♠`. */
function showCard(card: number): string {
  return displayCard(cardToString(card));
}

/**
 * Builds the archived record of a finished hand.
 *
 * Called the moment a hand completes, while `table.hand` is still that hand, so
 * the log and the board are exactly what the table showed. Hole cards come only
 * from the showdown list: a player who folded is archived as `null`, exactly as
 * they were at the table. Archiving mucked cards would quietly undo the whole
 * hidden-information guarantee.
 */
export function buildHandHistoryEntry(table: TableState, level: number): HandHistoryEntry | null {
  const hand = table.hand;
  const result = hand?.result;
  if (!hand || !result) return null;

  const shown = new Map<number, string[]>();
  for (const entry of result.showdown) shown.set(entry.seatIndex, entry.hole.map(cardToString));

  const winners: HandHistorySummary["winners"] = [];
  table.seats.forEach((seat, index) => {
    const paid = result.payouts[index] ?? 0;
    if (paid > 0) winners.push({ seatIndex: seat.index, name: seat.name, amount: paid });
  });

  return {
    handId: hand.handId,
    level,
    smallBlind: table.smallBlind,
    bigBlind: table.bigBlind,
    board: hand.board.map(cardToString),
    reason: result.reason,
    potTotal: result.pots.reduce((sum, pot) => sum + pot.amount, 0),
    winners,
    buttonIndex: hand.buttonIndex,
    seats: table.seats
      .filter((seat) => seat.inHand)
      .map((seat) => ({
        seatIndex: seat.index,
        name: seat.name,
        hole: shown.get(seat.index) ?? null,
        net: result.netChange[seat.index] ?? 0,
        folded: seat.folded,
      })),
    log: buildLog(table),
  };
}

/** A short, human-readable history for the table log panel. */
function buildLog(table: TableState): LogEntryView[] {
  const hand = table.hand;
  if (!hand) return [];
  const nameOf = (seatIndex: number): string => table.seats[seatIndex]?.name || `座位 ${seatIndex}`;
  const log: LogEntryView[] = [];
  let street: Street = "preflop";

  for (const event of hand.events) {
    switch (event.type) {
      case "blinds":
        log.push({ street: "preflop", text: `${nameOf(event.smallBlind.seat)} posts SB ${event.smallBlind.amount}` });
        log.push({ street: "preflop", text: `${nameOf(event.bigBlind.seat)} posts BB ${event.bigBlind.amount}` });
        break;
      case "action":
        log.push({
          street,
          text: `${nameOf(event.seat)} ${describeAction(event.action, event.previousBet)}`,
        });
        break;
      case "street":
        street = event.street;
        if (event.board.length > 0) {
          log.push({ street, text: `牌面 ${event.board.map(showCard).join(" ")}` });
        }
        break;
      case "showdown":
        for (const entry of event.entries) {
          log.push({
            street: "river",
            text: `${nameOf(entry.seatIndex)} 亮牌 ${entry.hole.map(showCard).join(" ")}（${handNameZh(
              categoryOf(entry.score),
              tiebreakersOf(entry.score),
            )}）`,
          });
        }
        break;
      case "award":
        for (const award of event.awards) {
          const winners = award.winners.map(nameOf).join("、");
          log.push({ street: "river", text: `${winners} 赢得 ${award.amount}` });
        }
        break;
      default:
        break;
    }
  }
  return log.slice(-40);
}

function describeAction(action: { type: string; to?: number }, previousBet: number): string {
  switch (action.type) {
    case "fold":
      return "Fold";
    case "check":
      return "Check";
    case "call":
      return "Call";
    case "raise":
      return previousBet === 0 ? `Bet ${action.to}` : `Raise to ${action.to}`;
    default:
      return action.type;
  }
}
