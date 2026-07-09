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
13. Nice-to-have: pass the token to `security add-generic-password` via stdin
    rather than argv if practical.

> **Note:** the command-surface work (`get`/`list`/`unset`/`run`/`init` and the
> mode/flag cleanup) is specified in detail in **Phase 2.0** below, which
> supersedes the old one-line "`juice get`" nice-to-have. Items 11–13 above are
> still in scope and fold into the Phase 2.0 pass.

### Phase 2.0 — Command surface & UX (review follow-up)

*Goal: make Juice a complete "add and use env vars in my project (agents too)"
tool, not just `set`. Today you can `set` from the CLI but can only read from the
SDK — asymmetric and surprising. This phase adds the missing verbs. It is split so
the **local-mode** commands (2.0-A) need zero server changes and can ship and be
reviewed first; **remote parity** (2.0-B) adds API/IAM surface and is a separate
checkpoint. Keep existing routes, token model, and test style unchanged.*

**Recommended final command set** (what `juice help` should list):

```
Setup:    auth login · init
Secrets:  set KEY · get KEY · list · unset KEY · run -- <cmd>
Tokens:   token create · token revoke
Help:     help
```

Shared flag rules for every secret command (`set/get/list/unset/run`):
- `--remote` forces remote; add a new `--local` that forces local. Passing both
  is an error. With neither, mode comes from the existing resolution chain
  (`JUICE_ENV → APP_ENV → NODE_ENV → development`; `JUICE_REMOTE=1` override).
- `--project <name>` and `--env <name>` override inference (already exist on
  `token create`; accept them everywhere for consistency).
- Values are **never** printed except by `get` (stdout only) — no echo in logs,
  audit lines, or confirmations.

#### 2.0-A — Local-mode commands (no server changes)

22. **`juice init`.** Idempotent scaffold: ensure `.gitignore` contains a
    juice-managed block (`.env`, `.env.*`, `.juice/`) — append only if absent,
    never duplicate; create an empty `.env` (mode `0600`) if missing; print the
    3-line local→remote model and the next command. Re-running is safe and a
    no-op when already set up. This also satisfies item 11 for the `set` path
    (reuse the same gitignore check).
23. **`juice get KEY`.** Prints the resolved value to **stdout** with a single
    trailing newline so `export X="$(juice get X)"` works. Missing key → nothing
    on stdout, message on stderr, non-zero exit. Local mode reuses `readDotEnv`;
    remote reuses the existing SDK GET path.
24. **`juice list`.** Prints **key names only**, one per line, sorted; never
    values. Local: keys from `readDotEnv(.env)`.
25. **`juice unset KEY`.** Local: rewrite `.env` removing the `KEY=` line and an
    immediately-preceding `# juice: added …` marker line if present, preserving
    all other lines/comments/ordering; then re-fingerprint via
    `recordEnvFingerprint`. Idempotent (unset of an absent key exits 0 with a
    note). Prompt for confirmation unless `--yes`.
26. **`juice run -- <cmd> [args…]`.** Loads the project/env secrets into a child
    process environment and execs `<cmd>`, propagating its exit code. Reuse
    `loadJuiceEnv` semantics: already-set real env vars win over loaded secrets,
    and `JUICE_*` control vars are still skipped. Secrets exist only in the child
    env, never printed. Require the `--` separator before the command.
27. **Help + discoverability.** Regenerate `rootHelpText` to list every command
    above (the current text omits `token`, `get`, `list`, `unset`, `run`). Group
    as shown; show the shared flags and the mode-resolution one-liner.

Tests (local): gitignore block added once and not duplicated on re-run; `get`
prints only the value; `list` never emits a value; `unset` removes the key and
its marker while leaving neighbors intact and updates the fingerprint; `run`
injects secrets into the child but does not override a pre-set env var and
propagates exit code; `--remote` + `--local` together errors.

#### 2.0-B — Remote parity (adds API + IAM surface; separate checkpoint)

28. **`GET /projects/:p/envs/:e/secrets` → `{ keys: string[] }`** for
    `juice list --remote`. Authz: `read`. Backend `listKeys(refWithoutKey)` uses
    Secrets Manager `ListSecrets` filtered to the prefix
    `/juice/users/<id>/projects/<p>/envs/<e>/secrets/`, then strips the prefix.
    **Security boundary:** `ListSecrets` cannot be IAM-scoped by prefix, so it can
    enumerate account-wide names; the server MUST filter by the caller's derived
    user prefix and return only their keys. Add a test proving user A's `list`
    never returns user B's keys. (Document the tradeoff; an index table is the
    later alternative if account-wide `ListSecrets` is unacceptable.)
