# Juice — Security Review & Improvement Plan

*Reviewed 2026-07-08. Decisions confirmed by Joe: self-host first, per-user secret
namespaces, short-lived user tokens + scoped machine tokens, MIT/Apache SDK with
AGPL server. This document is the implementation spec for the follow-up coding
pass; each phase is independently shippable and ordered by risk.*

> **Repo state note:** at review time, `main` pointed at an empty "init commit"
> and the working tree was empty. The real source lives in git history (fullest
> src tree at commit `126bb3e`; infra/tests/Dockerfile/workflow/README in the
> `20:14` commit batch, e.g. `17bbcd2` and `3589e2d`). Phase 0 restores it.

## Architecture (as reviewed)

- **Local mode** (default when env is `local`/`development`): CLI appends to the
  project's `.env`; a SHA-256 fingerprint in `.juice/state.json` detects outside
  edits ("drift"). SDK `juice.get(KEY)` reads `.env` directly.
- **Remote mode**: SDK/CLI call a Node HTTP API (`/projects/:p/envs/:e/secrets/:k`,
  GET/PUT) backed by AWS Secrets Manager under `/juice/projects/...`.
- **Auth**: GitHub OAuth device flow, proxied by the server, which mints its own
  HS256 JWT signed with `JUICE_TOKEN_SECRET`.
- **Deploy**: CDK → ALB + Fargate, task role scoped to `/juice/projects/*`.

### Strengths to preserve

- Single runtime dependency (`@aws-sdk/client-secrets-manager`) — tiny supply chain.
- Timing-safe token comparison; `execFileSync` (no shell injection).
- Tightly scoped IAM, including the name condition on `CreateSecret`.
- Minimal `read:user` OAuth scope; GitHub access token discarded after identity lookup.
- 0600/0600 file modes, macOS Keychain token storage, hidden secret prompt.
- `.env` drift fingerprinting — keep and document as a feature.

## Findings

| # | Severity | Finding | Where |
|---|----------|---------|-------|
| 1 | Critical | `authorize` defaults to `() => true`; project names are self-declared. Any authenticated GitHub user can read/write every secret of every project. No tenancy model. | `src/api/server.ts:21` |
| 2 | Critical | JWTs have no `exp`, `jti`, `iss`, or `aud` and cannot be revoked. Leaked token = permanent access. | `src/api/token.ts` |
| 3 | High | Hardcoded fallback signing secret `dev-juice-token-secret` when `NODE_ENV !== "production"`. Self-hosters who forget the env var run a forgeable-token server. | `src/api/server.ts:164-171` |
| 4 | High | Public ALB is plain HTTP (no cert, `http://` output). Tokens and secret values transit cleartext. Client accepts any `http://` `JUICE_API_URL`. | `infra/juice-api-stack.ts`, `src/http/client.ts` |
| 5 | High | CLI loads `.env`/`.env.local` from the repo into `process.env` before running, including `JUICE_API_URL`/`JUICE_TOKEN`/`JUICE_HOME`. A malicious repo (or one an agent was pointed at) can redirect `juice set --remote` to an attacker server and exfiltrate the secret value. | `src/cli/main.ts:32`, `src/local/bootstrap-env.ts` |
| 6 | Medium | No request body size limit, no rate limiting, no server timeouts. | `src/api/server.ts` (`readJson`) |
| 7 | Medium | 500 handler echoes raw `error.message` (AWS SDK internals) to clients; malformed JSON → 500 instead of 400. | `src/api/server.ts:87-90` |
| 8 | Medium | No audit logging of secret access. | `src/api/server.ts` |
| 9 | Medium | `/auth/github/*` endpoints are an unauthenticated, unlimited proxy to GitHub. | `src/api/server.ts` |
| 10 | Hygiene | `node_modules/`, `dist/`, `cdk.out/` (incl. `cdk.context.json`) and `.env.local` committed in history. The `.env.local` only held the public GitHub OAuth client ID — no rotation needed — but history must not ship when open-sourced. | git history |
| 11 | Hygiene | Deploy on every push to `main` with `--require-approval never`; actions pinned by tag; no audit/CodeQL/secret-scan in CI; README empty at HEAD; no SECURITY.md. | `.github/workflows/deploy.yaml` |

## Plan

### Phase 0 — Repo restoration & hygiene (prerequisite)

1. Restore the full project into the working tree from history (`126bb3e` for
   `src/` + `tsconfig.json`; `17bbcd2`-era commits for `README.md`, `test/`,
   `scripts/`, `package.json`, `package-lock.json`, `Dockerfile`,
   `.dockerignore`, `.github/workflows/deploy.yaml`, `LICENSE`, `cdk.json`,
   `infra/`).
2. **Start a fresh, single-commit history** for the public repo. Do not carry
   the existing history: it contains multi-MB `node_modules`/`dist`/`cdk.out`
   blobs and a committed `.env.local`.
3. `.gitignore`: `node_modules/`, `dist/`, `cdk.out/`, `.env`, `.env.*`,
   `.juice/`, `.DS_Store`, `cdk.context.json`.

### Phase 1 — Server security (critical fixes)

4. **Per-user tenancy.** Secrets Manager path becomes
   `/juice/users/<github-user-id>/projects/<project>/envs/<env>/secrets/<key>`.
   The default `authorize` becomes *owner-only*: the principal's `sub`
   (`github:<id>`) must match the user segment; there is no default-allow
   anywhere. Keep the pluggable `authorize` hook for self-hosters who want team
   logic. Update the IAM namespace ARN to match. API routes stay
   project-relative; the server derives the user segment from the verified
   token, never from the URL.
