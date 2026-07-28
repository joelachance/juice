/**
 * Minting and revoking machine tokens.
 *
 * A machine token inherits the account of the user that minted it and is
 * capped to one scope, one env, and one action set.
 */
import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { signToken, verifyToken, MACHINE_TOKEN_MAX_TTL_SECONDS, type AuthPrincipal, type TokenAction } from "../token.js";
import type { TokenRevocationStore } from "../token-revocation-store.js";
import { authorizeAccess, type AccessRequest } from "../authz.js";
import { HttpError, readJson, sendJson } from "../http.js";

const DEFAULT_MACHINE_TOKEN_TTL_SECONDS = 90 * 24 * 60 * 60;

export async function handleTokenCreate(
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
  const actions: TokenAction[] = body.readOnly === true ? ["read"] : ["read", "write"];
  const ttlSeconds = normalizeMachineTokenTtl(body.ttlSeconds);
  const probeRef = { accountId: principal.acc, project: body.project, env: body.env, key: "__token_scope_probe__" };
  for (const action of actions) {
    if (!await authorizeAccess(authorize, { ...probeRef, action, principal })) {
      sendJson(res, 403, { requestId, error: "Forbidden" });
      return;
    }
  }

  const jti = randomUUID();
  const token = signToken({
    sub: principal.sub,
    acc: principal.acc,
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

export async function handleTokenRevoke(
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

