#!/usr/bin/env node
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { emitKeypressEvents } from "node:readline";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { join } from "node:path";
import { getToken, setToken } from "../auth/token-store.js";
import { resolveProject, resolveJuiceEnv } from "../config/project.js";
import { apiBase, requestJson } from "../http/client.js";
import { loadJuiceEnv } from "../local/bootstrap-env.js";
import { appendDotEnvValue } from "../local/dotenv.js";
import { hasEnvDrift, recordEnvFingerprint } from "../local/state.js";

export const juiceLogoRaw = String.raw`       __
      / /_  __(_)_______
 __  / / / / / / ___/ _ \
/ /_/ / /_/ / / /__/  __/
\____/\__,_/_/\___/\___/`;

const juiceTagline = "agent secrets without copy/paste";

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
  help: boolean;
};

export async function runCli(argv = process.argv.slice(2)): Promise<number> {
  loadJuiceEnv();
  const args = parseArgs(argv);
  if (args.help || !args.command || args.command === "help") {
    console.log(rootHelpText());
    return 0;
  }
  if (args.command === "auth" && args.subcommand === "login") {
    warnIfDrift();
    await login();
    return 0;
  }
  if (args.command === "set" && args.key) {
    warnIfDrift();
    await setSecret(args.key, args.remote);
    return 0;
  }
  if (args.command === "token" && args.subcommand === "create") {
    await createMachineToken(args);
    return 0;
  }
  if (args.command === "token" && args.subcommand === "revoke" && args.jti) {
    await revokeToken(args.jti);
    return 0;
  }
  console.error(rootHelpText());
  return 1;
}

function parseArgs(argv: string[]): Args {
  return {
    command: argv[0],
    subcommand: argv[1],
    key: argv[0] === "set" ? argv[1] : undefined,
    project: flagValue(argv, "--project"),
    env: flagValue(argv, "--env"),
    ttlSeconds: parseTtl(flagValue(argv, "--ttl")),
    readOnly: argv.includes("--read-only"),
    jti: argv[0] === "token" && argv[1] === "revoke" ? argv[2] : undefined,
    remote: argv.includes("--remote"),
    help: argv.includes("--help") || argv.includes("-h")
  };
}

async function login(): Promise<void> {
  const start = await requestJson<{
    device_code: string;
    user_code: string;
    verification_uri: string;
    interval?: number;
  }>(`${apiBase()}/auth/github/start`, { method: "POST", body: "{}" });

  console.log(`Open ${start.verification_uri} and enter code ${start.user_code}.`);
  const intervalMs = Math.max(start.interval ?? 5, 1) * 1000;

  while (true) {
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
    if (complete.error && complete.error !== "authorization_pending" && complete.error !== "slow_down") {
      throw new Error(complete.error);
    }
  }
}

async function setSecret(key: string, remote: boolean): Promise<void> {
  const value = await promptSecret(`Value for ${key}: `);
  const { project, root } = resolveProject();
  const envName = resolveJuiceEnv();

  if (remote) {
    const token = getToken();
    if (!token) throw new Error("Run `juice auth login` or set JUICE_TOKEN before writing remote secrets.");
    const path = `/projects/${encodeURIComponent(project)}/envs/${encodeURIComponent(envName)}/secrets/${encodeURIComponent(key)}`;
    await requestJson(`${apiBase()}${path}`, {
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

async function createMachineToken(args: Args): Promise<void> {
  const token = getToken();
  if (!token) throw new Error("Run `juice auth login` or set JUICE_TOKEN before creating machine tokens.");
  const project = args.project || resolveProject().project;
  const envName = args.env || resolveJuiceEnv();
  const created = await requestJson<{
    token: string;
    jti: string;
    expiresIn: number;
    scope: { project: string; env: string; actions: string[] };
  }>(`${apiBase()}/tokens`, {
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

async function revokeToken(jti: string): Promise<void> {
  const token = getToken();
  if (!token) throw new Error("Run `juice auth login` or set JUICE_TOKEN before revoking tokens.");
  await requestJson(`${apiBase()}/tokens/${encodeURIComponent(jti)}`, {
    method: "DELETE",
    token
  });
  console.log(`Revoked token ${jti}.`);
}

function warnIfDrift(): void {
  const { root } = resolveProject();
  const envFile = join(root, ".env");
  if (hasEnvDrift(root, envFile)) {
    console.warn(".env changed outside Juice. Use juice set KEY to add or update secrets.");
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
  auth       Authenticate with Juice

Secrets:
  set        Add a secret to .env, or use --remote for Juice/AWS
  token      Create or revoke scoped machine tokens

Help:
  help       Help screen

Flags:
  -h, --help   help for juice

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

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runCli().then((code) => {
    process.exitCode = code;
  }).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
