# Juice

**Agent secrets without copy/paste.**

The CLI writes. The SDK reads. Nothing is inferred.

```sh
juice set OPENAI_API_KEY --scope my-app     # prompts; the value is never echoed
```

```ts
import { juice } from "@juice/sdk";

const secrets = juice.scope("my-app");
const apiKey = await secrets.get("OPENAI_API_KEY");
```

That is the whole model. There is no `.env` file to manage, nothing to add to
`.gitignore`, and no project to initialise.

## Install

```sh
npm i @juice/sdk
```

No server and no login is required for local development.

## Scopes

Every secret belongs to exactly one **scope** — the unit that owns it. A scope
is an opaque name, and may nest with `/`:

```sh
juice set DATABASE_URL --scope my-app
juice set OPENROUTER_API_KEY --scope my-app/agents/fix-auth
```

**Juice never guesses a scope.** It does not read `package.json`, and it does
not care which directory you are in. Earlier versions inferred one by walking up
for a repo, which is convenient right up until it is wrong — and when it is
wrong it is silent, so secrets land somewhere you did not look. A scope comes
from one of three places, in order:

| Source | Use |
|---|---|
| `--scope <name>` | Explicit, per command |
| `JUICE_SCOPE` | Shell profile, direnv, CI |
| an interactive prompt | Offers scopes you have used before |

If none applies and there is no terminal to ask — a script, a CI job, an agent —
that is an error, never a default.

```sh
juice scopes        # scopes this machine has used, most recent first
```

There is deliberately **no inheritance**. `my-app/agents/x` does not fall back
to `my-app`. Falling back would mean `juice unset` could appear to remove a
secret while quietly revealing a broader one underneath, and would silently
widen every machine token to its whole chain. Compose explicitly instead —
`juice export` takes several `--scope` flags.

## Environments

The second axis is `--env`: `development` (the default), `staging`,
`production`, whatever you like. It picks the file **and the source**:

| env | where the secret lives |
|---|---|
| `development` / `local` | `~/.juice/scopes/<scope>/development.env` on your disk — no server, no login |
| anything else | AWS Secrets Manager, via the Juice API |

So "development" is not a label on a remote secret. In development Juice never
contacts a server at all.

Resolution order for the env name: `JUICE_ENV` → `APP_ENV` → `NODE_ENV` →
`development`. `--env` overrides it; `JUICE_REMOTE=1` forces remote; `--local`
and `--remote` force a source regardless of env name.

## Writing secrets

```sh
juice set KEY --scope my-app                 # hidden prompt
printf %s "$VALUE" | juice set KEY --scope my-app --stdin   # scripted
juice list --scope my-app                    # key names only, never values
juice unset KEY --scope my-app --yes
```

A value is never accepted as an argument. `juice set KEY value` is **refused**,
because by the time you regret it, it is in `ps` and in your shell history and
deleting it later does not help. Use the prompt or `--stdin`.

Re-setting a key replaces it. The old value does not stay in the file.

## Reading in code

```ts
import { juice } from "@juice/sdk";

const secrets = juice.scope("my-app");
const apiKey = await secrets.get("OPENAI_API_KEY");
```

The scope is declared once, in code, and cannot be wrong at deploy time. The
env axis stays environmental, since dev-vs-prod genuinely is deployment config:

```ts
juice.scope("my-app", { env: "staging" });          // override if you must
await juice.get("KEY", { scope: "my-app" });        // one-shot form
```

`get` memoises. Concurrent reads of the same key collapse into one request, and
resolved values are cached for `JUICE_CACHE_TTL` seconds (default `300`, `0`
disables). Failures are never cached. The TTL exists so rotating a credential
takes effect without a restart — in a long-lived process that rotates on
demand, call `juice.clearCache()`. Local reads are not cached at all.

## Exporting to a file

The SDK only helps if the consumer is a Node process. When it is not — a VM or
sandbox that sources a file at boot, a Python service, a container entrypoint —
write the scope out:

```sh
juice export --scope my-app --to ./run.env
juice export --scope my-app/global --scope my-app/agents/a --to ./run.env
```

Later `--scope` flags win on conflict. The write is atomic and `0600`, and it
refuses to write inside a git repository unless you pass `--force` — anything
working in that repo could otherwise commit it.

The default format is `sh` (`export KEY='…'`), which single-quotes and expands
nothing, so it is safe to `source`. `--format dotenv` double-quotes: correct for
a dotenv parser, **unsafe for a shell**, because the shell still expands `$(…)`
and backticks inside double quotes — a secret containing a command substitution
would execute on `source`. Juice warns when a dotenv export contains shell
metacharacters.

There is no `--json` or stdout form. A command that prints secrets is one an
agent runs before the values are in a transcript forever.

## Agents

Copy [`docs/AGENTS.snippet.md`](docs/AGENTS.snippet.md) into your `AGENTS.md`
or `CLAUDE.md`.

## Remote

```sh
juice auth login
juice set OPENAI_API_KEY --scope my-app --env production
juice list --scope my-app --env production
```

Remote secrets belong to an **account**, not to a GitHub user. Logging in for
the first time creates a personal account; GitHub is a way to sign in to it, not
the thing that owns the data. That indirection is what lets a second person, a
second login provider, or a machine principal join later without renaming a
single stored secret.

