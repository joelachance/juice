import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { appendDotEnvValue, readDotEnv, removeDotEnvKey } from "../src/local/dotenv.js";
import { JUICE_GITIGNORE_MARKER, ensureJuiceGitignore } from "../src/local/gitignore.js";
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

test("removeDotEnvKey removes key and juice marker while leaving neighbors", () => {
  const dir = mkdtempSync(join(tmpdir(), "juice-unset-"));
  const envFile = join(dir, ".env");
  writeFileSync(
    envFile,
    [
      "# keep me",
      "KEEP=yes",
      "# juice: added 2026-01-01T00:00:00.000Z env=development",
      "REMOVE=secret-value",
      "AFTER=ok",
      ""
    ].join("\n")
  );

  assert.equal(removeDotEnvKey(envFile, "REMOVE"), true);
  const contents = readFileSync(envFile, "utf8");
  assert.match(contents, /# keep me/);
  assert.match(contents, /^KEEP=yes$/m);
  assert.match(contents, /^AFTER=ok$/m);
  assert.doesNotMatch(contents, /REMOVE=/);
  assert.doesNotMatch(contents, /secret-value/);
  assert.doesNotMatch(contents, /# juice: added/);
  assert.equal(readDotEnv(envFile).KEEP, "yes");
  assert.equal(readDotEnv(envFile).AFTER, "ok");
  assert.equal(removeDotEnvKey(envFile, "REMOVE"), false);
});

test("ensureJuiceGitignore appends once and is idempotent", () => {
  const dir = mkdtempSync(join(tmpdir(), "juice-gitignore-"));
  writeFileSync(join(dir, ".gitignore"), "node_modules/\n");

  const first = ensureJuiceGitignore(dir);
  assert.equal(first.added, true);
  const once = readFileSync(join(dir, ".gitignore"), "utf8");
  assert.match(once, new RegExp(JUICE_GITIGNORE_MARKER.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(once, /^\.env$/m);
  assert.match(once, /^\.env\.\*$/m);
  assert.match(once, /^\.juice\/$/m);

  const second = ensureJuiceGitignore(dir);
  assert.equal(second.added, false);
  assert.equal(readFileSync(join(dir, ".gitignore"), "utf8"), once);
  assert.equal(existsSync(join(dir, ".gitignore")), true);
});
