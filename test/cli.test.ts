import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, statSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { juiceLogoRaw, rootHelpText, runCli } from "../src/cli/main.js";
import { readDotEnv } from "../src/local/dotenv.js";

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
    "  juice [command] --scope <name>",
    "Setup:",
    "  auth login",
    "  scopes",
    "Secrets:",
    "  set KEY",
    "  list",
    "  unset KEY",
    "  export",
    "  get KEY",
    "Tokens:",
    "  token create",
    "  token revoke",
    "Help:",
    "  help",
    "Flags:",
    "  --scope NAME",
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

test("help still works with no scope and no arguments", async () => {
  assert.equal(await runCli(["--help"]), 0);
});

// ── scope is required ────────────────────────────────────────────────────────

test("a command with no scope and no TTY is an error, never a default", async () => {
  const dir = workDir("juice-noscope-");

  for (const argv of [
    ["set", "K", "--local", "--stdin"],
    ["list", "--local"],
    ["get", "K", "--local"],
    ["unset", "K", "--local", "--yes"]
  ]) {
    const result = await runCaptured(argv, { cwd: dir, input: "v" });
    assert.equal(result.code, 1, `expected failure for ${JSON.stringify(argv)}`);
    assert.match(result.stderr, /No scope/);
    assert.match(result.stderr, /--scope/);
  }
});

test("a repo nearby is never mistaken for a scope", async () => {
  const dir = workDir("juice-noinfer-");
  // Both signals the old inference used. Neither may produce a scope now.
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "tempting" }));
  mkdirSync(join(dir, ".git"), { recursive: true });

  const result = await runCaptured(["list", "--local"], { cwd: dir });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /No scope/);
  // And nothing was written into the repository.
  assert.equal(existsSync(join(dir, ".env")), false);
});

test("JUICE_SCOPE supplies the scope without a flag", async () => {
  const dir = workDir("juice-envscope-");
  const env = { ...process.env, JUICE_HOME: join(dir, "home"), JUICE_SCOPE: "from/env" };

  await runCaptured(["set", "K", "--local", "--stdin"], { cwd: dir, env, input: "v" });
  const read = await runCaptured(["get", "K", "--local"], { cwd: dir, env });
  assert.equal(read.stdout, "v\n");
});

test("an empty or missing --scope errors instead of falling back", async () => {
  const dir = workDir("juice-emptyscope-");

  for (const argv of [
    ["set", "K", "--local", "--stdin", "--scope", ""],
    ["set", "K", "--local", "--stdin", "--scope", "   "],
    ["set", "K", "--local", "--stdin", "--scope"],
    ["set", "K", "--stdin", "--scope", "--local"]
  ]) {
    const result = await runCaptured(argv, { cwd: dir, input: "v" });
    assert.equal(result.code, 1, `expected failure for ${JSON.stringify(argv)}`);
    assert.match(result.stderr, /--scope needs a value|Scope cannot be empty/);
  }
});

// ── the store ────────────────────────────────────────────────────────────────

test("secrets live under ~/.juice, never in the working directory", async () => {
  const dir = workDir("juice-store-");
  const home = join(dir, "home");

  const set = await runCaptured(
    ["set", "DATABASE_URL", "--local", "--scope", "myapp/agents/fix-auth", "--stdin"],
    { cwd: dir, input: "postgres://localhost/db" }
  );
  assert.equal(set.code, 0);

  const stored = join(home, "scopes", "myapp", "agents", "fix-auth", "development.env");
  assert.equal(existsSync(stored), true, `expected store at ${stored}`);
  assert.equal(readDotEnv(stored).DATABASE_URL, "postgres://localhost/db");
  assert.equal(existsSync(join(dir, ".env")), false);
  assert.equal(existsSync(join(dir, ".gitignore")), false);
});

test("each env gets its own file; development and local share one", async () => {
  const dir = workDir("juice-envsplit-");
  const home = join(dir, "home");
  const scoped = (argv: string[]) => [...argv, "--local", "--scope", "myapp"];

  await runCaptured(scoped(["set", "TOKEN", "--stdin"]), { cwd: dir, input: "dev-value" });
  await runCaptured(scoped(["set", "TOKEN", "--stdin", "--env", "prod"]), { cwd: dir, input: "prod-value" });
  await runCaptured(scoped(["set", "TOKEN", "--stdin", "--env", "staging"]), { cwd: dir, input: "staging-value" });

  const at = (name: string) => readDotEnv(join(home, "scopes", "myapp", `${name}.env`)).TOKEN;
  assert.equal(at("development"), "dev-value");
  assert.equal(at("prod"), "prod-value");
  assert.equal(at("staging"), "staging-value");

  // `local` and `development` are the same mode, so they must be the same file.
  const asLocal = await runCaptured(["get", "TOKEN", "--scope", "myapp"], {
    cwd: dir,
    env: { ...process.env, JUICE_HOME: home, JUICE_ENV: "local" }
  });
  assert.equal(asLocal.stdout, "dev-value\n");
});

