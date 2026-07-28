import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

/**
 * Accounts, identities, and invites.
 *
 * An **account** owns secrets. An **identity** is a way to log in (today only
 * GitHub). Keeping them separate is the whole point: secrets are stored under
 * `/juice/accounts/<accountId>/…`, so adding a second login provider, or a
 * machine principal, or a second person, never renames a stored secret.
 *
 * Exactly one account per identity for now. `identities.accountId` is therefore
 * a single field rather than a join table — when that becomes a list, this is
 * the file that changes and nothing in the secret path moves.
 */
export default defineSchema({
  accounts: defineTable({
    name: v.string(),
    /**
     * True while this is the account auto-created at first login. Redeeming an
     * invite may discard a personal account, but only an untouched one — see
     * `hasSecrets`.
     */
    personal: v.boolean(),
    /**
     * Set by the API the first time a secret is written. Redeem refuses to
     * discard an account that has secrets, because the secrets themselves live
     * in Secrets Manager and would silently become unreachable.
     */
    hasSecrets: v.boolean(),
    createdAt: v.number()
  }),

  identities: defineTable({
    provider: v.string(),      // "github"
    subject: v.string(),       // provider's stable id — GitHub's numeric user id
    login: v.optional(v.string()),
    accountId: v.id("accounts"),
    createdAt: v.number()
  })
    .index("by_provider_subject", ["provider", "subject"])
    .index("by_account", ["accountId"]),

  invites: defineTable({
    /**
     * sha256 of the invite code. The plaintext code never reaches Convex — the
     * API generates it, hashes it, and returns the plaintext to the caller
     * once. A dump of this table yields nothing usable.
     */
    codeHash: v.string(),
    accountId: v.id("accounts"),
    createdBy: v.string(),     // "github:123", for the audit trail
    expiresAt: v.number(),
    redeemedAt: v.optional(v.number()),
    redeemedBy: v.optional(v.string())
  })
    .index("by_code_hash", ["codeHash"])
    .index("by_account", ["accountId"])
});
