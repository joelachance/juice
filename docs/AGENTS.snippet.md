# Juice for agents (copy into AGENTS.md / CLAUDE.md)

Use Juice for project secrets. Do **not** edit `.env` by hand or print secret
values.

```sh
juice init
juice set KEY                 # prompt; appends to .env
juice get KEY                 # value on stdout only
juice list                    # key names only
juice unset KEY --yes
juice run -- <cmd> [args…]    # inject secrets into a child process
```

In code:

```ts
import { juice } from "@juice/sdk";
const value = await juice.get("KEY");
```

Remote / CI:

```sh
juice auth login
juice set KEY --remote
juice token create --project <name> --env <env> --read-only --ttl 90d
# Prefer one project + one env; use --read-only unless writes are required.
# Revoke with: juice token revoke
```

Rules:

1. Prefer `juice set` / `juice.get` / `juice run` over reading or writing `.env`.
2. Never log or echo secret values (`list` is names-only; `get` is for capture).
3. Use least-privilege machine tokens for headless work; revoke when done.
