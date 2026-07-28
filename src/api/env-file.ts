import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { readDotEnv } from "../local/dotenv.js";

/**
 * Server configuration from a file.
 *
 * The client-side loader refuses `JUICE_*` keys, because a `.env` sitting in a
 * repository must never be able to redirect which scope, environment, or store
 * the CLI talks to — a file someone else can commit should not steer your
 * secrets.
 *
 * The server is the opposite situation. It has no repository and no user; the
 * person running it *is* the operator, and a file next to the process is the
 * ordinary way to configure a deployment. Refusing `JUICE_*` here meant the
 * server could not be configured from a file at all — including the two things
 * it cannot start without, `JUICE_TOKEN_SECRET` and `JUICE_CONVEX_SECRET`.
 *
 * Two rules keep it honest:
 *
 *   The real environment always wins. A stale file must never silently
 *   override something a deploy explicitly set, so ECS task secrets and
 *   `docker run -e` beat the file every time.
 *
 *   Names are logged, values never. Knowing which keys a file supplied is the
 *   difference between debugging a misconfiguration in a minute and an hour.
 */

export type LoadServerEnvOptions = {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  log?: (message: string) => void;
};

export function serverEnvFilePath(cwd: string, env: NodeJS.ProcessEnv): string {
  return resolve(cwd, env.JUICE_ENV_FILE?.trim() || ".env");
}

export function loadServerEnvFile(options: LoadServerEnvOptions = {}): string[] {
  const cwd = options.cwd ?? process.cwd();
  const env = options.env ?? process.env;
  const log = options.log ?? ((message: string) => console.warn(message));

  const file = serverEnvFilePath(cwd, env);
  if (!existsSync(file)) return [];

  // This file holds the JWT signing secret and the Convex shared secret. If
  // anyone but the owner can read it, that is worth one line of noise.
  const mode = statSync(file).mode & 0o077;
  if (mode !== 0) {
    log(`warning: ${file} is readable by group or others (chmod 600 recommended).`);
  }

  const applied: string[] = [];
  for (const [key, value] of Object.entries(readDotEnv(file))) {
    if (env[key] !== undefined) continue; // the real environment wins
    env[key] = value;
    applied.push(key);
  }
  if (applied.length > 0) {
    // Names only. A value logged here would defeat the point of the file.
    log(`Loaded ${applied.length} variable${applied.length === 1 ? "" : "s"} from ${file}: ${applied.sort().join(", ")}`);
  }
  return applied;
}

