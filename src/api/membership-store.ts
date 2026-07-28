/**
 * Who owns which secrets.
 *
 * Secrets themselves stay in Secrets Manager; only the *mapping* — identity to
 * account, and the invites that create it — lives here. Splitting them that way
 * means the membership store never holds a secret value, so its blast radius is
 * "who can read what", not "what".
 *
 * Two implementations: Convex over HTTP for real deployments, and an in-memory
 * one so the API's tests never need a network.
 */

export type IdentityRef = {
  provider: "github";
  /** The provider's stable id. For GitHub that is the numeric user id, not the login. */
  subject: string;
  login?: string;
};

export type ResolvedAccount = {
  accountId: string;
  accountName: string;
  created: boolean;
};

export type MemberSummary = {
  provider: string;
  subject: string;
  login?: string;
  joinedAt: number;
};

export type RedeemResult =
  | { ok: true; accountId: string; accountName: string }
  | { ok: false; error: "invite_invalid" | "already_member" | "already_in_account"; accountName?: string };

export interface MembershipStore {
  /** The account for a login, creating a personal one on first sight. */
  resolveAccount(identity: IdentityRef): Promise<ResolvedAccount>;
  /** Store only the hash — the plaintext code never leaves the API server. */
  createInvite(input: { accountId: string; codeHash: string; createdBy: string; expiresAt: number }): Promise<void>;
  redeemInvite(input: { codeHash: string; identity: IdentityRef }): Promise<RedeemResult>;
  members(accountId: string): Promise<{ accountName: string; members: MemberSummary[] }>;
  /** Called on first write; stops redeem from discarding an account with data. */
  markAccountUsed(accountId: string): Promise<void>;
}

type MemoryAccount = { id: string; name: string; personal: boolean; hasSecrets: boolean };
type MemoryIdentity = { provider: string; subject: string; login?: string; accountId: string; joinedAt: number };
type MemoryInvite = { codeHash: string; accountId: string; createdBy: string; expiresAt: number; redeemedAt?: number };

/** Mirrors the Convex transaction semantics closely enough to test against. */
export class MemoryMembershipStore implements MembershipStore {
  private accounts = new Map<string, MemoryAccount>();
  private identities: MemoryIdentity[] = [];
  private invites: MemoryInvite[] = [];
  private nextId = 1;

  constructor(private readonly now: () => number = () => Date.now()) {}

  async resolveAccount(identity: IdentityRef): Promise<ResolvedAccount> {
    const existing = this.find(identity);
    if (existing) {
      if (identity.login) existing.login = identity.login;
      const account = this.accounts.get(existing.accountId);
      return { accountId: existing.accountId, accountName: account?.name ?? "account", created: false };
    }
    const id = `acc_${this.nextId++}`;
    const name = `${identity.login ?? identity.subject}'s account`;
    this.accounts.set(id, { id, name, personal: true, hasSecrets: false });
    this.identities.push({ ...identity, accountId: id, joinedAt: this.now() });
    return { accountId: id, accountName: name, created: true };
  }

  async createInvite(input: { accountId: string; codeHash: string; createdBy: string; expiresAt: number }): Promise<void> {
    this.invites.push({ ...input });
  }

  async redeemInvite(input: { codeHash: string; identity: IdentityRef }): Promise<RedeemResult> {
    const invite = this.invites.find((entry) => entry.codeHash === input.codeHash);
    const now = this.now();
    if (!invite || invite.redeemedAt !== undefined || invite.expiresAt <= now) {
      return { ok: false, error: "invite_invalid" };
    }
    const account = this.accounts.get(invite.accountId);
    if (!account) return { ok: false, error: "invite_invalid" };

    const identity = this.find(input.identity);
    if (identity) {
      if (identity.accountId === invite.accountId) return { ok: false, error: "already_member" };
      const current = this.accounts.get(identity.accountId);
      if (current && (!current.personal || current.hasSecrets)) {
        return { ok: false, error: "already_in_account", accountName: current.name };
      }
      identity.accountId = invite.accountId;
      if (current && !this.identities.some((entry) => entry.accountId === current.id)) {
        this.accounts.delete(current.id);
      }
    } else {
      this.identities.push({ ...input.identity, accountId: invite.accountId, joinedAt: now });
    }

    invite.redeemedAt = now;
    account.personal = false;
    return { ok: true, accountId: account.id, accountName: account.name };
  }

  async members(accountId: string): Promise<{ accountName: string; members: MemberSummary[] }> {
    return {
      accountName: this.accounts.get(accountId)?.name ?? "account",
      members: this.identities
        .filter((entry) => entry.accountId === accountId)
        .map((entry) => ({
          provider: entry.provider,
          subject: entry.subject,
          login: entry.login,
          joinedAt: entry.joinedAt
        }))
        .sort((a, b) => a.joinedAt - b.joinedAt)
    };
  }

  async markAccountUsed(accountId: string): Promise<void> {
    const account = this.accounts.get(accountId);
    if (account) account.hasSecrets = true;
  }

  private find(identity: IdentityRef): MemoryIdentity | undefined {
    return this.identities.find(
      (entry) => entry.provider === identity.provider && entry.subject === identity.subject
    );
  }
}
