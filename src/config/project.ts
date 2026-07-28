/**
 * The env axis, and what it implies about where a secret comes from.
 *
 * This file used to also infer a *project* by walking up for `package.json` or
 * `.git`. That inference is gone: scopes are always explicit, so nothing about
 * a secret depends on which directory a process happens to start in.
 */

export function resolveJuiceEnv(env: NodeJS.ProcessEnv = process.env): string {
  return (env.JUICE_ENV || env.APP_ENV || env.NODE_ENV || "development").trim();
}

/**
 * Development reads a file on this machine and never contacts a server;
 * everything else goes to the API. The env name picks the source, not just the
 * file — they are the same decision.
 */
export function isLocalMode(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.JUICE_REMOTE === "1" || env.JUICE_REMOTE === "true") return false;
  const juiceEnv = resolveJuiceEnv(env).toLowerCase();
  return juiceEnv === "local" || juiceEnv === "development";
}
