# Juice — Implementation Handoff (execution plan)

*Owner: Joe. Implementer: Grok 4.5. Reviewer: Claude (against the acceptance
gates below). This is the single entry point for the remaining work. Read
`SECURITY_REVIEW.md` once for context and finding-level detail; this file is the
execution order and the definition of done.*

---

## Current status (as of 2026-07-08)

**Done and reviewed** (commit `e8ac7e8` + uncommitted Phase 1.1 in the working tree):

- **Phase 0** — project restored on a fresh single-commit history; no
  `node_modules`/`dist`/`cdk.out`/`.env*` anywhere in history; `.gitignore` set.
- **Phase 1** — per-user tenancy (`/juice/users/<github-id>/projects/...`),
  owner-only default authorization, expiring JWTs (`exp/iat/jti/iss/aud`), scoped
  revocable machine tokens, mandatory `JUICE_TOKEN_SECRET` (≥32, no fallback),
  request body cap (64 KB)/timeouts/rate limits/sanitized 500s/request ids/audit
  logs, HTTPS-only CDK (ACM + redirect), client rejects non-HTTPS `JUICE_API_URL`.
- **Phase 1.1** — machine tokens can no longer mint tokens (no self-renewal past
  revocation), `DELETE /tokens/:jti` is ownership-checked (self-or-owned revoke),
  revocation store has a TTL cache that fails open on read error. 31 tests green;
  reviewer probes pass.

**Not started:** everything below (Checkpoints 1–4).

## Ground rules for every checkpoint

1. Work **one checkpoint at a time**, on its own branch, and stop for review
   before starting the next. Do not touch already-done phases.
2. `npm test` must stay green and `npx cdk synth JuiceApiStack -c versionCommit=test`
   must succeed at the end of each checkpoint. Add tests for every new behavior in
   the same checkpoint that adds it.
3. **No new runtime dependencies** (the single `@aws-sdk/client-secrets-manager`
   dependency is a deliberate feature). Dev/CI tooling is fine.
4. Secret **values** are never printed except by `juice get` (stdout only) and
   never appear in logs, audit lines, or confirmations.
5. Match the existing code and test style (Node built-in test runner, TS ESM,
   `.js` import specifiers, small pure functions).

---

## Checkpoint 0 — commit Phase 1.1 (housekeeping, do first)

The reviewed Phase 1.1 changes are still uncommitted in the working tree
(`src/api/server.ts`, `src/api/token-revocation-store.ts`, `src/cli/main.ts`,
`test/api.test.ts`, plus the planning docs). Commit them so Checkpoint 1 starts
from a clean tree.

- Commit message body ends with the repo's Co-Authored-By trailer.
- **Gate:** `git status` clean; `npm test` green (31 tests).

---

## Checkpoint 1 — Phase 2.0-A: local command surface (no server changes)

**Implement items 22–27 in `SECURITY_REVIEW.md` (Phase 2.0-A), plus items 11–13.**
Adds `init`, `get`, `list`, `unset`, `run`, and the help/flag cleanup — all
operating on local `.env`. Target command set:

```
Setup:    auth login · init
Secrets:  set KEY · get KEY · list · unset KEY · run -- <cmd>
Tokens:   token create · token revoke
Help:     help
```

Shared flags on all secret commands: `--remote` / new `--local` (mutually
exclusive), `--project <name>`, `--env <name>`. Also land: `juice set`/`init`
gitignore check (item 11), login polling deadline + `expired_token` message
(item 12), and Keychain write via stdin instead of argv (item 13).

**Gate (all local, no server):**
- `juice init` adds the gitignore block exactly once (idempotent), creates `0600`
  `.env`, prints the model.
- `juice get KEY` prints only the value + newline (works in `$(...)`); missing key
  → stderr + non-zero exit, nothing on stdout.
- `juice list` prints sorted key names, never a value.
- `juice unset KEY` removes the key and its `# juice: added …` marker, leaves
  neighbors intact, re-fingerprints; idempotent; `--yes` skips confirm.
- `juice run -- <cmd>` injects secrets into the child, does not override a pre-set
  env var, skips `JUICE_*`, propagates exit code.
- `--remote` + `--local` together errors; `juice help` lists every command.
- `npm test` green with new local tests.

---

## Checkpoint 2 — Phase 2.0-B: remote parity (adds API + IAM surface)

