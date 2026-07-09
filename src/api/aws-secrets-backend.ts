import {
  CreateSecretCommand,
  DeleteSecretCommand,
  DescribeSecretCommand,
  GetSecretValueCommand,
  ListSecretsCommand,
  PutSecretValueCommand,
  ResourceNotFoundException,
  SecretsManagerClient
} from "@aws-sdk/client-secrets-manager";
import type { SecretListRef, SecretRef, SecretsBackend } from "./secrets-backend.js";

export class AwsSecretsManagerBackend implements SecretsBackend {
  readonly client: SecretsManagerClient;

  constructor(client = new SecretsManagerClient({})) {
    this.client = client;
  }

  async getSecret(ref: SecretRef): Promise<string | undefined> {
    try {
      const response = await this.client.send(new GetSecretValueCommand({ SecretId: secretName(ref) }));
      return response.SecretString;
    } catch (error) {
      if (isNotFound(error)) return undefined;
      throw error;
    }
  }

  async putSecret(ref: SecretRef, value: string): Promise<void> {
    const name = secretName(ref);
    try {
      await this.client.send(new DescribeSecretCommand({ SecretId: name }));
      await this.client.send(new PutSecretValueCommand({ SecretId: name, SecretString: value }));
    } catch (error) {
      if (!isNotFound(error)) throw error;
      await this.client.send(new CreateSecretCommand({ Name: name, SecretString: value }));
    }
  }

  /**
   * ListSecrets cannot be IAM-scoped by name prefix. Callers must only pass a
   * ref derived from the authenticated principal; this method still filters to
   * that exact prefix so account-wide enumeration cannot leak other tenants.
   */
  async listKeys(ref: SecretListRef): Promise<string[]> {
    const prefix = secretPrefix(ref);
    const keys = new Set<string>();
    let nextToken: string | undefined;
    do {
      const response = await this.client.send(new ListSecretsCommand({
        MaxResults: 100,
        NextToken: nextToken,
        Filters: [{ Key: "name", Values: [prefix] }]
      }));
      for (const secret of response.SecretList ?? []) {
        const name = secret.Name;
        if (!name || !name.startsWith(prefix)) continue;
        const key = name.slice(prefix.length);
        if (key && !key.includes("/")) keys.add(decodeURIComponent(key));
      }
      nextToken = response.NextToken;
    } while (nextToken);
    return [...keys].sort();
  }

  async deleteSecret(ref: SecretRef): Promise<void> {
    try {
      await this.client.send(new DeleteSecretCommand({
        SecretId: secretName(ref),
        RecoveryWindowInDays: 7
      }));
    } catch (error) {
      if (isNotFound(error)) return;
      throw error;
    }
  }
}

export function secretName(ref: SecretRef): string {
  return `${secretPrefix(ref)}${segment(ref.key)}`;
}

export function secretPrefix(ref: SecretListRef): string {
  return `/juice/users/${segment(ref.userId)}/projects/${segment(ref.project)}/envs/${segment(ref.env)}/secrets/`;
}

function segment(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error("Secret path segments cannot be empty.");
  return encodeURIComponent(trimmed);
}

function isNotFound(error: unknown): boolean {
  return error instanceof ResourceNotFoundException ||
    (typeof error === "object" && error !== null && "name" in error && error.name === "ResourceNotFoundException");
}
