import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJuiceServer } from "../src/api/server.js";
import { signToken } from "../src/api/token.js";
import { MemoryTokenRevocationStore } from "../src/api/token-revocation-store.js";
import { juice } from "../src/sdk/index.js";
import type { SecretsBackend } from "../src/api/secrets-backend.js";

const TEST_SECRET = "0123456789abcdef0123456789abcdef";

test("juice.scope(...).get reads the local store in development", async () => {
  const home = storeWith("myapp", "development", "OPENAI_API_KEY=local-key\n");

  const secrets = juice.scope("myapp", {
    processEnv: { JUICE_ENV: "local", JUICE_HOME: home } as NodeJS.ProcessEnv
  });

  assert.equal(await secrets.get("OPENAI_API_KEY"), "local-key");
});

test("a scope is never inferred — get without one is an error naming the fix", async () => {
  await assert.rejects(
    () => juice.get("OPENAI_API_KEY"),
    /needs a scope.*juice\.scope\("my-scope"\)/s
  );
  await assert.rejects(() => juice.get("K", { scope: "   " }), /needs a scope/);
});

test("two scopes in one process do not read each other's secrets", async () => {
  const home = mkdtempSync(join(tmpdir(), "juice-two-"));
  write(home, "alpha", "development", "SHARED_NAME=alpha-value\n");
  write(home, "beta", "development", "SHARED_NAME=beta-value\n");
  const processEnv = { JUICE_ENV: "local", JUICE_HOME: home } as NodeJS.ProcessEnv;

  assert.equal(await juice.scope("alpha", { processEnv }).get("SHARED_NAME"), "alpha-value");
  assert.equal(await juice.scope("beta", { processEnv }).get("SHARED_NAME"), "beta-value");
});

test("the env axis picks the source, not just the file", async () => {
  const home = mkdtempSync(join(tmpdir(), "juice-envaxis-"));
  write(home, "myapp", "development", "TOKEN=dev\n");
  const processEnv = { JUICE_ENV: "local", JUICE_HOME: home } as NodeJS.ProcessEnv;
  const secrets = juice.scope("myapp", { processEnv });

  assert.equal(await secrets.get("TOKEN"), "dev");

  // `staging` is not a local env name, so overriding to it switches to the
  // remote API rather than reading a staging file off this disk. The env axis
  // chooses dev-vs-prod *and* file-vs-API; the two are the same decision.
  await assert.rejects(
    () => secrets.get("TOKEN", { env: "staging", processEnv }),
    /juice auth login|JUICE_TOKEN/
  );
});

test("a remote read sends the scope and env it was given", async () => {
  const seen: Array<{ project: string; env: string }> = [];
  const backend: SecretsBackend = {
    async getSecret(ref) { seen.push({ project: ref.project, env: ref.env }); return "v"; },
    async putSecret() { throw new Error("unexpected write"); },
    async listKeys() { throw new Error("unexpected list"); },
    async deleteSecret() { throw new Error("unexpected delete"); }
  };
  const { port, close } = await listen(backend);

  try {
    juice.clearCache();
    const processEnv = remoteEnv(port);
    await juice.scope("myapp", { processEnv }).get("TOKEN");
    await juice.scope("myapp", { processEnv }).get("TOKEN", { env: "staging", processEnv });

    assert.deepEqual(seen, [
      { project: "myapp", env: "production" },
      { project: "myapp", env: "staging" }
    ]);
  } finally {
    juice.clearCache();
    close();
  }
});

test("a missing secret names the command that would create it", async () => {
  const home = storeWith("myapp", "development", "OTHER=1\n");
  const secrets = juice.scope("myapp", {
    processEnv: { JUICE_ENV: "local", JUICE_HOME: home } as NodeJS.ProcessEnv
  });

  await assert.rejects(() => secrets.get("ABSENT"), /juice set ABSENT --scope myapp/);
});

test("juice.scope fetches one remote key in non-local mode", async () => {
  const backend: SecretsBackend = {
    async getSecret(ref) {
      assert.deepEqual(ref, { userId: "1", project: "myapp", env: "production", key: "OPENAI_API_KEY" });
      return "remote-key";
    },
    async putSecret() { throw new Error("unexpected write"); },
    async listKeys() { throw new Error("unexpected list"); },
    async deleteSecret() { throw new Error("unexpected delete"); }
  };
  const { port, close } = await listen(backend);

  try {
    juice.clearCache();
    const secrets = juice.scope("myapp", { processEnv: remoteEnv(port) });
    assert.equal(await secrets.get("OPENAI_API_KEY"), "remote-key");
  } finally {
    juice.clearCache();
    close();
  }
});

