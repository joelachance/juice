/**
 * Signing in, and who else can read this account's secrets.
 *
 * An invite grants every secret in the account, in every scope, so both ends
 * of the flow say so before they act.
 */
import { getToken, setToken } from "../../auth/token-store.js";
import { readKnownScopes } from "../../config/scope.js";
import { apiBase, requestJson } from "../../http/client.js";
import { envWithOverrides } from "../context.js";
import { confirm } from "../prompt.js";
import type { Args } from "../args.js";

const LOGIN_DEFAULT_EXPIRES_SECONDS = 15 * 60;

export async function login(): Promise<void> {
  const start = await requestJson<{
    device_code: string;
    user_code: string;
    verification_uri: string;
    interval?: number;
    expires_in?: number;
  }>(`${apiBase()}/auth/github/start`, { method: "POST", body: "{}" });

  console.log(`Open ${start.verification_uri} and enter code ${start.user_code}.`);
  const intervalMs = Math.max(start.interval ?? 5, 1) * 1000;
  const expiresIn = typeof start.expires_in === "number" && start.expires_in > 0
    ? start.expires_in
    : LOGIN_DEFAULT_EXPIRES_SECONDS;
  const deadline = Date.now() + expiresIn * 1000;

  while (Date.now() < deadline) {
    await delay(intervalMs);
    const complete = await requestJson<{ token?: string; login?: string; error?: string }>(`${apiBase()}/auth/github/complete`, {
      method: "POST",
      body: JSON.stringify({ device_code: start.device_code })
    });
    if (complete.token) {
      setToken(complete.token);
      console.log(`Logged in${complete.login ? ` as ${complete.login}` : ""}.`);
      return;
    }
    if (complete.error === "expired_token") {
      throw new Error("Device code expired. Run `juice auth login` again.");
    }
    if (complete.error && complete.error !== "authorization_pending" && complete.error !== "slow_down") {
      throw new Error(complete.error);
    }
  }
  throw new Error("Device code expired. Run `juice auth login` again.");
}


export function listScopes(args: Args): number {
  const env = envWithOverrides(args);
  const known = readKnownScopes(env);
  if (known.length === 0) {
    console.error("No scopes used yet on this machine. `juice set KEY --scope <name>` creates one.");
    return 0;
  }
  for (const scope of known) console.log(scope);
  return 0;
}


export async function listMembers(args: Args): Promise<number> {
  const env = envWithOverrides(args);
  const token = getToken(env);
  if (!token) {
    console.error("Run `juice auth login` before listing members.");
    return 1;
  }
  try {
    const result = await requestJson<{
      accountName: string;
      members: Array<{ provider: string; subject: string; login?: string; joinedAt: number }>;
    }>(`${apiBase(env)}/members`, { method: "GET", token });
    console.error(`${result.accountName} — ${result.members.length} member${result.members.length === 1 ? "" : "s"}`);
    for (const member of result.members) {
      console.log(member.login ?? `${member.provider}:${member.subject}`);
    }
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

export async function createInvite(args: Args): Promise<number> {
  const env = envWithOverrides(args);
  const token = getToken(env);
  if (!token) {
    console.error("Run `juice auth login` before creating an invite.");
    return 1;
  }
  try {
    const created = await requestJson<{ code: string; expiresAt: number; accountName: string }>(
      `${apiBase(env)}/invites`,
      { method: "POST", token, body: JSON.stringify({ ttlSeconds: args.ttlSeconds }) }
    );
    // The blast radius, stated plainly: there is no per-scope membership, so
    // this grants everything the account holds, including secrets set earlier.
    console.error(`Invite for ${created.accountName}.`);
    console.error("It grants read/write to EVERY secret in the account, in every scope.");
    console.error(`Single use, expires ${new Date(created.expiresAt).toISOString()}.`);
    console.error("");
    console.log(created.code);
    console.error("");
    console.error("Share it over a channel you trust. It is not shown again.");
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

export async function joinAccount(args: Args): Promise<number> {
  const code = args.positionals[1];
  if (!code) {
    console.error("Usage: juice join <code>");
    return 1;
  }
  const env = envWithOverrides(args);
  const token = getToken(env);
  if (!token) {
    console.error("Run `juice auth login` before joining an account.");
    return 1;
  }
  if (!(await confirm("Join this account? You will be able to read every secret it holds.", args.yes))) {
    console.error("Cancelled.");
    return 1;
  }
  try {
    const result = await requestJson<{ account: { id: string; name: string }; token: string }>(
      `${apiBase(env)}/invites/redeem`,
      { method: "POST", token, body: JSON.stringify({ code }) }
    );
    // The old token still names the previous account; replace it.
    setToken(result.token);
    console.log(`Joined ${result.account.name}.`);
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message === "invite_invalid") {
      console.error("That invite is not valid — it may be expired, already used, or mistyped.");
    } else if (message === "already_member") {
      console.error("You are already a member of that account.");
    } else if (message === "already_in_account") {
      console.error("You already belong to an account that holds secrets.");
      console.error("One account per identity for now, so this invite cannot be redeemed.");
    } else {
      console.error(message);
    }
    return 1;
  }
}


function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

