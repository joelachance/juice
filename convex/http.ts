import { httpRouter } from "convex/server";
import { httpAction } from "./_generated/server";
import { internal } from "./_generated/api";

/**
 * The only door into the membership tables.
 *
 * Everything in `membership.ts` is `internal*`, so it cannot be called by a
 * client holding the deployment URL. This router is the sole caller, and it
 * checks a shared secret first. The Juice API server is the only thing that
 * should ever hold that secret.
 *
 * Set `JUICE_API_SHARED_SECRET` in the Convex deployment's environment
 * variables. If it is unset, every route refuses rather than defaulting open.
 */

const http = httpRouter();

function authorize(request: Request): Response | undefined {
  const expected = process.env.JUICE_API_SHARED_SECRET;
  if (!expected || expected.length < 32) {
    return json(503, { error: "JUICE_API_SHARED_SECRET is not configured" });
  }
  const header = request.headers.get("authorization") ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(header);
  if (!match || !timingSafeEqual(match[1], expected)) {
    return json(401, { error: "unauthorized" });
  }
  return undefined;
}

/** Constant-time compare; `===` on a secret leaks length and prefix by timing. */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let index = 0; index < a.length; index++) {
    diff |= a.charCodeAt(index) ^ b.charCodeAt(index);
  }
  return diff === 0;
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" }
  });
}

function guarded(handler: (ctx: any, body: any) => Promise<Response>) {
  return httpAction(async (ctx, request) => {
    const denied = authorize(request);
    if (denied) return denied;
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return json(400, { error: "invalid_json" });
    }
    return await handler(ctx, body);
  });
}

http.route({
  path: "/identity/resolve",
  method: "POST",
  handler: guarded(async (ctx, body) => {
    const result = await ctx.runMutation(internal.membership.resolveAccount, {
      provider: String(body.provider),
      subject: String(body.subject),
      login: body.login ? String(body.login) : undefined,
      now: Date.now()
    });
    return json(200, result);
  })
});

http.route({
  path: "/invites/create",
  method: "POST",
  handler: guarded(async (ctx, body) => {
    const result = await ctx.runMutation(internal.membership.createInvite, {
      accountId: body.accountId,
      codeHash: String(body.codeHash),
      createdBy: String(body.createdBy),
      expiresAt: Number(body.expiresAt)
    });
    return json(200, result);
  })
});

http.route({
  path: "/invites/redeem",
  method: "POST",
  handler: guarded(async (ctx, body) => {
    const result = await ctx.runMutation(internal.membership.redeemInvite, {
      codeHash: String(body.codeHash),
      provider: String(body.provider),
      subject: String(body.subject),
      login: body.login ? String(body.login) : undefined,
      now: Date.now()
    });
    return json(result.ok ? 200 : 400, result);
  })
});

http.route({
  path: "/accounts/members",
  method: "POST",
  handler: guarded(async (ctx, body) => {
    const result = await ctx.runQuery(internal.membership.members, {
      accountId: body.accountId
    });
    return json(200, result);
  })
});

http.route({
  path: "/accounts/mark-used",
  method: "POST",
  handler: guarded(async (ctx, body) => {
    const result = await ctx.runMutation(internal.membership.markAccountUsed, {
      accountId: body.accountId
    });
    return json(200, result);
  })
});

export default http;