## Sharing an account

```sh
juice members                    # who can read this account's secrets
juice members invite             # single-use code, expires in 24h
juice join jc_inv_…              # the invitee runs this
```

An invite grants **read/write to every secret in the account, in every scope**,
including ones set before the invitee joined. There is no per-scope membership.
Both commands say so before they act.

The code is generated by the API, shown once, and only its SHA-256 reaches the
membership store — a dump of that store yields nothing redeemable. It is single
use, expires (24h by default, 7 days maximum via `--ttl`), and travels in a
request body rather than a URL so it stays out of access logs. Machine tokens
cannot create or redeem invites: a CI credential must not be a way to add
people.

One account per identity for now. A fresh invitee's empty personal account is
discarded when they join; someone whose own account already holds secrets is
refused rather than silently cut off from them.

There is no `juice members remove`. Removing someone would not rotate anything —
they have already seen the values — so rotate the secrets instead.

Machine tokens for CI, scoped to one scope + env and revocable:

```sh
juice token create --scope my-app --env production --read-only --ttl 90d
# prints the token on stdout; metadata on stderr
export JUICE_TOKEN=…
juice token revoke          # revoke the current token
juice token revoke <token>  # revoke another token you own (pass the full JWT)
```

Default API: `https://api.juice.run`. Override with `JUICE_API_URL` for
self-hosting (must be HTTPS unless localhost / `JUICE_ALLOW_INSECURE=1`).

## Command reference

| Command | Purpose |
|---------|---------|
| `juice auth login` | GitHub device-flow login; stores the session token at `~/.juice/token.json` (`0600`) |
| `juice scopes` | List scopes used on this machine |
| `juice members` | List who can read this account's secrets |
| `juice members invite` | Create a single-use invite code |
| `juice join CODE` | Join an account with an invite code |
| `juice set KEY` | Add/replace a secret (prompt, or `--stdin`) |
| `juice list` | Print sorted key **names** only |
| `juice unset KEY` | Remove a secret (`--yes` skips confirm) |
| `juice export --to PATH` | Write every key in a scope to a file |
| `juice get KEY` | Print one value to **stdout** — debugging only; apps use the SDK |
| `juice token create` | Create a scoped machine token |
| `juice token revoke [token]` | Revoke current or target token |
| `juice help` | Help screen |

| Flag | Meaning |
|------|---------|
| `--scope NAME` | Which scope to act on (repeatable on `export`) |
| `--env NAME` | Environment name (default `development`) |
| `--local` / `--remote` | Force a source; mutually exclusive |
| `--stdin` | Read the value for `set` from stdin |
| `--to PATH` | Destination for `export` |
| `--format FMT` | `export` format: `sh` (default) or `dotenv` |
| `--force` | Let `export` write inside a git repository |
| `--yes` / `-y` | Skip confirmation (`unset`) |

Token flags: `--scope`, `--env`, `--read-only`, `--ttl <Ns|Nm|Nh|Nd>`.

## Environment variables

### Client

| Variable | Purpose |
|----------|---------|
| `JUICE_SCOPE` | Scope to act on, when `--scope` is not passed |
| `JUICE_ENV` | Environment name / source hint |
| `APP_ENV` / `NODE_ENV` | Fallback env name |
| `JUICE_REMOTE` | `1` / `true` forces remote |
| `JUICE_CACHE_TTL` | SDK cache lifetime in seconds (default `300`; `0` disables) |
| `JUICE_API_URL` | API base (default `https://api.juice.run`) |
| `JUICE_TOKEN` | Bearer token (overrides `~/.juice/token.json`) |
| `JUICE_HOME` | Override `~/.juice` |
| `JUICE_ALLOW_INSECURE` | `1` allows non-HTTPS `JUICE_API_URL` |

Juice's own configuration comes from the real environment and flags only. No
file in a repository can change which scope, env, or source a command uses.

### Server (operators / self-hosters)

| Variable | Purpose |
|----------|---------|
| `JUICE_TOKEN_SECRET` | JWT signing secret (≥32 chars; required; no fallback) |
| `JUICE_CONVEX_URL` | Convex HTTP Actions URL (`https://<deployment>.convex.site`) |
| `JUICE_CONVEX_SECRET` | Shared secret for Convex; must match `JUICE_API_SHARED_SECRET` there (≥32 chars) |
| `GITHUB_CLIENT_ID` | GitHub OAuth app client ID (device flow) |
| `PORT` | Listen port (default `8787`) |
| `HOST` | Bind address |
| `JUICE_VERSION_COMMIT` | Commit SHA exposed by `GET /` |
| `JUICE_ENV_FILE` | Config file to read at startup (default `./.env`); real env wins over it |

## Self-hosting & security

- Self-host: clone this repo and deploy with Docker/CDK — see
  [`docs/SELF_HOSTING.md`](docs/SELF_HOSTING.md). The published npm package is
  SDK/CLI only (Apache-2.0); there is no `@juice/sdk/api` export.
- Threat model & reporting: [`SECURITY.md`](SECURITY.md)
- License map: [`LICENSING.md`](LICENSING.md)
