/**
 * The audit log.
 *
 * Keys, never values. Every outcome is recorded — including the refusals —
 * because a log that only shows successes cannot answer "who tried".
 */
import type { TokenAction } from "./token.js";

export type AuditAction = TokenAction | "list" | "delete";

export function auditSecretAccess(event: {
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

