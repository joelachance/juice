/**
 * Where a local secret lives. One shape, no branches.
 *
 * Local secrets used to live in the repository's own `.env`, which meant Juice
 * had to manage a `.gitignore` block, watch the file for hand edits, scaffold
 * it with `juice init`, and pick between two different stores depending on how
 * the scope had been resolved. It also meant a plain `NODE_ENV=production` line
 * in that file could silently flip Juice to remote mode.
 *
 * All of that was in service of "your existing `.env` just works". Dropping it
 * removes the gitignore management, the drift detection, the `init` command,
 * the two-store split, and that whole bug class — in exchange for one rule:
 *
 *   every local secret is at ~/.juice/scopes/<scope>/<env>.env
 *
 * The file is still dotenv-format, but that is an implementation detail of the
 * store rather than a file anyone else is expected to read. Things that are not
 * the SDK get secrets via `juice export`.
 */
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { juiceHome } from "../auth/token-store.js";
import { assertSegment, scopeSegments } from "../config/secret-path.js";

/**
 * `development` and `local` are the same mode as far as isLocalMode is
 * concerned, so they must address the same file.
 */
const DEFAULT_ENV_NAMES = new Set(["development", "local"]);

function canonicalEnvName(envName: string): string {
  return DEFAULT_ENV_NAMES.has(envName.trim().toLowerCase()) ? "development" : envName;
}

export function storePath(scope: string, envName: string, env: NodeJS.ProcessEnv = process.env): string {
  const leaf = `${assertSegment("env", canonicalEnvName(envName))}.env`;
  return join(juiceHome(env), "scopes", ...scopeSegments(scope), leaf);
}

/** Create the parent directory at 0700. */
export function ensureStoreDir(file: string): void {
  const dir = dirname(file);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
}
