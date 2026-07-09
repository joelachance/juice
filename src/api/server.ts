import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { AwsSecretsManagerBackend } from "./aws-secrets-backend.js";
import type { SecretRef, SecretsBackend } from "./secrets-backend.js";
import {
  MACHINE_TOKEN_MAX_TTL_SECONDS,
  signToken,
  verifyToken,
  type AuthPrincipal,
  type TokenAction
} from "./token.js";
import {
  AwsSecretsManagerTokenRevocationStore,
  type TokenRevocationStore
} from "./token-revocation-store.js";
import { versionInfo } from "./version.js";

const MAX_JSON_BYTES = 64 * 1024;
const MIN_TOKEN_SECRET_LENGTH = 32;
const USER_TOKEN_TTL_SECONDS = 12 * 60 * 60;
const DEFAULT_MACHINE_TOKEN_TTL_SECONDS = 90 * 24 * 60 * 60;

export type AccessRequest = SecretRef & {
  action: TokenAction;
  principal: AuthPrincipal;
};

export type JuiceServerOptions = {
  backend?: SecretsBackend;
  tokenSecret?: string;
  githubClientId?: string;
  authorize?: (request: AccessRequest) => boolean | Promise<boolean>;
  revocationStore?: TokenRevocationStore;
};

export function createJuiceServer(options: JuiceServerOptions = {}): Server {
  const backend = options.backend ?? new AwsSecretsManagerBackend();
  const signingSecret = tokenSecret(options);
  const authorize = options.authorize ?? ownerOnlyAuthorize;
  const revocationStore = options.revocationStore ?? new AwsSecretsManagerTokenRevocationStore();
  const authLimiter = new TokenBucketLimiter(20, 60_000);
  const principalLimiter = new TokenBucketLimiter(120, 60_000);

  const server = createServer(async (req, res) => {
    const requestId = randomUUID();
    res.setHeader("x-request-id", requestId);

    try {
      const url = new URL(req.url || "/", "http://localhost");

      if (req.method === "GET" && url.pathname === "/") {
        sendJson(res, 200, { requestId, ...versionInfo() });
        return;
      }

      if (req.method === "GET" && url.pathname === "/healthz") {
        sendJson(res, 200, { requestId, ok: true, service: "juice-api" });
        return;
      }

      if (url.pathname.startsWith("/auth/")) {
        if (!authLimiter.allow(clientIp(req))) {
          sendJson(res, 429, { requestId, error: "Too many requests" });
          return;
        }
        if (req.method === "POST" && url.pathname === "/auth/github/start") {
          await handleGithubStart(res, options, requestId);
          return;
        }
        if (req.method === "POST" && url.pathname === "/auth/github/complete") {
          await handleGithubComplete(req, res, options, signingSecret, requestId);
          return;
        }
      }

      const tokenCreateMatch = req.method === "POST" && url.pathname === "/tokens";
      const tokenRevokeMatch = /^\/tokens\/([^/]+)$/.exec(url.pathname);
      if (tokenCreateMatch || (req.method === "DELETE" && tokenRevokeMatch)) {
        const principal = await authenticate(req, signingSecret, revocationStore);
        if (!principal) {
          sendJson(res, 401, { requestId, error: "Unauthorized" });
          return;
        }
        if (!principalLimiter.allow(principal.sub)) {
          sendJson(res, 429, { requestId, error: "Too many requests" });
          return;
        }
        if (tokenCreateMatch) {
          await handleTokenCreate(req, res, requestId, principal, signingSecret, authorize);
          return;
        }
        await handleTokenRevoke(req, res, requestId, tokenRevokeMatch?.[1] || "", principal, signingSecret, revocationStore);
        return;
      }

      const listMatch = /^\/projects\/([^/]+)\/envs\/([^/]+)\/secrets$/.exec(url.pathname);
      const secretMatch = /^\/projects\/([^/]+)\/envs\/([^/]+)\/secrets\/([^/]+)$/.exec(url.pathname);

      if (listMatch && req.method === "GET") {
        await handleSecretList(req, res, requestId, {
          project: decodeURIComponent(listMatch[1]),
          env: decodeURIComponent(listMatch[2])
        }, backend, signingSecret, authorize, revocationStore, principalLimiter);
        return;
      }

      if (!secretMatch || (req.method !== "GET" && req.method !== "PUT" && req.method !== "DELETE")) {
        sendJson(res, 404, { requestId, error: "Not found" });
        return;
      }

      // DELETE uses the write action for v1 (a write token can already overwrite a
      // value). A future dedicated `delete` action could split this.
      const action: TokenAction = req.method === "GET" ? "read" : "write";
      const auditAction: AuditAction = req.method === "DELETE" ? "delete" : action;
      const refBase = {
        project: decodeURIComponent(secretMatch[1]),
        env: decodeURIComponent(secretMatch[2]),
        key: decodeURIComponent(secretMatch[3])
      };
      const principal = await authenticate(req, signingSecret, revocationStore);
      if (!principal) {
        auditSecretAccess({ requestId, principal: "anonymous", action: auditAction, ...refBase, outcome: "unauthorized" });
        sendJson(res, 401, { requestId, error: "Unauthorized" });
        return;
      }
      if (!principalLimiter.allow(principal.sub)) {
        auditSecretAccess({ requestId, principal: principal.sub, action: auditAction, ...refBase, outcome: "rate_limited" });
        sendJson(res, 429, { requestId, error: "Too many requests" });
        return;
      }

      const userId = githubUserId(principal.sub);
      if (!userId) {
        auditSecretAccess({ requestId, principal: principal.sub, action: auditAction, ...refBase, outcome: "unauthorized" });
        sendJson(res, 401, { requestId, error: "Unauthorized" });
        return;
      }

      const ref: SecretRef = { userId, ...refBase };
      if (!await authorizeAccess(authorize, { ...ref, action, principal })) {
        auditSecretAccess({ requestId, principal: principal.sub, action: auditAction, ...refBase, outcome: "forbidden" });
        sendJson(res, 403, { requestId, error: "Forbidden" });
        return;
      }

      if (req.method === "GET") {
        const value = await backend.getSecret(ref);
        if (value === undefined) {
          auditSecretAccess({ requestId, principal: principal.sub, action: auditAction, ...refBase, outcome: "not_found" });
          sendJson(res, 404, { requestId, error: "Secret not found" });
          return;
        }
        auditSecretAccess({ requestId, principal: principal.sub, action: auditAction, ...refBase, outcome: "ok" });
        sendJson(res, 200, { requestId, value });
        return;
      }

      if (req.method === "DELETE") {
        await backend.deleteSecret(ref);
        auditSecretAccess({ requestId, principal: principal.sub, action: auditAction, ...refBase, outcome: "ok" });
        sendJson(res, 204, {});
        return;
      }

      const body = await readJson<{ value?: unknown }>(req);
      if (typeof body.value !== "string") {
        auditSecretAccess({ requestId, principal: principal.sub, action: auditAction, ...refBase, outcome: "bad_request" });
        sendJson(res, 400, { requestId, error: "Secret value must be a string" });
        return;
      }
      await backend.putSecret(ref, body.value);
      auditSecretAccess({ requestId, principal: principal.sub, action: auditAction, ...refBase, outcome: "ok" });
      sendJson(res, 204, {});
    } catch (error) {
      if (error instanceof HttpError) {
        sendJson(res, error.status, { requestId, error: error.publicMessage });
        return;
      }
      console.error(JSON.stringify({
        ts: new Date().toISOString(),
        requestId,
        level: "error",
        message: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined
      }));
      sendJson(res, 500, { requestId, error: "Internal server error" });
    }
  });

  server.headersTimeout = 10_000;
  server.requestTimeout = 15_000;
  return server;
}

