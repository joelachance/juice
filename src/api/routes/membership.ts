/**
 * Invites and members.
 *
 * The code is generated here, returned once, and only its SHA-256 leaves the
 * process. It arrives in a request body rather than a URL so it stays out of
 * access logs, and it is absent from the audit line it produces.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { signToken, USER_TOKEN_TTL_SECONDS, type AuthPrincipal } from "../token.js";
import { generateInviteCode, hashInviteCode, inviteExpiry } from "../invite.js";
import type { IdentityRef, MembershipStore } from "../membership-store.js";
import { githubUserId } from "../authz.js";
import { readJson, sendJson } from "../http.js";

export async function handleInviteCreate(
  req: IncomingMessage,
  res: ServerResponse,
  requestId: string,
  principal: AuthPrincipal,
  membership: MembershipStore
): Promise<void> {
  const body = await readJson<{ ttlSeconds?: unknown }>(req);
  const ttlSeconds = typeof body.ttlSeconds === "number" ? body.ttlSeconds : undefined;

  // Generated here and hashed before it leaves: the membership store only ever
  // sees the digest, and the plaintext is returned to the caller exactly once.
  const code = generateInviteCode();
  const expiresAt = inviteExpiry(ttlSeconds);
  await membership.createInvite({
    accountId: principal.acc,
    codeHash: hashInviteCode(code),
    createdBy: principal.sub,
    expiresAt
  });

  const account = await membership.members(principal.acc);
  console.log(JSON.stringify({
    ts: new Date().toISOString(),
    requestId,
    principal: principal.sub,
    action: "invite_create",
    account: principal.acc,
    expiresAt
    // The code itself is deliberately absent from this line.
  }));
  sendJson(res, 201, { requestId, code, expiresAt, accountName: account.accountName });
}

export async function handleInviteRedeem(
  req: IncomingMessage,
  res: ServerResponse,
  requestId: string,
  principal: AuthPrincipal,
  signingSecret: string,
  membership: MembershipStore
): Promise<void> {
  // The code arrives in the body, never the path: URLs reach access logs,
  // proxies, and browser history.
  const body = await readJson<{ code?: unknown }>(req);
  if (typeof body.code !== "string" || body.code.trim() === "") {
    sendJson(res, 400, { requestId, error: "code is required" });
    return;
  }
  const identity = githubIdentity(principal.sub, principal.login);
  if (!identity) {
    sendJson(res, 401, { requestId, error: "Unauthorized" });
    return;
  }

  const result = await membership.redeemInvite({ codeHash: hashInviteCode(body.code), identity });
  console.log(JSON.stringify({
    ts: new Date().toISOString(),
    requestId,
    principal: principal.sub,
    action: "invite_redeem",
    outcome: result.ok ? "ok" : result.error
  }));

  if (!result.ok) {
    const status = result.error === "invite_invalid" ? 400 : 409;
    sendJson(res, status, { requestId, error: result.error, accountName: result.accountName });
    return;
  }

  // The caller's existing token still names the old account, so issue a fresh
  // one rather than leaving them authenticated to somewhere they just left.
  sendJson(res, 200, {
    requestId,
    account: { id: result.accountId, name: result.accountName },
    token: signToken(
      { sub: principal.sub, acc: result.accountId, login: principal.login },
      signingSecret,
      { ttlSeconds: USER_TOKEN_TTL_SECONDS }
    ),
    expiresIn: USER_TOKEN_TTL_SECONDS
  });
}

function githubIdentity(sub: string, login?: string): IdentityRef | undefined {
  const subject = githubUserId(sub);
  return subject ? { provider: "github", subject, login } : undefined;
}

