/**
 * Equity demo — run with:  node scripts/equity-demo.ts
 *
 * This is the layer every NPC will lean on for its non-LLM decisions, so it is
 * worth eyeballing the numbers against any published equity table.
 */

import { cardsFromString, seededRng } from "../src/engine/cards.ts";
import { equity } from "../src/engine/equity.ts";
import { parseRange, rangeShare, rangeToString } from "../src/engine/range.ts";

interface Scenario {
  hero: string;
  ranges: string[];
}

const scenarios: Scenario[] = [
  { hero: "AsAh", ranges: ["*"] },
  { hero: "KsKh", ranges: ["AA"] },
  { hero: "AhKh", ranges: ["QQ"] },
  { hero: "AhKh", ranges: ["77+,ATs+,KQs,AJo+"] },
  { hero: "7c2d", ranges: ["*"] },
  { hero: "QsQh", ranges: ["*", "*", "*"] },
  { hero: "JsTd", ranges: ["*", "*"] },
  { hero: "9h8h", ranges: ["JJ+,AKs"] },
];

const iterations = 20000;
const rng = seededRng(2024);

const pad = (text: string, width: number): string => text.padEnd(width);
const pct = (value: number): string => `${(value * 100).toFixed(1)}%`;

console.log(`\n  Monte Carlo equity — ${iterations.toLocaleString("en-US")} trials per line\n`);
console.log(`  ${pad("hero", 8)}${pad("opponents", 34)}${pad("equity", 9)}${pad("win", 8)}${pad("tie", 8)}${pad("lose", 8)}±`);
console.log(`  ${"-".repeat(78)}`);

for (const scenario of scenarios) {
  const hero = cardsFromString(scenario.hero);
  const ranges = scenario.ranges.map((text) => parseRange(text));

  const started = process.hrtime.bigint();
  const result = equity({
    hero,
    opponents: ranges.length,
    ranges,
    iterations,
    rng,
  });
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;

  const opponentLabel =
    ranges.length === 1
      ? `${rangeToString(ranges[0]!, 2)} (${pct(rangeShare(ranges[0]!))})`
      : `${ranges.length} x random`;

  console.log(
    `  ${pad(scenario.hero, 8)}${pad(opponentLabel, 34)}${pad(pct(result.equity), 9)}${pad(pct(result.win), 8)}${pad(
      pct(result.tie),
      8,
    )}${pad(pct(result.lose), 8)}${(result.standardError * 1.96 * 100).toFixed(2)}%   ${elapsedMs.toFixed(0)}ms`,
  );
}

console.log("");
