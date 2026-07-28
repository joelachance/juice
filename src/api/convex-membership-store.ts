import type {
  IdentityRef,
  MemberSummary,
  MembershipStore,
  RedeemResult,
  ResolvedAccount
} from "./membership-store.js";

/**
 * The membership store, over Convex HTTP Actions.
 *
 * Plain `fetch` rather than the `convex` client package, deliberately: the
 * published npm tarball is SDK + CLI only, and adding a runtime dependency here
 * would put it in every consumer's install tree for code they never run. The
 * `convex` package stays a devDependency, used only to author and deploy the
 * functions in `convex/`.
 *
 * The endpoints hit are HTTP Actions on `*.convex.site`, not public Convex
 * queries — see convex/http.ts for why that distinction matters.
 */
export class ConvexMembershipStore implements MembershipStore {
  constructor(
    private readonly baseUrl: string,
    private readonly sharedSecret: string,
    private readonly fetchImpl: typeof fetch = fetch
  ) {
    if (!/^https:\/\//.test(baseUrl) && !/^http:\/\/(localhost|127\.0\.0\.1)/.test(baseUrl)) {
      throw new Error("JUICE_CONVEX_URL must use https unless it points at localhost");
    }
    if (sharedSecret.length < 32) {
      throw new Error("JUICE_CONVEX_SECRET must be at least 32 characters");
    }
  }

  async resolveAccount(identity: IdentityRef): Promise<ResolvedAccount> {
    return await this.post<ResolvedAccount>("/identity/resolve", {
      provider: identity.provider,
      subject: identity.subject,
      login: identity.login
    });
  }

  async createInvite(input: {
    accountId: string;
    codeHash: string;
    createdBy: string;
    expiresAt: number;
  }): Promise<void> {
    await this.post("/invites/create", input);
  }

  async redeemInvite(input: { codeHash: string; identity: IdentityRef }): Promise<RedeemResult> {
    // Redeem answers 400 for a bad code, which is an expected outcome rather
    // than a transport failure, so it is read from the body instead of thrown.
    const response = await this.request("/invites/redeem", {
      codeHash: input.codeHash,
      provider: input.identity.provider,
      subject: input.identity.subject,
      login: input.identity.login
    });
    const body = await response.json() as RedeemResult;
    if (response.status >= 500) throw new Error(`membership store error (${response.status})`);
    return body;
  }

  async members(accountId: string): Promise<{ accountName: string; members: MemberSummary[] }> {
    return await this.post("/accounts/members", { accountId });
  }

  async markAccountUsed(accountId: string): Promise<void> {
    await this.post("/accounts/mark-used", { accountId });
  }

  private async request(path: string, body: unknown): Promise<Response> {
    return await this.fetchImpl(`${this.baseUrl.replace(/\/+$/, "")}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.sharedSecret}`
      },
      body: JSON.stringify(body)
    });
  }

  private async post<T>(path: string, body: unknown): Promise<T> {
    const response = await this.request(path, body);
    if (!response.ok) {
      // Never echo the response body: it is not secret, but it is attacker-
      // influenced and ends up in operator logs.
      throw new Error(`membership store request failed (${response.status})`);
    }
    return await response.json() as T;
  }
}

export function membershipStoreFromEnv(env: NodeJS.ProcessEnv = process.env): ConvexMembershipStore | undefined {
  const url = env.JUICE_CONVEX_URL?.trim();
  const secret = env.JUICE_CONVEX_SECRET?.trim();
  if (!url || !secret) return undefined;
  return new ConvexMembershipStore(url, secret);
}
