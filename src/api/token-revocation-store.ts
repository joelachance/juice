import {
  CreateSecretCommand,
  GetSecretValueCommand,
  PutSecretValueCommand,
  ResourceNotFoundException,
  SecretsManagerClient
} from "@aws-sdk/client-secrets-manager";

export interface TokenRevocationStore {
  isRevoked(jti: string): Promise<boolean>;
  revoke(jti: string, owner: string): Promise<void>;
}

export const REVOCATION_CACHE_TTL_MS = 5000;

type RevokedEntry = {
  jti: string;
  sub: string;
  revokedAt: string;
};

type RevocationDocument = {
  revoked: RevokedEntry[];
  updatedAt?: string;
};

export class MemoryTokenRevocationStore implements TokenRevocationStore {
  readonly revoked = new Set<string>();

  async isRevoked(jti: string): Promise<boolean> {
    return this.revoked.has(jti);
  }

  async revoke(jti: string, _owner: string): Promise<void> {
    this.revoked.add(jti);
  }
}

export class AwsSecretsManagerTokenRevocationStore implements TokenRevocationStore {
  readonly client: SecretsManagerClient;
  readonly secretName: string;
  readonly cacheTtlMs: number;
  private cache?: { document: RevocationDocument; jtis: Set<string>; expiresAt: number };

  constructor(
    client = new SecretsManagerClient({}),
    secretName = "/juice/token-revocations",
    cacheTtlMs = REVOCATION_CACHE_TTL_MS
  ) {
    this.client = client;
    this.secretName = secretName;
    this.cacheTtlMs = cacheTtlMs;
  }

  async isRevoked(jti: string): Promise<boolean> {
    const now = Date.now();
    if (this.cache && this.cache.expiresAt > now) return this.cache.jtis.has(jti);

    try {
      const revoked = await this.readRevocations();
      this.updateCache(revoked);
      return this.cache?.jtis.has(jti) ?? false;
    } catch (error) {
      if (this.cache) return this.cache.jtis.has(jti);
      // Availability-vs-strictness tradeoff: a fresh deploy with a throttled
      // revocation secret should not brick all auth. Token blast radius is
      // bounded by exp; DynamoDB with conditional reads is the durable answer.
      console.error(JSON.stringify({
        ts: new Date().toISOString(),
        level: "error",
        message: "Token revocation read failed; allowing token",
        error: error instanceof Error ? error.message : String(error)
      }));
      return false;
    }
  }

  async revoke(jti: string, owner: string): Promise<void> {
    const revoked = await this.readRevocations();
    if (!revoked.revoked.some((entry) => entry.jti === jti)) {
      revoked.revoked.push({ jti, sub: owner, revokedAt: new Date().toISOString() });
    }
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
    this.updateCache(revoked);
  }

  private async readRevocations(): Promise<RevocationDocument> {
    try {
      const response = await this.client.send(new GetSecretValueCommand({ SecretId: this.secretName }));
      const parsed = JSON.parse(response.SecretString || "{}") as { revoked?: unknown; updatedAt?: string };
      return {
        revoked: parseRevokedEntries(parsed.revoked),
        updatedAt: parsed.updatedAt
      };
    } catch (error) {
      if (isNotFound(error)) return { revoked: [] };
      throw error;
    }
  }

  private updateCache(document: RevocationDocument): void {
    this.cache = {
      document,
      jtis: new Set(document.revoked.map((entry) => entry.jti)),
      expiresAt: Date.now() + this.cacheTtlMs
    };
  }
}

function parseRevokedEntries(value: unknown): RevokedEntry[] {
  if (!Array.isArray(value)) return [];
  const entries: RevokedEntry[] = [];
  for (const entry of value) {
    if (typeof entry === "string") {
      entries.push({ jti: entry, sub: "", revokedAt: "" });
      continue;
    }
    if (
      typeof entry === "object" &&
      entry !== null &&
      "jti" in entry &&
      typeof entry.jti === "string"
    ) {
      entries.push({
        jti: entry.jti,
        sub: "sub" in entry && typeof entry.sub === "string" ? entry.sub : "",
        revokedAt: "revokedAt" in entry && typeof entry.revokedAt === "string" ? entry.revokedAt : ""
      });
    }
  }
  return entries;
}

function isNotFound(error: unknown): boolean {
  return error instanceof ResourceNotFoundException ||
    (typeof error === "object" && error !== null && "name" in error && error.name === "ResourceNotFoundException");
}
