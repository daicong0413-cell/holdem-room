import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { updateEnvFile } from "./env-file.ts";

function scratch(contents?: string): string {
  const dir = mkdtempSync(join(tmpdir(), "holdem-env-"));
  const path = join(dir, ".env");
  if (contents !== undefined) writeFileSync(path, contents, "utf8");
  return path;
}

const read = (path: string): string => readFileSync(path, "utf8");

test("a key that is already there is replaced in place", () => {
  const path = scratch("PORT=8787\nDEEPSEEK_MODEL=old-model\nHOST=0.0.0.0\n");
  updateEnvFile(path, { DEEPSEEK_MODEL: "new-model" });
  assert.equal(read(path), "PORT=8787\nDEEPSEEK_MODEL=new-model\nHOST=0.0.0.0\n");
});

test("comments, blanks and unrelated keys survive", () => {
  const path = scratch("# 说明\n\nPORT=8787\n\n# 另一个注释\nHOST=0.0.0.0\n");
  updateEnvFile(path, { PORT: "9999" });
  assert.equal(read(path), "# 说明\n\nPORT=9999\n\n# 另一个注释\nHOST=0.0.0.0\n");
});

test("a commented-out example is not treated as the setting", () => {
  const path = scratch("# DEEPSEEK_API_KEY=\nPORT=8787\n");
  updateEnvFile(path, { DEEPSEEK_API_KEY: "sk-real" });
  assert.equal(read(path), "# DEEPSEEK_API_KEY=\nPORT=8787\nDEEPSEEK_API_KEY=sk-real\n");
});

test("a missing key is appended, and null removes one", () => {
  const path = scratch("PORT=8787\nDEEPSEEK_API_KEY=sk-old\n");
  updateEnvFile(path, { DEEPSEEK_API_KEY: null, DEEPSEEK_BASE_URL: "https://example.test" });
  assert.equal(read(path), "PORT=8787\nDEEPSEEK_BASE_URL=https://example.test\n");
});

test("writing to a file that does not exist creates it", () => {
  const path = scratch();
  updateEnvFile(path, { DEEPSEEK_API_KEY: "sk-new" });
  assert.equal(read(path), "DEEPSEEK_API_KEY=sk-new\n");
});