test("juice scopes lists what this machine has used", async () => {
  const dir = workDir("juice-scopes-");

  const empty = await runCaptured(["scopes"], { cwd: dir });
  assert.equal(empty.stdout, "");
  assert.match(empty.stderr, /No scopes used yet/);

  await runCaptured(["set", "A", "--local", "--scope", "first/one", "--stdin"], { cwd: dir, input: "1" });
  await runCaptured(["set", "B", "--local", "--scope", "second/two", "--stdin"], { cwd: dir, input: "2" });

  const listed = await runCaptured(["scopes"], { cwd: dir });
  // Most recent first.
  assert.equal(listed.stdout, "second/two\nfirst/one\n");
  assert.doesNotMatch(listed.stdout, /[12]$/m);
});

// ── secrets ──────────────────────────────────────────────────────────────────

test("juice get prints only the value; a miss stays off stdout", async () => {
  const dir = workDir("juice-get-");
  const scoped = ["--local", "--scope", "myapp"];
  await runCaptured(["set", "OPENAI_API_KEY", ...scoped, "--stdin"], { cwd: dir, input: "sk-test" });

  const ok = await runCaptured(["get", "OPENAI_API_KEY", ...scoped], { cwd: dir });
  assert.equal(ok.code, 0);
  assert.equal(ok.stdout, "sk-test\n");

  const missing = await runCaptured(["get", "MISSING", ...scoped], { cwd: dir });
  assert.equal(missing.code, 1);
  assert.equal(missing.stdout, "");
  assert.match(missing.stderr, /Missing secret MISSING/);
});

test("juice list prints sorted keys and never values", async () => {
  const dir = workDir("juice-list-");
  const scoped = ["--local", "--scope", "myapp"];
  await runCaptured(["set", "ZEBRA", ...scoped, "--stdin"], { cwd: dir, input: "z-secret" });
  await runCaptured(["set", "ALPHA", ...scoped, "--stdin"], { cwd: dir, input: "a-secret" });

  const result = await runCaptured(["list", ...scoped], { cwd: dir });
  assert.equal(result.code, 0);
  assert.equal(result.stdout, "ALPHA\nZEBRA\n");
  assert.doesNotMatch(result.stdout, /secret/);
  assert.doesNotMatch(result.stderr, /secret/);
});

test("juice unset removes the value and is idempotent", async () => {
  const dir = workDir("juice-unset-");
  const scoped = ["--local", "--scope", "myapp"];
  await runCaptured(["set", "KEEP", ...scoped, "--stdin"], { cwd: dir, input: "neighbor" });
  await runCaptured(["set", "REMOVE", ...scoped, "--stdin"], { cwd: dir, input: "top-secret" });
  const file = join(dir, "home", "scopes", "myapp", "development.env");

  const result = await runCaptured(["unset", "REMOVE", ...scoped, "--yes"], { cwd: dir });
  assert.equal(result.code, 0);
  assert.doesNotMatch(result.stdout, /top-secret/);
  assert.doesNotMatch(readFileSync(file, "utf8"), /top-secret/);
  assert.equal(readDotEnv(file).KEEP, "neighbor");

  const again = await runCaptured(["unset", "REMOVE", ...scoped, "--yes"], { cwd: dir });
  assert.equal(again.code, 0);
  assert.match(again.stdout, /REMOVE is not set/);
});

test("juice set refuses a value as an argument and offers --stdin instead", async () => {
  const dir = workDir("juice-argv-");

  const rejected = await runCaptured(["set", "KEY", "hunter2", "--local", "--scope", "myapp"], { cwd: dir });
  assert.equal(rejected.code, 1);
  assert.match(rejected.stderr, /cannot be an argument/);
  assert.match(rejected.stderr, /--stdin/);

  const piped = await runCaptured(["set", "KEY", "--local", "--scope", "myapp", "--stdin"], {
    cwd: dir,
    input: "hunter2\n"
  });
  assert.equal(piped.code, 0);
  assert.equal(readDotEnv(join(dir, "home", "scopes", "myapp", "development.env")).KEY, "hunter2");
});

test("juice set without a TTY fails loudly instead of storing nothing", async () => {
  const dir = workDir("juice-notty-");
  const result = await runCaptured(["set", "NEW", "--local", "--scope", "myapp"], { cwd: dir });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /--stdin/);
});

