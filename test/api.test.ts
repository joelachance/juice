import assert from "node:assert/strict";
import test from "node:test";
import type { SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { createJuiceServer } from "../src/api/server.js";
import { signToken, verifyToken } from "../src/api/token.js";
import {
  AwsSecretsManagerTokenRevocationStore,
  MemoryTokenRevocationStore
} from "../src/api/token-revocation-store.js";
import type { SecretRef, SecretsBackend } from "../src/api/secrets-backend.js";

const TEST_SECRET = "0123456789abcdef0123456789abcdef";

test("API root exposes deployed version and commit", async () => {
  const previous = process.env.JUICE_VERSION_COMMIT;
  process.env.JUICE_VERSION_COMMIT = "abc123";
  const server = createJuiceServer({ tokenSecret: TEST_SECRET });
  const port = await listen(server);

  const response = await fetch(`http://127.0.0.1:${port}/`);
  const body = await response.json() as { service?: string; commit?: string; version?: string };

  server.close();
  if (previous === undefined) {
    delete process.env.JUICE_VERSION_COMMIT;
  } else {
    process.env.JUICE_VERSION_COMMIT = previous;
  }
  assert.equal(response.status, 200);
  assert.equal(body.service, "juice-api");
  assert.equal(body.commit, "abc123");
  assert.equal(body.version, "0.1.0");
});

test("API exposes health check for deploy platforms", async () => {
  const server = createJuiceServer({ tokenSecret: TEST_SECRET });
  const port = await listen(server);

  const response = await fetch(`http://127.0.0.1:${port}/healthz`);
  const body = await response.json() as { ok?: boolean; service?: string };

  server.close();
  assert.equal(response.status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.service, "juice-api");
});

test("server refuses to start without a strong token secret", () => {
  assert.throws(() => createJuiceServer(), /JUICE_TOKEN_SECRET/);
  assert.throws(() => createJuiceServer({ tokenSecret: "too-short" }), /JUICE_TOKEN_SECRET/);
});

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

test("bad JSON returns 400 and bodies over 64 KB return 413", async () => {
  const server = createJuiceServer({
    backend: valueBackend("secret"),
    tokenSecret: TEST_SECRET,
    revocationStore: new MemoryTokenRevocationStore()
  });
  const port = await listen(server);
  const token = signToken({ sub: "github:1", acc: "acc_1" }, TEST_SECRET);
  const url = `http://127.0.0.1:${port}/projects/demo/envs/dev/secrets/KEY`;

  const badJson = await fetch(url, {
    method: "PUT",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: "{"
  });
  const tooLarge = await fetch(url, {
    method: "PUT",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ value: "x".repeat(70 * 1024) })
  });

  server.close();
  assert.equal(badJson.status, 400);
  assert.equal(tooLarge.status, 413);
});

test("500 responses are sanitized and include request ids", async () => {
  const server = createJuiceServer({
    backend: {
      async getSecret() {
        throw new Error("AWS internal detail");
      },
      async putSecret() {},
      async listKeys() {
        return [];
      },
      async deleteSecret() {}
    },
    tokenSecret: TEST_SECRET,
    revocationStore: new MemoryTokenRevocationStore()
  });
  const port = await listen(server);
  const token = signToken({ sub: "github:1", acc: "acc_1" }, TEST_SECRET);

  const response = await fetch(`http://127.0.0.1:${port}/projects/demo/envs/dev/secrets/KEY`, {
    headers: { authorization: `Bearer ${token}` }
  });
  const body = await response.json() as { error?: string; requestId?: string };

  server.close();
  assert.equal(response.status, 500);
  assert.equal(body.error, "Internal server error");
  assert.equal(typeof body.requestId, "string");
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

function valueBackend(value: string): SecretsBackend {
  return {
    async getSecret() {
      return value;
    },
    async putSecret() {},
    async listKeys() {
      return [];
    },
    async deleteSecret() {}
  };
}

function memoryBackend(initial: Array<{ ref: SecretRef; value: string }> = []): SecretsBackend & {
  store: Map<string, string>;
  deleted: SecretRef[];
  listed: Array<{ accountId: string; project: string; env: string }>;
} {
  const store = new Map(initial.map(({ ref, value }) => [secretKey(ref), value]));
  const deleted: SecretRef[] = [];
  const listed: Array<{ accountId: string; project: string; env: string }> = [];
  return {
    store,
    deleted,
    listed,
    async getSecret(ref) {
      return store.get(secretKey(ref));
    },
    async putSecret(ref, value) {
      store.set(secretKey(ref), value);
    },
    async listKeys(ref) {
      listed.push(ref);
      const prefix = `${ref.accountId}/${ref.project}/${ref.env}/`;
      return [...store.keys()]
        .filter((key) => key.startsWith(prefix))
        .map((key) => key.slice(prefix.length))
        .sort();
    },
    async deleteSecret(ref) {
      deleted.push(ref);
      store.delete(secretKey(ref));
    }
  };
}

function secretKey(ref: SecretRef): string {
  return `${ref.accountId}/${ref.project}/${ref.env}/${ref.key}`;
}

async function listen(server: ReturnType<typeof createJuiceServer>): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  assert(address && typeof address === "object" && "port" in address);
  return address.port;
}

class FakeSecretsManagerClient {
  getCalls = 0;
  secret: string | undefined;
  failGet = false;

  constructor(secret?: string) {
    this.secret = secret;
  }

  async send(command: { constructor: { name: string }; input?: { SecretString?: string } }): Promise<{ SecretString?: string }> {
    if (command.constructor.name === "GetSecretValueCommand") {
      this.getCalls += 1;
      if (this.failGet) throw new Error("throttled");
      return { SecretString: this.secret };
    }
    if (command.constructor.name === "PutSecretValueCommand" || command.constructor.name === "CreateSecretCommand") {
      this.secret = command.input?.SecretString;
      return {};
    }
    throw new Error(`Unexpected command ${command.constructor.name}`);
  }
}
