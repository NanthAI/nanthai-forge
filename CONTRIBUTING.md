# Contributing

Contributions go through Forge: use an isolated Lane or the contribution/proposal route.
GitHub `main` is a read-only mirror of accepted Forge source. See
[project governance](docs/operations/governance.md) for access and protected paths.

Read [AGENTS.md](AGENTS.md) first, then [development](docs/development.md).

Use Node 24.22.1+ (24.x) and Git. Run `npm ci --ignore-scripts`, then `npm run verify` before submitting the change through Forge. `npm run format` fixes formatting.

Use `feat/<scope>`, `fix/<scope>` or `docs/<scope>` branches. In the Forge handoff, describe the problem, the new behavior, how you verified it and what it does not cover. Keep unrelated refactors separate. Include consumers and compatibility tests when you change a shared contract. A benchmark report must include failed attempts. Private repositories never become public fixtures, so use synthetic fixtures.

Follow [LICENSE.md](LICENSE.md). Keep permissive protocol and tooling code independent from server code, and do not copy code from another repository without checking its license.

Never put credentials or private data in issues or pull requests. Report vulnerabilities as described in [SECURITY.md](SECURITY.md).