test("flags before the key still resolve the key", async () => {
  const dir = workDir("juice-flagorder-");
  await runCaptured(["set", "MYKEY", "--local", "--scope", "myapp", "--stdin"], { cwd: dir, input: "real" });

  const unset = await runCaptured(["unset", "--yes", "MYKEY", "--local", "--scope", "myapp"], { cwd: dir });
  assert.equal(unset.code, 0);
  assert.match(unset.stdout, /Unset MYKEY/);

  await runCaptured(["set", "--local", "--scope", "myapp", "MYKEY", "--stdin"], { cwd: dir, input: "v2" });
  assert.equal(readDotEnv(join(dir, "home", "scopes", "myapp", "development.env")).MYKEY, "v2");
});

// ── export ───────────────────────────────────────────────────────────────────

test("juice export merges scopes, quotes for sh, and never prints values", async () => {
  const dir = workDir("juice-export-");
  const out = join(dir, "out");
  mkdirSync(out, { recursive: true });

  await runCaptured(["set", "OPENROUTER_API_KEY", "--local", "--scope", "myapp/global", "--stdin"], {
    cwd: dir,
    input: "or-key"
  });
  await runCaptured(["set", "DATABASE_URL", "--local", "--scope", "myapp/agents/a", "--stdin"], {
    cwd: dir,
    input: "$(touch /tmp/juice-pwned)"
  });

  const result = await runCaptured(
    ["export", "--local", "--scope", "myapp/global", "--scope", "myapp/agents/a",
      "--to", join(out, "run.env")],
    { cwd: dir }
  );
  assert.equal(result.code, 0);
  assert.equal(result.stdout, "");
  assert.doesNotMatch(result.stderr, /or-key/);
  assert.doesNotMatch(result.stderr, /touch/);

  assert.equal(
    readFileSync(join(out, "run.env"), "utf8"),
    "export DATABASE_URL='$(touch /tmp/juice-pwned)'\nexport OPENROUTER_API_KEY='or-key'\n"
  );
  assert.equal(statSync(join(out, "run.env")).mode & 0o777, 0o600);
});

test("juice export refuses to write inside a git repository without --force", async () => {
  const dir = workDir("juice-export-git-");
  mkdirSync(join(dir, ".git"), { recursive: true });
  await runCaptured(["set", "K", "--local", "--scope", "myapp", "--stdin"], { cwd: dir, input: "v" });

  const target = join(dir, "run.env");
  const blocked = await runCaptured(["export", "--local", "--scope", "myapp", "--to", target], { cwd: dir });
  assert.equal(blocked.code, 1);
  assert.match(blocked.stderr, /inside a git repository/);
  assert.equal(existsSync(target), false);

  const forced = await runCaptured(
    ["export", "--local", "--scope", "myapp", "--to", target, "--force"],
    { cwd: dir }
  );
  assert.equal(forced.code, 0);
  assert.equal(readDotEnv(target).K, "v");
});

test("juice export requires --to; there is no stdout form", async () => {
  const dir = workDir("juice-export-usage-");
  const result = await runCaptured(["export", "--local", "--scope", "myapp"], { cwd: dir });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /--to <path>/);
  assert.match(result.stderr, /printed secret is a logged secret/);
});

test("juice export skips JUICE_ control-plane keys", async () => {
  const dir = workDir("juice-export-juicevars-");
  const scoped = ["--local", "--scope", "myapp"];
  await runCaptured(["set", "FROM_STORE", ...scoped, "--stdin"], { cwd: dir, input: "file-value" });
  await runCaptured(["set", "JUICE_TOKEN", ...scoped, "--stdin"], { cwd: dir, input: "should-skip" });

  const target = join(dir, "out", "run.env");
  const result = await runCaptured(["export", ...scoped, "--to", target], { cwd: dir });

  assert.equal(result.code, 0);
  const written = readDotEnv(target);
  assert.equal(written.FROM_STORE, "file-value");
  assert.equal(written.JUICE_TOKEN, undefined);
});

test("--remote and --local together errors", async () => {
  const dir = workDir("juice-flags-");
  const result = await runCaptured(["list", "--remote", "--local", "--scope", "myapp"], { cwd: dir });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /only one of --remote or --local/);
});

function workDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  mkdirSync(join(dir, "home"), { recursive: true });
  return dir;
}

async function runCaptured(
  argv: string[],
  options: { cwd: string; env?: NodeJS.ProcessEnv; input?: string }
): Promise<{ code: number; stdout: string; stderr: string }> {
  return await new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [cliEntry, ...argv], {
      cwd: options.cwd,
      env: options.env ?? { ...process.env, JUICE_HOME: join(options.cwd, "home") },
      stdio: ["pipe", "pipe", "pipe"]
    });
    child.stdin.end(options.input ?? "");
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
