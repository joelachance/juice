/**
 * Turning argv into an `Args`.
 *
 * The two rules worth knowing are both here, and both were bugs: commands and
 * keys come from *positionals* rather than fixed argv slots, so a leading flag
 * cannot be mistaken for either; and a value-taking flag with a missing value
 * is an error, never a silent fallback to the default.
 */
import type { ExportFormat } from "../local/dotenv.js";

/** Commands whose first positional after the command name is a secret key. */
export const KEY_COMMANDS = new Set(["set", "get", "unset"]);

/** Flags that consume the next argv entry, so positionals can be counted. */
const VALUE_FLAGS = new Set(["--scope", "--env", "--to", "--format", "--ttl"]);

export type Args = {
  command?: string;
  subcommand?: string;
  key?: string;
  positionals: string[];
  scopes: string[];
  env?: string;
  to?: string;
  format: ExportFormat;
  force: boolean;
  stdin: boolean;
  ttlSeconds?: number;
  readOnly: boolean;
  jti?: string;
  remote: boolean;
  local: boolean;
  yes: boolean;
  help: boolean;
};

export function parseArgs(flagArgv: string[]): Args {
  const positionals = positionalArgs(flagArgv);
  // The command comes from positionals too, so a leading flag does not become
  // the command: `juice --local set K` used to parse its command as "--local".
  const command = positionals[0];

  // Defaults to `sh`, not `dotenv`. `export` exists for files that get sourced,
  // and the dotenv writer double-quotes — under `source` the shell still
  // expands `$(…)` and backticks inside double quotes. The unsafe format has to
  // be the one you opt into, not the one you get by forgetting a flag.
  const format = flagValue(flagArgv, "--format") ?? "sh";
  if (format !== "dotenv" && format !== "sh") {
    throw new Error(`Invalid --format: ${format} (expected "dotenv" or "sh")`);
  }
  return {
    command,
    // From positionals, not argv[1]: `juice unset --yes MYKEY` used to take
    // "--yes" as the key, report "--yes is not set." and exit 0.
    subcommand: positionals[1],
    key: command && KEY_COMMANDS.has(command) ? positionals[1] : undefined,
    positionals,
    scopes: flagValues(flagArgv, "--scope"),
    env: flagValue(flagArgv, "--env"),
    to: flagValue(flagArgv, "--to"),
    format,
    force: flagArgv.includes("--force"),
    stdin: flagArgv.includes("--stdin"),
    ttlSeconds: parseTtl(flagValue(flagArgv, "--ttl")),
    readOnly: flagArgv.includes("--read-only"),
    jti: command === "token" && positionals[1] === "revoke" ? positionals[2] : undefined,
    remote: flagArgv.includes("--remote"),
    local: flagArgv.includes("--local"),
    yes: flagArgv.includes("--yes") || flagArgv.includes("-y"),
    help: flagArgv.includes("--help") || flagArgv.includes("-h")
  };
}

function positionalArgs(argv: string[]): string[] {
  const out: string[] = [];
  for (let index = 0; index < argv.length; index++) {
    const entry = argv[index];
    if (VALUE_FLAGS.has(entry)) {
      index++;
      continue;
    }
    if (entry.startsWith("-")) continue;
    out.push(entry);
  }
  return out;
}

function flagValue(argv: string[], flag: string): string | undefined {
  const index = argv.indexOf(flag);
  if (index < 0) return undefined;
  const value = argv[index + 1];
  // A flag that names a destination must not quietly become "use the default
  // destination" when its value goes missing.
  if (value === undefined || value.trim() === "" || value.startsWith("--")) {
    throw new Error(`${flag} needs a value${value?.startsWith("--") ? `, but got the flag ${value}` : ""}.`);
  }
  return value;
}

/**
 * Repeated flag values, strict about a missing or empty one. Silently dropping
 * `--scope ""` would put secrets somewhere other than where they were asked to
 * go, and `--scope "$VAR"` with VAR unset is the everyday way to produce it.
 */
function flagValues(argv: string[], flag: string): string[] {
  const out: string[] = [];
  for (let index = 0; index < argv.length; index++) {
    if (argv[index] !== flag) continue;
    const value = argv[index + 1];
    if (value === undefined || value.trim() === "") {
      throw new Error(`${flag} needs a value.`);
    }
    if (value.startsWith("--")) {
      throw new Error(`${flag} needs a value, but got the flag ${value}.`);
    }
    out.push(value);
    index++;
  }
  return out;
}

function parseTtl(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const match = /^(\d+)([smhd])?$/.exec(value);
  if (!match) throw new Error(`Invalid ttl: ${value}`);
  const amount = Number.parseInt(match[1], 10);
  const unit = match[2] || "s";
  const multiplier = unit === "s" ? 1 : unit === "m" ? 60 : unit === "h" ? 60 * 60 : 24 * 60 * 60;
  return amount * multiplier;
}

