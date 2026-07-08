import assert from "node:assert/strict";
import test from "node:test";
import {
  CreateSecretCommand,
  DescribeSecretCommand,
  GetSecretValueCommand,
  PutSecretValueCommand,
  ResourceNotFoundException
} from "@aws-sdk/client-secrets-manager";
import { AwsSecretsManagerBackend, secretName } from "../src/api/aws-secrets-backend.js";

test("secretName builds deterministic AWS Secrets Manager paths", () => {
  assert.equal(
    secretName({ userId: "123", project: "@scope/demo", env: "production", key: "OPENAI_API_KEY" }),
    "/juice/users/123/projects/%40scope%2Fdemo/envs/production/secrets/OPENAI_API_KEY"
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

void CreateSecretCommand;
void PutSecretValueCommand;

function commandName(command: unknown): string {
  return (command as { constructor: { name: string } }).constructor.name;
}
