import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readDotEnv, removeDotEnvKey, serializeSecrets, setDotEnvValue, shQuote } from "../src/local/dotenv.js";

test("setDotEnvValue replaces in place and leaves no copy of the old value", () => {
  const dir = mkdtempSync(join(tmpdir(), "juice-local-"));
  const envFile = join(dir, ".env");

  setDotEnvValue(envFile, "OPENAI_API_KEY", "first", "development");
  setDotEnvValue(envFile, "OPENAI_API_KEY", "second value", "development");

  const contents = readFileSync(envFile, "utf8");
  assert.match(contents, /# juice: added .* env=development/);
  assert.equal(readDotEnv(envFile).OPENAI_API_KEY, "second value");
  // The point of the upsert: rotating a leaked key must not leave it in the file.
  assert.doesNotMatch(contents, /first/);
  assert.equal(contents.match(/^OPENAI_API_KEY=/gm)?.length, 1);
});

test("setDotEnvValue keeps position and neighbours when replacing", () => {
  const dir = mkdtempSync(join(tmpdir(), "juice-upsert-"));
  const envFile = join(dir, ".env");
  writeFileSync(envFile, ["FIRST=1", "TARGET=old", "LAST=3", ""].join("\n"));

  setDotEnvValue(envFile, "TARGET", "new", "development");

  const lines = readFileSync(envFile, "utf8").split("\n").filter((line) => line && !line.startsWith("#"));
  assert.deepEqual(lines, ["FIRST=1", "TARGET=new", "LAST=3"]);
});


test("writers match indented key lines that the reader can see", () => {
  const dir = mkdtempSync(join(tmpdir(), "juice-indent-"));
  const envFile = join(dir, ".env");
  // The reader trims; the writers used to match untrimmed, so an indented line
  // was readable but neither replaceable nor removable — `unset` reported
  // success while the old secret stayed on disk.
  writeFileSync(envFile, "  STRIPE=sk_live_LEAKED\n\tOTHER=also-indented\n");

  assert.equal(readDotEnv(envFile).STRIPE, "sk_live_LEAKED");
  setDotEnvValue(envFile, "STRIPE", "rotated", "development");
  assert.doesNotMatch(readFileSync(envFile, "utf8"), /sk_live_LEAKED/);
  assert.equal(readDotEnv(envFile).STRIPE, "rotated");

  assert.equal(removeDotEnvKey(envFile, "OTHER"), true);
  assert.equal(readDotEnv(envFile).OTHER, undefined);
});

test("readDotEnv has no prototype chain", () => {
  const dir = mkdtempSync(join(tmpdir(), "juice-proto-"));
  const envFile = join(dir, ".env");
  writeFileSync(envFile, "REAL=1\n");
  const values = readDotEnv(envFile);

  // `juice get constructor` printed "[Function: Object]" and exited 0.
  assert.equal(values.constructor, undefined);
  assert.equal(values.toString, undefined);
  assert.equal("valueOf" in values, false);
  assert.equal(values.REAL, "1");
});

test("readDotEnv round-trips a literal backslash-n without turning it into a newline", () => {
  const dir = mkdtempSync(join(tmpdir(), "juice-escape-"));
  const envFile = join(dir, ".env");
  const value = String.raw`a\nb"c\\d`;

  setDotEnvValue(envFile, "TRICKY", value, "development");

  assert.equal(readDotEnv(envFile).TRICKY, value);
});

test("every escape the writer emits survives the reader", () => {
  const dir = mkdtempSync(join(tmpdir(), "juice-ctrl-"));
  const envFile = join(dir, ".env");
  // The writer escapes with JSON.stringify; a hand-rolled unescape only knew
  // \n \r \t, so control characters came back as literal "u0001" and \b as "b".
  const values = [
    "a\u0001b", "a\u0007b", "a\bb", "a\fb", "a\u000bb", "a\u0000b",
    "a\ud800b", "line\nbreak", "tab\there", 'quote"dq', "sq'q", "back\\slash",
    String.raw`a\nb`, "", " lead", "trail ", "#hash", "emoji😀"
  ];
  for (const value of values) {
    setDotEnvValue(envFile, "K", value, "development");
    assert.equal(readDotEnv(envFile).K, value, `round-trip failed for ${JSON.stringify(value)}`);
  }
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


test("shQuote neutralises shell expansion so a sourced export cannot execute", () => {
  assert.equal(shQuote("plain"), "'plain'");
  assert.equal(shQuote("$(id)"), "'$(id)'");
  assert.equal(shQuote("it's"), "'it'\\''s'");

  // The failure this guards: a double-quoted value runs the substitution on `source`.
  const serialized = serializeSecrets({ TOKEN: "$(touch /tmp/pwned)`id`" }, "sh");
  assert.equal(serialized, "export TOKEN='$(touch /tmp/pwned)`id`'\n");
  assert.doesNotMatch(serialized, /"/);
});

test("serializeSecrets sorts keys and emits dotenv without the export prefix", () => {
  assert.equal(serializeSecrets({ B: "2", A: "1" }, "dotenv"), "A=1\nB=2\n");
  assert.equal(serializeSecrets({}, "sh"), "");
});
