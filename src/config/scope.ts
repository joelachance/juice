/**
 * Scopes are always explicit.
 *
 * This module used to infer a scope by walking up for `package.json` or `.git`.
 * That is convenient exactly until it is wrong, and when it is wrong it is
 * silent: secrets land in whatever repository happened to be nearby, and the
 * only way to notice is to go looking. Every mechanism that made inference
 * "safe" — printable provenance, a pin file, a `(guess)` label — was really
 * just tooling to compensate for not knowing.
 *
 * So there is no inference and no pin file. A scope comes from `--scope`, from
 * `JUICE_SCOPE`, or from asking the person at the keyboard. If nobody is at the
 * keyboard and neither was supplied, that is an error — never a default.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { juiceHome } from "../auth/token-store.js";
import { assertScope } from "./secret-path.js";

export type ScopeSource = "flag" | "JUICE_SCOPE" | "chosen";

export type ScopeResolution = {
  scope: string;
  source: ScopeSource;
};

/** Scopes this machine has used, most recent first. */
function knownScopesPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(juiceHome(env), "scopes.json");
}

export function readKnownScopes(env: NodeJS.ProcessEnv = process.env): string[] {
  const path = knownScopesPath(env);
  if (!existsSync(path)) return [];
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { scopes?: unknown };
    if (!Array.isArray(parsed.scopes)) return [];
    return parsed.scopes.filter((value): value is string => typeof value === "string" && value.trim().length > 0);
  } catch {
    // A corrupt registry degrades to "no history", never to a crash mid-command.
    return [];
  }
}

/** Record a scope as used. Most recent first, de-duplicated, capped. */
export function rememberScope(scope: string, env: NodeJS.ProcessEnv = process.env): void {
  const existing = readKnownScopes(env);
  const next = [scope, ...existing.filter((entry) => entry !== scope)].slice(0, 50);
  const path = knownScopesPath(env);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${JSON.stringify({ scopes: next }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
}

/**
 * Resolve without prompting. Returns undefined when nothing explicit was given,
 * leaving the caller to prompt or fail — this module never picks for you.
 */
export function resolveScope(
  env: NodeJS.ProcessEnv = process.env,
  flag?: string
): ScopeResolution | undefined {
  // An explicitly-passed but empty scope is an error, not a fallthrough:
  // `--scope "$VAR"` with VAR unset must not quietly become something else.
  if (flag !== undefined && flag.trim() === "") {
    throw new Error("Scope cannot be empty. Pass a scope name with --scope.");
  }
  if (flag?.trim()) {
    return { scope: assertScope(flag), source: "flag" };
  }
  if (env.JUICE_SCOPE?.trim()) {
    return { scope: assertScope(env.JUICE_SCOPE), source: "JUICE_SCOPE" };
  }
  return undefined;
}

export const MISSING_SCOPE_MESSAGE = [
  "No scope. Every secret belongs to one, and Juice will not guess.",
  "",
  "  juice <command> --scope <name>",
  "  JUICE_SCOPE=<name> juice <command>",
  "",
  "Run interactively to pick from scopes you have used before."
].join("\n");
