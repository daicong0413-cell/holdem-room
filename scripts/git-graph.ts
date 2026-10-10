/**
 * Renders a git history as a commit-graph SVG.
 *
 * `git log --graph` is a fine text rendering, but it is awkward to hand to
 * somebody. This draws the same information as a picture: one lane per line of
 * development, a dot per commit, curves for merges, and ref pills for branches.
 *
 * The log is passed in as a file rather than read by running git from here,
 * because spawning a child process is exactly what a sandboxed environment
 * refuses to do. Two steps, both one line:
 *
 *   git log --all --date-order --pretty=format:"%H|%P|%D|%s" > graph.txt
 *   node scripts/git-graph.ts graph.txt docs/git-graph.svg
 */

import { readFileSync, writeFileSync } from "node:fs";

interface Commit {
  readonly hash: string;
  readonly parents: string[];
  readonly refs: string[];
  readonly subject: string;
}

const PALETTE = ["#2f81f7", "#3fb950", "#e3b341", "#f85149", "#a371f7", "#39c5cf", "#db61a2", "#d29922"];
const ROW_HEIGHT = 34;
const LANE_WIDTH = 26;
const PAD_X = 30;
const PAD_Y = 30;
const DOT_RADIUS = 5.5;
const LABEL_GAP = 18;
const CHAR_WIDTH = 7.6;

/**
 * Reads the log however the shell happened to write it.
 *
 * `git log … > file` produces UTF-8 under cmd/bash, but PowerShell's `>` writes
 * UTF-16LE. Reading the latter as UTF-8 puts a NUL between every character,
 * which then makes the SVG invalid XML — so detect it instead of guessing.
 */
export function readLogFile(path: string): string {
  const raw = readFileSync(path);
  const text = raw.includes(0) ? raw.toString("utf16le") : raw.toString("utf8");
  return text.replace(/^\uFEFF/, "").replace(/\u0000/g, "");
}

export function parseLog(text: string): Commit[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => {
      const parts = line.split("|");
      const hash = parts[0] ?? "";
      const parents = (parts[1] ?? "").split(" ").filter((value) => value.length > 0);
      const refs = (parts[2] ?? "")
        .split(",")
        .map((value) => value.trim())
        .filter((value) => value.length > 0);
      const subject = parts.slice(3).join("|");
      return { hash, parents, refs, subject };
    })
    .filter((commit) => commit.hash.length > 0);
}

/**
 * Classic lane assignment, walked newest-first.
 *
 * Each lane remembers the commit it is still waiting for. A commit either
 * continues the lane that was waiting for it, or — if it is a branch tip —
 * claims a fresh lane. Extra parents of a merge get lanes of their own.
 */
export function assignLanes(commits: readonly Commit[]): Map<string, number> {
  const columns = new Map<string, number>();
  const lanes: (string | null)[] = [];
  const taken = new Set<string>();

  for (const commit of commits) {
    let column = lanes.findIndex((waiting) => waiting === commit.hash);
    if (column < 0) {
      column = lanes.findIndex((waiting) => waiting === null);
      if (column < 0) {
        lanes.push(null);
        column = lanes.length - 1;
      }
    }

    columns.set(commit.hash, column);
    taken.add(commit.hash);
    lanes[column] = commit.parents[0] ?? null;

    for (const parent of commit.parents.slice(1)) {
      if (lanes.includes(parent)) continue;
      let free = lanes.findIndex((waiting) => waiting === null);
      if (free < 0) {
        lanes.push(null);
        free = lanes.length - 1;
      }
      lanes[free] = parent;
    }

    // A lane waiting for something we have already drawn is a finished branch.
    for (let index = 0; index < lanes.length; index++) {
      const waiting = lanes[index];
      if (waiting !== null && columns.has(waiting)) lanes[index] = null;
    }
  }

  return columns;
}

