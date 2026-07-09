import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { mkdirSync } from "node:fs";

const JUICE_MARKER_PREFIX = "# juice: added ";

export function readDotEnv(filePath: string): Record<string, string> {
  if (!existsSync(filePath)) return {};
  const values: Record<string, string> = {};
  for (const rawLine of readFileSync(filePath, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    values[match[1]] = parseDotEnvValue(match[2]);
  }
  return values;
}

export function appendDotEnvValue(filePath: string, key: string, value: string, envName: string): void {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
    throw new Error(`Invalid environment variable name: ${key}`);
  }
  mkdirSync(dirname(filePath), { recursive: true });
  const timestamp = new Date().toISOString();
  const block = `\n# juice: added ${timestamp} env=${envName}\n${key}=${formatDotEnvValue(value)}\n`;
  appendFileSync(filePath, block, { encoding: "utf8", mode: 0o600 });
}

/** Remove KEY= lines and an immediately preceding `# juice: added …` marker. Returns true if any KEY line was removed. */
export function removeDotEnvKey(filePath: string, key: string): boolean {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
    throw new Error(`Invalid environment variable name: ${key}`);
  }
  if (!existsSync(filePath)) return false;

  const lines = readFileSync(filePath, "utf8").split(/\r?\n/);
  const keyLine = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/;
  const kept: string[] = [];
  let removed = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const match = keyLine.exec(line);
    if (match?.[1] === key) {
      if (kept.length > 0 && kept[kept.length - 1].startsWith(JUICE_MARKER_PREFIX)) {
        kept.pop();
      }
      removed = true;
      continue;
    }
    kept.push(line);
  }

  if (!removed) return false;

  // Preserve a trailing newline when the original file had content.
  const body = kept.join("\n");
  const endsWithNewline = lines.length > 0 && lines[lines.length - 1] === "";
  writeFileSync(filePath, endsWithNewline || body === "" ? body : `${body}\n`, { encoding: "utf8", mode: 0o600 });
  return true;
}

function parseDotEnvValue(value: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed.slice(1, -1).replace(/\\n/g, "\n").replace(/\\"/g, '"').replace(/\\\\/g, "\\");
  }
  if (trimmed.startsWith("'") && trimmed.endsWith("'")) return trimmed.slice(1, -1);
  const hashIndex = trimmed.indexOf(" #");
  return hashIndex >= 0 ? trimmed.slice(0, hashIndex).trimEnd() : trimmed;
}

function formatDotEnvValue(value: string): string {
  if (/^[A-Za-z0-9_./:@-]+$/.test(value)) return value;
  return JSON.stringify(value);
}
