import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

/**
 * Where the session token lives.
 *
 * One mechanism on every platform: a `0600` file inside a `0700` directory.
 * This used to prefer the macOS Keychain, which is genuinely better at rest —
 * encrypted, OS-gated — but it made "where is my token" have a different answer
 * per operating system, and it got there by shelling out to `security`, whose
 * prompt writes to /dev/tty and looks exactly like a password request aimed at
 * the user. It was not; the value was already being piped in on stdin. It also
 * put machine state in a credential lookup, so a test run on a laptop where
 * someone had logged in would quietly pick up their real token.
 *
 * Be honest about what 0600 buys: it stops other users on a shared machine, and
 * nothing else. It is not encrypted at rest, so anything that can read your
 * home directory as you can read it too. That is the same bargain as
 * `~/.aws/credentials`, `~/.npmrc`, `gh`, and `docker` — familiar, and not
 * pretending to be more than it is.
 *
 * What it holds is a session JWT from `juice auth login`, not a password —
 * nothing the user types is ever stored here. If it leaks, `juice token revoke`
 * invalidates it server-side; it also expires on its own.
 */

export function juiceHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.JUICE_HOME?.trim() || join(homedir(), ".juice");
}

export function tokenFile(env: NodeJS.ProcessEnv = process.env): string {
  return join(juiceHome(env), "token.json");
}

export function getToken(env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (env.JUICE_TOKEN?.trim()) return env.JUICE_TOKEN.trim();
  const file = tokenFile(env);
  if (!existsSync(file)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as { token?: string };
    return parsed.token?.trim() || undefined;
  } catch {
    // A corrupt token file degrades to "not signed in", never to a crash.
    return undefined;
  }
}

export function setToken(token: string, env: NodeJS.ProcessEnv = process.env): void {
  const file = tokenFile(env);
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, `${JSON.stringify({ token }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  // `mode` only applies when creating; an existing file keeps whatever bits it
  // had, so one that was ever world-readable would silently stay that way.
  chmodSync(file, 0o600);
}

/** Forget the stored session. `juice token revoke` invalidates it server-side. */
export function clearToken(env: NodeJS.ProcessEnv = process.env): boolean {
  const file = tokenFile(env);
  if (!existsSync(file)) return false;
  rmSync(file, { force: true });
  return true;
}
