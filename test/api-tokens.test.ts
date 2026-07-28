/**
 * Minting, scoping, and revoking tokens, plus the revocation store's cache.
 *
 * A cache in front of a revocation check is a security control: the tests pin
 * both that it is used and that a read failure does not fail open.
 */
import assert from "node:assert/strict";
import test from "node:test";
import type { SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { createJuiceServer } from "../src/api/server.js";
import { signToken, verifyToken } from "../src/api/token.js";
import {
  AwsSecretsManagerTokenRevocationStore,
  MemoryTokenRevocationStore
} from "../src/api/token-revocation-store.js";
import { FakeSecretsManagerClient, listen, TEST_SECRET, valueBackend } from "./helpers/api.js";

test("expired and revoked tokens are rejected", async () => {
  const revocationStore = new MemoryTokenRevocationStore();
  const backend = valueBackend("secret");
  const server = createJuiceServer({ backend, tokenSecret: TEST_SECRET, revocationStore });
  const port = await listen(server);
  const expired = signToken({ sub: "github:1", acc: "acc_1" }, TEST_SECRET, { now: 100, ttlSeconds: 60 });
  const revoked = signToken({ sub: "github:1", acc: "acc_1" }, TEST_SECRET, { jti: "revoked-token" });
  await revocationStore.revoke("revoked-token", "github:1");

  const expiredResponse = await fetch(`http://127.0.0.1:${port}/projects/demo/envs/dev/secrets/KEY`, {
    headers: { authorization: `Bearer ${expired}` }
  });
  const revokedResponse = await fetch(`http://127.0.0.1:${port}/projects/demo/envs/dev/secrets/KEY`, {
    headers: { authorization: `Bearer ${revoked}` }
  });

  server.close();
  assert.equal(expiredResponse.status, 401);
  assert.equal(revokedResponse.status, 401);
});

test("user tokens carry exp, iat, jti, iss and aud", () => {
  const now = 1_800_000_000;
  const token = signToken({ sub: "github:1", acc: "acc_1" }, TEST_SECRET, { now });
  const principal = verifyToken(token, TEST_SECRET, now + 1);

  assert(principal);
  assert.equal(principal.iss, "juice");
  assert.equal(principal.aud, "juice-api");
  assert.equal(principal.iat, now);
  assert.equal(principal.exp, now + 12 * 60 * 60);
  assert.equal(typeof principal.jti, "string");
});

test("machine token scope limits project, env and action", async () => {
  const backend = valueBackend("secret");
  const server = createJuiceServer({
    backend,
    tokenSecret: TEST_SECRET,
    revocationStore: new MemoryTokenRevocationStore()
  });
  const port = await listen(server);
  const userToken = signToken({ sub: "github:1", acc: "acc_1" }, TEST_SECRET);

  const createResponse = await fetch(`http://127.0.0.1:${port}/tokens`, {
    method: "POST",
    headers: { authorization: `Bearer ${userToken}`, "content-type": "application/json" },
    body: JSON.stringify({ project: "projA", env: "dev", readOnly: true, ttlSeconds: 3600 })
  });
  const created = await createResponse.json() as { token: string };

  const allowed = await fetch(`http://127.0.0.1:${port}/projects/projA/envs/dev/secrets/KEY`, {
    headers: { authorization: `Bearer ${created.token}` }
  });
  const wrongEnv = await fetch(`http://127.0.0.1:${port}/projects/projA/envs/prod/secrets/KEY`, {
    headers: { authorization: `Bearer ${created.token}` }
  });
  const wrongProject = await fetch(`http://127.0.0.1:${port}/projects/projB/envs/dev/secrets/KEY`, {
    headers: { authorization: `Bearer ${created.token}` }
  });
  const writeDenied = await fetch(`http://127.0.0.1:${port}/projects/projA/envs/dev/secrets/KEY`, {
    method: "PUT",
    headers: { authorization: `Bearer ${created.token}`, "content-type": "application/json" },
    body: JSON.stringify({ value: "new" })
  });

  server.close();
  assert.equal(createResponse.status, 201);
  assert.equal(allowed.status, 200);
  assert.equal(wrongEnv.status, 403);
  assert.equal(wrongProject.status, 403);
  assert.equal(writeDenied.status, 403);
});

test("machine tokens cannot create tokens", async () => {
  let authorizeCalled = false;
  const server = createJuiceServer({
    backend: valueBackend("secret"),
    tokenSecret: TEST_SECRET,
    revocationStore: new MemoryTokenRevocationStore(),
    authorize() {
      authorizeCalled = true;
      return true;
    }
  });
  const port = await listen(server);
  const machineToken = signToken({
    sub: "github:1",
    acc: "acc_1",
    scope: { project: "projA", env: "dev", actions: ["read", "write"] }
  }, TEST_SECRET);

  const response = await fetch(`http://127.0.0.1:${port}/tokens`, {
    method: "POST",
    headers: { authorization: `Bearer ${machineToken}`, "content-type": "application/json" },
    body: "{"
  });
  const body = await response.json() as { error?: string };

  server.close();
  assert.equal(response.status, 403);
  assert.equal(body.error, "Machine tokens cannot create tokens");
  assert.equal(authorizeCalled, false);
});

test("tokens can revoke themselves and are rejected afterwards", async () => {
  const revocationStore = new MemoryTokenRevocationStore();
  const server = createJuiceServer({
    backend: valueBackend("secret"),
    tokenSecret: TEST_SECRET,
    revocationStore
  });
  const port = await listen(server);
  const token = signToken({ sub: "github:1", acc: "acc_1" }, TEST_SECRET, { jti: "self-token" });

  const revokeResponse = await fetch(`http://127.0.0.1:${port}/tokens/self-token`, {
    method: "DELETE",
    headers: { authorization: `Bearer ${token}` }
  });
  const secretResponse = await fetch(`http://127.0.0.1:${port}/projects/demo/envs/dev/secrets/KEY`, {
    headers: { authorization: `Bearer ${token}` }
  });

  server.close();
  assert.equal(revokeResponse.status, 204);
  assert.equal(secretResponse.status, 401);
});

test("users cannot revoke another user's token", async () => {
  const server = createJuiceServer({
    backend: valueBackend("secret"),
    tokenSecret: TEST_SECRET,
    revocationStore: new MemoryTokenRevocationStore()
  });
  const port = await listen(server);
  const userAToken = signToken({ sub: "github:1", acc: "acc_1" }, TEST_SECRET, { jti: "user-a" });
  const userBToken = signToken({ sub: "github:2", acc: "acc_2" }, TEST_SECRET, { jti: "user-b" });

  const revokeResponse = await fetch(`http://127.0.0.1:${port}/tokens/user-b`, {
    method: "DELETE",
    headers: { authorization: `Bearer ${userAToken}`, "content-type": "application/json" },
    body: JSON.stringify({ token: userBToken })
  });
  const stillWorks = await fetch(`http://127.0.0.1:${port}/projects/demo/envs/dev/secrets/KEY`, {
    headers: { authorization: `Bearer ${userBToken}` }
  });

  server.close();
  assert.equal(revokeResponse.status, 403);
  assert.equal(stillWorks.status, 200);
});

test("token revoke rejects target tokens whose jti mismatches the path", async () => {
  const server = createJuiceServer({
    backend: valueBackend("secret"),
    tokenSecret: TEST_SECRET,
    revocationStore: new MemoryTokenRevocationStore()
  });
  const port = await listen(server);
  const userToken = signToken({ sub: "github:1", acc: "acc_1" }, TEST_SECRET, { jti: "actual-jti" });

  const response = await fetch(`http://127.0.0.1:${port}/tokens/other-jti`, {
    method: "DELETE",
    headers: { authorization: `Bearer ${userToken}`, "content-type": "application/json" },
    body: JSON.stringify({ token: userToken })
  });

  server.close();
  assert.equal(response.status, 400);
});

test("AWS token revocation lookups are cached within the TTL", async () => {
  const client = new FakeSecretsManagerClient(JSON.stringify({ revoked: ["cached-token"] }));
  const store = new AwsSecretsManagerTokenRevocationStore(client as unknown as SecretsManagerClient, "/test", 60_000);

  assert.equal(await store.isRevoked("cached-token"), true);
  assert.equal(await store.isRevoked("other-token"), false);
  assert.equal(client.getCalls, 1);
});

test("AWS token revoke updates the cache after writing", async () => {
  const client = new FakeSecretsManagerClient(JSON.stringify({ revoked: [] }));
  const store = new AwsSecretsManagerTokenRevocationStore(client as unknown as SecretsManagerClient, "/test", 60_000);

  assert.equal(await store.isRevoked("new-token"), false);
  await store.revoke("new-token", "github:1");
  assert.equal(await store.isRevoked("new-token"), true);
  assert.equal(client.getCalls, 2);
});

test("AWS token revocation read errors allow auth without an empty cache", async () => {
  const client = new FakeSecretsManagerClient();
  client.failGet = true;
  const store = new AwsSecretsManagerTokenRevocationStore(client as unknown as SecretsManagerClient, "/test", 60_000);
  const previousError = console.error;
  let logged = false;
  console.error = (message?: unknown) => {
    logged = String(message).includes("Token revocation read failed");
  };

  try {
    assert.equal(await store.isRevoked("token"), false);
  } finally {
    console.error = previousError;
  }
  assert.equal(logged, true);
});
