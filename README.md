# Juice

**Agent secrets without copy/paste.**

Call `juice.get("KEY")` (or `juice get KEY` / `juice run -- …`). In development
Juice reads your local `.env`; in production it fetches from the Juice API
(AWS Secrets Manager). Same call site — Juice picks the source.

## Install + 5-minute local quickstart

No server and no login required for local use.

```sh
npm i @juice/sdk
npx juice init
npx juice set OPENAI_API_KEY
```

```ts
import { juice } from "@juice/sdk";

const apiKey = await juice.get("OPENAI_API_KEY");
```

`juice init` adds a gitignore block for `.env` / `.juice/` (once) and creates an
empty `0600` `.env` if missing. `juice set KEY` prompts for the value and
appends it to `.env` — the value is never echoed.

## Agents quickstart

Copy [`docs/AGENTS.snippet.md`](docs/AGENTS.snippet.md) into your project's
`AGENTS.md` or `CLAUDE.md`. Short version:

- Prefer `juice set KEY`, `juice.get("KEY")`, and `juice run -- <cmd>` over
  editing `.env` by hand.
- Never print secret values; `juice list` shows names only.
- For CI/headless work, use a least-privilege machine token (one project + env,
  `--read-only` when possible).

Run a process with secrets injected (pre-set env vars win; `JUICE_*` is skipped):

```sh
juice run -- node app.js
juice run -- npm test
```

## Team / remote

```sh
juice auth login
juice set OPENAI_API_KEY --remote
juice get OPENAI_API_KEY --remote
juice list --remote
juice unset OPENAI_API_KEY --remote --yes
```

Machine tokens for CI (scoped, revocable):

```sh
juice token create --project my-app --env prod --read-only --ttl 90d
# prints the token on stdout; metadata on stderr
export JUICE_TOKEN=…
juice token revoke          # revoke the current token
juice token revoke <token>  # revoke another token you own (pass the full JWT)
```

Default remote API: `https://api.juice.run`. Override with `JUICE_API_URL` for
self-hosting (must be HTTPS unless localhost / `JUICE_ALLOW_INSECURE=1`).

## Command reference

| Command | Purpose |
|---------|---------|
| `juice auth login` | GitHub device-flow login; stores token in Keychain / `~/.juice` |
| `juice init` | Scaffold `.gitignore` + `.env` for local secrets |
| `juice set KEY` | Add/update a secret (local `.env` or `--remote`) |
| `juice get KEY` | Print one value to **stdout** only (for `$(…)`) |
| `juice list` | Print sorted key **names** only |
| `juice unset KEY` | Remove a secret (`--yes` skips confirm) |
| `juice run -- <cmd> [args…]` | Exec with secrets injected; propagates exit code |
| `juice token create` | Create a scoped machine token |
| `juice token revoke [token]` | Revoke current or target token |
| `juice help` | Help screen |

Shared flags on secret commands (`set` / `get` / `list` / `unset` / `run`):

| Flag | Meaning |
|------|---------|
| `--local` | Force local `.env` mode |
| `--remote` | Force remote API mode |
| `--project NAME` | Override project |
| `--env NAME` | Override environment name |
| `--yes` / `-y` | Skip confirmation (`unset`) |

`--remote` and `--local` together is an error.

Token flags: `--project`, `--env`, `--read-only`, `--ttl <Ns|Nm|Nh|Nd>`.

## Mode resolution

| Condition | Mode |
|-----------|------|
| `--remote` | remote |
| `--local` | local |
| `JUICE_REMOTE=1` or `true` | remote |
| `JUICE_ENV` / `APP_ENV` / `NODE_ENV` is `local` or `development` (default) | local |
| otherwise | remote |

Resolution order for the env name: `JUICE_ENV` → `APP_ENV` → `NODE_ENV` →
`development`.

Project name: `JUICE_PROJECT` → nearest `package.json` `name` → directory name.

## Environment variables

Repo-local `.env` / `.env.local` configure **your app**, never Juice itself.
Any `JUICE_*` key found in those files is **ignored** (with a one-line warning).
Set Juice control-plane vars in the real environment or via flags.

### Client

| Variable | Purpose |
|----------|---------|
| `JUICE_ENV` | Environment name / mode hint |
| `APP_ENV` | Fallback env name |
| `NODE_ENV` | Fallback env name |
| `JUICE_REMOTE` | `1` / `true` forces remote |
| `JUICE_PROJECT` | Override project name |
| `JUICE_API_URL` | API base (default `https://api.juice.run`) |
| `JUICE_TOKEN` | Bearer token (overrides Keychain / `~/.juice`) |
| `JUICE_HOME` | Override `~/.juice` |
| `JUICE_ALLOW_INSECURE` | `1` allows non-HTTPS `JUICE_API_URL` |

### Server (operators / self-hosters)

| Variable | Purpose |
|----------|---------|
| `JUICE_TOKEN_SECRET` | JWT signing secret (≥32 chars; required; no fallback) |
| `GITHUB_CLIENT_ID` | GitHub OAuth app client ID (device flow) |
| `PORT` | Listen port (default `8787`) |
| `HOST` | Bind address |
| `JUICE_VERSION_COMMIT` | Commit SHA exposed by `GET /` |

## Self-hosting & security

- Self-host: clone this repo and deploy with Docker/CDK — see
  [`docs/SELF_HOSTING.md`](docs/SELF_HOSTING.md). The published npm package is
  SDK/CLI only (Apache-2.0); there is no `@juice/sdk/api` export.
- Threat model & reporting: [`SECURITY.md`](SECURITY.md)
- License map: [`LICENSING.md`](LICENSING.md)
