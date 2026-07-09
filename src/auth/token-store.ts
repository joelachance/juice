import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir, platform } from "node:os";

const service = "juice";
const account = "machine-token";

export function juiceHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.JUICE_HOME?.trim() || join(homedir(), ".juice");
}

export function getToken(env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (env.JUICE_TOKEN?.trim()) return env.JUICE_TOKEN.trim();
  const keychain = readMacKeychain();
  if (keychain) return keychain;
  const file = tokenFile(env);
  if (!existsSync(file)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as { token?: string };
    return parsed.token?.trim() || undefined;
  } catch {
    return undefined;
  }
}

export function setToken(token: string, env: NodeJS.ProcessEnv = process.env): void {
  if (writeMacKeychain(token)) return;
  const file = tokenFile(env);
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, `${JSON.stringify({ token }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
}

function tokenFile(env: NodeJS.ProcessEnv): string {
  return join(juiceHome(env), "token.json");
}

function readMacKeychain(): string | undefined {
  if (platform() !== "darwin") return undefined;
  try {
    return execFileSync("security", ["find-generic-password", "-s", service, "-a", account, "-w"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    }).trim() || undefined;
  } catch {
    return undefined;
  }
}

function writeMacKeychain(token: string): boolean {
  if (platform() !== "darwin") return false;
  try {
    execFileSync("security", ["delete-generic-password", "-s", service, "-a", account], {
      stdio: "ignore"
    });
  } catch {
    // Missing existing token is fine.
  }
  try {
    // Omit -w value so the secret is read from stdin (password + retype), not argv.
    execFileSync("security", ["add-generic-password", "-s", service, "-a", account, "-U", "-w"], {
      input: `${token}\n${token}\n`,
      stdio: ["pipe", "ignore", "ignore"]
    });
    return true;
  } catch {
    return false;
  }
}
