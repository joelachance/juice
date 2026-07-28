import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadServerEnvFile, serverEnvFilePath } from "../src/api/env-file.js";

test("the server can be configured from a file, including JUICE_ keys", () => {
  const dir = mkdtempSync(join(tmpdir(), "juice-serverenv-"));
  writeFileSync(join(dir, ".env"), [
    "JUICE_TOKEN_SECRET=0123456789abcdef0123456789abcdef",
    "JUICE_CONVEX_URL=https://example.convex.site",
    "GITHUB_CLIENT_ID=Iv1.demo",
    ""
  ].join("\n"), { mode: 0o600 });
  const env: NodeJS.ProcessEnv = {};

  const applied = loadServerEnvFile({ cwd: dir, env, log: () => {} });

  // The client-side loader refuses JUICE_*; the server must not, or it cannot
  // be configured at all.
  assert.deepEqual(applied.sort(), ["GITHUB_CLIENT_ID", "JUICE_CONVEX_URL", "JUICE_TOKEN_SECRET"]);
  assert.equal(env.JUICE_TOKEN_SECRET, "0123456789abcdef0123456789abcdef");
  assert.equal(env.JUICE_CONVEX_URL, "https://example.convex.site");
});

test("the real environment wins over the file", () => {
  const dir = mkdtempSync(join(tmpdir(), "juice-serverenv-precedence-"));
  writeFileSync(join(dir, ".env"), "JUICE_CONVEX_URL=https://stale.convex.site\n", { mode: 0o600 });
  const env: NodeJS.ProcessEnv = { JUICE_CONVEX_URL: "https://real.convex.site" };

  const applied = loadServerEnvFile({ cwd: dir, env, log: () => {} });

  // A stale file must never override what a deploy explicitly set.
  assert.deepEqual(applied, []);
  assert.equal(env.JUICE_CONVEX_URL, "https://real.convex.site");
});

test("JUICE_ENV_FILE points at an explicit path", () => {
  const dir = mkdtempSync(join(tmpdir(), "juice-serverenv-path-"));
  writeFileSync(join(dir, "prod.env"), "GITHUB_CLIENT_ID=from-explicit-path\n", { mode: 0o600 });
  const env: NodeJS.ProcessEnv = { JUICE_ENV_FILE: "prod.env" };

  assert.equal(serverEnvFilePath(dir, env), join(dir, "prod.env"));
  loadServerEnvFile({ cwd: dir, env, log: () => {} });
  assert.equal(env.GITHUB_CLIENT_ID, "from-explicit-path");
});

test("a missing file is not an error", () => {
  const dir = mkdtempSync(join(tmpdir(), "juice-serverenv-missing-"));
  assert.deepEqual(loadServerEnvFile({ cwd: dir, env: {}, log: () => {} }), []);
});

test("loose permissions warn, and values never reach the log", () => {
  const dir = mkdtempSync(join(tmpdir(), "juice-serverenv-perms-"));
  const file = join(dir, ".env");
  writeFileSync(file, "JUICE_TOKEN_SECRET=super-secret-value\n");
  chmodSync(file, 0o644);
  const messages: string[] = [];

  loadServerEnvFile({ cwd: dir, env: {}, log: (message) => messages.push(message) });

  assert.equal(messages.some((line) => /readable by group or others/.test(line)), true);
  assert.equal(messages.some((line) => line.includes("JUICE_TOKEN_SECRET")), true);
  // Names are useful for debugging; values would defeat the point of the file.
  assert.equal(messages.some((line) => line.includes("super-secret-value")), false);
});
