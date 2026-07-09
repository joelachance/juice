#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { emitKeypressEvents } from "node:readline";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { join } from "node:path";
import { existsSync, writeFileSync } from "node:fs";
import { getToken, setToken } from "../auth/token-store.js";
import { resolveProject, resolveJuiceEnv, isLocalMode } from "../config/project.js";
import { apiBase, requestJson } from "../http/client.js";
import { loadJuiceEnv } from "../local/bootstrap-env.js";
import { appendDotEnvValue, readDotEnv, removeDotEnvKey } from "../local/dotenv.js";
import { ensureJuiceGitignore } from "../local/gitignore.js";
import { hasEnvDrift, recordEnvFingerprint } from "../local/state.js";

export const juiceLogoRaw = String.raw`       __
      / /_  __(_)_______
 __  / / / / / / ___/ _ \
/ /_/ / /_/ / / /__/  __/
\____/\__,_/_/\___/\___/`;

const juiceTagline = "agent secrets without copy/paste";
const LOGIN_DEFAULT_EXPIRES_SECONDS = 15 * 60;

type Args = {
  command?: string;
  subcommand?: string;
  key?: string;
  project?: string;
  env?: string;
  ttlSeconds?: number;
  readOnly: boolean;
  jti?: string;
  remote: boolean;
  local: boolean;
  yes: boolean;
  help: boolean;
  runCommand: string[];
};

export async function runCli(argv = process.argv.slice(2)): Promise<number> {
  loadJuiceEnv();
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
    warnIfDrift(args);
    await login();
    return 0;
  }
  if (args.command === "init") {
    return initProject(args);
  }
  if (args.command === "set" && args.key) {
    warnIfDrift(args);
    await setSecret(args.key, args);
    return 0;
  }
  if (args.command === "get" && args.key) {
    warnIfDrift(args);
    return getSecret(args.key, args);
  }
  if (args.command === "list") {
    warnIfDrift(args);
    return listSecrets(args);
  }
  if (args.command === "unset" && args.key) {
    warnIfDrift(args);
    return unsetSecret(args.key, args);
  }
  if (args.command === "run") {
    warnIfDrift(args);
    return runWithSecrets(args);
  }
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

function parseArgs(argv: string[]): Args {
  const dashIndex = argv.indexOf("--");
  const flagArgv = dashIndex >= 0 ? argv.slice(0, dashIndex) : argv;
  const runCommand = dashIndex >= 0 ? argv.slice(dashIndex + 1) : [];
  const command = flagArgv[0];
  const keyCommands = new Set(["set", "get", "unset"]);
  return {
    command,
    subcommand: flagArgv[1],
    key: command && keyCommands.has(command) ? flagArgv[1] : undefined,
    project: flagValue(flagArgv, "--project"),
    env: flagValue(flagArgv, "--env"),
    ttlSeconds: parseTtl(flagValue(flagArgv, "--ttl")),
    readOnly: flagArgv.includes("--read-only"),
    jti: command === "token" && flagArgv[1] === "revoke" ? flagArgv[2] : undefined,
    remote: flagArgv.includes("--remote"),
    local: flagArgv.includes("--local"),
    yes: flagArgv.includes("--yes") || flagArgv.includes("-y"),
    help: flagArgv.includes("--help") || flagArgv.includes("-h"),
    runCommand
  };
}

function resolveSecretMode(args: Args, env: NodeJS.ProcessEnv = process.env): "local" | "remote" {
  if (args.remote) return "remote";
  if (args.local) return "local";
  return isLocalMode(env) ? "local" : "remote";
}