async function handleSecretList(
  req: IncomingMessage,
  res: ServerResponse,
  requestId: string,
  refBase: { project: string; env: string },
  backend: SecretsBackend,
  signingSecret: string,
  authorize: (request: AccessRequest) => boolean | Promise<boolean>,
  revocationStore: TokenRevocationStore,
  principalLimiter: TokenBucketLimiter
): Promise<void> {
  const action: TokenAction = "read";
  const auditAction: AuditAction = "list";
  const principal = await authenticate(req, signingSecret, revocationStore);
  if (!principal) {
    auditSecretAccess({ requestId, principal: "anonymous", action: auditAction, ...refBase, outcome: "unauthorized" });
    sendJson(res, 401, { requestId, error: "Unauthorized" });
    return;
  }
  if (!principalLimiter.allow(principal.sub)) {
    auditSecretAccess({ requestId, principal: principal.sub, action: auditAction, ...refBase, outcome: "rate_limited" });
    sendJson(res, 429, { requestId, error: "Too many requests" });
    return;
  }

  const userId = githubUserId(principal.sub);
  if (!userId) {
    auditSecretAccess({ requestId, principal: principal.sub, action: auditAction, ...refBase, outcome: "unauthorized" });
    sendJson(res, 401, { requestId, error: "Unauthorized" });
    return;
  }

  const probe: SecretRef = { userId, ...refBase, key: "__list__" };
  if (!await authorizeAccess(authorize, { ...probe, action, principal })) {
    auditSecretAccess({ requestId, principal: principal.sub, action: auditAction, ...refBase, outcome: "forbidden" });
    sendJson(res, 403, { requestId, error: "Forbidden" });
    return;
  }

  // Tenant isolation: listKeys must only ever be called with the caller's userId.
  const keys = await backend.listKeys({ userId, project: refBase.project, env: refBase.env });
  auditSecretAccess({ requestId, principal: principal.sub, action: auditAction, ...refBase, outcome: "ok" });
  sendJson(res, 200, { requestId, keys });
}