5. **Token lifecycle.** Add `exp` (user tokens: 12h default), `iat`, `jti`,
   `iss: "juice"`, `aud: "juice-api"`; `verifyToken` enforces all of them and
   rejects missing/blank `sub`. Add machine tokens for agents/CI:
   `juice token create --project X --env prod [--read-only] [--ttl 90d]`
   mints a token with a `scope` claim `{project, env, actions}`; `authorize`
   intersects scope with the request. Add `juice token revoke <jti>` backed by
   a small revocation store (start with a DynamoDB table or a single Secrets
   Manager JSON entry; document the tradeoff in code comments).
6. **Fail closed on the signing secret.** Delete the `dev-juice-token-secret`
   fallback. The server refuses to start without `JUICE_TOKEN_SECRET` (min
   length 32). For local development, `scripts/run-api-local.mjs` may generate
   an ephemeral random secret and print it — never a constant.
7. **TLS everywhere.** CDK: require an ACM certificate parameter + hosted-zone
   domain, HTTPS listener, HTTP→HTTPS redirect, output `https://` URL. Client:
   reject non-`https` `JUICE_API_URL` unless the host is
   `localhost`/`127.0.0.1` or `JUICE_ALLOW_INSECURE=1` is explicitly set.
8. **Request hardening.** Cap request bodies at 64 KB (Secrets Manager's own
   limit) and reject larger with 413; malformed JSON → 400; set
   `server.headersTimeout`/`requestTimeout`; add a simple in-memory token-bucket
   rate limit per IP for `/auth/*` and per principal for secret routes
   (document that multi-instance deployments should add ALB/WAF rate rules).
9. **Sanitized errors + audit log.** 500s return a generic message and a random
   request id; full error goes to server logs keyed by that id. Log one
   structured line per secret access: `{ts, requestId, principal, action,
   project, env, key, outcome}` — never values.

### Phase 2 — Client/CLI hardening

10. **Never load Juice control-plane vars from repo files.** `loadJuiceEnv`
    skips any `JUICE_*` key found in `.env`/`.env.local` (at minimum:
    `JUICE_API_URL`, `JUICE_TOKEN`, `JUICE_HOME`, `JUICE_TOKEN_SECRET`). Those
    must come from the real environment or flags. Print a one-line warning when
    a skipped key is present so users understand why.
11. `juice set` checks the project `.gitignore` and offers to append
    `.env`/`.juice/` if missing (warn loudly when declining).
12. Device-flow login: give the polling loop a deadline (GitHub device codes
    expire in ~15 min) and handle `expired_token` with a clear message.
13. Nice-to-have: `juice get KEY` CLI command for parity with the SDK, and
    pass the token to `security add-generic-password` via stdin rather than
    argv if practical.

### Phase 3 — Documentation (a launch requirement, not an afterthought)

14. **README rewrite**, three audiences in order:
    - *Humans, 5-minute quickstart*: install, `juice set KEY`, `juice.get(KEY)`
      in code, done — local `.env` only, no server needed.
    - *Agents*: a copy-paste `CLAUDE.md`/`AGENTS.md` snippet telling agents to
      use `juice set` / `juice.get()` instead of touching `.env` directly, and
      how machine tokens work for headless/CI agents (least privilege:
      one project+env, read-only where possible).
    - *Self-hosting*: CDK deploy walkthrough (ACM cert, `JUICE_TOKEN_SECRET`,
      GitHub OAuth app setup), env var reference table, upgrade notes.
15. **SECURITY.md**: how to report vulnerabilities, supported versions, and an
    honest threat model — what Juice protects against (secrets out of source
    control, per-user isolation, revocable scoped tokens) and what it cannot
    (anything that can read your process env or `~/.juice` can act as you;
    local mode is only as safe as your disk).
16. Document the Phase-10 rule explicitly: repo-local `.env` files configure
    *your app*, never Juice itself.

### Phase 4 — CI/CD & licensing

17. Pin GitHub Actions by commit SHA; add `npm audit` gate, CodeQL, and gitleaks
    to CI; enable Dependabot. Keep the OIDC deploy role (already good). Require
    reviewers on the `production` environment instead of auto-deploy on push.
18. **License split**: SDK + CLI (`src/sdk`, `src/cli`, `src/local`,
    `src/config`, `src/http`, `src/auth`) → Apache-2.0; server + infra
    (`src/api`, `infra/`) → AGPL-3.0-or-later. Cleanest mechanically as two
    packages in a small workspace (`@juice/sdk`, `@juice/server`); update
    `check-licenses.mjs` and per-directory LICENSE files accordingly.

### Acceptance checklist for the review pass (after implementation)

- [ ] A second GitHub account cannot read or write the first account's secrets (403).
- [ ] An expired or revoked token is rejected; user tokens carry `exp` ≤ 12h.
- [ ] Machine token scoped to `projA/dev` cannot touch `projA/prod` or `projB`.
- [ ] Server exits at startup without `JUICE_TOKEN_SECRET`; no constant fallback anywhere in the tree.
- [ ] CDK synth shows HTTPS listener + redirect; client refuses `http://` URLs (except localhost).
- [ ] `JUICE_API_URL` planted in a repo `.env` is ignored by the CLI (with warning).
- [ ] >64 KB body → 413; bad JSON → 400; 500 bodies contain no AWS error internals.
- [ ] Audit log line emitted for every secret read/write; no secret values in any log.
- [ ] Fresh history: no `node_modules`, `dist`, `cdk.out`, or `.env*` anywhere in `git log --all`.
- [ ] Tests restored from history and extended to cover every item above.