const escapeXml = (text: string): string =>
  text.replace(/[&<>"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[char]!);

/**
 * Rough text width. CJK glyphs are full-width, so counting characters alone
 * badly under-sizes any line containing Chinese — and a canvas that is too
 * narrow silently clips the subject.
 */
function textWidth(text: string, size = CHAR_WIDTH): number {
  let width = 0;
  for (const char of text) width += char.codePointAt(0)! > 0x2e80 ? size * 1.9 : size;
  return width;
}

function refColour(ref: string): string {
  if (ref.includes("HEAD")) return "#e3b341";
  if (ref === "main" || ref.endsWith("/main") || ref.endsWith("-> main")) return "#2f81f7";
  if (ref.startsWith("tag:")) return "#a371f7";
  return "#6e7681";
}

function refLabel(ref: string): string {
  return ref.replace("HEAD -> ", "HEAD → ");
}

export function renderGraph(commits: readonly Commit[], columns: Map<string, number>, title: string): string {
  const laneCount = Math.max(1, ...[...columns.values()].map((column) => column + 1));
  const labelX = PAD_X + laneCount * LANE_WIDTH + LABEL_GAP;
  const rowOf = new Map(commits.map((commit, index) => [commit.hash, index]));
  const x = (column: number): number => PAD_X + column * LANE_WIDTH;
  const y = (row: number): number => PAD_Y + row * ROW_HEIGHT;

  // Size the canvas to the widest line of text.
  let widest = 0;
  for (const commit of commits) {
    const refsWidth = commit.refs.reduce((sum, ref) => sum + textWidth(refLabel(ref)) + 22, 0);
    widest = Math.max(widest, refsWidth + textWidth(commit.subject, 7.9) + 26 + 7 * CHAR_WIDTH);
  }
  const width = Math.round(labelX + widest + PAD_X);
  const height = Math.round(PAD_Y * 2 + commits.length * ROW_HEIGHT);

  const parts: string[] = [];
  parts.push(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" ` +
      // Natural size, but never wider than the window it is opened in.
      `style="max-width:100%;height:auto" ` +
      `font-family="ui-sans-serif, -apple-system, 'Segoe UI', 'Microsoft YaHei', sans-serif">`,
  );
  parts.push(`<rect width="${width}" height="${height}" fill="#0b0f14"/>`);
  parts.push(
    `<text x="${PAD_X}" y="20" fill="#8b98a5" font-size="12.5" letter-spacing="0.08em">${escapeXml(title.toUpperCase())}</text>`,
  );

  // Edges first, so dots sit on top of them.
  for (const commit of commits) {
    const childRow = rowOf.get(commit.hash);
    if (childRow === undefined) continue;
    const colour = PALETTE[columns.get(commit.hash)! % PALETTE.length]!;
    for (const parent of commit.parents) {
      const parentRow = rowOf.get(parent);
      if (parentRow === undefined) continue;
      const x1 = x(columns.get(commit.hash)!);
      const y1 = y(childRow);
      const x2 = x(columns.get(parent)!);
      const y2 = y(parentRow);
      const bend = (y2 - y1) * 0.45;
      parts.push(
        `<path d="M ${x1} ${y1} C ${x1} ${y1 + bend}, ${x2} ${y2 - bend}, ${x2} ${y2}" fill="none" ` +
          `stroke="${colour}" stroke-width="2" stroke-linecap="round" opacity="0.6"/>`,
      );
    }
  }

  // Dots, ref pills and subjects.
  commits.forEach((commit, row) => {
    const column = columns.get(commit.hash) ?? 0;
    const colour = PALETTE[column % PALETTE.length]!;
    const cy = y(row);

    parts.push(
      `<circle cx="${x(column)}" cy="${cy}" r="${DOT_RADIUS}" fill="${colour}" stroke="#0b0f14" stroke-width="2"/>`,
    );

    let cursor = labelX;
    for (const ref of commit.refs) {
      const label = refLabel(ref);
      const pillWidth = textWidth(label, 6.4) + 18;
      parts.push(
        `<rect x="${cursor}" y="${cy - 10}" width="${pillWidth.toFixed(1)}" height="20" rx="10" fill="${refColour(ref)}" opacity="0.18"/>`,
      );
      parts.push(
        `<rect x="${cursor}" y="${cy - 10}" width="${pillWidth.toFixed(1)}" height="20" rx="10" fill="none" stroke="${refColour(ref)}" stroke-width="1.2"/>`,
      );
      parts.push(
        `<text x="${cursor + 8}" y="${cy + 4}" fill="${refColour(ref)}" font-size="12" font-weight="600">${escapeXml(label)}</text>`,
      );
      cursor += pillWidth + 6;
    }

    parts.push(`<text x="${cursor + 10}" y="${cy + 4}" fill="#6e7681" font-size="12" font-family="ui-monospace, Consolas, monospace">${commit.hash.slice(0, 7)}</text>`);
    parts.push(
      `<text x="${cursor + 10 + 7 * CHAR_WIDTH}" y="${cy + 4}" fill="#e6edf3" font-size="13">${escapeXml(commit.subject)}</text>`,
    );
  });

  parts.push("</svg>");
  return parts.join("\n");
}

function main(): void {
  const [logPath = "graph.txt", outPath = "git-graph.svg", ...titleParts] = process.argv.slice(2);
  const title = titleParts.length > 0 ? titleParts.join(" ") : "git 提交图";

  const commits = parseLog(readLogFile(logPath));
  if (commits.length === 0) throw new Error(`${logPath} 里没有解析到任何提交`);

  const columns = assignLanes(commits);
  writeFileSync(outPath, renderGraph(commits, columns, title), "utf8");
  console.log(`已生成 ${outPath}：${commits.length} 个提交，${Math.max(...[...columns.values()]) + 1} 条泳道`);
}

if (process.argv[1]?.endsWith("git-graph.ts")) main();
