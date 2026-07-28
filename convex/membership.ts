import { v } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";

/**
 * Every function here is `internal*` on purpose.
 *
 * A Convex `query`/`mutation` export is callable by anyone who knows the
 * deployment URL. For a table that decides who can read an organisation's
 * secrets, that is not an acceptable default. These are reachable only from
 * `http.ts`, which checks a shared secret first.
 */

const PERSONAL_ACCOUNT_SUFFIX = "'s account";

/** Resolve the account for a login, creating a personal one on first sight. */
export const resolveAccount = internalMutation({
  args: {
    provider: v.string(),
    subject: v.string(),
    login: v.optional(v.string()),
    now: v.number()
  },
  handler: async (ctx, args) => {
    const existing = await byProviderSubject(ctx, args.provider, args.subject);
    if (existing) {
      // Keep the display login fresh; people rename themselves.
      if (args.login && args.login !== existing.login) {
        await ctx.db.patch(existing._id, { login: args.login });
      }
      const account = await ctx.db.get(existing.accountId);
      return { accountId: existing.accountId, accountName: account?.name ?? "account", created: false };
    }

    const name = `${args.login ?? args.subject}${PERSONAL_ACCOUNT_SUFFIX}`;
    const accountId = await ctx.db.insert("accounts", {
      name,
      personal: true,
      hasSecrets: false,
      createdAt: args.now
    });
    await ctx.db.insert("identities", {
      provider: args.provider,
      subject: args.subject,
      login: args.login,
      accountId,
      createdAt: args.now
    });
    return { accountId, accountName: name, created: true };
  }
});

export const createInvite = internalMutation({
  args: {
    accountId: v.id("accounts"),
    codeHash: v.string(),
    createdBy: v.string(),
    expiresAt: v.number()
  },
  handler: async (ctx, args) => {
    await ctx.db.insert("invites", {
      codeHash: args.codeHash,
      accountId: args.accountId,
      createdBy: args.createdBy,
      expiresAt: args.expiresAt
    });
    return { ok: true as const };
  }
});

/**
 * Redeem, as one transaction.
 *
 * This is the reason membership lives in Convex rather than a JSON blob in
 * Secrets Manager: read-modify-write on a blob has no compare-and-swap, so two
 * simultaneous redeems could lose one. Here the lookup, the single-use check,
 * and the relink are one atomic mutation.
 */
export const redeemInvite = internalMutation({
  args: {
    codeHash: v.string(),
    provider: v.string(),
    subject: v.string(),
    login: v.optional(v.string()),
    now: v.number()
  },
  handler: async (ctx, args) => {
    const invite = await ctx.db
      .query("invites")
      .withIndex("by_code_hash", (q) => q.eq("codeHash", args.codeHash))
      .unique();

    // One message for missing / spent / expired: distinguishing them tells an
    // attacker which guesses were once real codes.
    if (!invite || invite.redeemedAt !== undefined || invite.expiresAt <= args.now) {
      return { ok: false as const, error: "invite_invalid" };
    }

    const account = await ctx.db.get(invite.accountId);
    if (!account) return { ok: false as const, error: "invite_invalid" };

    const identity = await byProviderSubject(ctx, args.provider, args.subject);

    if (identity) {
      if (identity.accountId === invite.accountId) {
        return { ok: false as const, error: "already_member" };
      }
      const current = await ctx.db.get(identity.accountId);
      // One account per identity today. Moving is only safe when the account
      // being left is an untouched personal one — otherwise its secrets, which
      // live in Secrets Manager and not here, would silently become unreachable.
      if (current && (!current.personal || current.hasSecrets)) {
        return { ok: false as const, error: "already_in_account", accountName: current.name };
      }
      await ctx.db.patch(identity._id, { accountId: invite.accountId, login: args.login });
      if (current && (await isLastMember(ctx, current._id))) {
        await ctx.db.delete(current._id);
      }
    } else {
      await ctx.db.insert("identities", {
        provider: args.provider,
        subject: args.subject,
        login: args.login,
        accountId: invite.accountId,
        createdAt: args.now
      });
    }

    await ctx.db.patch(invite._id, {
      redeemedAt: args.now,
      redeemedBy: `${args.provider}:${args.subject}`
    });
    if (account.personal) await ctx.db.patch(account._id, { personal: false });

    return { ok: true as const, accountId: invite.accountId, accountName: account.name };
  }
});

export const members = internalQuery({
  args: { accountId: v.id("accounts") },
  handler: async (ctx, args) => {
    const account = await ctx.db.get(args.accountId);
    const identities = await ctx.db
      .query("identities")
      .withIndex("by_account", (q) => q.eq("accountId", args.accountId))
      .collect();
    return {
      accountName: account?.name ?? "account",
      members: identities
        .map((identity) => ({
          provider: identity.provider,
          subject: identity.subject,
          login: identity.login,
          joinedAt: identity.createdAt
        }))
        .sort((a, b) => a.joinedAt - b.joinedAt)
    };
  }
});

/** Flips `hasSecrets`, which is what stops redeem from discarding real data. */
export const markAccountUsed = internalMutation({
  args: { accountId: v.id("accounts") },
  handler: async (ctx, args) => {
    const account = await ctx.db.get(args.accountId);
    if (account && !account.hasSecrets) {
      await ctx.db.patch(args.accountId, { hasSecrets: true });
    }
    return { ok: true as const };
  }
});

async function byProviderSubject(
  ctx: { db: { query: (table: "identities") => never } } | any,
  provider: string,
  subject: string
): Promise<Doc<"identities"> | null> {
  return await ctx.db
    .query("identities")
    .withIndex("by_provider_subject", (q: any) => q.eq("provider", provider).eq("subject", subject))
    .unique();
}

async function isLastMember(ctx: any, accountId: Id<"accounts">): Promise<boolean> {
  const remaining = await ctx.db
    .query("identities")
    .withIndex("by_account", (q: any) => q.eq("accountId", accountId))
    .collect();
  return remaining.length === 0;
}