function envWithOverrides(args: Args): NodeJS.ProcessEnv {
  const env = { ...process.env };
  if (args.project) env.JUICE_PROJECT = args.project;
  if (args.env) env.JUICE_ENV = args.env;
  if (args.remote) env.JUICE_REMOTE = "1";
  if (args.local) {
    delete env.JUICE_REMOTE;
    if (!args.env && !env.JUICE_ENV) env.JUICE_ENV = "development";
  }
  return env;
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

function initProject(args: Args): number {
  const env = envWithOverrides(args);
  const { root } = resolveProject(process.cwd(), env);
  const gitignore = ensureJuiceGitignore(root);
  const envFile = join(root, ".env");
  let createdEnv = false;
  if (!existsSync(envFile)) {
    writeFileSync(envFile, "", { encoding: "utf8", mode: 0o600 });
    createdEnv = true;
  }
  recordEnvFingerprint(root, envFile);

  if (gitignore.added) console.log("Added juice block to .gitignore.");
  else console.log(".gitignore already has the juice block.");
  if (createdEnv) console.log("Created .env (mode 0600).");
  else console.log(".env already exists.");

  console.log("");
  console.log("Model: call juice.get(\"KEY\") — local .env in development, remote API otherwise.");
  console.log("Same call site; Juice picks the source from JUICE_ENV / APP_ENV / NODE_ENV / JUICE_REMOTE.");
  console.log("Next: juice set KEY");
  return 0;
}

async function setSecret(key: string, args: Args): Promise<void> {
  const value = await promptSecret(`Value for ${key}: `);
  const env = envWithOverrides(args);
  const mode = resolveSecretMode(args, env);
  const { project, root } = resolveProject(process.cwd(), env);
  const envName = args.env || resolveJuiceEnv(env);

  ensureGitignoreForSet(root);

  if (mode === "remote") {
    const token = getToken(env);
    if (!token) throw new Error("Run `juice auth login` or set JUICE_TOKEN before writing remote secrets.");
    const path = `/projects/${encodeURIComponent(project)}/envs/${encodeURIComponent(envName)}/secrets/${encodeURIComponent(key)}`;
    await requestJson(`${apiBase(env)}${path}`, {
      method: "PUT",
      token,
      body: JSON.stringify({ value })
    });
    console.log(`Stored ${key} remotely for ${project}/${envName}.`);
    return;
  }

  const envFile = join(root, ".env");
  appendDotEnvValue(envFile, key, value, envName);
  recordEnvFingerprint(root, envFile);
  console.log(`Appended ${key} to .env.`);
}

function ensureGitignoreForSet(root: string): void {
  const result = ensureJuiceGitignore(root);
  if (result.added) {
    console.log("Added .env / .juice/ to .gitignore.");
  }
}

async function getSecret(key: string, args: Args): Promise<number> {
  const env = envWithOverrides(args);
  const mode = resolveSecretMode(args, env);
  const { project, root } = resolveProject(process.cwd(), env);
  const envName = args.env || resolveJuiceEnv(env);

  if (mode === "local") {
    const value = readDotEnv(join(root, ".env"))[key];
    if (value === undefined) {
      console.error(`Missing local secret: ${key}`);
      return 1;
    }
    console.log(value);
    return 0;
  }

  const token = getToken(env);
  if (!token) {
    console.error("Run `juice auth login` or set JUICE_TOKEN before reading remote secrets.");
    return 1;
  }
  const path = `/projects/${encodeURIComponent(project)}/envs/${encodeURIComponent(envName)}/secrets/${encodeURIComponent(key)}`;
  try {
    const response = await requestJson<{ value: string }>(`${apiBase(env)}${path}`, {
      method: "GET",
      token
    });
    console.log(response.value);
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

async function listSecrets(args: Args): Promise<number> {
  const env = envWithOverrides(args);
  const mode = resolveSecretMode(args, env);
  const { project, root } = resolveProject(process.cwd(), env);
  const envName = args.env || resolveJuiceEnv(env);

  if (mode === "local") {
    const keys = Object.keys(readDotEnv(join(root, ".env"))).sort();
    for (const key of keys) console.log(key);
    return 0;
  }

  const token = getToken(env);
  if (!token) {
    console.error("Run `juice auth login` or set JUICE_TOKEN before listing remote secrets.");
    return 1;
  }
  try {
    const path = `/projects/${encodeURIComponent(project)}/envs/${encodeURIComponent(envName)}/secrets`;
    const response = await requestJson<{ keys: string[] }>(`${apiBase(env)}${path}`, {
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
  const env = envWithOverrides(args);
  const mode = resolveSecretMode(args, env);
  const { project, root } = resolveProject(process.cwd(), env);
  const envName = args.env || resolveJuiceEnv(env);

  if (mode === "local") {
    const envFile = join(root, ".env");
    const existing = readDotEnv(envFile);
    if (!(key in existing)) {
      console.log(`${key} is not set.`);
      return 0;
    }
    if (!(await confirm(`Unset ${key} from .env?`, args.yes))) {
      console.error("Cancelled.");
      return 1;
    }
    removeDotEnvKey(envFile, key);
    recordEnvFingerprint(root, envFile);
    console.log(`Unset ${key}.`);
    return 0;
  }

  const token = getToken(env);
  if (!token) {
    console.error("Run `juice auth login` or set JUICE_TOKEN before unsetting remote secrets.");
    return 1;
  }
  if (!(await confirm(`Unset remote secret ${key} for ${project}/${envName}?`, args.yes))) {
    console.error("Cancelled.");
    return 1;
  }
  try {
    const path = `/projects/${encodeURIComponent(project)}/envs/${encodeURIComponent(envName)}/secrets/${encodeURIComponent(key)}`;
    await requestJson(`${apiBase(env)}${path}`, {
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

async function runWithSecrets(args: Args): Promise<number> {
  if (args.runCommand.length === 0) {
    console.error("Usage: juice run -- <cmd> [args…]");
    return 1;
  }
  const env = envWithOverrides(args);
  const mode = resolveSecretMode(args, env);
  const { project, root } = resolveProject(process.cwd(), env);
  const envName = args.env || resolveJuiceEnv(env);
  const childEnv = { ...env };
  const originalKeys = new Set(Object.keys(env));

  if (mode === "local") {
    for (const [key, value] of Object.entries(readDotEnv(join(root, ".env")))) {
      if (key.startsWith("JUICE_")) continue;
      if (!originalKeys.has(key)) childEnv[key] = value;
    }
  } else {
    const token = getToken(env);
    if (!token) {
      console.error("Run `juice auth login` or set JUICE_TOKEN before running with remote secrets.");
      return 1;
    }
    try {
      const listPath = `/projects/${encodeURIComponent(project)}/envs/${encodeURIComponent(envName)}/secrets`;
      const listed = await requestJson<{ keys: string[] }>(`${apiBase(env)}${listPath}`, {
        method: "GET",
        token
      });
      for (const key of listed.keys) {
        if (key.startsWith("JUICE_")) continue;
        if (originalKeys.has(key)) continue;
        const getPath = `/projects/${encodeURIComponent(project)}/envs/${encodeURIComponent(envName)}/secrets/${encodeURIComponent(key)}`;
        const response = await requestJson<{ value: string }>(`${apiBase(env)}${getPath}`, {
          method: "GET",
          token
        });
        childEnv[key] = response.value;
      }
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      return 1;
    }
  }

  const [command, ...commandArgs] = args.runCommand;
  return await new Promise<number>((resolvePromise) => {
    const child = spawn(command, commandArgs, {
      env: childEnv,
      stdio: "inherit"
    });
    child.on("error", (error) => {
      console.error(error.message);
      resolvePromise(1);
    });
    child.on("exit", (code, signal) => {
      if (signal) {
        resolvePromise(1);
        return;
      }
      resolvePromise(code ?? 1);
    });
  });
}

async function createMachineToken(args: Args): Promise<void> {
  const env = envWithOverrides(args);
  const token = getToken(env);
  if (!token) throw new Error("Run `juice auth login` or set JUICE_TOKEN before creating machine tokens.");
  const project = args.project || resolveProject(process.cwd(), env).project;
  const envName = args.env || resolveJuiceEnv(env);
  const created = await requestJson<{
    token: string;
    jti: string;
    expiresIn: number;
    scope: { project: string; env: string; actions: string[] };
  }>(`${apiBase(env)}/tokens`, {
    method: "POST",
    token,
    body: JSON.stringify({
      project,
      env: envName,
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

function warnIfDrift(args: Args): void {
  const env = envWithOverrides(args);
  const { root } = resolveProject(process.cwd(), env);
  const envFile = join(root, ".env");
  if (hasEnvDrift(root, envFile)) {
    console.warn(".env changed outside Juice. Use juice set KEY to add or update secrets.");
  }
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
  if (input.isTTY && typeof input.setRawMode === "function") {
    return hiddenPrompt(prompt);
  }
  const rl = createInterface({ input, output });
  const value = await rl.question(prompt);
  rl.close();
  return value;
}

function hiddenPrompt(prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
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
        resolve(value);
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
  juice [command]

Setup:
  auth login Authenticate with Juice
  init       Scaffold .gitignore + .env for local secrets

Secrets:
  set KEY    Add a secret (local .env or --remote)
  get KEY    Print one secret value to stdout
  list       List secret key names (never values)
  unset KEY  Remove a secret
  run --     Run a command with secrets injected

Tokens:
  token create   Create a scoped machine token
  token revoke   Revoke current token, or revoke by full token

Help:
  help       Help screen

Flags:
  --local          Force local .env mode
  --remote         Force remote API mode
  --project NAME   Override project
  --env NAME       Override environment name
  --yes, -y        Skip confirmation prompts
  -h, --help       help for juice

Mode: JUICE_ENV → APP_ENV → NODE_ENV → development; JUICE_REMOTE=1 forces remote.
--remote and --local are mutually exclusive.

Use "juice [command] --help" for more information about a command.`;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function flagValue(argv: string[], flag: string): string | undefined {
  const index = argv.indexOf(flag);
  return index >= 0 ? argv[index + 1] : undefined;
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