test("remote reads memoise, dedupe concurrent calls, and honour JUICE_CACHE_TTL=0", async () => {
  let reads = 0;
  const backend: SecretsBackend = {
    async getSecret() { reads++; return `value-${reads}`; },
    async putSecret() { throw new Error("unexpected write"); },
    async listKeys() { throw new Error("unexpected list"); },
    async deleteSecret() { throw new Error("unexpected delete"); }
  };
  const { port, close } = await listen(backend);
  const processEnv = remoteEnv(port);

  try {
    juice.clearCache();
    const secrets = juice.scope("myapp", { processEnv });

    const together = await Promise.all([secrets.get("KEY"), secrets.get("KEY"), secrets.get("KEY")]);
    assert.deepEqual(together, ["value-1", "value-1", "value-1"]);
    assert.equal(reads, 1);

    assert.equal(await secrets.get("KEY"), "value-1");
    assert.equal(reads, 1);

    // A different scope is a different cache entry, not a shared one.
    await juice.scope("other", { processEnv }).get("KEY");
    assert.equal(reads, 2);

    juice.clearCache();
    assert.equal(await secrets.get("KEY"), "value-3");

    const uncached = { ...processEnv, JUICE_CACHE_TTL: "0" } as NodeJS.ProcessEnv;
    await juice.scope("myapp", { processEnv: uncached }).get("KEY");
    await juice.scope("myapp", { processEnv: uncached }).get("KEY");
    assert.equal(reads, 5);
  } finally {
    juice.clearCache();
    close();
  }
});

test("failures are never cached", async () => {
  let attempts = 0;
  const backend: SecretsBackend = {
    async getSecret() { attempts++; return attempts === 1 ? undefined : "eventually-there"; },
    async putSecret() { throw new Error("unexpected write"); },
    async listKeys() { throw new Error("unexpected list"); },
    async deleteSecret() { throw new Error("unexpected delete"); }
  };
  const { port, close } = await listen(backend);

  try {
    juice.clearCache();
    const secrets = juice.scope("miss-demo", { processEnv: remoteEnv(port) });
    await assert.rejects(() => secrets.get("LATER"));
    assert.equal(await secrets.get("LATER"), "eventually-there");
    assert.equal(attempts, 2);
  } finally {
    juice.clearCache();
    close();
  }
});

test("local reads see an edit that mtime and size cannot distinguish", async () => {
  const home = storeWith("myapp", "development", "K=first\n");
  const file = join(home, "scopes", "myapp", "development.env");
  const processEnv = { JUICE_ENV: "local", JUICE_HOME: home } as NodeJS.ProcessEnv;
  const secrets = juice.scope("myapp", { processEnv });

  assert.equal(await secrets.get("K"), "first");
  // Same byte length, and on a coarse-granularity filesystem the same mtime.
  // An mtime+size cache serves "first" forever; local reads are uncached.
  writeFileSync(file, "K=secon\n");
  assert.equal(await secrets.get("K"), "secon");
});

function write(home: string, scope: string, envName: string, contents: string): void {
  const dir = join(home, "scopes", ...scope.split("/"));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${envName}.env`), contents);
}

function storeWith(scope: string, envName: string, contents: string): string {
  const home = mkdtempSync(join(tmpdir(), "juice-sdk-"));
  write(home, scope, envName, contents);
  return home;
}

function remoteEnv(port: number): NodeJS.ProcessEnv {
  return {
    JUICE_ENV: "production",
    JUICE_API_URL: `http://127.0.0.1:${port}`,
    JUICE_TOKEN: signToken({ sub: "github:1" }, TEST_SECRET)
  } as NodeJS.ProcessEnv;
}

async function listen(backend: SecretsBackend): Promise<{ port: number; close: () => void }> {
  const server = createJuiceServer({
    backend,
    tokenSecret: TEST_SECRET,
    revocationStore: new MemoryTokenRevocationStore()
  });
  await new Promise<void>((done) => server.listen(0, done));
  const address = server.address();
  assert(address && typeof address === "object" && "port" in address);
  return { port: address.port, close: () => server.close() };
}
