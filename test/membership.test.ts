import assert from "node:assert/strict";
import test from "node:test";
import { createJuiceServer } from "../src/api/server.js";
import { signToken, verifyToken } from "../src/api/token.js";
import { MemoryTokenRevocationStore } from "../src/api/token-revocation-store.js";
import { MemoryMembershipStore } from "../src/api/membership-store.js";
import { generateInviteCode, hashInviteCode, inviteExpiry, MAX_INVITE_TTL_SECONDS } from "../src/api/invite.js";
import type { SecretRef, SecretsBackend } from "../src/api/secrets-backend.js";

const TEST_SECRET = "0123456789abcdef0123456789abcdef";

// ── invite codes ─────────────────────────────────────────────────────────────

test("invite codes are high-entropy, prefixed, and only ever stored hashed", () => {
  const a = generateInviteCode();
  const b = generateInviteCode();

  assert.notEqual(a, b);
  assert.match(a, /^jc_inv_[A-Za-z0-9_-]{43}$/);
  // The digest must not contain the code, or storing it would be pointless.
  const hash = hashInviteCode(a);
  assert.match(hash, /^[0-9a-f]{64}$/);
  assert.equal(hash.includes(a.slice(7)), false);
  assert.equal(hashInviteCode(a), hash);
  assert.notEqual(hashInviteCode(b), hash);
});

test("invite ttl is clamped so a long-lived code cannot be minted", () => {
  const now = 1_000_000;
  assert.equal(inviteExpiry(60, now), now + 60_000);
  assert.equal(inviteExpiry(undefined, now), now + 24 * 60 * 60 * 1000);
  assert.equal(inviteExpiry(365 * 24 * 60 * 60, now), now + MAX_INVITE_TTL_SECONDS * 1000);
  assert.throws(() => inviteExpiry(0, now), /positive/);
  assert.throws(() => inviteExpiry(-5, now), /positive/);
});

// ── the store's transactional rules ──────────────────────────────────────────

test("first login creates a personal account; the second reuses it", async () => {
  const store = new MemoryMembershipStore();
  const identity = { provider: "github" as const, subject: "1", login: "octo" };

  const first = await store.resolveAccount(identity);
  const second = await store.resolveAccount(identity);

  assert.equal(first.created, true);
  assert.equal(second.created, false);
  assert.equal(second.accountId, first.accountId);
  assert.match(first.accountName, /octo/);
});

test("an invite is single use", async () => {
  const store = new MemoryMembershipStore();
  const owner = await store.resolveAccount({ provider: "github", subject: "1", login: "owner" });
  const code = generateInviteCode();
  await store.createInvite({
    accountId: owner.accountId,
    codeHash: hashInviteCode(code),
    createdBy: "github:1",
    expiresAt: Date.now() + 60_000
  });

  const first = await store.redeemInvite({
    codeHash: hashInviteCode(code),
    identity: { provider: "github", subject: "2", login: "invitee" }
  });
  const second = await store.redeemInvite({
    codeHash: hashInviteCode(code),
    identity: { provider: "github", subject: "3", login: "other" }
  });

  assert.equal(first.ok, true);
  assert.equal(second.ok, false);
  assert.equal(second.ok === false && second.error, "invite_invalid");
});

test("an expired invite is refused, and indistinguishably from a bad one", async () => {
  let now = 1_000_000;
  const store = new MemoryMembershipStore(() => now);
  const owner = await store.resolveAccount({ provider: "github", subject: "1" });
  const code = generateInviteCode();
  await store.createInvite({
    accountId: owner.accountId,
    codeHash: hashInviteCode(code),
    createdBy: "github:1",
    expiresAt: now + 1000
  });

  now += 2000;
  const expired = await store.redeemInvite({
    codeHash: hashInviteCode(code),
    identity: { provider: "github", subject: "2" }
  });
  const nonsense = await store.redeemInvite({
    codeHash: hashInviteCode(generateInviteCode()),
    identity: { provider: "github", subject: "2" }
  });

  // Same error for both: telling them apart reveals which guesses were real.
  assert.deepEqual(expired, { ok: false, error: "invite_invalid" });
  assert.deepEqual(nonsense, { ok: false, error: "invite_invalid" });
});

