/**
 * set / get / list / unset / export.
 *
 * `get` is the only command that prints a value, which is why it is
 * documented as a debugging tool: apps use the SDK.
 */
import { dirname, resolve } from "node:path";
import { apiBase, requestJson } from "../../http/client.js";
import { readDotEnv, removeDotEnvKey, setDotEnvValue } from "../../local/dotenv.js";
import { enclosingGitRepo, writeSecretsFile } from "../../local/export.js";
import { ensureStoreDir } from "../../local/store.js";
import { requireToken, resolveContext, secretsPath, type Context } from "../context.js";
import { confirm, displayPath, promptSecret, readAllStdin, stripOneTrailingNewline } from "../prompt.js";
import type { Args } from "../args.js";


export async function setSecret(key: string, args: Args): Promise<number> {
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

export async function getSecret(key: string, args: Args): Promise<number> {
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

export async function listSecrets(args: Args): Promise<number> {
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

export async function unsetSecret(key: string, args: Args): Promise<number> {
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

export async function exportSecrets(args: Args): Promise<number> {
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

