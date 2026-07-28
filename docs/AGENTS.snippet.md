# Juice for agents (copy into AGENTS.md / CLAUDE.md)

Use Juice for secrets. Never put a secret in a file in this repository, and
never print a secret value.

**The CLI writes. The SDK reads. Every command needs an explicit `--scope`.**

```sh
juice scopes                                  # scopes available on this machine
juice set KEY --scope <name>                  # hidden prompt
juice list --scope <name>                     # key names only
juice unset KEY --scope <name> --yes
juice export --scope <name> --to <path>       # for things that are not Node
```

In code:

```ts
import { juice } from "@juice/sdk";
const secrets = juice.scope("<name>");
const value = await secrets.get("KEY");
```

Rules:

1. **Always pass `--scope`.** Juice does not infer one from the directory, and
   will refuse rather than guess. If you do not know which scope to use, run
   `juice scopes` or ask — do not invent one.
2. **A value is never an argument.** `juice set KEY value` is refused; it would
   land in `ps` and in shell history. Use the prompt, or
   `printf %s "$V" | juice set KEY --scope <name> --stdin`.
3. **Never log or echo values.** `list` is names-only. `get` prints a value to
   stdout and exists for debugging — avoid it in scripts, since
   `$(juice get KEY)` lands in shell history.
4. **`export` writes to a path, never stdout**, and refuses to write inside a
   git repository without `--force`. It defaults to `--format sh`, which is safe
   to `source`; `--format dotenv` is not.
5. `--env` selects the environment: `development` (default, stored on this
   machine) or `staging` / `production` (stored remotely, needs auth).
6. **Never create or redeem an invite** (`juice members invite`, `juice join`).
   An invite grants access to every secret in the account; that is a decision
   for a person, not an agent. Machine tokens are refused these commands.
7. For headless work use a least-privilege machine token
   (`juice token create --scope <name> --env <env> --read-only --ttl 90d`) and
   revoke it when done.
