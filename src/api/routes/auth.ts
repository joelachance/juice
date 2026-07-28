/**
 * GitHub device flow.
 *
 * The GitHub token is used once, immediately, to read the numeric user id
 * that keys the account, and then discarded — Juice mints its own.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { signToken, USER_TOKEN_TTL_SECONDS } from "../token.js";
import { readJson, sendJson } from "../http.js";
import type { MembershipStore } from "../membership-store.js";
import type { JuiceServerOptions } from "../server.js";

export async function handleGithubStart(res: ServerResponse, options: JuiceServerOptions, requestId: string): Promise<void> {
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

export async function handleGithubComplete(
  req: IncomingMessage,
  res: ServerResponse,
  options: JuiceServerOptions,
  signingSecret: string,
  requestId: string,
  membership: MembershipStore | undefined
): Promise<void> {
  const clientId = options.githubClientId || process.env.GITHUB_CLIENT_ID || process.env.GITHUB_OAUTH_CLIENT_ID;
  if (!clientId) {
    sendJson(res, 501, { requestId, error: "GITHUB_CLIENT_ID is required for GitHub OAuth login" });
    return;
  }
  if (!membership) {
    sendJson(res, 501, { requestId, error: "Login needs JUICE_CONVEX_URL (the .convex.site URL) and JUICE_CONVEX_SECRET (same value as JUICE_API_SHARED_SECRET in Convex)" });
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
  // Resolve (or create, on first login) the account this identity acts as. The
  // account, not the GitHub id, is what secrets are stored under — which is why
  // adding a second login provider later renames nothing.
  const account = await membership.resolveAccount({
    provider: "github",
    subject: String(user.id),
    login: user.login
  });
  sendJson(res, 200, {
    requestId,
    token: signToken(
      { sub: `github:${user.id}`, acc: account.accountId, login: user.login },
      signingSecret,
      { ttlSeconds: USER_TOKEN_TTL_SECONDS }
    ),
    login: user.login,
    account: { id: account.accountId, name: account.accountName, created: account.created },
    expiresIn: USER_TOKEN_TTL_SECONDS
  });
}

