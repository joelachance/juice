/**
 * The secret routes.
 *
 * The assertions that matter here are about the *ref* the server builds — the
 * account comes from the verified token and never from the request, so a test
 * that only checked status codes would miss a tenant-isolation regression.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { createJuiceServer } from "../src/api/server.js";
import { signToken } from "../src/api/token.js";
import { MemoryTokenRevocationStore } from "../src/api/token-revocation-store.js";
import type { SecretRef, SecretsBackend } from "../src/api/secrets-backend.js";
import { listen, memoryBackend, TEST_SECRET } from "./helpers/api.js";

test("API rejects unauthorized reads before calling the backend", async () => {
  let called = false;
  const backend: SecretsBackend = {
    async getSecret() {
      called = true;
      return "secret";
    },
    async putSecret() {
      called = true;
    },
    async listKeys() {
      called = true;
      return [];
    },
    async deleteSecret() {
      called = true;
    }
  };
  const server = createJuiceServer({ backend, tokenSecret: TEST_SECRET, revocationStore: new MemoryTokenRevocationStore() });
  const port = await listen(server);

  const response = await fetch(`http://127.0.0.1:${port}/projects/demo/envs/production/secrets/KEY`);

  server.close();
  assert.equal(response.status, 401);
  assert.equal(called, false);
});

test("API stores secrets under the authenticated GitHub user namespace", async () => {
  const writes: Array<{ ref: SecretRef; value: string }> = [];
  const backend: SecretsBackend = {
    async getSecret() {
      return undefined;
    },
    async putSecret(ref, value) {
      writes.push({ ref, value });
    },
    async listKeys() {
      return [];
    },
    async deleteSecret() {}
  };
  const server = createJuiceServer({
    backend,
    tokenSecret: TEST_SECRET,
    revocationStore: new MemoryTokenRevocationStore()
  });
  const port = await listen(server);
  const token = signToken({ sub: "github:123", acc: "acc_123" }, TEST_SECRET);

  const response = await fetch(`http://127.0.0.1:${port}/projects/demo/envs/development/secrets/KEY`, {
    method: "PUT",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ value: "secret" })
  });

  server.close();
  assert.equal(response.status, 204);
  assert.deepEqual(writes, [{
    ref: { accountId: "acc_123", project: "demo", env: "development", key: "KEY" },
    value: "secret"
  }]);
});

test("list returns only the caller's keys (cross-user isolation)", async () => {
  const backend = memoryBackend([
    { ref: { accountId: "acc_1", project: "demo", env: "dev", key: "ALPHA" }, value: "a" },
    { ref: { accountId: "acc_1", project: "demo", env: "dev", key: "BETA" }, value: "b" },
    { ref: { accountId: "acc_2", project: "demo", env: "dev", key: "OTHER" }, value: "leak-me" },
    { ref: { accountId: "acc_2", project: "demo", env: "dev", key: "SECRET" }, value: "nope" }
  ]);
  const logs: string[] = [];
  const previousLog = console.log;
  console.log = (message?: unknown) => {
    logs.push(String(message));
  };
  const server = createJuiceServer({
    backend,
    tokenSecret: TEST_SECRET,
    revocationStore: new MemoryTokenRevocationStore()
  });
  const port = await listen(server);
  const tokenA = signToken({ sub: "github:1", acc: "acc_1" }, TEST_SECRET);

  try {
    const response = await fetch(`http://127.0.0.1:${port}/projects/demo/envs/dev/secrets`, {
      headers: { authorization: `Bearer ${tokenA}` }
    });
    const body = await response.json() as { keys?: string[] };

    assert.equal(response.status, 200);
    assert.deepEqual(body.keys, ["ALPHA", "BETA"]);
    assert.deepEqual(backend.listed, [{ accountId: "acc_1", project: "demo", env: "dev" }]);
    assert.equal(logs.some((line) => line.includes('"action":"list"') && line.includes('"outcome":"ok"')), true);
    assert.equal(logs.some((line) => /leak-me|nope|"value"/.test(line)), false);
  } finally {
    console.log = previousLog;
    server.close();
  }
});

test("?values=1 returns the caller's secrets in one request and audits each key", async () => {
  const backend = memoryBackend([
    { ref: { accountId: "acc_1", project: "demo", env: "dev", key: "ALPHA" }, value: "a" },
    { ref: { accountId: "acc_1", project: "demo", env: "dev", key: "BETA" }, value: "b" },
    { ref: { accountId: "acc_2", project: "demo", env: "dev", key: "OTHER" }, value: "leak-me" }
  ]);
  const logs: string[] = [];
  const previousLog = console.log;
  console.log = (message?: unknown) => {
    logs.push(String(message));
  };
  const server = createJuiceServer({
    backend,
    tokenSecret: TEST_SECRET,
    revocationStore: new MemoryTokenRevocationStore()
  });
  const port = await listen(server);

  try {
    const response = await fetch(`http://127.0.0.1:${port}/projects/demo/envs/dev/secrets?values=1`, {
      headers: { authorization: `Bearer ${signToken({ sub: "github:1", acc: "acc_1" }, TEST_SECRET)}` }
    });
    const body = await response.json() as { keys?: string[]; secrets?: Record<string, string> };

    assert.equal(response.status, 200);
    assert.deepEqual(body.keys, ["ALPHA", "BETA"]);
    assert.deepEqual(body.secrets, { ALPHA: "a", BETA: "b" });
    // Bulk must not be a quieter path than N gets: one read record per key.
    assert.equal(logs.filter((line) => line.includes('"action":"read"')).length, 2);
    assert.equal(logs.some((line) => /leak-me|"value"|"a"|"b"/.test(line)), false);
  } finally {
    console.log = previousLog;
    server.close();
  }
});

test("?values=1 is refused for a read-only token scoped to another project", async () => {
  const backend = memoryBackend([
    { ref: { accountId: "acc_1", project: "other", env: "dev", key: "KEY" }, value: "secret" }
  ]);
  const server = createJuiceServer({
    backend,
    tokenSecret: TEST_SECRET,
    revocationStore: new MemoryTokenRevocationStore()
  });
  const port = await listen(server);

  try {
    const scoped = signToken(
      { sub: "github:1", acc: "acc_1", scope: { project: "demo", env: "dev", actions: ["read"] } },
      TEST_SECRET
    );
    const response = await fetch(`http://127.0.0.1:${port}/projects/other/envs/dev/secrets?values=1`, {
      headers: { authorization: `Bearer ${scoped}` }
    });
    assert.equal(response.status, 403);
    assert.equal(JSON.stringify(await response.json()).includes("secret"), false);
  } finally {
    server.close();
  }
});

test("unset deletes with write authz; read-only machine token gets 403", async () => {
  const backend = memoryBackend([
    { ref: { accountId: "acc_1", project: "demo", env: "dev", key: "KEY" }, value: "secret" }
  ]);
  const logs: string[] = [];
  const previousLog = console.log;
  console.log = (message?: unknown) => {
    logs.push(String(message));
  };
  const server = createJuiceServer({
    backend,
    tokenSecret: TEST_SECRET,
    revocationStore: new MemoryTokenRevocationStore()
  });
  const port = await listen(server);
  const readOnly = signToken({
    sub: "github:1",
    acc: "acc_1",
    scope: { project: "demo", env: "dev", actions: ["read"] }
  }, TEST_SECRET);
  const writer = signToken({
    sub: "github:1",
    acc: "acc_1",
    scope: { project: "demo", env: "dev", actions: ["read", "write"] }
  }, TEST_SECRET);

  try {
    const listOk = await fetch(`http://127.0.0.1:${port}/projects/demo/envs/dev/secrets`, {
      headers: { authorization: `Bearer ${readOnly}` }
    });
    assert.equal(listOk.status, 200);
    assert.deepEqual((await listOk.json() as { keys: string[] }).keys, ["KEY"]);

    const denied = await fetch(`http://127.0.0.1:${port}/projects/demo/envs/dev/secrets/KEY`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${readOnly}` }
    });
    assert.equal(denied.status, 403);
    assert.equal(backend.store.has("acc_1/demo/dev/KEY"), true);

    const deleted = await fetch(`http://127.0.0.1:${port}/projects/demo/envs/dev/secrets/KEY`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${writer}` }
    });
    assert.equal(deleted.status, 204);
    assert.equal(backend.store.has("acc_1/demo/dev/KEY"), false);

    const again = await fetch(`http://127.0.0.1:${port}/projects/demo/envs/dev/secrets/KEY`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${writer}` }
    });
    assert.equal(again.status, 204);

    assert.equal(logs.some((line) => line.includes('"action":"delete"') && line.includes('"outcome":"ok"')), true);
    assert.equal(logs.some((line) => line.includes("secret")), false);
  } finally {
    console.log = previousLog;
    server.close();
  }
});