29. **`DELETE /projects/:p/envs/:e/secrets/:k` → 204** for
    `juice unset --remote`. Authz: `write` (fold delete into the existing `write`
    action for v1 — a write token can already clobber a value; add a code comment
    noting a future `delete` action could split this). Backend `deleteSecret(ref)`
    uses `DeleteSecret` with `RecoveryWindowInDays: 7` (recoverable, not force);
    return 204 even if already absent. Confirm prompt on the CLI unless `--yes`.
30. **`run --remote`** = `list` (read) then `get` each key; inject and exec as in
    item 26. No new endpoint.
31. **IAM (CDK).** Add `secretsmanager:ListSecrets` (resource `*` — AWS
    limitation, mitigated by server-side prefix filtering per item 28) and
    `secretsmanager:DeleteSecret` on the `/juice/users/*/projects/*` namespace to
    the task role. Update the machine-token scope docs: `list` needs a read
    token, `unset`/`delete` need a write token.
32. **Audit + scope.** Emit the standard audit line for list (action `list`,
    outcome, no key values) and delete (action `write`/`delete`). `scopeAllows`
    already gates by action; confirm list maps to `read` and delete to `write`.

Tests (remote): `list --remote` returns only the caller's keys (cross-user
isolation); `unset --remote` deletes with a recovery window and is idempotent;
a read-only machine token can `list` but `unset` → 403; audit lines emitted
without values.

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

---

## Phase 1.1 — Review follow-up (post-checkpoint fixes)

*Review of commit `e8ac7e8` (2026-07-08) passed 9/10 of the checklist. This section
specifies the remaining fixes. Items 19–20 are blocking; item 21 is a hardening
improvement that can land in the same pass. Nothing else in the commit needs to
change. Keep the existing public API, route shapes, and test style.*

### 19. Blocking — machine (scoped) tokens must not mint or outlive revocation

**Defect.** `handleTokenCreate` (`src/api/server.ts:262`) authenticates the caller
but never checks whether the caller is itself a scoped machine token. A read-write
machine token can therefore call `POST /tokens` and mint a fresh 90-day token within
its own scope, and revoking the parent `jti` does **not** cascade to the child.
Confirmed empirically: parent revoked → parent 401, child still 200. This defeats the
"revocable, expiring" guarantee that is the entire reason machine tokens exist, in
exactly the CI/agent-token-leak scenario they are meant to contain.

**Required behavior.**
- Only **user tokens** may mint machine tokens. In `handleTokenCreate`, if
  `principal.scope !== undefined`, respond `403 { error: "Machine tokens cannot create tokens" }`
  before any other work (before the body is parsed / probe authorize runs).
- Apply the same guard to `POST` token creation only. Leave `DELETE` (revoke) to item 20.
- Do this as an explicit check on `principal.scope`, not by inspecting the token string.

**Tests (add to `test/api.test.ts`).**
- A scoped machine token calling `POST /tokens` gets `403`; assert the backend/sign
  path was not reached.
- A user token calling `POST /tokens` still gets `201` (regression guard — keep the
  existing scope test passing).

### 20. Blocking — `DELETE /tokens/:jti` must verify ownership

**Defect.** `handleTokenRevoke` (`src/api/server.ts:310`) revokes any `jti` supplied by
any authenticated principal. `jti` is an unguessable UUID so real-world exposure is low,
but a `jti` that leaks into a log, ticket, or shared token payload becomes a cross-user
revocation (griefing) vector. Revocation is a write action and must be authorized.

