#!/usr/bin/env node
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { emitKeypressEvents } from "node:readline";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { getToken, setToken } from "../auth/token-store.js";
import { resolveJuiceEnv, isLocalMode } from "../config/project.js";
import { MISSING_SCOPE_MESSAGE, readKnownScopes, rememberScope, resolveScope } from "../config/scope.js";
import { apiBase, requestJson } from "../http/client.js";
import { readDotEnv, removeDotEnvKey, setDotEnvValue, type ExportFormat } from "../local/dotenv.js";
import { enclosingGitRepo, writeSecretsFile } from "../local/export.js";
import { ensureStoreDir, storePath } from "../local/store.js";
import { pickScope } from "./pick-scope.js";

export const juiceLogoRaw = String.raw`       __
      / /_  __(_)_______
 __  / / / / / / ___/ _ \
/ /_/ / /_/ / / /__/  __/
\____/\__,_/_/\___/\___/`;

const juiceTagline = "agent secrets without copy/paste";
const LOGIN_DEFAULT_EXPIRES_SECONDS = 15 * 60;

/** Commands whose first positional after the command name is a secret key. */
const KEY_COMMANDS = new Set(["set", "get", "unset"]);

/** Flags that consume the next argv entry, so positionals can be counted. */
const VALUE_FLAGS = new Set(["--scope", "--project", "--env", "--to", "--format", "--ttl"]);

type Args = {
  command?: string;
  subcommand?: string;
  key?: string;
  positionals: string[];
  scopes: string[];
  env?: string;
  to?: string;
  format: ExportFormat;
  force: boolean;
  stdin: boolean;
  ttlSeconds?: number;
  readOnly: boolean;
  jti?: string;
  remote: boolean;
  local: boolean;
  yes: boolean;
  help: boolean;
};

type Context = {
  env: NodeJS.ProcessEnv;
  scope: string;
  envName: string;
  mode: "local" | "remote";
  file: string;
};

export async function runCli(argv = process.argv.slice(2)): Promise<number> {
  // Deliberately does not bootstrap from `.env`. Juice's control plane reads
  // the real environment and flags only, so no file in a repository can change
  // which scope, env, or mode a command runs against.
  const args = parseArgs(argv);
  if (args.help || !args.command || args.command === "help") {
    console.log(rootHelpText());
    return 0;
  }
  if (args.remote && args.local) {
    console.error("Pass only one of --remote or --local.");
    return 1;
  }
  if (args.command === "auth" && args.subcommand === "login") {
    await login();
    return 0;
  }
  if (args.command === "scopes") {
    return listScopes(args);
  }
  if (args.command === "members") {
    return args.subcommand === "invite" ? await createInvite(args) : await listMembers(args);
  }
  if (args.command === "join") {
    return await joinAccount(args);
  }
  if (args.command === "set" && args.key) {
    if (args.positionals.length > 2) {
      console.error(valueAsArgumentError(args.key));
      return 1;
    }
    return await setSecret(args.key, args);
  }
  if (args.command === "get" && args.key) return getSecret(args.key, args);
  if (args.command === "list") return listSecrets(args);
  if (args.command === "unset" && args.key) return unsetSecret(args.key, args);
  // A key-taking command with no key: say which argument is missing rather
  // than dumping the whole help screen and leaving the reader to diff it.
  if (args.command && KEY_COMMANDS.has(args.command)) {
    console.error(`\`juice ${args.command}\` needs a KEY.`);
    console.error("");
    console.error(`  juice ${args.command} MY_KEY --scope <name>${args.command === "set" ? " --stdin" : ""}`);
    return 1;
  }
  if (args.command === "export") return exportSecrets(args);
  if (args.command === "token" && args.subcommand === "create") {
    await createMachineToken(args);
    return 0;
  }
  if (args.command === "token" && args.subcommand === "revoke") {
    await revokeToken(args.jti);
    return 0;
  }
  console.error(rootHelpText());
  return 1;
}

