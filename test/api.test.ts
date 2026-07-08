import assert from "node:assert/strict";
import test from "node:test";
import { createJuiceServer } from "../src/api/server.js";
import { signToken, verifyToken } from "../src/api/token.js";
import { MemoryTokenRevocationStore } from "../src/api/token-revocation-store.js";
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
    }
  };
  const server = createJuiceServer({
    backend,
    tokenSecret: TEST_SECRET,
    revocationStore: new MemoryTokenRevocationStore()
  });
  const port = await listen(server);
  const token = signToken({ sub: "github:123" }, TEST_SECRET);

  const response = await fetch(`http://127.0.0.1:${port}/projects/demo/envs/development/secrets/KEY`, {
    method: "PUT",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ value: "secret" })
  });

  server.close();
  assert.equal(response.status, 204);
  assert.deepEqual(writes, [{
    ref: { userId: "123", project: "demo", env: "development", key: "KEY" },
    value: "secret"
  }]);
});

test("expired and revoked tokens are rejected", async () => {
  const revocationStore = new MemoryTokenRevocationStore();
  const backend = valueBackend("secret");
  const server = createJuiceServer({ backend, tokenSecret: TEST_SECRET, revocationStore });
  const port = await listen(server);
  const expired = signToken({ sub: "github:1" }, TEST_SECRET, { now: 100, ttlSeconds: 60 });
  const revoked = signToken({ sub: "github:1" }, TEST_SECRET, { jti: "revoked-token" });
  await revocationStore.revoke("revoked-token");

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
  const token = signToken({ sub: "github:1" }, TEST_SECRET, { now });
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
  const userToken = signToken({ sub: "github:1" }, TEST_SECRET);

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

test("bad JSON returns 400 and bodies over 64 KB return 413", async () => {
  const server = createJuiceServer({
    backend: valueBackend("secret"),
    tokenSecret: TEST_SECRET,
    revocationStore: new MemoryTokenRevocationStore()
  });
  const port = await listen(server);
  const token = signToken({ sub: "github:1" }, TEST_SECRET);
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
      async putSecret() {}
    },
    tokenSecret: TEST_SECRET,
    revocationStore: new MemoryTokenRevocationStore()
  });
  const port = await listen(server);
  const token = signToken({ sub: "github:1" }, TEST_SECRET);

  const response = await fetch(`http://127.0.0.1:${port}/projects/demo/envs/dev/secrets/KEY`, {
    headers: { authorization: `Bearer ${token}` }
  });
  const body = await response.json() as { error?: string; requestId?: string };

  server.close();
  assert.equal(response.status, 500);
  assert.equal(body.error, "Internal server error");
  assert.equal(typeof body.requestId, "string");
});

function valueBackend(value: string): SecretsBackend {
  return {
    async getSecret() {
      return value;
    },
    async putSecret() {}
  };
}

async function listen(server: ReturnType<typeof createJuiceServer>): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  assert(address && typeof address === "object" && "port" in address);
  return address.port;
}
