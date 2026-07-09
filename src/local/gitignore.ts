import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const JUICE_GITIGNORE_MARKER = "# juice — ignore local secrets and state";

export const JUICE_GITIGNORE_BLOCK = `${JUICE_GITIGNORE_MARKER}
.env
.env.*
.juice/
`;

export type GitignoreEnsureResult = {
  added: boolean;
  path: string;
};

/** Append the juice-managed gitignore block once. Idempotent when the marker is already present. */
export function ensureJuiceGitignore(projectRoot: string): GitignoreEnsureResult {
  const path = join(projectRoot, ".gitignore");
  if (existsSync(path)) {
    const existing = readFileSync(path, "utf8");
    if (existing.includes(JUICE_GITIGNORE_MARKER)) {
      return { added: false, path };
    }
    const separator = existing.length === 0 || existing.endsWith("\n") ? "" : "\n";
    appendFileSync(path, `${separator}\n${JUICE_GITIGNORE_BLOCK}`);
    return { added: true, path };
  }
  writeFileSync(path, `${JUICE_GITIGNORE_BLOCK}\n`, { encoding: "utf8" });
  return { added: true, path };
}
