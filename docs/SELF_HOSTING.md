# Self-hosting the Juice API

The published `@juice/sdk` package is **SDK + CLI only** (Apache-2.0). To run the
API yourself, clone this repository and deploy with Docker or CDK. Server and
infra are **AGPL-3.0-or-later** — see [`LICENSING.md`](../LICENSING.md).

## 1. Create a GitHub OAuth App (device flow)

1. GitHub → Settings → Developer settings → OAuth Apps → New OAuth App.
2. Application name: e.g. `Juice`.
3. Homepage URL: your docs or API URL.
4. Authorization callback URL: unused for device flow; any HTTPS URL is fine.
5. Copy the **Client ID** (you do not need a client secret for device flow).

Enable **Device Flow** on the OAuth App if GitHub shows that option.

## 2. Required CDK parameters

| Parameter | Description |
|-----------|-------------|
| `GitHubClientId` | OAuth App client ID from step 1 |
| `CertificateArn` | ACM certificate ARN for the HTTPS listener |
| `HostedZoneId` | Route53 hosted zone ID |
| `HostedZoneName` | Zone name, e.g. `example.com` |
| `ApiDomainName` | FQDN for the API, e.g. `api.example.com` |

Optional: `DesiredCount` (default `1`), `VersionCommit` (defaults from context /
`git rev-parse HEAD`).

`JUICE_TOKEN_SECRET` is **auto-generated** by the stack into Secrets Manager and
injected into the task — do not put it in git.

## 3. Bootstrap and deploy

```sh
git clone <this-repo>
cd juice
npm ci
npm run build
npx cdk bootstrap aws://ACCOUNT_ID/REGION

npx cdk deploy JuiceApiStack \
  -c versionCommit="$(git rev-parse HEAD)" \
  --parameters GitHubClientId=Iv1.xxxxxxxx \
  --parameters CertificateArn=arn:aws:acm:... \
  --parameters HostedZoneId=ZXXXXXXXX \
  --parameters HostedZoneName=example.com \
  --parameters ApiDomainName=api.example.com \
  --parameters VersionCommit="$(git rev-parse HEAD)"
```

## 4. Stack outputs

| Output | Use |
|--------|-----|
| `ApiUrl` | `https://api.example.com` — set as `JUICE_API_URL` for clients |
| `TokenSecretArn` | ARN of the generated JWT signing secret |
| `DeployedVersionCommit` | Commit exposed by `GET /` |

```sh
export JUICE_API_URL="$(aws cloudformation describe-stacks \
  --stack-name JuiceApiStack \
  --query "Stacks[0].Outputs[?OutputKey=='ApiUrl'].OutputValue" \
  --output text)"

curl "$JUICE_API_URL/healthz"
juice auth login
```

## 5. Local API development

```sh
npm run dev
```

`scripts/run-api-local.mjs` generates an **ephemeral** `JUICE_TOKEN_SECRET` for
that process if unset, and sets `JUICE_VERSION_COMMIT` from `git`. Point the CLI
at it:

```sh
export JUICE_API_URL=http://127.0.0.1:8787
export JUICE_ALLOW_INSECURE=1   # only for local http
export GITHUB_CLIENT_ID=…      # required for login
```

Production refuses to start without a strong `JUICE_TOKEN_SECRET` (≥32 chars).

## 6. Docker (without CDK)

```sh
docker build --build-arg JUICE_VERSION_COMMIT="$(git rev-parse HEAD)" -t juice-api .
docker run --rm -p 8787:8787 \
  -e JUICE_TOKEN_SECRET="$(openssl rand -base64 48)" \
  -e GITHUB_CLIENT_ID=your-client-id \
  -e AWS_REGION=us-east-1 \
  juice-api
```

Prefer an IAM task role over static AWS keys. The task needs Secrets Manager
access for `/juice/users/*/projects/*` (CRUD + delete), token revocations, and
account-wide `ListSecrets` (tenant isolation is enforced in the API by prefix
filter — see `SECURITY.md`).

## 7. Deploy from GitHub Actions

`.github/workflows/deploy.yaml` runs on **`workflow_dispatch` only** and uses the
`production` environment (configure required reviewers in GitHub). Needed
secrets/vars:

- `AWS_DEPLOY_ROLE_ARN` — OIDC-assumable deploy role
- `JUICE_GITHUB_CLIENT_ID`
- `AWS_REGION` (optional; default `us-east-1`)

## Membership store (Convex)

Accounts, identities, and invites live in Convex; secret *values* never do. The
API server reaches it over HTTP Actions, guarded by a shared secret.

```sh
npx convex dev --once            # or: npx convex deploy   (pushes convex/)
npx convex env set JUICE_API_SHARED_SECRET "$(openssl rand -base64 32)"
npx convex env get JUICE_API_SHARED_SECRET   # copy to the API server
```

Then on the API server:

| Variable | Value |
|---|---|
| `JUICE_CONVEX_URL` | `https://<deployment>.convex.site` — the **HTTP Actions** URL, not `.convex.cloud` |
| `JUICE_CONVEX_SECRET` | the same value as `JUICE_API_SHARED_SECRET` above (≥32 chars) |

Everything in `convex/membership.ts` is an `internal*` function, so it cannot be
called by a client holding the deployment URL. `convex/http.ts` is the only
caller and checks the shared secret first, in constant time. If
`JUICE_API_SHARED_SECRET` is unset or short, every route refuses rather than
defaulting open.

Without both variables, `juice auth login` returns 501 — there is no way to
resolve an account, and inventing one would put secrets somewhere unrecoverable.

## Configuring the server from a file

The server reads `JUICE_ENV_FILE` (default `./.env`) at startup. Unlike the CLI,
it **does** accept `JUICE_*` keys from that file — the CLI refuses them because a
`.env` in a repository must not be able to redirect someone's secrets, but a
server has no repository and the operator is the one writing the file.

```sh
cat > .env <<'ENV'
JUICE_TOKEN_SECRET=...
JUICE_CONVEX_URL=https://<deployment>.convex.site
JUICE_CONVEX_SECRET=...
GITHUB_CLIENT_ID=...
ENV
chmod 600 .env
```

The real environment always wins over the file, so ECS task secrets and
`docker run -e` are never overridden by a stale checkout. Startup logs which
keys the file supplied — names only, never values — and warns if the file is
readable by group or others.

## GitHub OAuth / App setup

Juice uses the **device flow**, so the CLI is a public client and there is no
client secret. The server needs only `GITHUB_CLIENT_ID`.

Either an OAuth App or a GitHub App works. For a GitHub App, note that the
**Client ID** (`Iv23li…`) is not the **App ID** (a small integer) — the device
flow needs the Client ID.

- Tick **Enable Device Flow**. It is off by default, and without it login fails
  with `device_flow_disabled` and no other clue.
- The **callback URL is never used** by the device flow. It is required by the
  registration form and then ignored, so any placeholder is fine.
- **No permissions or scopes need to be granted.** The only GitHub call Juice
  makes is `GET /user`, to read the numeric user id that keys the account. That
  endpoint works with any user-access token. GitHub Apps ignore the `scope`
  parameter entirely; the `read:user` we send is harmless.
- The GitHub token is used once, immediately, to read that id, and then
  discarded — Juice mints its own JWT. GitHub App token expiry is therefore
  irrelevant.
