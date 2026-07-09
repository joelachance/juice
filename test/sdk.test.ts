import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJuiceServer } from "../src/api/server.js";
import { signToken } from "../src/api/token.js";
import { MemoryTokenRevocationStore } from "../src/api/token-revocation-store.js";
import { juice } from "../src/sdk/index.js";
import type { SecretsBackend } from "../src/api/secrets-backend.js";

const TEST_SECRET = "0123456789abcdef0123456789abcdef";

test("juice.get reads a local .env in local mode", async () => {
  const dir = mkdtempSync(join(tmpdir(), "juice-sdk-local-"));
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "demo" }));
  writeFileSync(join(dir, ".env"), "OPENAI_API_KEY=local-key\n");

  const value = await juice.get("OPENAI_API_KEY", {
    cwd: dir,
    env: { JUICE_ENV: "local" } as NodeJS.ProcessEnv
  });

  assert.equal(value, "local-key");
});

test("juice.get fetches one remote key in non-local mode", async () => {
  const backend: SecretsBackend = {
    async getSecret(ref) {
      assert.deepEqual(ref, { userId: "1", project: "demo", env: "production", key: "OPENAI_API_KEY" });
      return "remote-key";
    },
    async putSecret() {
      throw new Error("unexpected write");
    },
    async listKeys() {
      throw new Error("unexpected list");
    },
    async deleteSecret() {
      throw new Error("unexpected delete");
    }
  };
  const server = createJuiceServer({ backend, tokenSecret: TEST_SECRET, revocationStore: new MemoryTokenRevocationStore() });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  assert(address && typeof address === "object" && "port" in address);

  const token = signToken({ sub: "github:1", login: "octo" }, TEST_SECRET);
  const value = await juice.get("OPENAI_API_KEY", {
    cwd: makePackage("demo"),
    env: {
      JUICE_ENV: "production",
      JUICE_API_URL: `http://127.0.0.1:${address.port}`,
      JUICE_TOKEN: token
    } as NodeJS.ProcessEnv
  });

  server.close();
  assert.equal(value, "remote-key");
});

function makePackage(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), "juice-sdk-remote-"));
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name }));
  return dir;
}
