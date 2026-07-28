/**
 * Who is calling, and may they.
 *
 * Authorization takes the account from the verified token rather than the
 * request, so a caller cannot address another account by construction — there
 * is no identifier to compare and therefore none to get wrong.
 */
import type { IncomingMessage } from "node:http";
import { verifyToken, type AuthPrincipal, type TokenAction } from "./token.js";
import type { TokenRevocationStore } from "./token-revocation-store.js";
import type { SecretRef } from "./secrets-backend.js";

export type AccessRequest = SecretRef & {
  action: TokenAction;
  principal: AuthPrincipal;
};

export async function authenticate(
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

export function ownerOnlyAuthorize(request: AccessRequest): boolean {
  // A token can only ever name its own account, so there is nothing to compare.
  return request.principal.acc === request.accountId;
}

export async function authorizeAccess(
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

export function githubUserId(sub: string): string | undefined {
  return /^github:(\d+)$/.exec(sub)?.[1];
}