async function authenticate(
  req: IncomingMessage,
  signingSecret: string,
  revocationStore: TokenRevocationStore
): Promise<AuthPrincipal | undefined> {
  const header = req.headers.authorization || "";
  const match = /^Bearer\s+(.+)$/i.exec(Array.isArray(header) ? header[0] : header);
  if (!match) return undefined;
  const principal = verifyToken(match[1], signingSecret);
  if (!principal) return undefined;
  if (await revocationStore.isRevoked(principal.jti)) return undefined;
  return principal;
}

async function handleGithubStart(res: ServerResponse, options: JuiceServerOptions, requestId: string): Promise<void> {
  const clientId = options.githubClientId || process.env.GITHUB_CLIENT_ID || process.env.GITHUB_OAUTH_CLIENT_ID;
  if (!clientId) {
    sendJson(res, 501, { requestId, error: "GITHUB_CLIENT_ID is required for GitHub OAuth login" });
    return;
  }
  const response = await fetch("https://github.com/login/device/code", {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json"
    },
    body: JSON.stringify({ client_id: clientId, scope: "read:user" })
  });
  const body = await response.json() as Record<string, unknown>;
  sendJson(res, response.status, { requestId, ...body });
}

async function handleGithubComplete(
  req: IncomingMessage,
  res: ServerResponse,
  options: JuiceServerOptions,
  signingSecret: string,
  requestId: string
): Promise<void> {
  const clientId = options.githubClientId || process.env.GITHUB_CLIENT_ID || process.env.GITHUB_OAUTH_CLIENT_ID;
  if (!clientId) {
    sendJson(res, 501, { requestId, error: "GITHUB_CLIENT_ID is required for GitHub OAuth login" });
    return;
  }
  const body = await readJson<{ device_code?: unknown }>(req);
  if (typeof body.device_code !== "string") {
    sendJson(res, 400, { requestId, error: "device_code is required" });
    return;
  }
  const tokenResponse = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json"
    },
    body: JSON.stringify({
      client_id: clientId,
      device_code: body.device_code,
      grant_type: "urn:ietf:params:oauth:grant-type:device_code"
    })
  });
  const tokenBody = await tokenResponse.json() as { access_token?: string; error?: string };
  if (!tokenBody.access_token) {
    sendJson(res, 202, { requestId, ...tokenBody });
    return;
  }
  const userResponse = await fetch("https://api.github.com/user", {
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${tokenBody.access_token}`,
      "user-agent": "juice"
    }
  });
  const user = await userResponse.json() as { id?: number; login?: string };
  if (!user.id) {
    sendJson(res, 502, { requestId, error: "GitHub user lookup failed" });
    return;
  }
  sendJson(res, 200, {
    requestId,
    token: signToken({ sub: `github:${user.id}`, login: user.login }, signingSecret, { ttlSeconds: USER_TOKEN_TTL_SECONDS }),
    login: user.login,
    expiresIn: USER_TOKEN_TTL_SECONDS
  });
}

async function handleTokenCreate(
  req: IncomingMessage,
  res: ServerResponse,
  requestId: string,
  principal: AuthPrincipal,
  signingSecret: string,
  authorize: (request: AccessRequest) => boolean | Promise<boolean>
): Promise<void> {
  if (principal.scope !== undefined) {
    sendJson(res, 403, { requestId, error: "Machine tokens cannot create tokens" });
    return;
  }

  const body = await readJson<{
    project?: unknown;
    env?: unknown;
    readOnly?: unknown;
    ttlSeconds?: unknown;
  }>(req);
  if (typeof body.project !== "string" || body.project.trim() === "" || typeof body.env !== "string" || body.env.trim() === "") {
    sendJson(res, 400, { requestId, error: "project and env are required" });
    return;
  }
  const userId = githubUserId(principal.sub);
  if (!userId) {
    sendJson(res, 401, { requestId, error: "Unauthorized" });
    return;
  }
  const actions: TokenAction[] = body.readOnly === true ? ["read"] : ["read", "write"];
  const ttlSeconds = normalizeMachineTokenTtl(body.ttlSeconds);
  const probeRef = { userId, project: body.project, env: body.env, key: "__token_scope_probe__" };
  for (const action of actions) {
    if (!await authorizeAccess(authorize, { ...probeRef, action, principal })) {
      sendJson(res, 403, { requestId, error: "Forbidden" });
      return;
    }
  }

  const jti = randomUUID();
  const token = signToken({
    sub: principal.sub,
    login: principal.login,
    scope: { project: body.project, env: body.env, actions }
  }, signingSecret, { ttlSeconds, jti });
  sendJson(res, 201, {
    requestId,
    token,
    jti,
    expiresIn: ttlSeconds,
    scope: { project: body.project, env: body.env, actions }
  });
}

async function handleTokenRevoke(
  req: IncomingMessage,
  res: ServerResponse,
  requestId: string,
  jti: string,
  principal: AuthPrincipal,
  signingSecret: string,
  revocationStore: TokenRevocationStore
): Promise<void> {
  const decoded = decodeURIComponent(jti);
  if (!decoded.trim()) {
    sendJson(res, 400, { requestId, error: "jti is required" });
    return;
  }
  if (decoded === principal.jti) {
    await revocationStore.revoke(decoded, principal.sub);
    sendJson(res, 204, {});
    return;
  }

  const body = await readJson<{ token?: unknown }>(req);
  if (typeof body.token !== "string") {
    sendJson(res, 400, { requestId, error: "token is expired or invalid" });
    return;
  }
  const target = verifyToken(body.token, signingSecret);
  if (!target) {
    sendJson(res, 400, { requestId, error: "token is expired or invalid" });
    return;
  }
  if (target.jti !== decoded) {
    sendJson(res, 400, { requestId, error: "token jti does not match path" });
    return;
  }
  if (target.sub !== principal.sub) {
    sendJson(res, 403, { requestId, error: "Forbidden" });
    return;
  }

  await revocationStore.revoke(target.jti, target.sub);
  sendJson(res, 204, {});
}

function normalizeMachineTokenTtl(value: unknown): number {
  if (value === undefined) return DEFAULT_MACHINE_TOKEN_TTL_SECONDS;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 60 || value > MACHINE_TOKEN_MAX_TTL_SECONDS) {
    throw new HttpError(400, "ttlSeconds must be between 60 seconds and 90 days");
  }
  return value;
}

function tokenSecret(options: JuiceServerOptions): string {
  const secret = options.tokenSecret || process.env.JUICE_TOKEN_SECRET;
  if (!secret || secret.length < MIN_TOKEN_SECRET_LENGTH) {
    throw new Error(`JUICE_TOKEN_SECRET is required and must be at least ${MIN_TOKEN_SECRET_LENGTH} characters`);
  }
  return secret;
}

function ownerOnlyAuthorize(request: AccessRequest): boolean {
  return githubUserId(request.principal.sub) === request.userId;
}

async function authorizeAccess(
  authorize: (request: AccessRequest) => boolean | Promise<boolean>,
  request: AccessRequest
): Promise<boolean> {
  if (!scopeAllows(request.principal, request)) return false;
  return Boolean(await authorize(request));
}

function scopeAllows(principal: AuthPrincipal, request: AccessRequest): boolean {
  if (!principal.scope) return true;
  return principal.scope.project === request.project &&
    principal.scope.env === request.env &&
    principal.scope.actions.includes(request.action);
}

function githubUserId(sub: string): string | undefined {
  return /^github:(\d+)$/.exec(sub)?.[1];
}

async function readJson<T>(req: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > MAX_JSON_BYTES) throw new HttpError(413, "Request body too large");
    chunks.push(buffer);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  if (!text) return {} as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new HttpError(400, "Malformed JSON");
  }
}

function sendJson(res: ServerResponse, status: number, body: Record<string, unknown>): void {
  if (res.headersSent) return;
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  if (status === 204) {
    res.end();
    return;
  }
  res.end(`${JSON.stringify(body)}\n`);
}

type AuditAction = TokenAction | "list" | "delete";

function auditSecretAccess(event: {
  requestId: string;
  principal: string;
  action: AuditAction;
  project: string;
  env: string;
  key?: string;
  outcome: string;
}): void {
  console.log(JSON.stringify({ ts: new Date().toISOString(), ...event }));
}

function clientIp(req: IncomingMessage): string {
  const forwarded = req.headers["x-forwarded-for"];
  const firstForwarded = Array.isArray(forwarded) ? forwarded[0] : forwarded;
  return firstForwarded?.split(",")[0]?.trim() || req.socket.remoteAddress || "unknown";
}

class TokenBucketLimiter {
  readonly buckets = new Map<string, { count: number; resetAt: number }>();

  constructor(readonly limit: number, readonly windowMs: number) {}

  allow(key: string): boolean {
    const now = Date.now();
    const bucket = this.buckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
      this.buckets.set(key, { count: 1, resetAt: now + this.windowMs });
      return true;
    }
    if (bucket.count >= this.limit) return false;
    bucket.count += 1;
    return true;
  }
}

class HttpError extends Error {
  constructor(readonly status: number, readonly publicMessage: string) {
    super(publicMessage);
  }
}
