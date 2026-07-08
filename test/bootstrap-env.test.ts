import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadJuiceEnv } from "../src/local/bootstrap-env.js";

test("loadJuiceEnv reads .env and .env.local without overriding real env", () => {
  const dir = mkdtempSync(join(tmpdir(), "juice-bootstrap-env-"));
  writeFileSync(join(dir, ".env"), "GITHUB_CLIENT_ID=from-env\nSHARED=from-env\n");
  writeFileSync(join(dir, ".env.local"), "JUICE_TOKEN_SECRET=from-local\nSHARED=from-local\n");
  const env = { GITHUB_CLIENT_ID: "from-process" } as NodeJS.ProcessEnv;
  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (message?: unknown) => {
    warnings.push(String(message));
  };

  try {
    loadJuiceEnv({ cwd: dir, env });
  } finally {
    console.warn = originalWarn;
  }

  assert.equal(env.GITHUB_CLIENT_ID, "from-process");
  assert.equal(env.JUICE_TOKEN_SECRET, undefined);
  assert.equal(env.SHARED, "from-local");
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /Ignoring JUICE_TOKEN_SECRET/);
});
