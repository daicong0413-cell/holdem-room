/**
 * Plays one complete hand with four seats and prints a play-by-play.
 *
 * Run with:  node scripts/hand-demo.ts [seed]
 *
 * The point is to make the state machine legible: every line below comes from
 * the engine's own event log, so this doubles as a debugging window into what
 * the table actually decided.
 */

import { cardToString, cardsToString, seededRng } from "../src/engine/cards.ts";
import {
  type PlayerAction,
  type TableState,
  applyAction,
  createTable,
  legalActions,
  seatPlayer,
  startHand,
} from "../src/engine/table.ts";

const seed = Number(process.argv[2] ?? 20240501);
const rng = seededRng(seed);

const players = [
  { name: "你", stack: 200 },
  { name: "GTO·岩", stack: 200 },
  { name: "松凶·老K", stack: 200 },
  { name: "谭轩风格", stack: 200 },
];

const table = createTable({ seats: players.length, smallBlind: 1, bigBlind: 2 });
players.forEach((player, index) => {
  seatPlayer(table, index, { playerId: `p${index}`, name: player.name, stack: player.stack });
});

startHand(table, rng);

const nameOf = (seatIndex: number): string => table.seats[seatIndex]!.name;

function describe(action: PlayerAction, chips: number, previousBet: number): string {
  switch (action.type) {
    case "fold":
      return "弃牌";
    case "check":
      return "过牌";
    case "call":
      return `跟注 ${chips}`;
    case "raise":
      return previousBet === 0 ? `下注 ${action.to}` : `加注到 ${action.to}`;
    default:
      return "?";
  }
}

console.log(`\n德州扑克 — 一手完整牌局（随机种子 ${seed}）`);
console.log(`座位：${players.map((player, index) => `${index}=${player.name}`).join("  ")}`);
console.log(`盲注 1/2    起始筹码 ${players[0]!.stack}\n`);

const streetLabel: Record<string, string> = {
  preflop: "翻前",
  flop: "翻牌",
  turn: "转牌",
  river: "河牌",
};

/** A patient bot: it mostly calls so that hands actually reach showdown. */
function chooseAction(table: TableState): PlayerAction {
  const legal = legalActions(table)!;
  const roll = rng();
  if (legal.canCheck) {
    if (roll < 0.18 && legal.canRaise) return { type: "raise", to: legal.minRaiseTo };
    return { type: "check" };
  }
  if (roll < 0.1) return { type: "fold" };
  if (roll < 0.24 && legal.canRaise) {
    const target = Math.min(legal.maxRaiseTo, Math.max(legal.minRaiseTo, legal.minRaiseTo * 2));
    return { type: "raise", to: target };
  }
  return { type: "call" };
}

let guard = 0;
while (table.hand && table.hand.street !== "complete") {
  if (guard++ > 200) throw new Error("hand did not terminate");
  const seatIndex = table.hand.toActIndex!;
  const action = chooseAction(table);
  applyAction(table, action);
}

const hand = table.hand!;

// Replay the event log rather than re-deriving the story. The street is tracked
// as the log is walked: by now the hand itself is already "complete".
let streetAtEvent = "preflop";
for (const event of hand.events) {
  switch (event.type) {
    case "blinds":
      console.log(
        `[翻前] ${nameOf(event.smallBlind.seat)} 下小盲 ${event.smallBlind.amount}，${nameOf(
          event.bigBlind.seat,
        )} 下大盲 ${event.bigBlind.amount}`,
      );
      break;
    case "action":
      console.log(
        `[${streetLabel[streetAtEvent] ?? streetAtEvent}] ${nameOf(event.seat)} ${describe(
          event.action,
          event.committed,
          event.previousBet,
        )}`,
      );
      break;
    case "street":
      streetAtEvent = event.street;
      if (event.board.length > 0) console.log(`\n[${streetLabel[event.street]}] 牌面：${cardsToString(event.board)}`);
      break;
    case "showdown":
      console.log(`\n[摊牌]`);
      for (const entry of event.entries) {
        const cards = entry.hole.map(cardToString).join(" ");
        console.log(`  ${nameOf(entry.seatIndex).padEnd(6)} ${cards}   ${entry.handName}`);
      }
      break;
    case "award":
      console.log(`\n[派彩]`);
      for (const award of event.awards) {
        const winners = award.winners.map((seat) => nameOf(seat)).join("、");
        console.log(`  底池 ${award.potIndex + 1}：${winners} 赢得 ${award.amount}`);
      }
      break;
    case "handEnd":
      console.log(`\n[结果] 共 ${table.seats.length} 人，筹码变化：`);
      event.netChange.forEach((change, seat) => {
        const sign = change > 0 ? "+" : "";
        console.log(`  ${nameOf(seat).padEnd(6)} ${sign}${change}`);
      });
      break;
    default:
      break;
  }
}

console.log("");
