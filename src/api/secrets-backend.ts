export type SecretRef = {
  userId: string;
  project: string;
  env: string;
  key: string;
};

export type SecretListRef = {
  userId: string;
  project: string;
  env: string;
};

export interface SecretsBackend {
  getSecret(ref: SecretRef): Promise<string | undefined>;
  putSecret(ref: SecretRef, value: string): Promise<void>;
  listKeys(ref: SecretListRef): Promise<string[]>;
  deleteSecret(ref: SecretRef): Promise<void>;
}