**Implement items 28–32 in `SECURITY_REVIEW.md` (Phase 2.0-B).** Adds
`GET /projects/:p/envs/:e/secrets` (list) and
`DELETE /projects/:p/envs/:e/secrets/:k` (unset), wires `list/unset/run --remote`,
and grants the two new IAM actions.

**The one security-critical detail:** `secretsmanager:ListSecrets` cannot be
IAM-scoped by name prefix, so the **server** must filter results to the caller's
`/juice/users/<id>/…` prefix and return only their keys. This server-side filter
is the tenant-isolation boundary — it must have a dedicated cross-user test.

Delete folds into the existing `write` action for v1 (a write token can already
overwrite a value); leave a code comment noting a future `delete` action could
split it. Remote `DeleteSecret` uses `RecoveryWindowInDays: 7` (recoverable).

**Gate:**
- `list --remote` returns only the caller's keys (cross-user isolation test passes).
- `unset --remote` deletes with a recovery window, idempotent, confirms unless `--yes`.
- A read-only machine token can `list` but `unset` → 403.
- Audit lines emitted for list/delete without values.
- `cdk synth` shows the two new IAM actions on `/juice/users/*/projects/*`
  (`DeleteSecret`) and `*` (`ListSecrets`, mitigated by server filtering).
- `npm test` green.

---

## Checkpoint 3 — Phase 4: licensing split + CI hardening (legal/pipeline, minimal behavior change)

Do this **before** the docs checkpoint so the README describes the real install
surface. Two independent workstreams; land together.

### 3a. License split — Apache SDK/CLI, AGPL server/infra

Verified fact: `src/sdk` and `src/cli` (and their deps `src/auth`, `src/config`,
`src/http`, `src/local`) do **not** import `src/api`. The split is clean without a
workspace refactor. Approach — keep one repo, make the **published npm package**
Apache-clean and server-free; keep the server/infra in-repo under AGPL (it is
consumed by clone + Docker deploy, not `npm install`):

1. `package.json`: set `"license": "Apache-2.0"`; **remove the `"./api"` export**
   (server is no longer an npm entry point); set `"files"` to publish only
   `dist/src/{sdk,cli,auth,config,http,local}`, `LICENSE`, `README.md` — i.e.
   exclude `dist/src/api` and `infra` from the tarball entirely.
2. Root `LICENSE` → Apache-2.0 (governs the published SDK/CLI). Add
   `src/api/LICENSE` and `infra/LICENSE` → AGPL-3.0-or-later. Add root
   `LICENSING.md` mapping directories to licenses and explaining the rationale
   (permissive SDK for adoption; copyleft server so hosted forks share changes).
3. Optional but recommended: SPDX headers per file (`// SPDX-License-Identifier:
   Apache-2.0` in SDK/CLI, `AGPL-3.0-or-later` in `src/api`/`infra`).
4. Update `scripts/check-licenses.mjs` to accept both project licenses and keep
   the dependency-license allowlist.

**Gate:** `npm pack --dry-run` lists no `api/` or `infra/` files and no AGPL
LICENSE; `check-licenses` passes; a short test or script asserts the tarball
manifest excludes server code.

### 3b. CI/CD hardening

1. Pin every GitHub Action to a commit SHA (not a tag).
2. Add CI jobs: `npm audit --audit-level=high` (gate), CodeQL, and gitleaks
   secret scan. Add a Dependabot config.
3. Keep the OIDC deploy role. Replace auto-deploy-on-push-to-`main` with a
   required-reviewer gate on the `production` environment (deploy still runs via
   `workflow_dispatch` / after approval).

**Gate:** CI config parses; deploy no longer fires automatically on push without
approval; actions are SHA-pinned.

---

## Checkpoint 4 — Phase 3: documentation (launch requirement)

**Implement items 14–16 in `SECURITY_REVIEW.md`, expanded as follows.** Docs must
match the post-split reality from Checkpoint 3 (self-hosting is clone + Docker/CDK,
**not** `import "@juice/sdk/api"`).

