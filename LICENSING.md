# Licensing

Juice uses a split license so the client can be adopted permissively while
hosted/server forks share their changes.

| Path | License | Why |
|------|---------|-----|
| Published npm package (`@juice/sdk`) — `src/sdk`, `src/cli`, `src/auth`, `src/config`, `src/http`, `src/local` | **Apache-2.0** | Agents and apps can depend on the SDK/CLI without AGPL obligations. |
| `src/api/` | **AGPL-3.0-or-later** | The hosted API is copyleft so modifications to a networked service are shared. |
| `infra/` | **AGPL-3.0-or-later** | Deploy/CDK stack ships with the server under the same terms. |

The root `LICENSE` is Apache-2.0 and governs the published package. AGPL texts
live at `src/api/LICENSE` and `infra/LICENSE`.

## Install vs self-host

- `npm install @juice/sdk` gives you the Apache SDK/CLI only. There is no
  `@juice/sdk/api` export.
- To run the Juice API yourself, clone this repository and deploy via Docker/CDK
  (see `docs/SELF_HOSTING.md` once published). That path is AGPL.
