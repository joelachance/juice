# Juice marketing site — build plan

*A single-page static marketing site for Juice. This is a build spec for the
implementing agent. Keep it **super simple**: one page, no framework, no build
step, no external network calls. Everything below is grounded in what actually
ships in this repo — do not invent features. Verify any claim against `README.md`,
`src/cli/main.ts`, `docs/`, and `SECURITY.md` before writing copy.*

## Goal & audience

Convince three audiences, in this priority order, that Juice is the simplest way
to keep env vars/secrets out of source control:

1. **Developers** who are tired of copy/pasting secrets into `.env` files.
2. **AI agents / the people running them** — agents should manage secrets with a
   command, not by editing `.env` by hand.
3. **Teams / self-hosters** who want a private, auditable secrets API.

Primary CTA everywhere: **install + first command** (`npm i @juice/sdk`, then
`juice init`). Secondary CTA: **GitHub repo** (link placeholder `#repo`).

## Tech constraints (keep it simple)

- **One file if possible:** `www/index.html` with inline `<style>` (or a single
  `styles.css` sibling). No JS framework. Vanilla JS only if needed for the mobile
  nav or copy-to-clipboard on code blocks — progressive enhancement, page must
  work with JS disabled.
- Static, self-contained, deployable to any static host (GitHub Pages, S3, etc.).
- No web fonts from a CDN, no analytics, no trackers — Juice is a security tool;
  the site should practice what it preaches. System font stack.
- Responsive, mobile-first. Light/dark via `prefers-color-scheme`.
- Accessible: semantic landmarks, real headings, sufficient contrast, focus states.

## Brand voice

- Tagline (verbatim from the CLI): **"agent secrets without copy/paste."**
- Tone: terminal-native, developer-to-developer, no marketing fluff, no buzzwords
  ("enterprise-grade", "revolutionary" — banned). Short sentences. Show commands.
- Optional motif: the ASCII "juice" logo already in `src/cli/main.ts`
  (`juiceLogoRaw`) rendered in a monospace hero. Reuse it; don't redraw it.
- Color: one warm accent (juice/citrus — amber/orange) on a neutral background.
  One accent only.

## Page structure (top to bottom)

Each section below lists the copy points. Keep each section to a few lines.

### 1. Hero
- ASCII logo + tagline "agent secrets without copy/paste."
- One-sentence positioning: *Juice is minimal secrets management for agents and
  apps — local development reads and writes `.env`; production fetches one secret
  at a time from your own Juice API.*
- Primary CTA button (install) + a copyable command:
  `npm i @juice/sdk && npx juice init`
- Secondary: "View on GitHub".

### 2. The problem (short)
Three lines max: secrets get copy/pasted into `.env`, committed by accident,
and agents editing files by hand make it worse. Juice gives one command to add a
secret and one call to read it.

### 3. How it works — the one idea
The single source of truth. Show the same call site working in both modes:

```ts
import { juice } from "@juice/sdk";
const key = await juice.get("OPENAI_API_KEY");
```

Copy point: *You call `juice.get("KEY")` once. Juice reads local `.env` in
development and your remote API in production — same code, no branching.* Mention
mode resolution plainly: `JUICE_ENV → APP_ENV → NODE_ENV → development`.

### 4. Feature grid (the core benefits)
Six cards, each a real, shipped capability. Titles + one line each:

1. **Single source of truth for env vars.** Add a secret once; read it everywhere
   with `juice.get()` (SDK) or `juice get` (CLI).
2. **Local-first, zero setup.** `juice set KEY` appends to `.env`; `juice.get()`
   reads it. No server, no login, no account to start.
3. **Built for agents.** Agents run `juice set` / `juice get` / `juice run`
   instead of hand-editing `.env`. Drop-in `AGENTS.md`/`CLAUDE.md` snippet
   included (see `docs/AGENTS.snippet.md`).
4. **`juice run -- <cmd>`.** Launch any process with secrets injected into its
   environment — nothing printed, nothing copy/pasted.
5. **Drift detection.** Juice fingerprints `.env` and warns when it changes
   outside the tool, so surprise edits don't slip by.
6. **One secret at a time.** Fetches are per-key, which keeps blast radius small
   and the audit trail meaningful.

### 5. Commands at a glance
Render the real command list (from `juice help`) as a compact table. Use these
exact commands — do not add any that aren't in the CLI:

| Command | Does |
|---|---|
| `juice init` | Scaffold `.gitignore` + `.env` for local secrets |
| `juice auth login` | Sign in with GitHub (device flow) |
| `juice set KEY` | Add a secret (local `.env`, or `--remote`) |
| `juice get KEY` | Print one secret value to stdout |
| `juice list` | List secret key names (never values) |
| `juice unset KEY` | Remove a secret |
| `juice run -- <cmd>` | Run a command with secrets injected |
| `juice token create` | Create a scoped machine token (CI/agents) |
| `juice token revoke` | Revoke a token |

Note the shared flags briefly: `--remote` / `--local`, `--project`, `--env`.

### 6. Security posture (this is a selling point — be accurate, link SECURITY.md)
Bullet the real guarantees; keep them honest (mirror `SECURITY.md`, don't
overclaim):
- **Per-user isolation.** Remote secrets are namespaced per authenticated GitHub
  identity; one user can't read another's.
- **Short-lived, scoped, revocable tokens.** Interactive logins expire; CI/agent
  machine tokens are scoped to one project + env, can be read-only, and are
  revocable.
- **HTTPS-only.** The client refuses non-HTTPS API URLs (except localhost).
- **Secret values are never printed** to logs or confirmations (only `juice get`
  writes a value, to stdout).
- **Backed by AWS Secrets Manager** in remote mode; **tiny dependency surface**
  (one runtime dependency).
- Add the honest caveat from `SECURITY.md`: anything that can read your process
  env or `~/.juice` can act as you; local mode is only as safe as your disk.

### 7. Self-host / open source
- **Open source.** SDK + CLI are Apache-2.0 (adopt freely, no copyleft); the
  server + infra are AGPL-3.0. Link `LICENSING.md`.
- **Self-hostable.** Deploy your own API to AWS with the included CDK stack
  (Fargate behind HTTPS). Link `docs/SELF_HOSTING.md`.
- Reinforce: your secrets live in **your** AWS account.

### 8. Final CTA + footer
- Repeat install command + GitHub link.
- Footer: links to README, SECURITY.md, LICENSING.md, self-hosting guide; license
  line ("Apache-2.0 SDK · AGPL-3.0 server").

## Copy do / don't
- **Do** show real commands and the real tagline. **Do** keep every claim checkable
  against the repo.
- **Don't** promise a hosted service, pricing, a dashboard/UI, team sharing, secret
  rotation, or any integration that isn't in the code today. (`api.juice.run` is
  not a live product — do not present a hosted signup.)
- **Don't** add SSO, Vault, k8s, or cloud logos that aren't implemented.

## Deliverables
- `www/index.html` (+ optional `www/styles.css`) — the site.
- Passes: renders with no console errors, no external requests, works with JS off,
  legible in light and dark, mobile and desktop.
- Keep this `PLAN.md` in `www/` for reference, or delete it once the site is built.