function parseArgs(flagArgv: string[]): Args {
  const positionals = positionalArgs(flagArgv);
  // The command comes from positionals too, so a leading flag does not become
  // the command: `juice --local set K` used to parse its command as "--local".
  const command = positionals[0];

  // Defaults to `sh`, not `dotenv`. `export` exists for files that get sourced,
  // and the dotenv writer double-quotes — under `source` the shell still
  // expands `$(…)` and backticks inside double quotes. The unsafe format has to
  // be the one you opt into, not the one you get by forgetting a flag.
  const format = flagValue(flagArgv, "--format") ?? "sh";
  if (format !== "dotenv" && format !== "sh") {
    throw new Error(`Invalid --format: ${format} (expected "dotenv" or "sh")`);
  }
  return {
    command,
    // From positionals, not argv[1]: `juice unset --yes MYKEY` used to take
    // "--yes" as the key, report "--yes is not set." and exit 0.
    subcommand: positionals[1],
    key: command && KEY_COMMANDS.has(command) ? positionals[1] : undefined,
    positionals,
    // --project is the old spelling of --scope; a scope *is* the project string.
    scopes: [...flagValues(flagArgv, "--scope"), ...flagValues(flagArgv, "--project")],
    env: flagValue(flagArgv, "--env"),
    to: flagValue(flagArgv, "--to"),
    format,
    force: flagArgv.includes("--force"),
    stdin: flagArgv.includes("--stdin"),
    ttlSeconds: parseTtl(flagValue(flagArgv, "--ttl")),
    readOnly: flagArgv.includes("--read-only"),
    jti: command === "token" && positionals[1] === "revoke" ? positionals[2] : undefined,
    remote: flagArgv.includes("--remote"),
    local: flagArgv.includes("--local"),
    yes: flagArgv.includes("--yes") || flagArgv.includes("-y"),
    help: flagArgv.includes("--help") || flagArgv.includes("-h")
  };
}

function positionalArgs(argv: string[]): string[] {
  const out: string[] = [];
  for (let index = 0; index < argv.length; index++) {
    const entry = argv[index];
    if (VALUE_FLAGS.has(entry)) {
      index++;
      continue;
    }
    if (entry.startsWith("-")) continue;
    out.push(entry);
  }
  return out;
}

function resolveSecretMode(args: Args, env: NodeJS.ProcessEnv): "local" | "remote" {
  if (args.remote) return "remote";
  if (args.local) return "local";
  return isLocalMode(env) ? "local" : "remote";
}

function envWithOverrides(args: Args): NodeJS.ProcessEnv {
  const env = { ...process.env };
  if (args.env) env.JUICE_ENV = args.env;
  if (args.remote) env.JUICE_REMOTE = "1";
  if (args.local) {
    delete env.JUICE_REMOTE;
    if (!args.env && !env.JUICE_ENV) env.JUICE_ENV = "development";
  }
  return env;
}

/**
 * Everything a secret command needs. Prompts for a scope when one was not
 * supplied and a human is present; errors otherwise. Never guesses.
 */
async function resolveContext(args: Args, scopeOverride?: string): Promise<Context> {
  const env = envWithOverrides(args);
  const resolved = resolveScope(env, scopeOverride ?? args.scopes[0]);
  const scope = resolved?.scope ?? await pickScope(env);
  const envName = args.env || resolveJuiceEnv(env);
  rememberScope(scope, env);
  return {
    env,
    scope,
    envName,
    mode: resolveSecretMode(args, env),
    file: storePath(scope, envName, env)
  };
}

function secretsPath(ctx: Context): string {
  return `/projects/${encodeURIComponent(ctx.scope)}/envs/${encodeURIComponent(ctx.envName)}/secrets`;
}

function requireToken(ctx: Context, verb: string): string {
  const token = getToken(ctx.env);
  if (!token) throw new Error(`Run \`juice auth login\` or set JUICE_TOKEN before ${verb} remote secrets.`);
  return token;
}