test("redeeming moves an untouched personal account but never one with secrets", async () => {
  const store = new MemoryMembershipStore();
  const team = await store.resolveAccount({ provider: "github", subject: "1", login: "owner" });
  const invitee = { provider: "github" as const, subject: "2", login: "invitee" };

  // Fresh invitee: their empty personal account is discarded and they move.
  await store.resolveAccount(invitee);
  const code = generateInviteCode();
  await store.createInvite({
    accountId: team.accountId,
    codeHash: hashInviteCode(code),
    createdBy: "github:1",
    expiresAt: Date.now() + 60_000
  });
  const moved = await store.redeemInvite({ codeHash: hashInviteCode(code), identity: invitee });
  assert.equal(moved.ok, true);
  assert.equal(moved.ok === true && moved.accountId, team.accountId);

  // Someone whose own account holds secrets must not be silently cut off from
  // them — those secrets live in Secrets Manager and are not moved.
  const withData = { provider: "github" as const, subject: "3", login: "hasdata" };
  const own = await store.resolveAccount(withData);
  await store.markAccountUsed(own.accountId);
  const second = generateInviteCode();
  await store.createInvite({
    accountId: team.accountId,
    codeHash: hashInviteCode(second),
    createdBy: "github:1",
    expiresAt: Date.now() + 60_000
  });
  const refused = await store.redeemInvite({ codeHash: hashInviteCode(second), identity: withData });
  assert.equal(refused.ok, false);
  assert.equal(refused.ok === false && refused.error, "already_in_account");
});

test("members lists everyone who joined, oldest first", async () => {
  const store = new MemoryMembershipStore();
  const team = await store.resolveAccount({ provider: "github", subject: "1", login: "owner" });
  const code = generateInviteCode();
  await store.createInvite({
    accountId: team.accountId,
    codeHash: hashInviteCode(code),
    createdBy: "github:1",
    expiresAt: Date.now() + 60_000
  });
  await store.redeemInvite({
    codeHash: hashInviteCode(code),
    identity: { provider: "github", subject: "2", login: "invitee" }
  });

  const listed = await store.members(team.accountId);
  assert.deepEqual(listed.members.map((member) => member.login), ["owner", "invitee"]);
});

// ── the HTTP surface ─────────────────────────────────────────────────────────

test("invite create returns the code once and never logs it", async () => {
  const { port, close, logs, restore } = await serve();
  try {
    const token = signToken({ sub: "github:1", acc: "acc_1", login: "owner" }, TEST_SECRET);
    const response = await fetch(`http://127.0.0.1:${port}/invites`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({})
    });
    const body = await response.json() as { code: string; expiresAt: number };

    assert.equal(response.status, 201);
    assert.match(body.code, /^jc_inv_/);
    // An invite is a credential; it must not reach the operator's log.
    assert.equal(logs().some((line) => line.includes(body.code)), false);
    assert.equal(logs().some((line) => line.includes('"action":"invite_create"')), true);
  } finally {
    restore();
    close();
  }
});

test("a machine token cannot manage membership", async () => {
  const { port, close, restore } = await serve();
  try {
    const machine = signToken({
      sub: "github:1",
      acc: "acc_1",
      scope: { project: "demo", env: "dev", actions: ["read", "write"] }
    }, TEST_SECRET);

    for (const [method, path] of [["POST", "/invites"], ["POST", "/invites/redeem"], ["GET", "/members"]] as const) {
      const response = await fetch(`http://127.0.0.1:${port}${path}`, {
        method,
        headers: { authorization: `Bearer ${machine}`, "content-type": "application/json" },
        body: method === "POST" ? JSON.stringify({ code: "x" }) : undefined
      });
      // A CI credential must not be a way to add people to the account.
      assert.equal(response.status, 403, `${method} ${path}`);
    }
  } finally {
    restore();
    close();
  }
});

test("membership endpoints reject an anonymous caller", async () => {
  const { port, close, restore } = await serve();
  try {
    for (const [method, path] of [["POST", "/invites"], ["GET", "/members"]] as const) {
      const response = await fetch(`http://127.0.0.1:${port}${path}`, { method });
      assert.equal(response.status, 401, `${method} ${path}`);
    }
  } finally {
    restore();
    close();
  }
});

test("redeeming re-issues a token bound to the new account", async () => {
  const membership = new MemoryMembershipStore();
  const team = await membership.resolveAccount({ provider: "github", subject: "1", login: "owner" });
  const { port, close, restore } = await serve(membership);

  try {
    const ownerToken = signToken(
      { sub: "github:1", acc: team.accountId, login: "owner" },
      TEST_SECRET
    );
    const created = await fetch(`http://127.0.0.1:${port}/invites`, {
      method: "POST",
      headers: { authorization: `Bearer ${ownerToken}`, "content-type": "application/json" },
      body: JSON.stringify({})
    });
    const { code } = await created.json() as { code: string };

    // The invitee arrives holding a token for their own personal account.
    const invitee = await membership.resolveAccount({ provider: "github", subject: "2", login: "invitee" });
    const inviteeToken = signToken(
      { sub: "github:2", acc: invitee.accountId, login: "invitee" },
      TEST_SECRET
    );
    const redeemed = await fetch(`http://127.0.0.1:${port}/invites/redeem`, {
      method: "POST",
      headers: { authorization: `Bearer ${inviteeToken}`, "content-type": "application/json" },
      body: JSON.stringify({ code })
    });
    const body = await redeemed.json() as { account: { id: string }; token: string };

    assert.equal(redeemed.status, 200);
    assert.equal(body.account.id, team.accountId);
    // The old token still named the account they just left, so a fresh one is
    // issued naming the new account.
    const principal = verifyToken(body.token, TEST_SECRET);
    assert.equal(principal?.acc, team.accountId);
    assert.equal(principal?.sub, "github:2");

    // And a bad code is refused without saying why in detail.
    const bad = await fetch(`http://127.0.0.1:${port}/invites/redeem`, {
      method: "POST",
      headers: { authorization: `Bearer ${inviteeToken}`, "content-type": "application/json" },
      body: JSON.stringify({ code: "jc_inv_not-a-real-code" })
    });
    assert.equal(bad.status, 400);
    assert.equal((await bad.json() as { error: string }).error, "invite_invalid");
  } finally {
    restore();
    close();
  }
});

