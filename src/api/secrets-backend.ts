export type SecretRef = {
  userId: string;
  project: string;
  env: string;
  key: string;
};

export interface SecretsBackend {
  getSecret(ref: SecretRef): Promise<string | undefined>;
  putSecret(ref: SecretRef, value: string): Promise<void>;
}
