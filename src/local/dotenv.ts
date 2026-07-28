import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { mkdirSync } from "node:fs";

const JUICE_MARKER_PREFIX = "# juice: added ";

/** The one place a `KEY=` line is recognised. Everything else must reuse it. */
const KEY_LINE = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/;

/** Returns the key a line assigns, or undefined. Leading whitespace is allowed. */
export function dotEnvLineKey(rawLine: string): string | undefined {
  return KEY_LINE.exec(rawLine.trim())?.[1];
}

export function readDotEnv(filePath: string): Record<string, string> {
  // Null-prototype: a plain object makes `values["constructor"]` and
  // `"toString" in values` truthy, so `juice get constructor` printed
  // "[Function: Object]" with exit 0 and `unset toString` claimed success.
  const values: Record<string, string> = Object.create(null);
  if (!existsSync(filePath)) return values;
  for (const rawLine of readFileSync(filePath, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    values[match[1]] = parseDotEnvValue(match[2]);
  }
  return values;
}

/**
 * Upsert `key`. Replaces in place when the key is already present, preserving
 * its position, and appends otherwise.
 *
 * This used to append unconditionally. Reads still came out right, because
 * `readDotEnv` is last-wins — but every re-set left the *previous* secret value
 * sitting in the file forever, which is the opposite of what someone rotating a
 * leaked credential is trying to achieve.
 */
export function setDotEnvValue(filePath: string, key: string, value: string, envName: string): void {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
    throw new Error(`Invalid environment variable name: ${key}`);
  }
  mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 });
  const marker = `${JUICE_MARKER_PREFIX}${new Date().toISOString()} env=${envName}`;
  const line = `${key}=${formatDotEnvValue(value)}`;

  if (!existsSync(filePath)) {
    writeFileSync(filePath, `${marker}\n${line}\n`, { encoding: "utf8", mode: 0o600 });
    return;
  }

  const lines = readFileSync(filePath, "utf8").split(/\r?\n/);
  const kept: string[] = [];
  let replaced = false;

  for (const current of lines) {
    if (dotEnvLineKey(current) === key) {
      // Drop the stale marker that belonged to the value being replaced.
      if (kept.length > 0 && kept[kept.length - 1].startsWith(JUICE_MARKER_PREFIX)) kept.pop();
      if (!replaced) {
        kept.push(marker, line);
        replaced = true;
      }
      continue;
    }
    kept.push(current);
  }

  if (!replaced) {
    while (kept.length > 0 && kept[kept.length - 1] === "") kept.pop();
    if (kept.length > 0) kept.push("");
    kept.push(marker, line);
  }

  writeFileSync(filePath, `${trimTrailingBlanks(kept).join("\n")}\n`, { encoding: "utf8", mode: 0o600 });
  chmodSync(filePath, 0o600);
}

function trimTrailingBlanks(lines: string[]): string[] {
  const copy = [...lines];
  while (copy.length > 0 && copy[copy.length - 1] === "") copy.pop();
  return copy;
}

/** Remove KEY= lines and an immediately preceding `# juice: added …` marker. Returns true if any KEY line was removed. */
export function removeDotEnvKey(filePath: string, key: string): boolean {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
    throw new Error(`Invalid environment variable name: ${key}`);
  }
  if (!existsSync(filePath)) return false;

  const lines = readFileSync(filePath, "utf8").split(/\r?\n/);
  const kept: string[] = [];
  let removed = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (dotEnvLineKey(line) === key) {
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
  // `mode` only applies when creating; an existing file keeps whatever bits it had.
  chmodSync(filePath, 0o600);
  return true;
}

function parseDotEnvValue(value: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2) {
    return unescapeDoubleQuotedBody(trimmed.slice(1, -1));
  }
  if (trimmed.startsWith("'") && trimmed.endsWith("'")) return trimmed.slice(1, -1);
  const hashIndex = trimmed.indexOf(" #");
  return hashIndex >= 0 ? trimmed.slice(0, hashIndex).trimEnd() : trimmed;
}

/**
 * The writer escapes with `JSON.stringify`, so the reader parses with
 * `JSON.parse` — anything else is asymmetric and silently corrupts values.
 * Hand-rolling the unescape missed every form `JSON.stringify` emits beyond
 * `\n`/`\r`/`\t`: a control character came back as the literal `u0001`, and
 * `\b` as `b`.
 *
 * A hand-written `.env` need not be valid JSON, so an unparsable value falls
 * back to the lenient reader rather than failing the whole file.
 */
function unescapeDoubleQuotedBody(body: string): string {
  try {
    const parsed = JSON.parse(`"${body}"`) as unknown;
    if (typeof parsed === "string") return parsed;
  } catch {
    // Not JSON-escaped; fall through.
  }
  return lenientUnescape(body);
}

/**
 * Single pass, because chained `.replace()` calls unescape their own output:
 * `"a\\nb"` (a literal backslash then `n`) had its `\\` collapsed to `\`, and
 * the resulting `\n` was then read as a newline by the next replace.
 */
function lenientUnescape(body: string): string {
  let out = "";
  for (let index = 0; index < body.length; index++) {
    if (body[index] !== "\\") {
      out += body[index];
      continue;
    }
    const next = body[++index];
    if (next === undefined) return `${out}\\`;
    out += next === "n" ? "\n" : next === "r" ? "\r" : next === "t" ? "\t" : next;
  }
  return out;
}

function formatDotEnvValue(value: string): string {
  if (/^[A-Za-z0-9_./:@-]+$/.test(value)) return value;
  return JSON.stringify(value);
}
