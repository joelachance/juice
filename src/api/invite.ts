import { createHash, randomBytes } from "node:crypto";

/**
 * Invite codes.
 *
 * The code is generated here, handed to the caller once, and never stored. Only
 * its sha256 reaches the membership store — the same discipline the token
 * revocation list uses, and for the same reason: a dump of that table should
 * yield nothing an attacker can present.
 *
 * A code grants access to every secret in the account, so it is treated like a
 * credential end to end: high entropy, single use, short-lived, and it travels
 * in a request body rather than a URL path so it stays out of access logs.
 */

export const INVITE_PREFIX = "jc_inv_";
export const DEFAULT_INVITE_TTL_SECONDS = 24 * 60 * 60;
export const MAX_INVITE_TTL_SECONDS = 7 * 24 * 60 * 60;

export function generateInviteCode(): string {
  // 32 bytes, matching the entropy of the machine tokens already minted.
  return `${INVITE_PREFIX}${randomBytes(32).toString("base64url")}`;
}

export function hashInviteCode(code: string): string {
  return createHash("sha256").update(code.trim()).digest("hex");
}

export function inviteExpiry(ttlSeconds: number | undefined, now = Date.now()): number {
  const requested = ttlSeconds ?? DEFAULT_INVITE_TTL_SECONDS;
  if (!Number.isFinite(requested) || requested <= 0) {
    throw new Error("Invite ttl must be a positive number of seconds.");
  }
  return now + Math.min(requested, MAX_INVITE_TTL_SECONDS) * 1000;
}
