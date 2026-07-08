import {
  CreateSecretCommand,
  GetSecretValueCommand,
  PutSecretValueCommand,
  ResourceNotFoundException,
  SecretsManagerClient
} from "@aws-sdk/client-secrets-manager";

export interface TokenRevocationStore {
  isRevoked(jti: string): Promise<boolean>;
  revoke(jti: string): Promise<void>;
}

export class MemoryTokenRevocationStore implements TokenRevocationStore {
  readonly revoked = new Set<string>();

  async isRevoked(jti: string): Promise<boolean> {
    return this.revoked.has(jti);
  }

  async revoke(jti: string): Promise<void> {
    this.revoked.add(jti);
  }
}

export class AwsSecretsManagerTokenRevocationStore implements TokenRevocationStore {
  readonly client: SecretsManagerClient;
  readonly secretName: string;

  constructor(client = new SecretsManagerClient({}), secretName = "/juice/token-revocations") {
    this.client = client;
    this.secretName = secretName;
  }

  async isRevoked(jti: string): Promise<boolean> {
    const revoked = await this.readRevocations();
    return revoked.revoked.includes(jti);
  }

  async revoke(jti: string): Promise<void> {
    const revoked = await this.readRevocations();
    if (!revoked.revoked.includes(jti)) revoked.revoked.push(jti);
    revoked.updatedAt = new Date().toISOString();

    // This deliberately starts as a single JSON secret to keep the self-hosted
    // server dependency surface tiny. Multi-writer or high-volume deployments
    // should move this interface to DynamoDB with conditional writes.
    try {
      await this.client.send(new PutSecretValueCommand({
        SecretId: this.secretName,
        SecretString: JSON.stringify(revoked)
      }));
    } catch (error) {
      if (!isNotFound(error)) throw error;
      await this.client.send(new CreateSecretCommand({
        Name: this.secretName,
        SecretString: JSON.stringify(revoked)
      }));
    }
  }

  private async readRevocations(): Promise<{ revoked: string[]; updatedAt?: string }> {
    try {
      const response = await this.client.send(new GetSecretValueCommand({ SecretId: this.secretName }));
      const parsed = JSON.parse(response.SecretString || "{}") as { revoked?: unknown; updatedAt?: string };
      return {
        revoked: Array.isArray(parsed.revoked) ? parsed.revoked.filter((jti): jti is string => typeof jti === "string") : [],
        updatedAt: parsed.updatedAt
      };
    } catch (error) {
      if (isNotFound(error)) return { revoked: [] };
      throw error;
    }
  }
}

function isNotFound(error: unknown): boolean {
  return error instanceof ResourceNotFoundException ||
    (typeof error === "object" && error !== null && "name" in error && error.name === "ResourceNotFoundException");
}
