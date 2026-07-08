import {
  CreateSecretCommand,
  DescribeSecretCommand,
  GetSecretValueCommand,
  PutSecretValueCommand,
  ResourceNotFoundException,
  SecretsManagerClient
} from "@aws-sdk/client-secrets-manager";
import type { SecretRef, SecretsBackend } from "./secrets-backend.js";

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
}

export function secretName(ref: SecretRef): string {
  return `/juice/users/${segment(ref.userId)}/projects/${segment(ref.project)}/envs/${segment(ref.env)}/secrets/${segment(ref.key)}`;
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
