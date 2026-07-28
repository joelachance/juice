/**
 * Shared scaffolding for the API tests.
 *
 * The backends here are deliberately dumb: they record what they were asked
 * for, so a test can assert on the ref the server built rather than only on the
 * response. That is what catches an account or scope being derived wrongly.
 */
import assert from "node:assert/strict";
import { createJuiceServer } from "../../src/api/server.js";
import type { SecretRef, SecretsBackend } from "../../src/api/secrets-backend.js";

export const TEST_SECRET = "0123456789abcdef0123456789abcdef";

export function valueBackend(value: string): SecretsBackend {
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

export function memoryBackend(initial: Array<{ ref: SecretRef; value: string }> = []): SecretsBackend & {
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

export function secretKey(ref: SecretRef): string {
  return `${ref.accountId}/${ref.project}/${ref.env}/${ref.key}`;
}

export async function listen(server: ReturnType<typeof createJuiceServer>): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  assert(address && typeof address === "object" && "port" in address);
  return address.port;
}

export class FakeSecretsManagerClient {
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
