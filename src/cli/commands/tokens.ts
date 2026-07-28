/**
 * Machine tokens: scoped to one scope and env, and revocable.
 */
import { getToken } from "../../auth/token-store.js";
import { apiBase, requestJson } from "../../http/client.js";
import { requireToken, resolveContext } from "../context.js";
import type { Args } from "../args.js";


export async function createMachineToken(args: Args): Promise<void> {
  const ctx = await resolveContext(args);
  const token = requireToken(ctx, "creating machine tokens for");
  const created = await requestJson<{
    token: string;
    jti: string;
    expiresIn: number;
    scope: { project: string; env: string; actions: string[] };
  }>(`${apiBase(ctx.env)}/tokens`, {
    method: "POST",
    token,
    body: JSON.stringify({
      project: ctx.scope,
      env: ctx.envName,
      readOnly: args.readOnly,
      ttlSeconds: args.ttlSeconds
    })
  });

  console.log(created.token);
  console.error(`Created token ${created.jti} for ${created.scope.project}/${created.scope.env} (${created.scope.actions.join(",")}, ${created.expiresIn}s).`);
}

export async function revokeToken(target: string | undefined): Promise<void> {
  const token = getToken();
  if (!token) throw new Error("Run `juice auth login` or set JUICE_TOKEN before revoking tokens.");
  const currentJti = decodeTokenJti(token);
  if (!currentJti) throw new Error("Stored token is invalid; run `juice auth login` again.");
  const targetJti = target ? decodeTokenJti(target) ?? (target === currentJti ? target : undefined) : currentJti;
  if (!targetJti) throw new Error("Pass the full target token, or omit the argument to revoke your current token.");

  await requestJson(`${apiBase()}/tokens/${encodeURIComponent(targetJti)}`, {
    method: "DELETE",
    token,
    body: target && targetJti !== currentJti ? JSON.stringify({ token: target }) : undefined
  });
  console.log(`Revoked token ${targetJti}.`);
}


function decodeTokenJti(token: string): string | undefined {
  const [, encodedPayload] = token.split(".");
  if (!encodedPayload) return undefined;
  try {
    const payload = JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8")) as { jti?: unknown };
    return typeof payload.jti === "string" && payload.jti.trim() ? payload.jti : undefined;
  } catch {
    return undefined;
  }
}

