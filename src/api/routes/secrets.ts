/**
 * Listing a scope, optionally with values.
 *
 * `?values=1` is not a weaker permission: same read action, same
 * authorization, and still one audit record per key, so the log is what N
 * separate GETs would have produced. Only the round trips collapse.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { SecretRef, SecretsBackend } from "../secrets-backend.js";
import type { TokenAction } from "../token.js";
import type { TokenRevocationStore } from "../token-revocation-store.js";
import { authenticate, authorizeAccess, type AccessRequest } from "../authz.js";
import { auditSecretAccess, type AuditAction } from "../audit.js";
import { sendJson, TokenBucketLimiter } from "../http.js";

export async function handleSecretList(
  req: IncomingMessage,
  res: ServerResponse,
  requestId: string,
  refBase: { project: string; env: string },
  backend: SecretsBackend,
  signingSecret: string,
  authorize: (request: AccessRequest) => boolean | Promise<boolean>,
  revocationStore: TokenRevocationStore,
  principalLimiter: TokenBucketLimiter,
  withValues = false
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

  const probe: SecretRef = { accountId: principal.acc, ...refBase, key: "__list__" };
  if (!await authorizeAccess(authorize, { ...probe, action, principal })) {
    auditSecretAccess({ requestId, principal: principal.sub, action: auditAction, ...refBase, outcome: "forbidden" });
    sendJson(res, 403, { requestId, error: "Forbidden" });
    return;
  }

  // Tenant isolation: listKeys must only ever be called with the caller's userId.
  const keys = await backend.listKeys({ accountId: principal.acc, project: refBase.project, env: refBase.env });
  auditSecretAccess({ requestId, principal: principal.sub, action: auditAction, ...refBase, outcome: "ok" });

  if (!withValues) {
    sendJson(res, 200, { requestId, keys });
    return;
  }

  // `?values=1` exists so `export` and `run` stop doing list-then-N-gets. It is
  // not a weaker permission: it needs the same read action, and it still emits
  // one audit record per key, so the log is byte-for-byte what N separate GETs
  // would have produced. Only the round trips collapse.
  const secrets: Record<string, string> = {};
  for (const key of keys) {
    const value = await backend.getSecret({ accountId: principal.acc, ...refBase, key });
    if (value === undefined) continue;
    secrets[key] = value;
    auditSecretAccess({ requestId, principal: principal.sub, action: "read", ...refBase, key, outcome: "ok" });
  }
  sendJson(res, 200, { requestId, keys, secrets });
}

