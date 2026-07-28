/**
 * Wiring: version, health, refusing to start without a signing secret, and the
 * two ways a request body can be hostile.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { createJuiceServer } from "../src/api/server.js";
import { signToken } from "../src/api/token.js";
import { MemoryTokenRevocationStore } from "../src/api/token-revocation-store.js";
import { listen, TEST_SECRET, valueBackend } from "./helpers/api.js";

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
