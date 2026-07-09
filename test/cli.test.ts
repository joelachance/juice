import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { juiceLogoRaw, rootHelpText, runCli } from "../src/cli/main.js";
import { appendDotEnvValue } from "../src/local/dotenv.js";
import { fingerprintFile, recordEnvFingerprint } from "../src/local/state.js";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const cliEntry = join(repoRoot, "dist/src/cli/main.js");

test("root help starts with ASCII logo and renders gx-style sections", () => {
  const text = rootHelpText({ authConfigured: false });

  assert(text.startsWith(`${juiceLogoRaw}\n`));
  assert.match(text, /agent secrets without copy\/paste/);
  assert.match(text, /Not signed in  juice auth login/);
  assert.match(text, /\$ juice help/);

  const ordered = [
    "Usage:",
    "  juice [command]",
    "Setup:",
    "  auth login",
    "  init",
    "Secrets:",
    "  set KEY",
    "  get KEY",
    "  list",
    "  unset KEY",
    "  run --",
    "Tokens:",
    "  token create",
    "  token revoke",
    "Help:",
    "  help",
    "Flags:",
    "  --local",
    "  --remote",
    "  -h, --help"
  ];
  let previous = -1;
  for (const want of ordered) {
    const index = text.indexOf(want);
    assert.notEqual(index, -1, `missing ${want} in:\n${text}`);
    assert(index > previous, `${want} rendered out of order:\n${text}`);
    previous = index;
  }
});

test("root help shows configured token status", () => {
  const text = rootHelpText({ authConfigured: true });
  assert.match(text, /Token configured/);
});

test("juice init scaffolds gitignore and .env once", async () => {
  const dir = mkdtempSync(join(tmpdir(), "juice-init-"));
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "demo" }));
  const previous = process.cwd();
  process.chdir(dir);
  try {
    assert.equal(await runCli(["init"]), 0);
    const gitignore = readFileSync(join(dir, ".gitignore"), "utf8");
    assert.match(gitignore, /# juice — ignore local secrets and state/);
    assert.match(gitignore, /^\.env$/m);
    assert.equal(existsSync(join(dir, ".env")), true);
    const firstIgnore = gitignore;
    assert.equal(await runCli(["init"]), 0);
    assert.equal(readFileSync(join(dir, ".gitignore"), "utf8"), firstIgnore);
  } finally {
    process.chdir(previous);
  }
});

test("juice get prints only the value; missing key stays off stdout", async () => {
  const dir = projectDir("juice-get-");
  appendDotEnvValue(join(dir, ".env"), "OPENAI_API_KEY", "sk-test", "development");

  const ok = await runCaptured(["get", "OPENAI_API_KEY", "--local"], { cwd: dir });
  assert.equal(ok.code, 0);
  assert.equal(ok.stdout, "sk-test\n");
  assert.equal(ok.stderr, "");

  const missing = await runCaptured(["get", "MISSING", "--local"], { cwd: dir });
  assert.equal(missing.code, 1);
  assert.equal(missing.stdout, "");
  assert.match(missing.stderr, /Missing local secret: MISSING/);
});

test("juice list prints sorted keys and never values", async () => {
  const dir = projectDir("juice-list-");
  appendDotEnvValue(join(dir, ".env"), "ZEBRA", "z-secret", "development");
  appendDotEnvValue(join(dir, ".env"), "ALPHA", "a-secret", "development");

  const result = await runCaptured(["list", "--local"], { cwd: dir });
  assert.equal(result.code, 0);
  assert.equal(result.stdout, "ALPHA\nZEBRA\n");
  assert.doesNotMatch(result.stdout, /secret/);
  assert.doesNotMatch(result.stderr, /secret/);
});

test("juice unset removes key and marker, leaves neighbors, re-fingerprints", async () => {
  const dir = projectDir("juice-unset-cli-");
  const envFile = join(dir, ".env");
  writeFileSync(
    envFile,
    [
      "KEEP=neighbor",
      "# juice: added 2026-01-01T00:00:00.000Z env=development",
      "REMOVE=top-secret",
      "AFTER=still-here",
      ""
    ].join("\n")
  );
  recordEnvFingerprint(dir, envFile);
  const before = fingerprintFile(envFile);

  const result = await runCaptured(["unset", "REMOVE", "--local", "--yes"], { cwd: dir });
  assert.equal(result.code, 0);
  assert.match(result.stdout, /Unset REMOVE/);
  assert.doesNotMatch(result.stdout, /top-secret/);
  const contents = readFileSync(envFile, "utf8");
  assert.match(contents, /^KEEP=neighbor$/m);
  assert.match(contents, /^AFTER=still-here$/m);
  assert.doesNotMatch(contents, /REMOVE=/);
  assert.doesNotMatch(contents, /top-secret/);
  assert.doesNotMatch(contents, /# juice: added/);
  assert.notEqual(fingerprintFile(envFile), before);

  const again = await runCaptured(["unset", "REMOVE", "--local", "--yes"], { cwd: dir });
  assert.equal(again.code, 0);
  assert.match(again.stdout, /REMOVE is not set/);
});

test("juice run injects secrets without overriding env and propagates exit code", async () => {
  const dir = projectDir("juice-run-");
  appendDotEnvValue(join(dir, ".env"), "FROM_FILE", "file-value", "development");
  appendDotEnvValue(join(dir, ".env"), "PRESET", "file-should-lose", "development");
  appendDotEnvValue(join(dir, ".env"), "JUICE_TOKEN", "should-skip", "development");

  const inject = await runCaptured(
    ["run", "--local", "--", "node", "-e", "process.stdout.write(process.env.FROM_FILE + '|' + (process.env.PRESET || '') + '|' + (process.env.JUICE_TOKEN || ''))"],
    { cwd: dir, env: { ...process.env, PRESET: "already-set", JUICE_HOME: join(dir, "home") } }
  );
  assert.equal(inject.code, 0);
  assert.equal(inject.stdout, "file-value|already-set|");

  const fail = await runCaptured(["run", "--local", "--", "node", "-e", "process.exit(42)"], {
    cwd: dir,
    env: { ...process.env, JUICE_HOME: join(dir, "home") }
  });
  assert.equal(fail.code, 42);
});

test("--remote and --local together errors", async () => {
  const dir = projectDir("juice-flags-");
  const result = await runCaptured(["list", "--remote", "--local"], { cwd: dir });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /only one of --remote or --local/);
});

function projectDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "demo" }));
  mkdirSync(join(dir, "home"), { recursive: true });
  return dir;
}

async function runCaptured(
  argv: string[],
  options: { cwd: string; env?: NodeJS.ProcessEnv }
): Promise<{ code: number; stdout: string; stderr: string }> {
  return await new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [cliEntry, ...argv], {
      cwd: options.cwd,
      env: options.env ?? { ...process.env, JUICE_HOME: join(options.cwd, "home") },
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      resolvePromise({ code: code ?? 1, stdout, stderr });
    });
  });
}
