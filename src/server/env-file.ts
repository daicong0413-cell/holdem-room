/**
 * Rewrites individual keys in a `.env` file, leaving everything else alone.
 *
 * The point is to be able to change a setting from a UI without flattening the
 * comments and blank lines that make the file readable — and without dropping
 * keys somebody else put there.
 */

import { readFileSync, writeFileSync } from "node:fs";

/** A `null` value removes the key instead of setting it. */
export type EnvUpdates = Record<string, string | null>;

const ASSIGNMENT = /^[ \t]*([A-Za-z_][A-Za-z0-9_]*)[ \t]*=/;

export function updateEnvFile(path: string, updates: EnvUpdates): void {
  const pending = new Map(Object.entries(updates));

  let existing: string[] = [];
  try {
    existing = readFileSync(path, "utf8").split(/\r?\n/);
    // A file ending in a newline splits to a trailing "", which would otherwise
    // end up as a stray blank line in the middle once we append a key.
    if (existing.length > 0 && existing[existing.length - 1] === "") existing.pop();
  } catch {
    // No file yet: we are creating one.
  }

  const lines: string[] = [];
  for (const line of existing) {
    const match = ASSIGNMENT.exec(line);
    const key = match?.[1];
    if (key === undefined || !pending.has(key)) {
      lines.push(line);
      continue;
    }
    const value = pending.get(key)!;
    pending.delete(key);
    // A `#` comment mentioning the key never reaches here: the regex anchors
    // on the start of the line.
    if (value !== null) lines.push(`${key}=${value}`);
  }

  for (const [key, value] of pending) {
    if (value !== null) lines.push(`${key}=${value}`);
  }

  // Trim trailing blank lines, then end with exactly one newline.
  while (lines.length > 0 && lines[lines.length - 1]!.trim() === "") lines.pop();
  writeFileSync(path, `${lines.join("\n")}\n`, "utf8");
}
