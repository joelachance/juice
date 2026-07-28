/**
 * Naming rules for the `project / env / key` triple that addresses a secret.
 *
 * These used to be percent-encoded on the way into an AWS Secrets Manager name.
 * That is wrong in a way that only shows up against real AWS: a secret name may
 * contain `A-Za-z0-9/_+=.@-` and nothing else, so `%` is itself illegal. Any
 * project whose name needed encoding produced a name AWS rejects — including
 * every scoped npm package, since `@acme/api` encodes to `%40acme%2Fapi` and
 * project names are read straight out of `package.json`.
 *
 * So: validate instead of encode. Names stay readable, stay round-trippable,
 * and path traversal is rejected at the door rather than escaped into something
 * that looks safe.
 *
 * A scope may contain `/`, so it can be hierarchical (`yeet/agents/fix-auth`).
 * Nothing else may — otherwise `projects/<scope>/envs/<env>` is ambiguous, and
 * scope `a` + env `b/envs/dev` would address the same secret as scope
 * `a/envs/b` + env `dev`, which is a tenant-isolation bug rather than a
 * cosmetic one.
 */

/** The Secrets Manager charset, minus `/`. */
const SEGMENT = /^[A-Za-z0-9_+=.@-]+$/;

const SEGMENT_RULE = "letters, digits, and _ + = . @ -";

/** One path component: no slashes, no traversal. */
export function assertSegment(label: string, value: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error(`${label} cannot be empty.`);
  if (!SEGMENT.test(trimmed)) {
    throw new Error(`Invalid ${label}: ${JSON.stringify(value)} — use ${SEGMENT_RULE}.`);
  }
  if (trimmed === "." || trimmed === "..") throw new Error(`Invalid ${label}: ${JSON.stringify(value)}.`);
  return trimmed;
}

/** A scope (a.k.a. project): one or more segments joined by `/`. */
export function assertScope(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error("Scope cannot be empty.");
  if (trimmed.startsWith("/") || trimmed.endsWith("/") || trimmed.includes("//")) {
    throw new Error(`Invalid scope: ${JSON.stringify(value)} — no leading, trailing, or repeated "/".`);
  }
  return trimmed.split("/").map((part) => assertSegment("scope segment", part)).join("/");
}

/** Split a validated scope into filesystem-safe path components. */
export function scopeSegments(scope: string): string[] {
  return assertScope(scope).split("/");
}

