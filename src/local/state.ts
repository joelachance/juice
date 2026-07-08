import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export type JuiceState = {
  envFingerprint?: string;
};

export function statePath(projectRoot: string): string {
  return join(projectRoot, ".juice", "state.json");
}

export function fingerprintFile(filePath: string): string {
  const hash = createHash("sha256");
  if (existsSync(filePath)) hash.update(readFileSync(filePath));
  return hash.digest("hex");
}

export function readState(projectRoot: string): JuiceState {
  const file = statePath(projectRoot);
  if (!existsSync(file)) return {};
  try {
    return JSON.parse(readFileSync(file, "utf8")) as JuiceState;
  } catch {
    return {};
  }
}

export function writeState(projectRoot: string, state: JuiceState): void {
  const file = statePath(projectRoot);
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
}

export function hasEnvDrift(projectRoot: string, envFile: string): boolean {
  const state = readState(projectRoot);
  return Boolean(state.envFingerprint && state.envFingerprint !== fingerprintFile(envFile));
}

export function recordEnvFingerprint(projectRoot: string, envFile: string): void {
  writeState(projectRoot, { ...readState(projectRoot), envFingerprint: fingerprintFile(envFile) });
}