async function login(): Promise<void> {
  const start = await requestJson<{
    device_code: string;
    user_code: string;
    verification_uri: string;
    interval?: number;
    expires_in?: number;
  }>(`${apiBase()}/auth/github/start`, { method: "POST", body: "{}" });

  console.log(`Open ${start.verification_uri} and enter code ${start.user_code}.`);
  const intervalMs = Math.max(start.interval ?? 5, 1) * 1000;
  const expiresIn = typeof start.expires_in === "number" && start.expires_in > 0
    ? start.expires_in
    : LOGIN_DEFAULT_EXPIRES_SECONDS;
  const deadline = Date.now() + expiresIn * 1000;

  while (Date.now() < deadline) {
    await delay(intervalMs);
    const complete = await requestJson<{ token?: string; login?: string; error?: string }>(`${apiBase()}/auth/github/complete`, {
      method: "POST",
      body: JSON.stringify({ device_code: start.device_code })
    });
    if (complete.token) {
      setToken(complete.token);
      console.log(`Logged in${complete.login ? ` as ${complete.login}` : ""}.`);
      return;
    }
    if (complete.error === "expired_token") {
      throw new Error("Device code expired. Run `juice auth login` again.");
    }
    if (complete.error && complete.error !== "authorization_pending" && complete.error !== "slow_down") {
      throw new Error(complete.error);
    }
  }
  throw new Error("Device code expired. Run `juice auth login` again.");
}

// ── scopes ───────────────────────────────────────────────────────────────────

function listScopes(args: Args): number {
  const env = envWithOverrides(args);
  const known = readKnownScopes(env);
  if (known.length === 0) {
    console.error("No scopes used yet on this machine. `juice set KEY --scope <name>` creates one.");
    return 0;
  }
  for (const scope of known) console.log(scope);
  return 0;
}

// ── membership ───────────────────────────────────────────────────────────────