1. **README.md** — replace the current stub. Sections, in order:
   - Tagline + one-paragraph mental model (call `juice.get("KEY")`; Juice picks
     local `.env` in dev, remote API in prod — same call site).
   - **Install + 5-minute local quickstart** (`npm i @juice/sdk`, `juice init`,
     `juice set KEY`, `juice.get("KEY")` — no server, no login).
   - **Agents quickstart** — the copy-paste `AGENTS.md`/`CLAUDE.md` snippet
     (below), and how `juice run -- <cmd>` launches a process with secrets.
   - **Team / remote** — `juice auth login`, `--remote`, machine tokens for CI
     (`juice token create --project X --env prod --read-only --ttl 90d`),
     `juice token revoke`.
   - **Command reference** — every command + shared flags.
   - **Mode resolution table** — how `--remote`/`--local`/`JUICE_REMOTE`/
     `JUICE_ENV`/`APP_ENV`/`NODE_ENV` interact.
   - **Environment variable reference table** — client vars (`JUICE_ENV`,
     `APP_ENV`, `NODE_ENV`, `JUICE_REMOTE`, `JUICE_PROJECT`, `JUICE_API_URL`,
     `JUICE_TOKEN`, `JUICE_HOME`, `JUICE_ALLOW_INSECURE`) and server vars
     (`JUICE_TOKEN_SECRET`, `GITHUB_CLIENT_ID`, `PORT`, `HOST`,
     `JUICE_VERSION_COMMIT`). State plainly that repo-local `.env` files configure
     *your app*, never Juice itself, and that `JUICE_*` keys in `.env` are ignored
     (item 16).
   - Link to `SECURITY.md` and `LICENSING.md`.

2. **AGENTS.md / CLAUDE.md snippet** — a short template block (in the README and
   as a copy-paste file) instructing agents to use `juice set KEY` / `juice.get()`
   / `juice run` instead of touching `.env` directly, and to use least-privilege
   machine tokens (one project + env, read-only where possible) for headless work.

3. **docs/SELF_HOSTING.md** — CDK walkthrough: create the GitHub OAuth app (device
   flow), the required CDK parameters (`GitHubClientId`, `CertificateArn`,
   `HostedZoneId`, `HostedZoneName`, `ApiDomainName`), the auto-generated
   `JUICE_TOKEN_SECRET`, the deploy command, and reading stack outputs
   (`ApiUrl`, `TokenSecretArn`). Note local dev via `npm run dev` (ephemeral
   signing secret).

4. **SECURITY.md** — vulnerability reporting, supported versions, and an honest
   threat model: what Juice protects against (secrets out of source control,
   per-user isolation, revocable scoped tokens) and what it does not (anything
   that can read your process env or `~/.juice` can act as you; local mode is only
   as safe as your disk).

**Gate:** README quickstart commands match the shipped CLI exactly; no doc
references the removed `@juice/sdk/api` import; `SECURITY.md`, `LICENSING.md`,
`docs/SELF_HOSTING.md`, and the agent snippet exist.

---

## Consolidated acceptance checklist (final review)

CLI / local:
- [ ] `init`, `get`, `list`, `unset`, `run` all work in local mode with the shared flags.
- [ ] `get` prints only the value; `list` never prints a value; `unset` preserves neighbors and re-fingerprints.
- [ ] `run -- <cmd>` injects secrets into the child without overriding pre-set env vars; propagates exit code.
- [ ] `init` gitignore block is idempotent; login has a deadline; `--remote`+`--local` errors; `help` lists all commands.

Remote / server:
- [ ] `list --remote` returns only the caller's keys (cross-user isolation test).
- [ ] `unset --remote` deletes with a 7-day recovery window; read-only token → 403 on unset.
- [ ] New IAM actions present in `cdk synth`; audit lines for list/delete carry no values.
- [ ] `npm test` green; `cdk synth` succeeds.

Licensing / CI:
- [ ] `npm pack --dry-run` excludes `api/` and `infra/`; published `license` is Apache-2.0; `./api` export removed.
- [ ] `src/api/LICENSE` + `infra/LICENSE` are AGPL; `LICENSING.md` maps directories.
- [ ] Actions SHA-pinned; `npm audit`/CodeQL/gitleaks/Dependabot present; production deploy gated by reviewer.

Docs:
- [ ] README has the three quickstarts, command reference, mode table, and env-var table.
- [ ] `SECURITY.md`, `LICENSING.md`, `docs/SELF_HOSTING.md`, agent snippet exist and match the shipped CLI.

Invariants (must remain true):
- [ ] Only `@aws-sdk/client-secrets-manager` as a runtime dependency.
- [ ] No constant signing-secret fallback; server refuses to start without `JUICE_TOKEN_SECRET`.
- [ ] Machine tokens cannot mint tokens; cross-user secret access and cross-user revoke are denied.
- [ ] No secret values in any log; history free of build artifacts and `.env*`.