test("two members of one account read the same secrets; an outsider reads none", async () => {
  const membership = new MemoryMembershipStore();
  const team = await membership.resolveAccount({ provider: "github", subject: "1", login: "owner" });
  const outsider = await membership.resolveAccount({ provider: "github", subject: "9", login: "stranger" });
  const store = new Map<string, string>();
  const backend = mapBackend(store);
  const { port, close, restore } = await serve(membership, backend);

  try {
    const ownerToken = signToken({ sub: "github:1", acc: team.accountId }, TEST_SECRET);
    await fetch(`http://127.0.0.1:${port}/projects/demo/envs/dev/secrets/SHARED`, {
      method: "PUT",
      headers: { authorization: `Bearer ${ownerToken}`, "content-type": "application/json" },
      body: JSON.stringify({ value: "team-value" })
    });

    // A second identity, same account: the point of the whole account model.
    const memberToken = signToken({ sub: "github:2", acc: team.accountId }, TEST_SECRET);
    const shared = await fetch(`http://127.0.0.1:${port}/projects/demo/envs/dev/secrets/SHARED`, {
      headers: { authorization: `Bearer ${memberToken}` }
    });
    assert.equal(shared.status, 200);
    assert.equal((await shared.json() as { value: string }).value, "team-value");

    const outsiderToken = signToken({ sub: "github:9", acc: outsider.accountId }, TEST_SECRET);
    const denied = await fetch(`http://127.0.0.1:${port}/projects/demo/envs/dev/secrets/SHARED`, {
      headers: { authorization: `Bearer ${outsiderToken}` }
    });
    assert.equal(denied.status, 404, "a different account must not resolve the same secret");
  } finally {
    restore();
    close();
  }
});

test("writing a secret marks the account as holding data", async () => {
  const membership = new MemoryMembershipStore();
  const account = await membership.resolveAccount({ provider: "github", subject: "1" });
  const { port, close, restore } = await serve(membership, mapBackend(new Map()));

  try {
    const token = signToken({ sub: "github:1", acc: account.accountId }, TEST_SECRET);
    await fetch(`http://127.0.0.1:${port}/projects/demo/envs/dev/secrets/K`, {
      method: "PUT",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ value: "v" })
    });

    // Which is what makes a later redeem refuse to discard it.
    const code = generateInviteCode();
    const other = await membership.resolveAccount({ provider: "github", subject: "2" });
    await membership.createInvite({
      accountId: other.accountId,
      codeHash: hashInviteCode(code),
      createdBy: "github:2",
      expiresAt: Date.now() + 60_000
    });
    const result = await membership.redeemInvite({
      codeHash: hashInviteCode(code),
      identity: { provider: "github", subject: "1" }
    });
    assert.equal(result.ok === false && result.error, "already_in_account");
  } finally {
    restore();
    close();
  }
});

function mapBackend(store: Map<string, string>): SecretsBackend {
  const key = (ref: SecretRef) => `${ref.accountId}/${ref.project}/${ref.env}/${ref.key}`;
  return {
    async getSecret(ref) { return store.get(key(ref)); },
    async putSecret(ref, value) { store.set(key(ref), value); },
    async listKeys() { return []; },
    async deleteSecret(ref) { store.delete(key(ref)); }
  };
}

async function serve(
  membershipStore = new MemoryMembershipStore(),
  backend: SecretsBackend = mapBackend(new Map())
): Promise<{ port: number; close: () => void; logs: () => string[]; restore: () => void }> {
  const lines: string[] = [];
  const previousLog = console.log;
  console.log = (message?: unknown) => { lines.push(String(message)); };

  const server = createJuiceServer({
    backend,
    tokenSecret: TEST_SECRET,
    revocationStore: new MemoryTokenRevocationStore(),
    membershipStore
  });
  await new Promise<void>((done) => server.listen(0, done));
  const address = server.address();
  assert(address && typeof address === "object" && "port" in address);
  return {
    port: address.port,
    close: () => server.close(),
    logs: () => [...lines],
    restore: () => { console.log = previousLog; }
  };
}
