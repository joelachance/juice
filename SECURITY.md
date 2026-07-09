# Security Policy

## Supported versions

| Version | Supported |
|---------|-----------|
| 0.1.x   | Yes |

## Reporting a vulnerability

Email the maintainers privately (do not open a public issue for exploitable
bugs). Include:

- Affected version / commit
- Reproduction steps
- Impact (e.g. cross-user secret read, token forgery)

We aim to acknowledge within a few business days and coordinate a fix before
any public disclosure.

## Threat model

### What Juice protects against

- **Secrets in source control** — local mode keeps values in `.env` (gitignored
  via `juice init`); remote mode stores them in AWS Secrets Manager under
  `/juice/users/<github-id>/…`.
- **Cross-user access** — authorization is owner-only by default; paths are
  namespaced per GitHub user id. `list` results are filtered to the caller's
  prefix (IAM cannot scope `ListSecrets` by name).
- **Stolen long-lived credentials** — user JWTs expire; machine tokens are
  scoped (project/env/actions), revocable, and cannot mint new tokens.
- **Accidental value leaks in CLI UX** — only `juice get` prints a value
  (stdout); `list` / confirmations / audit logs never include values.

### What Juice does not protect against

- **Anyone who can read your process environment** can use injected secrets
  (`juice run`) or a `JUICE_TOKEN` already in the environment.
- **Anyone who can read `~/.juice` or the macOS Keychain entry** can act as
  you against the API until the token expires or is revoked.
- **Local mode is only as safe as your disk and backups** — `.env` is a plain
  file (`0600`); Juice does not encrypt it at rest.
- **Host compromise / malicious dependencies** in your app are out of scope.
- **Account-wide `ListSecrets` on the API task role** can enumerate secret
  *names* in the AWS account; the API must filter by caller prefix before
  returning keys. Do not weaken that filter.

### Operator notes

- Never set a weak or hardcoded `JUICE_TOKEN_SECRET`. The server refuses to
  start without a secret ≥32 characters.
- Prefer HTTPS endpoints; the client rejects cleartext non-local `JUICE_API_URL`
  unless `JUICE_ALLOW_INSECURE=1`.
- Repo `.env` files must not be used for Juice control-plane config — `JUICE_*`
  keys there are ignored.
