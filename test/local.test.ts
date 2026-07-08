import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { appendDotEnvValue, readDotEnv } from "../src/local/dotenv.js";
import { hasEnvDrift, recordEnvFingerprint } from "../src/local/state.js";

test("appendDotEnvValue appends and readDotEnv uses the last value", () => {
  const dir = mkdtempSync(join(tmpdir(), "juice-local-"));
  const envFile = join(dir, ".env");

  appendDotEnvValue(envFile, "OPENAI_API_KEY", "first", "development");
  appendDotEnvValue(envFile, "OPENAI_API_KEY", "second value", "development");

  const contents = readFileSync(envFile, "utf8");
  assert.match(contents, /# juice: added .* env=development/);
  assert.equal(readDotEnv(envFile).OPENAI_API_KEY, "second value");
});

test("state fingerprint detects out-of-band .env edits", () => {
  const dir = mkdtempSync(join(tmpdir(), "juice-state-"));
  const envFile = join(dir, ".env");

  writeFileSync(envFile, "A=1\n");
  recordEnvFingerprint(dir, envFile);
  assert.equal(hasEnvDrift(dir, envFile), false);

  writeFileSync(envFile, "A=2\n");
  assert.equal(hasEnvDrift(dir, envFile), true);
});
