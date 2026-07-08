# Juice

Juice is minimal secrets management for agents. Local development reads and
writes `.env`; non-local environments fetch one secret at a time from a Juice
API backed by AWS Secrets Manager.

## V1 commands

```sh
juice auth login
juice set OPENAI_API_KEY
juice set OPENAI_API_KEY --remote
```

`juice set KEY` appends to local `.env` and records a fingerprint so Juice can
warn when `.env` changes outside the CLI. `--remote` writes through the Juice
API to AWS Secrets Manager and never prints the secret value.

## SDK

```ts
import { juice } from "@juice/sdk";

const apiKey = await juice.get("OPENAI_API_KEY");
```

Resolution order:

1. `JUICE_ENV`
2. `APP_ENV`
3. `NODE_ENV`
4. `development`

`local` and `development` read local `.env`, unless `JUICE_REMOTE=1` is set.
Remote reads use `JUICE_PROJECT` or the nearest `package.json` name.
By default, remote commands use the hosted Juice API at `https://api.juice.run`.
Set `JUICE_API_URL` to use a local or self-hosted API.

## API service

The production secret backend uses the official AWS SDK for JavaScript v3:
`@aws-sdk/client-secrets-manager`.

```ts
import { createJuiceServer } from "@juice/sdk/api";

const server = createJuiceServer();
server.listen(8787);
```

AWS credentials are resolved by the AWS SDK credential provider chain.

To run the API locally:

```sh
npm run dev
```

This loads `.env` and `.env.local` automatically. If `GITHUB_CLIENT_ID` is in
`.env.local`, no export is needed.

To run the full local API smoke test in one command:

```sh
npm run test:api-local
```

Health checks:

```sh
curl http://localhost:8787/healthz
```

Version checks:

```sh
curl http://localhost:8787/
```

The root path returns the deployed service version and commit:

```json
{"service":"juice-api","commit":"<git-sha>","version":"0.1.0"}
```

For local development, the API and CLI automatically read `.env` and
`.env.local` from the current directory. Real environment variables still win,
and `.env.local` overrides `.env`.

`JUICE_TOKEN_SECRET` is only for whoever operates a Juice API server. Hosted SaaS
users should not set it; they only run `juice auth login` and use the hosted API.
Self-hosters need it because, after GitHub OAuth completes, the API signs its own
bearer token for the CLI/SDK. This secret prevents forged Juice tokens. It is not
the GitHub OAuth client secret, not an AWS credential, and not a user application
secret. CDK creates it automatically for Fargate. Locally, `/`, `/healthz`, and
`/auth/github/start` work without it; completing login and authorizing remote
secret reads/writes need it.

## Docker

Juice ships with a Dockerfile so the same API service can be self-hosted or run
as the hosted Juice SaaS.

```sh
docker build --build-arg JUICE_VERSION_COMMIT="$(git rev-parse HEAD)" -t juice-api .
docker run --rm -p 8787:8787 \
  -e JUICE_TOKEN_SECRET=replace-with-long-random-secret \
  -e GITHUB_CLIENT_ID=your-github-oauth-client-id \
  -e AWS_REGION=us-east-1 \
  -e AWS_ACCESS_KEY_ID=... \
  -e AWS_SECRET_ACCESS_KEY=... \
  juice-api
```

For AWS deployments, prefer IAM roles or web identity over static access keys.
The runtime identity needs:

```json
{
  "Effect": "Allow",
  "Action": [
    "secretsmanager:CreateSecret",
    "secretsmanager:DescribeSecret",
    "secretsmanager:PutSecretValue",
    "secretsmanager:GetSecretValue"
  ],
  "Resource": "arn:aws:secretsmanager:*:*:secret:/juice/projects/*"
}
```

## Hosted SaaS

The hosted Juice API is the default remote endpoint. The OSS API remains fully
self-hostable under AGPL-3.0-or-later; the hosted service can add billing,
organization policy, rate limits, support, and managed AWS operations without
changing the CLI or SDK interface.

## Deploy the SDK/API stack

The CDK stack deploys the Dockerfile to ECS Fargate behind an Application Load
Balancer. It also creates:

- a VPC and ECS cluster
- CloudWatch log group
- generated `JUICE_TOKEN_SECRET` in AWS Secrets Manager
- task IAM permissions for Juice-owned Secrets Manager paths under
  `/juice/projects/*`

Bootstrap CDK once per AWS account/region:

```sh
npm ci
npm run build
npx cdk bootstrap aws://ACCOUNT_ID/us-east-1
```

Deploy:

```sh
npx cdk deploy JuiceApiStack \
  -c versionCommit="$(git rev-parse HEAD)" \
  --parameters GitHubClientId=your-github-oauth-client-id \
  --parameters VersionCommit="$(git rev-parse HEAD)"
```

After deploy, use the `ApiUrl` stack output:

```sh
curl "$API_URL/healthz"
curl "$API_URL/"
```

To point a client at a self-hosted stack:

```sh
export JUICE_API_URL="$API_URL"
```

GitHub Actions deployment is defined in `.github/workflows/deploy.yaml`. Configure
these repository settings:

- secret `AWS_DEPLOY_ROLE_ARN`: AWS role assumable by GitHub OIDC
- secret `JUICE_GITHUB_CLIENT_ID`: GitHub OAuth app client ID
- variable `AWS_REGION`: deployment region, defaults to `us-east-1`
