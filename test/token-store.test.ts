import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { clearToken, getToken, setToken, tokenFile } from "../src/auth/token-store.js";

function home(): NodeJS.ProcessEnv {
  return { JUICE_HOME: mkdtempSync(join(tmpdir(), "juice-token-")) };
}

test("a token round-trips through the file store at 0600", () => {
  const env = home();

  assert.equal(getToken(env), undefined);
  setToken("jwt-value", env);

  assert.equal(getToken(env), "jwt-value");
  assert.equal(statSync(tokenFile(env)).mode & 0o777, 0o600);
});

test("re-writing tightens permissions on an already-loose file", () => {
  const env = home();
  setToken("first", env);
  // `mode` only applies when creating, so a file that was ever world-readable
  // would silently stay that way without an explicit chmod.
  chmodSync(tokenFile(env), 0o644);

  setToken("second", env);

  assert.equal(statSync(tokenFile(env)).mode & 0o777, 0o600);
  assert.equal(getToken(env), "second");
});

test("JUICE_TOKEN wins over the stored file", () => {
  const env = home();
  setToken("from-file", env);

  assert.equal(getToken({ ...env, JUICE_TOKEN: "from-env" }), "from-env");
  // Whitespace-only is not a token; fall through rather than send " " as auth.
  assert.equal(getToken({ ...env, JUICE_TOKEN: "   " }), "from-file");
});

test("a corrupt token file reads as signed-out, not as a crash", () => {
  const env = home();
  setToken("valid", env);
  writeFileSync(tokenFile(env), "{not json");

  assert.equal(getToken(env), undefined);
});

test("clearToken forgets the session and is idempotent", () => {
  const env = home();
  setToken("jwt-value", env);

  assert.equal(clearToken(env), true);
  assert.equal(getToken(env), undefined);
  assert.equal(clearToken(env), false);
});

test("the store is per JUICE_HOME, so nothing leaks between environments", () => {
  const a = home();
  const b = home();
  setToken("token-a", a);

  // This is what makes the tests isolated from a developer's real login — the
  // Keychain lookup that used to run first could not be pointed anywhere.
  assert.equal(getToken(b), undefined);
  assert.equal(getToken(a), "token-a");
});