**Required behavior.**
- Bind revocation to the caller. Because the revocation store currently holds only a
  flat list of `jti` strings, extend it minimally to record the owning `sub` alongside
  each `jti`, and check it on revoke:
  - `TokenRevocationStore.revoke(jti: string, owner: string): Promise<void>`
  - Add `ownerOf(jti: string): Promise<string | undefined>` **or** have `revoke` be a
    no-op-with-403 when the recorded owner (from the *token being revoked*) mismatches.
    Simplest correct approach: the server already holds the caller's verified `principal`.
    Require the client to present proof it owns the target `jti`. Two acceptable designs —
    pick the first unless it forces a route change:
    1. **Self-revoke by token:** caller may only revoke a `jti` whose `sub` matches their
       own `principal.sub`. Since the store does not know each `jti`'s `sub`, record
       `{ jti, sub }` at *creation time is not possible* (tokens aren't stored). Therefore
       record `{ jti, sub, revokedAt }` at *revoke time* is insufficient for the check.
       Resolve this by having the client send the full target token (or its `sub`) — see
       design 2.
    2. **Revoke by presenting the target token:** change the revoke contract to
       `DELETE /tokens/:jti` where the server derives ownership from the *caller's* token
       and requires `:jti === principal.jti` (self-revoke) OR the caller submits the
       target token in the body (`{ token }`), the server `verifyToken`s it, and requires
       its `sub === principal.sub`. Then revoke by `jti`.
  - **Chosen design (implement this one):** self-or-owned revoke.
    - Allow revoking `principal.jti` (a token revoking itself) with no extra proof.
    - To revoke a *different* `jti`, require a JSON body `{ token: string }` containing the
      full target token; `verifyToken` it (ignore expiry for this purpose is unnecessary —
      an expired token needs no revocation, so reject with `400 { error: "token is expired or invalid" }`),
      confirm its `sub === principal.sub`, then revoke its `jti`. If `:jti` in the path does
      not equal the decoded target token's `jti`, respond `400`.
    - On any ownership mismatch respond `403 { error: "Forbidden" }`.
- Keep `revoke(jti, owner)` recording `owner` in the stored JSON (`{ revoked: [{jti, sub, revokedAt}], updatedAt }`) so the shape is future-proof; `isRevoked` only needs membership by `jti` and must tolerate both the old string-array and the new object form when parsing.

**Tests.**
- A token revoking *itself* (`:jti === principal.jti`, no body) → `204`, and the token is
  then rejected (`401`) on a secret route.
- User A cannot revoke User B's `jti` (presenting B's token) → `403`; B's token still works.
- Presenting a target token whose `jti` mismatches the path `:jti` → `400`.

> If design (self-or-owned) proves awkward against the existing CLI `juice token revoke <jti>`,
> update the CLI to send the target token in the body when revoking a token other than the
> one in the local token store, and keep bare `juice token revoke` (no arg) meaning
> "revoke my current token." Update `src/cli/main.ts:revokeToken` and its help text accordingly.

### 21. Hardening — cache revocation lookups; don't let the store outage deny all access

**Defect.** `authenticate` calls `revocationStore.isRevoked` on **every** authenticated
request, which for the AWS store is a `GetSecretValue` per request. Any non-`NotFound`
error (e.g. Secrets Manager throttling) propagates to the 500 handler, so throttling on
the single revocations secret becomes a full-service outage, plus per-request latency and
cost.

**Required behavior.**
- Add a short in-process TTL cache to `AwsSecretsManagerTokenRevocationStore` for the
  revocations set: cache the parsed set for `REVOCATION_CACHE_TTL_MS` (default `5000`,
  overridable via constructor arg for tests). `isRevoked` reads through the cache; `revoke`
  invalidates it (and updates the cache optimistically after a successful write).
- Fail closed on *auth*, but do not let a transient read error 500 every request: if a
  cached set is available, serve from it on read error; if none is available and the read
  errors (non-`NotFound`), treat as **not revoked** only if you also emit a structured
  `level:"error"` log line — document in a code comment that this is an availability-vs-
  strictness tradeoff and that DynamoDB with conditional reads is the durable answer.
  (Rationale: a brand-new deployment with no revocations secret must not be bricked by a
  throttle; a compromised token's blast radius is already bounded by `exp`.)
- Keep the existing read-modify-write comment and the DynamoDB migration note.

**Tests.**
- Two `isRevoked` calls within the TTL trigger only one underlying `GetSecretValue`
  (assert via a fake client call counter).
- `revoke` makes a subsequent `isRevoked` return `true` without waiting for TTL expiry.

### Acceptance additions for the follow-up pass

- [ ] A scoped machine token calling `POST /tokens` is rejected `403`; user tokens still mint `201`.
- [ ] A machine token cannot create a child that survives revocation of its parent (no self-renewal path exists).
- [ ] Self-revoke (no body, `:jti === principal.jti`) works and invalidates the token; cross-user revoke is `403`.
- [ ] `isRevoked` is served from a TTL cache; a transient store read error does not 500 every request.
- [ ] `npm test` green; `cdk synth` unchanged; no new runtime dependencies added.
