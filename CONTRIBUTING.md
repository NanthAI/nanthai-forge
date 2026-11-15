# Contributing

Contributions go through Forge: use a hosted clone and an isolated Lane.
GitHub `main` is a read-only mirror of accepted Forge source. See
[project governance](docs/operations/governance.md) for access and protected paths.

Read [AGENTS.md](AGENTS.md) first, then [development](docs/development.md).

Use Node 24.22.1+ (24.x); Git is needed for the Git compatibility tests. Forge's hosted main is the source of truth; the local Git checkout and GitHub main are mirrors. Do not commit changes in the project folder.

1. Read the planning Item and all its comments. Check for earlier open Lanes, then start your own Lane with a fresh operation id: `nforge agent ROOT start '{"planningItemId":"ITEM_ID","operationId":"UUID"}'`.
2. Edit only the returned Lane path. Use normal tools there and save after meaningful steps with `nforge agent ROOT save '{"laneId":"LANE_ID","message":"What changed"}'`.
3. Run affected tests, docs, typecheck, lint and format checks through `nforge heavy`. Use `preflight {"laneId":"LANE_ID"}` for saved-head selection. `npm run format` fixes formatting. The full `npm run verify` belongs on the project runner, not a second full local run.
4. Unless the brief says save-only or a benchmark hold is active, use `nforge agent ROOT land --save '{"laneId":"LANE_ID","message":"What changed and why"}'`. Follow the exact receipt until terminal; comment the evidence on the Item. A saved State alone is not a landing.

The handoff describes the problem, resulting behavior, saved/accepted State, what was removed or merged, checks run and anything unverified. Keep unrelated refactors separate. Include consumers and compatibility tests for a shared contract. Benchmark reports include failed attempts. Use synthetic fixtures; private repositories never become public fixtures.

Plain Git clone/fetch is a read/export path ([Git serving](docs/git-serving.md)); current contributions use hosted clones and Lanes. Existing proposal archives can still be downloaded or their original uploads reconciled; the browser does not create a new archive proposal.

Follow [LICENSE.md](LICENSE.md). Keep permissive protocol and tooling code independent from server code, and do not copy code from another repository without checking its license.

Never put credentials or private data in issues or pull requests. Report vulnerabilities as described in [SECURITY.md](SECURITY.md).
