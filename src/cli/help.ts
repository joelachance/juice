/**
 * The help screen, kept away from the code it documents so neither drifts
 * because the other was inconvenient to edit.
 */
import { getToken } from "../auth/token-store.js";

export const juiceLogoRaw = String.raw`       __
      / /_  __(_)_______
 __  / / / / / / ___/ _ \
/ /_/ / /_/ / / /__/  __/
\____/\__,_/_/\___/\___/`;

const juiceTagline = "agent secrets without copy/paste";

export function rootHelpText(options: { authConfigured?: boolean } = {}): string {
  const authConfigured = options.authConfigured ?? Boolean(getToken());
  const authLine = authConfigured ? "● Token configured" : "● Not signed in  juice auth login";
  return `${juiceLogoRaw}
${juiceTagline}
${authLine}

$ juice help

Usage:
  juice [command] --scope <name>

Setup:
  auth login Authenticate with Juice
  scopes     List scopes used on this machine

Account:
  members        List who can read this account's secrets
  members invite Create a single-use invite code
  join CODE      Join an account with an invite code

Secrets:
  set KEY    Add or replace a secret (prompt, or --stdin)
  list       List secret key names (never values)
  unset KEY  Remove a secret
  export     Write every key in a scope to a file
  get KEY    Print one value to stdout (debugging; apps use the SDK)

Tokens:
  token create   Create a scoped machine token
  token revoke   Revoke current token, or revoke by full token

Help:
  help       Help screen

Flags:
  --scope NAME     Which scope to act on (repeatable on export)
  --env NAME       Environment: development (default), staging, production…
  --local          Force the local store
  --remote         Force the remote API
  --stdin          Read the value for \`set\` from stdin
  --to PATH        Destination for \`export\`
  --format FMT     \`export\` format: sh (default) or dotenv
  --force          Let \`export\` write inside a git repository
  --yes, -y        Skip confirmation prompts
  -h, --help       help for juice

Scope is never inferred. Pass --scope or set JUICE_SCOPE; run interactively and
Juice offers the scopes you have used before. Without either, it is an error.

Secrets live in ~/.juice/scopes/<scope>/<env>.env for development, and in the
Juice API for every other env. Reading in an app is the SDK's job:

  const secrets = juice.scope("my-scope");
  await secrets.get("MY_KEY");

Mode: JUICE_ENV → APP_ENV → NODE_ENV → development; JUICE_REMOTE=1 forces remote.
--remote and --local are mutually exclusive.`;
}

