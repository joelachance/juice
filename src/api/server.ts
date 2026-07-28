import { createServer, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import { AwsSecretsManagerBackend } from "./aws-secrets-backend.js";
import { membershipStoreFromEnv } from "./convex-membership-store.js";
import type { MembershipStore } from "./membership-store.js";
import type { SecretRef, SecretsBackend } from "./secrets-backend.js";
import { AwsSecretsManagerTokenRevocationStore, type TokenRevocationStore } from "./token-revocation-store.js";
import type { TokenAction } from "./token.js";
import { versionInfo } from "./version.js";
import { authenticate, authorizeAccess, ownerOnlyAuthorize } from "./authz.js";
import type { AccessRequest } from "./authz.js";
import { auditSecretAccess, type AuditAction } from "./audit.js";
import { clientIp, HttpError, readJson, sendJson, TokenBucketLimiter } from "./http.js";
import { handleGithubComplete, handleGithubStart } from "./routes/auth.js";
import { handleInviteCreate, handleInviteRedeem } from "./routes/membership.js";
import { handleSecretList } from "./routes/secrets.js";
import { handleTokenCreate, handleTokenRevoke } from "./routes/tokens.js";

export type { AccessRequest };

const MIN_TOKEN_SECRET_LENGTH = 32;



export type JuiceServerOptions = {
  backend?: SecretsBackend;
  tokenSecret?: string;
  githubClientId?: string;
  authorize?: (request: AccessRequest) => boolean | Promise<boolean>;
  revocationStore?: TokenRevocationStore;
  membershipStore?: MembershipStore;
};

export function createJuiceServer(options: JuiceServerOptions = {}): Server {
  const backend = options.backend ?? new AwsSecretsManagerBackend();
  const signingSecret = tokenSecret(options);
  const authorize = options.authorize ?? ownerOnlyAuthorize;
  const revocationStore = options.revocationStore ?? new AwsSecretsManagerTokenRevocationStore();
  // Without a configured membership store there is no way to resolve an
  // account, so login must fail loudly rather than invent one.
  const membership = options.membershipStore ?? membershipStoreFromEnv();
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
          await handleGithubComplete(req, res, options, signingSecret, requestId, membership);
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

      if (url.pathname === "/invites" || url.pathname === "/invites/redeem" || url.pathname === "/members") {
        const principal = await authenticate(req, signingSecret, revocationStore);
        if (!principal) {
          sendJson(res, 401, { requestId, error: "Unauthorized" });
          return;
        }
        if (!principalLimiter.allow(principal.sub)) {
          sendJson(res, 429, { requestId, error: "Too many requests" });
          return;
        }
        if (!membership) {
          sendJson(res, 501, { requestId, error: "Membership store is not configured" });
          return;
        }
        // A machine token is a deployment credential, not a person. Letting one
        // mint invites would turn a CI secret into a way to add members.
        if (principal.scope !== undefined) {
          sendJson(res, 403, { requestId, error: "Machine tokens cannot manage membership" });
          return;
        }
        if (req.method === "POST" && url.pathname === "/invites") {
          await handleInviteCreate(req, res, requestId, principal, membership);
          return;
        }
        if (req.method === "POST" && url.pathname === "/invites/redeem") {
          await handleInviteRedeem(req, res, requestId, principal, signingSecret, membership);
          return;
        }
        if (req.method === "GET" && url.pathname === "/members") {
          const listed = await membership.members(principal.acc);
          sendJson(res, 200, { requestId, ...listed });
          return;
        }
        sendJson(res, 404, { requestId, error: "Not found" });
        return;
      }

      const listMatch = /^\/projects\/([^/]+)\/envs\/([^/]+)\/secrets$/.exec(url.pathname);
      const secretMatch = /^\/projects\/([^/]+)\/envs\/([^/]+)\/secrets\/([^/]+)$/.exec(url.pathname);

      if (listMatch && req.method === "GET") {
        await handleSecretList(req, res, requestId, {
          project: decodeURIComponent(listMatch[1]),
          env: decodeURIComponent(listMatch[2])
        }, backend, signingSecret, authorize, revocationStore, principalLimiter, url.searchParams.get("values") === "1");
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

      // The account is read off the verified token and never from the request,
      // so a caller cannot address someone else's namespace by construction.
      const ref: SecretRef = { accountId: principal.acc, ...refBase };
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
      // Records that this account now owns data. Redeeming an invite may
      // discard an untouched personal account, and must never discard this one.
      if (membership) await membership.markAccountUsed(principal.acc).catch(() => undefined);
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

function tokenSecret(options: JuiceServerOptions): string {
  const secret = options.tokenSecret || process.env.JUICE_TOKEN_SECRET;
  if (!secret || secret.length < MIN_TOKEN_SECRET_LENGTH) {
    throw new Error(`JUICE_TOKEN_SECRET is required and must be at least ${MIN_TOKEN_SECRET_LENGTH} characters`);
  }
  return secret;
}

