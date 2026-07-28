/**
 * Reading secrets.
 *
 *   const secrets = juice.scope("myapp");
 *   const apiKey = await secrets.get("OPENAI_API_KEY");
 *
 * The scope is declared in code, once, and is never inferred. `juice.get("K")`
 * with no scope used to work by guessing from the working directory, which made
 * the answer depend on where the process happened to be started from — fine on
 * a laptop, and a silent mystery in a container whose cwd is `/`.
 *
 * The *env* axis is different and still environmental: `JUICE_ENV` / `APP_ENV`
 * / `NODE_ENV` decide dev vs prod, because that genuinely is deployment config
 * and hardcoding it is what people are trying to avoid. It also picks the
 * source: in development Juice reads a local file and never contacts a server;
 * anywhere else it calls the API.
 *
 * ── the cache ────────────────────────────────────────────────────────────────
 *
 * Remote reads are memoised, because a service reading five secrets at startup
 * paid five round trips and one inside a request handler paid one per request.
 * Two failure modes are worth naming:
 *
 *   Stale after rotation. A cache with no expiry means rotating a leaked
 *   credential does nothing until the process restarts. Hence a TTL, default 5
 *   minutes, `JUICE_CACHE_TTL=0` to disable.
 *
 *   Resident longer than needed. A cached value sits in the heap between uses,
 *   so it is in any core dump taken in that window. The value was already there
 *   for as long as the caller held it, and refetching constantly leaks more
 *   through traffic analysis and rate limits.
 *
 * Failures are never cached: a missing secret may be created a second later.
 * Local reads are not cached at all — keying a file cache on mtime+size is
 * wrong on any filesystem with coarse timestamps, and re-parsing a small file
 * costs microseconds. The memoisation that matters is the one in front of the
 * network.
 */
import { getToken } from "../auth/token-store.js";
import { resolveJuiceEnv, isLocalMode } from "../config/project.js";
import { assertScope } from "../config/secret-path.js";
import { apiBase, requestJson } from "../http/client.js";
import { readDotEnv } from "../local/dotenv.js";
import { storePath } from "../local/store.js";

export type JuiceScopeOptions = {
  /** Override the env axis. Defaults to JUICE_ENV / APP_ENV / NODE_ENV. */
  env?: string;
  /** Process environment to read configuration from. Defaults to process.env. */
  processEnv?: NodeJS.ProcessEnv;
};

export type JuiceGetOptions = JuiceScopeOptions & {
  /** Required unless you obtained this client from `juice.scope(...)`. */
  scope?: string;
};

export interface JuiceClient {
  readonly scope: string;
  get(key: string, options?: JuiceScopeOptions): Promise<string>;
}

/** A separator that cannot occur inside a scope, env name, or key. */
const CACHE_KEY_SEPARATOR = String.fromCharCode(0);

const DEFAULT_CACHE_TTL_SECONDS = 300;

/** Remote values, keyed by api base + scope + env + key. */
const remoteCache = new Map<string, { value: string; expiresAt: number }>();
/** In-flight requests, so N concurrent gets of the same key make one request. */
const inflight = new Map<string, Promise<string>>();

function cacheTtlMs(env: NodeJS.ProcessEnv): number {
  const raw = env.JUICE_CACHE_TTL?.trim();
  if (!raw) return DEFAULT_CACHE_TTL_SECONDS * 1000;
  const seconds = Number(raw);
  if (!Number.isFinite(seconds) || seconds < 0) return DEFAULT_CACHE_TTL_SECONDS * 1000;
  return seconds * 1000;
}

async function readSecret(scope: string, key: string, options: JuiceScopeOptions): Promise<string> {
  const env = options.processEnv ?? process.env;
  const envName = options.env?.trim() || resolveJuiceEnv(env);

  if (isLocalMode({ ...env, ...(options.env ? { JUICE_ENV: options.env } : {}) })) {
    const file = storePath(scope, envName, env);
    const value = readDotEnv(file)[key];
    if (value === undefined) {
      throw new Error(`Missing secret ${key} in scope ${scope} (${envName}). Set it with: juice set ${key} --scope ${scope}`);
    }
    return value;
  }

  const base = apiBase(env);
  const cacheKey = [base, scope, envName, key].join(CACHE_KEY_SEPARATOR);
  const ttl = cacheTtlMs(env);

  // TTL 0 means "do not use the cache", not merely "do not fill it".
  const cached = ttl > 0 ? remoteCache.get(cacheKey) : undefined;
  if (cached && cached.expiresAt > Date.now()) return cached.value;

  const pending = inflight.get(cacheKey);
  if (pending) return await pending;

  const request = (async () => {
    const token = getToken(env);
    if (!token) throw new Error("Run `juice auth login` or set JUICE_TOKEN before reading remote secrets.");
    const path = `/projects/${encodeURIComponent(scope)}/envs/${encodeURIComponent(envName)}/secrets/${encodeURIComponent(key)}`;
    const response = await requestJson<{ value: string }>(`${base}${path}`, { method: "GET", token });
    if (ttl > 0) remoteCache.set(cacheKey, { value: response.value, expiresAt: Date.now() + ttl });
    return response.value;
  })();

  inflight.set(cacheKey, request);
  try {
    return await request;
  } finally {
    // Cleared on failure too, so a transient error is not remembered.
    inflight.delete(cacheKey);
  }
}

export const juice = {
  /** Bind a scope once, then read from it. The intended entry point. */
  scope(name: string, scopeOptions: JuiceScopeOptions = {}): JuiceClient {
    const scope = assertScope(name);
    return {
      scope,
      get(key: string, options: JuiceScopeOptions = {}) {
        return readSecret(scope, key, { ...scopeOptions, ...options });
      }
    };
  },

  /** One-shot read. `scope` is required — Juice does not infer one. */
  async get(key: string, options: JuiceGetOptions = {}): Promise<string> {
    if (!options.scope?.trim()) {
      throw new Error(
        `juice.get("${key}") needs a scope. Use juice.scope("my-scope").get("${key}"), ` +
        `or juice.get("${key}", { scope: "my-scope" }).`
      );
    }
    return readSecret(assertScope(options.scope), key, options);
  },

  /** Drop every cached value. Call after rotating a secret in a long-lived process. */
  clearCache(): void {
    remoteCache.clear();
  }
};

export default juice;
