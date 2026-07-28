/**
 * Writing a whole scope to a file.
 *
 * This exists because Juice does not start the process that needs the secrets.
 * When the thing doing that is a VM supervisor or a sandbox, the only channel
 * into the guest is a file it sources at boot.
 *
 * Deliberately `--to <path>` with no `--json` alternative. A command that
 * prints secrets to stdout is the footgun that makes the rest pointless: an
 * agent runs it once and the values are in the session transcript forever, and
 * `$(juice get KEY)` puts them in shell history. Writing to a path means the
 * value never transits a stream anything is logging.
 */
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { serializeSecrets, type ExportFormat } from "./dotenv.js";

export type ExportResult = {
  path: string;
  keys: string[];
};

/** Nearest enclosing git worktree, if any. */
export function enclosingGitRepo(start: string): string | undefined {
  let current = resolve(start);
  while (true) {
    if (existsSync(join(current, ".git"))) return current;
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

/**
 * Atomic because the consumer may be reading on a timer. A half-written
 * `run.env` sourced by a guest is a silently truncated environment, which
 * surfaces as a confusing auth failure rather than as an obvious I/O error.
 * Temp file in the *same* directory, so the rename cannot cross a filesystem.
 */
export function writeSecretsFile(
  targetPath: string,
  values: Record<string, string>,
  format: ExportFormat
): ExportResult {
  const path = resolve(targetPath);
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true, mode: 0o700 });

  const temp = join(dir, `.juice-export-${process.pid}-${Date.now()}.tmp`);
  try {
    writeFileSync(temp, serializeSecrets(values, format), { encoding: "utf8", mode: 0o600 });
    renameSync(temp, path);
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
  return { path, keys: Object.keys(values).sort() };
}
