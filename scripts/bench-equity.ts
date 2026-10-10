/**
 * Measures the cost of one bot decision's equity calculation.
 *
 * The interesting comparison is the last line: the old code rebuilt a
 * 1326-combo pool for every opponent on every decision just to represent "any
 * two cards", so that number is work that used to happen on the hot path.
 *
 * Usage:  node scripts/bench-equity.ts [decisions]
 */

import { cardsFromString, seededRng } from "../src/engine/cards.ts";
import { buildComboPool, equity } from "../src/engine/equity.ts";
import { fullRange } from "../src/engine/range.ts";

const decisions = Number(process.argv[2] ?? 200);
const opponents = 4;
const iterations = 2000;
const rng = seededRng(7);

const hero = cardsFromString("AsKs");
const board = cardsFromString("2c3d4h");

const started = process.hrtime.bigint();
let checksum = 0;
let samples = 0;
for (let i = 0; i < decisions; i++) {
  const result = equity({ hero, board, opponents, iterations, rng, tolerance: 0.012 });
  checksum += result.equity;
  samples += result.iterations;
}
const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;

console.log(`\n机器人一次决策的胜率计算：${opponents} 个对手，上限 ${iterations} 次抽样`);
console.log(`  ${decisions} 次决策，共 ${elapsedMs.toFixed(0)}ms`);
console.log(`  平均 ${(elapsedMs / decisions).toFixed(2)}ms / 次决策（实际平均抽样 ${Math.round(samples / decisions)} 次）`);
console.log(`  校验和 ${checksum.toFixed(2)}（只用来防止优化掉循环）`);

const poolStart = process.hrtime.bigint();
for (let i = 0; i < decisions * opponents; i++) buildComboPool(fullRange(), []);
const poolMs = Number(process.hrtime.bigint() - poolStart) / 1e6;

console.log(
  `\n对比：旧路径每次决策要额外构建 ${opponents} 个全范围池，` +
    `${decisions * opponents} 次构建耗时 ${poolMs.toFixed(0)}ms`,
);
console.log(`  也就是每次决策白白多花 ${(poolMs / decisions).toFixed(2)}ms，并制造 1326×${opponents} 个临时对象\n`);
