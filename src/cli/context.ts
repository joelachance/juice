/**
 * What every secret command needs: which scope, which env, which side, and —
 * for local — which file.
 *
 * Resolving a scope may prompt, so this is async. It never guesses: with no
 * scope supplied and no terminal to ask, it throws.
 */
import { resolveJuiceEnv, isLocalMode } from "../config/env.js";
import { rememberScope, resolveScope } from "../config/scope.js";
import { getToken } from "../auth/token-store.js";
import { storePath } from "../local/store.js";
import { pickScope } from "./pick-scope.js";
import type { Args } from "./args.js";

export type Context = {
  env: NodeJS.ProcessEnv;
  scope: string;
  envName: string;
  mode: "local" | "remote";
  file: string;
};

function resolveSecretMode(args: Args, env: NodeJS.ProcessEnv): "local" | "remote" {
  if (args.remote) return "remote";
  if (args.local) return "local";
  return isLocalMode(env) ? "local" : "remote";
}

export function envWithOverrides(args: Args): NodeJS.ProcessEnv {
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
export async function resolveContext(args: Args, scopeOverride?: string): Promise<Context> {
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

export function secretsPath(ctx: Context): string {
  return `/projects/${encodeURIComponent(ctx.scope)}/envs/${encodeURIComponent(ctx.envName)}/secrets`;
}

export function requireToken(ctx: Context, verb: string): string {
  const token = getToken(ctx.env);
  if (!token) throw new Error(`Run \`juice auth login\` or set JUICE_TOKEN before ${verb} remote secrets.`);
  return token;
}

