import assert from "node:assert/strict";
import test from "node:test";
import {
  CreateSecretCommand,
  DeleteSecretCommand,
  DescribeSecretCommand,
  GetSecretValueCommand,
  ListSecretsCommand,
  PutSecretValueCommand,
  ResourceNotFoundException
} from "@aws-sdk/client-secrets-manager";
import { AwsSecretsManagerBackend, secretName, secretPrefix } from "../src/api/aws-secrets-backend.js";

test("secretName builds deterministic AWS Secrets Manager paths", () => {
  assert.equal(
    secretName({ userId: "123", project: "@scope/demo", env: "production", key: "OPENAI_API_KEY" }),
    "/juice/users/123/projects/%40scope%2Fdemo/envs/production/secrets/OPENAI_API_KEY"
  );
  assert.equal(
    secretPrefix({ userId: "123", project: "@scope/demo", env: "production" }),
    "/juice/users/123/projects/%40scope%2Fdemo/envs/production/secrets/"
  );
});

test("putSecret creates missing AWS secret", async () => {
  const sent: string[] = [];
  const client = {
    async send(command: unknown) {
      sent.push(commandName(command));
      if (command instanceof DescribeSecretCommand) {
        throw new ResourceNotFoundException({ message: "missing", $metadata: {} });
      }
      return {};
    }
  };
  const backend = new AwsSecretsManagerBackend(client as never);

  await backend.putSecret({ userId: "123", project: "demo", env: "production", key: "KEY" }, "value");

  assert.deepEqual(sent, ["DescribeSecretCommand", "CreateSecretCommand"]);
});

test("putSecret updates existing AWS secret", async () => {
  const sent: string[] = [];
  const client = {
    async send(command: unknown) {
      sent.push(commandName(command));
      return {};
    }
  };
  const backend = new AwsSecretsManagerBackend(client as never);

  await backend.putSecret({ userId: "123", project: "demo", env: "production", key: "KEY" }, "value");

  assert.deepEqual(sent, ["DescribeSecretCommand", "PutSecretValueCommand"]);
});

test("getSecret reads one AWS secret value", async () => {
  const client = {
    async send(command: unknown) {
      assert(command instanceof GetSecretValueCommand);
      return { SecretString: "value" };
    }
  };
  const backend = new AwsSecretsManagerBackend(client as never);

  assert.equal(await backend.getSecret({ userId: "123", project: "demo", env: "production", key: "KEY" }), "value");
});

test("listKeys filters to the caller prefix even when ListSecrets returns other tenants", async () => {
  const prefix = secretPrefix({ userId: "1", project: "demo", env: "dev" });
  const client = {
    async send(command: unknown) {
      assert(command instanceof ListSecretsCommand);
      assert.deepEqual(command.input.Filters, [{ Key: "name", Values: [prefix] }]);
      return {
        SecretList: [
          { Name: `${prefix}ALPHA` },
          { Name: `${prefix}BETA` },
          { Name: "/juice/users/2/projects/demo/envs/dev/secrets/OTHER" },
          { Name: `${prefix}nested/bad` },
          { Name: undefined }
        ]
      };
    }
  };
  const backend = new AwsSecretsManagerBackend(client as never);
  assert.deepEqual(await backend.listKeys({ userId: "1", project: "demo", env: "dev" }), ["ALPHA", "BETA"]);
});

test("deleteSecret uses a 7-day recovery window and is idempotent", async () => {
  const sent: Array<{ name: string; recovery?: number }> = [];
  let missing = false;
  const client = {
    async send(command: unknown) {
      assert(command instanceof DeleteSecretCommand);
      sent.push({
        name: command.input.SecretId || "",
        recovery: command.input.RecoveryWindowInDays
      });
      if (missing) throw new ResourceNotFoundException({ message: "missing", $metadata: {} });
      return {};
    }
  };
  const backend = new AwsSecretsManagerBackend(client as never);
  const ref = { userId: "123", project: "demo", env: "production", key: "KEY" };

  await backend.deleteSecret(ref);
  missing = true;
  await backend.deleteSecret(ref);

  assert.deepEqual(sent, [
    { name: secretName(ref), recovery: 7 },
    { name: secretName(ref), recovery: 7 }
  ]);
});

void CreateSecretCommand;
void PutSecretValueCommand;
void DeleteSecretCommand;

function commandName(command: unknown): string {
  return (command as { constructor: { name: string } }).constructor.name;
}