async function listMembers(args: Args): Promise<number> {
  const env = envWithOverrides(args);
  const token = getToken(env);
  if (!token) {
    console.error("Run `juice auth login` before listing members.");
    return 1;
  }
  try {
    const result = await requestJson<{
      accountName: string;
      members: Array<{ provider: string; subject: string; login?: string; joinedAt: number }>;
    }>(`${apiBase(env)}/members`, { method: "GET", token });
    console.error(`${result.accountName} — ${result.members.length} member${result.members.length === 1 ? "" : "s"}`);
    for (const member of result.members) {
      console.log(member.login ?? `${member.provider}:${member.subject}`);
    }
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

async function createInvite(args: Args): Promise<number> {
  const env = envWithOverrides(args);
  const token = getToken(env);
  if (!token) {
    console.error("Run `juice auth login` before creating an invite.");
    return 1;
  }
  try {
    const created = await requestJson<{ code: string; expiresAt: number; accountName: string }>(
      `${apiBase(env)}/invites`,
      { method: "POST", token, body: JSON.stringify({ ttlSeconds: args.ttlSeconds }) }
    );
    // The blast radius, stated plainly: there is no per-scope membership, so
    // this grants everything the account holds, including secrets set earlier.
    console.error(`Invite for ${created.accountName}.`);
    console.error("It grants read/write to EVERY secret in the account, in every scope.");
    console.error(`Single use, expires ${new Date(created.expiresAt).toISOString()}.`);
    console.error("");
    console.log(created.code);
    console.error("");
    console.error("Share it over a channel you trust. It is not shown again.");
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

async function joinAccount(args: Args): Promise<number> {
  const code = args.positionals[1];
  if (!code) {
    console.error("Usage: juice join <code>");
    return 1;
  }
  const env = envWithOverrides(args);
  const token = getToken(env);
  if (!token) {
    console.error("Run `juice auth login` before joining an account.");
    return 1;
  }
  if (!(await confirm("Join this account? You will be able to read every secret it holds.", args.yes))) {
    console.error("Cancelled.");
    return 1;
  }
  try {
    const result = await requestJson<{ account: { id: string; name: string }; token: string }>(
      `${apiBase(env)}/invites/redeem`,
      { method: "POST", token, body: JSON.stringify({ code }) }
    );
    // The old token still names the previous account; replace it.
    setToken(result.token);
    console.log(`Joined ${result.account.name}.`);
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message === "invite_invalid") {
      console.error("That invite is not valid — it may be expired, already used, or mistyped.");
    } else if (message === "already_member") {
      console.error("You are already a member of that account.");
    } else if (message === "already_in_account") {
      console.error("You already belong to an account that holds secrets.");
      console.error("One account per identity for now, so this invite cannot be redeemed.");
    } else {
      console.error(message);
    }
    return 1;
  }
}

// ── secrets ──────────────────────────────────────────────────────────────────

async function setSecret(key: string, args: Args): Promise<number> {
  const ctx = await resolveContext(args);
  const value = args.stdin
    ? stripOneTrailingNewline(await readAllStdin())
    : await promptSecret(`Value for ${key}: `);

  if (ctx.mode === "remote") {
    const token = requireToken(ctx, "writing");
    await requestJson(`${apiBase(ctx.env)}${secretsPath(ctx)}/${encodeURIComponent(key)}`, {
      method: "PUT",
      token,
      body: JSON.stringify({ value })
    });
    console.log(`Stored ${key} in ${ctx.scope} (${ctx.envName}, remote).`);
    return 0;
  }

  ensureStoreDir(ctx.file);
  setDotEnvValue(ctx.file, key, value, ctx.envName);
  console.log(`Stored ${key} in ${ctx.scope} (${ctx.envName}).`);
  return 0;
}

async function getSecret(key: string, args: Args): Promise<number> {
  const ctx = await resolveContext(args);

  if (ctx.mode === "local") {
    const value = readDotEnv(ctx.file)[key];
    if (value === undefined) {
      console.error(`Missing secret ${key} in ${ctx.scope} (${ctx.envName}).`);
      return 1;
    }
    console.log(value);
    return 0;
  }

  try {
    const token = requireToken(ctx, "reading");
    const response = await requestJson<{ value: string }>(
      `${apiBase(ctx.env)}${secretsPath(ctx)}/${encodeURIComponent(key)}`,
      { method: "GET", token }
    );
    console.log(response.value);
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

async function listSecrets(args: Args): Promise<number> {
  const ctx = await resolveContext(args);

  if (ctx.mode === "local") {
    for (const key of Object.keys(readDotEnv(ctx.file)).sort()) console.log(key);
    return 0;
  }

  try {
    const token = requireToken(ctx, "listing");
    const response = await requestJson<{ keys: string[] }>(`${apiBase(ctx.env)}${secretsPath(ctx)}`, {
      method: "GET",
      token
    });
    for (const key of [...response.keys].sort()) console.log(key);
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

async function unsetSecret(key: string, args: Args): Promise<number> {
  const ctx = await resolveContext(args);

  if (ctx.mode === "local") {
    if (!(key in readDotEnv(ctx.file))) {
      console.log(`${key} is not set in ${ctx.scope} (${ctx.envName}).`);
      return 0;
    }
    if (!(await confirm(`Unset ${key} from ${ctx.scope} (${ctx.envName})?`, args.yes))) {
      console.error("Cancelled.");
      return 1;
    }
    if (!removeDotEnvKey(ctx.file, key)) {
      console.error(`Could not remove ${key} from ${displayPath(ctx.file)}.`);
      return 1;
    }
    console.log(`Unset ${key}.`);
    return 0;
  }

  try {
    const token = requireToken(ctx, "unsetting");
    if (!(await confirm(`Unset remote secret ${key} for ${ctx.scope} (${ctx.envName})?`, args.yes))) {
      console.error("Cancelled.");
      return 1;
    }
    await requestJson(`${apiBase(ctx.env)}${secretsPath(ctx)}/${encodeURIComponent(key)}`, {
      method: "DELETE",
      token
    });
    console.log(`Unset ${key}.`);
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

/**
 * One request instead of list-then-N-gets, falling back when the server has no
 * `?values=1` — a self-hosted deployment can be older than this client, and
 * silently returning zero secrets would be worse than being slow.
 */
async function fetchAllRemote(ctx: Context): Promise<Record<string, string>> {
  const token = requireToken(ctx, "reading");
  const base = `${apiBase(ctx.env)}${secretsPath(ctx)}`;
  const bulk = await requestJson<{ keys: string[]; secrets?: Record<string, string> }>(`${base}?values=1`, {
    method: "GET",
    token
  });
  if (bulk.secrets) return bulk.secrets;

  const values: Record<string, string> = Object.create(null);
  for (const key of bulk.keys) {
    const response = await requestJson<{ value: string }>(`${base}/${encodeURIComponent(key)}`, {
      method: "GET",
      token
    });
    values[key] = response.value;
  }
  return values;
}

async function readScope(ctx: Context): Promise<Record<string, string>> {
  return ctx.mode === "local" ? readDotEnv(ctx.file) : await fetchAllRemote(ctx);
}

async function exportSecrets(args: Args): Promise<number> {
  if (!args.to) {
    console.error("Usage: juice export --to <path> --scope <name>… [--format sh|dotenv]");
    console.error("There is no --json / stdout form on purpose: a printed secret is a logged secret.");
    return 1;
  }

  const target = resolve(args.to);
  const repo = enclosingGitRepo(dirname(target));
  if (repo && !args.force) {
    console.error(`${displayPath(target)} is inside a git repository (${displayPath(repo)}).`);
    console.error("Anything working in that repo can commit and push it. Pass --force to override.");
    return 1;
  }

  const merged: Record<string, string> = Object.create(null);
  const summary: Array<{ scope: string; keys: string[] }> = [];
  try {
    // No --scope: resolveContext prompts (or errors when non-interactive).
    for (const scopeName of args.scopes.length > 0 ? args.scopes : [undefined]) {
      const ctx = await resolveContext(args, scopeName);
      const values = await readScope(ctx);
      const keys: string[] = [];
      for (const [key, value] of Object.entries(values)) {
        if (key.startsWith("JUICE_")) continue;
        merged[key] = value; // later scopes win
        keys.push(key);
      }
      summary.push({ scope: ctx.scope, keys: keys.sort() });
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }

  if (args.format === "dotenv") {
    const risky = Object.keys(merged).filter((key) => /[$`\\]/.test(merged[key])).sort();
    if (risky.length > 0) {
      console.error("warning: dotenv format double-quotes, so this file is NOT safe to `source`.");
      console.error(`         ${risky.join(", ")} contain shell metacharacters. Use --format sh if anything sources it.`);
    }
  }

  const result = writeSecretsFile(target, merged, args.format);
  console.error(`wrote ${result.keys.length} key${result.keys.length === 1 ? "" : "s"} → ${displayPath(result.path)} (0600, ${args.format})`);
  for (const entry of summary) {
    console.error(`  ${entry.scope}  ${entry.keys.length > 0 ? entry.keys.join(", ") : "(empty)"}`);
  }
  if (summary.length > 1) console.error("  later scopes win on conflict");
  return 0;
}

// ── tokens ───────────────────────────────────────────────────────────────────

async function createMachineToken(args: Args): Promise<void> {
  const ctx = await resolveContext(args);
  const token = requireToken(ctx, "creating machine tokens for");
  const created = await requestJson<{
    token: string;
    jti: string;
    expiresIn: number;
    scope: { project: string; env: string; actions: string[] };
  }>(`${apiBase(ctx.env)}/tokens`, {
    method: "POST",
    token,
    body: JSON.stringify({
      project: ctx.scope,
      env: ctx.envName,
      readOnly: args.readOnly,
      ttlSeconds: args.ttlSeconds
    })
  });

  console.log(created.token);
  console.error(`Created token ${created.jti} for ${created.scope.project}/${created.scope.env} (${created.scope.actions.join(",")}, ${created.expiresIn}s).`);
}

async function revokeToken(target: string | undefined): Promise<void> {
  const token = getToken();
  if (!token) throw new Error("Run `juice auth login` or set JUICE_TOKEN before revoking tokens.");
  const currentJti = decodeTokenJti(token);
  if (!currentJti) throw new Error("Stored token is invalid; run `juice auth login` again.");
  const targetJti = target ? decodeTokenJti(target) ?? (target === currentJti ? target : undefined) : currentJti;
  if (!targetJti) throw new Error("Pass the full target token, or omit the argument to revoke your current token.");

  await requestJson(`${apiBase()}/tokens/${encodeURIComponent(targetJti)}`, {
    method: "DELETE",
    token,
    body: target && targetJti !== currentJti ? JSON.stringify({ token: target }) : undefined
  });
  console.log(`Revoked token ${targetJti}.`);
}

// ── plumbing ─────────────────────────────────────────────────────────────────

function valueAsArgumentError(key: string): string {
  return [
    "A secret value cannot be an argument — it lands in `ps` and in shell history,",
    "and deleting it later does not help.",
    "",
    `  interactive   juice set ${key} --scope <name>`,
    `  scripted      printf %s "$VALUE" | juice set ${key} --scope <name> --stdin`
  ].join("\n");
}

function stripOneTrailingNewline(value: string): string {
  return value.replace(/\r?\n$/, "");
}

async function readAllStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of input) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

/** `~`-relative where possible; absolute paths in output are noise. */
export function displayPath(path: string, home = homedir()): string {
  const absolute = resolve(path);
  const fromCwd = relative(process.cwd(), absolute);
  if (fromCwd && !fromCwd.startsWith("..")) return fromCwd;
  const fromHome = relative(home, absolute);
  if (fromHome && !fromHome.startsWith("..")) return join("~", fromHome);
  return absolute;
}

async function confirm(message: string, yes: boolean): Promise<boolean> {
  if (yes) return true;
  if (!input.isTTY) {
    throw new Error("Pass --yes to confirm in non-interactive mode.");
  }
  const rl = createInterface({ input, output });
  try {
    const answer = await rl.question(`${message} [y/N] `);
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}

async function promptSecret(prompt: string): Promise<string> {
  // Without a TTY there is nothing to prompt. Falling back to readline here
  // meant `juice set KEY < /dev/null` printed the prompt, never resolved, and
  // let node exit 0 with nothing stored — success reported for a lost secret.
  if (!input.isTTY || typeof input.setRawMode !== "function") {
    throw new Error("No terminal to read a secret from. Pipe the value instead: printf %s \"$VALUE\" | juice set KEY --scope <name> --stdin");
  }
  return hiddenPrompt(prompt);
}

function hiddenPrompt(prompt: string): Promise<string> {
  return new Promise((resolvePrompt, reject) => {
    let value = "";
    output.write(prompt);
    emitKeypressEvents(input);
    input.setRawMode(true);
    input.resume();

    const cleanup = () => {
      input.setRawMode(false);
      input.off("keypress", onKeypress);
      output.write("\n");
    };

    const onKeypress = (str: string, key: { name?: string; ctrl?: boolean }) => {
      if (key.ctrl && key.name === "c") {
        cleanup();
        reject(new Error("Cancelled"));
        return;
      }
      if (key.name === "return" || key.name === "enter") {
        cleanup();
        resolvePrompt(value);
        return;
      }
      if (key.name === "backspace") {
        value = value.slice(0, -1);
        return;
      }
      if (str) value += str;
    };

    input.on("keypress", onKeypress);
  });
}

export function rootHelpText(options: { authConfigured?: boolean } = {}): string {
  const authConfigured = options.authConfigured ?? Boolean(getToken());
  const authLine = authConfigured ? "● Token configured" : "● Not signed in  juice auth login";
  return `${juiceLogoRaw}
${juiceTagline}
${authLine}

$ juice help

Usage:
  juice [command] --scope <name>

Setup:
  auth login Authenticate with Juice
  scopes     List scopes used on this machine

Account:
  members        List who can read this account's secrets
  members invite Create a single-use invite code
  join CODE      Join an account with an invite code

Secrets:
  set KEY    Add or replace a secret (prompt, or --stdin)
  list       List secret key names (never values)
  unset KEY  Remove a secret
  export     Write every key in a scope to a file
  get KEY    Print one value to stdout (debugging; apps use the SDK)

Tokens:
  token create   Create a scoped machine token
  token revoke   Revoke current token, or revoke by full token

Help:
  help       Help screen

Flags:
  --scope NAME     Which scope to act on (repeatable on export)
  --env NAME       Environment: development (default), staging, production…
  --local          Force the local store
  --remote         Force the remote API
  --stdin          Read the value for \`set\` from stdin
  --to PATH        Destination for \`export\`
  --format FMT     \`export\` format: sh (default) or dotenv
  --force          Let \`export\` write inside a git repository
  --yes, -y        Skip confirmation prompts
  -h, --help       help for juice

Scope is never inferred. Pass --scope or set JUICE_SCOPE; run interactively and
Juice offers the scopes you have used before. Without either, it is an error.

Secrets live in ~/.juice/scopes/<scope>/<env>.env for development, and in the
Juice API for every other env. Reading in an app is the SDK's job:

  const secrets = juice.scope("my-scope");
  await secrets.get("MY_KEY");

Mode: JUICE_ENV → APP_ENV → NODE_ENV → development; JUICE_REMOTE=1 forces remote.
--remote and --local are mutually exclusive.`;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

function flagValue(argv: string[], flag: string): string | undefined {
  const index = argv.indexOf(flag);
  if (index < 0) return undefined;
  const value = argv[index + 1];
  // A flag that names a destination must not quietly become "use the default
  // destination" when its value goes missing.
  if (value === undefined || value.trim() === "" || value.startsWith("--")) {
    throw new Error(`${flag} needs a value${value?.startsWith("--") ? `, but got the flag ${value}` : ""}.`);
  }
  return value;
}

/**
 * Repeated flag values, strict about a missing or empty one. Silently dropping
 * `--scope ""` would put secrets somewhere other than where they were asked to
 * go, and `--scope "$VAR"` with VAR unset is the everyday way to produce it.
 */
function flagValues(argv: string[], flag: string): string[] {
  const out: string[] = [];
  for (let index = 0; index < argv.length; index++) {
    if (argv[index] !== flag) continue;
    const value = argv[index + 1];
    if (value === undefined || value.trim() === "") {
      throw new Error(`${flag} needs a value.`);
    }
    if (value.startsWith("--")) {
      throw new Error(`${flag} needs a value, but got the flag ${value}.`);
    }
    out.push(value);
    index++;
  }
  return out;
}

function parseTtl(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const match = /^(\d+)([smhd])?$/.exec(value);
  if (!match) throw new Error(`Invalid ttl: ${value}`);
  const amount = Number.parseInt(match[1], 10);
  const unit = match[2] || "s";
  const multiplier = unit === "s" ? 1 : unit === "m" ? 60 : unit === "h" ? 60 * 60 : 24 * 60 * 60;
  return amount * multiplier;
}

function decodeTokenJti(token: string): string | undefined {
  const [, encodedPayload] = token.split(".");
  if (!encodedPayload) return undefined;
  try {
    const payload = JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8")) as { jti?: unknown };
    return typeof payload.jti === "string" && payload.jti.trim() ? payload.jti : undefined;
  } catch {
    return undefined;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runCli().then((code) => {
    process.exitCode = code;
  }).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
