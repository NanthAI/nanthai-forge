# NanthAi:Forge

Forge is a source host and workspace for people and AI agents changing the same code at the same time. Agents keep working in their own tools (Claude Code, Codex, editors); Forge gives them isolated places to work, merges their changes safely, runs checks, and shows a human what is happening.

Four ideas cover most of it:

- **Intent** — an outcome you want ("fix tax rounding").
- **Lane** — an isolated working directory where one person or agent makes that change.
- **Check** — a recorded test run against an exact snapshot of the code.
- **Channel** — accepted source, like a branch (`main`). Agents accept after a passing check; people can accept a clean Candidate under review. Accepting never drops someone else's accepted work.

More in [concepts](docs/concepts.md).

For offline Git adoption through first acceptance: `nforge docs quickstart`
([quickstart](docs/quickstart.md)). Browse installed documentation with `nforge docs`.

## Try it

Node 24.22.1+ (24.x):

```sh
npm ci --ignore-scripts
npm run verify                      # format, typecheck, lint, tests
node dist/cli.js init-native ./demo # a new project; no Git needed
```

To host a project and browse it in the web app: `nforge login DEPLOYMENT_URL`, then `nforge host ./demo`. The browser UI is the hosted app; there is no local web UI.

For agents: `nforge agent ./demo start '{"outcome":"…"}'`, edit the returned Lane, then `nforge agent ./demo finish '{"laneId":"…","message":"…","accept":true}'`. See the [agent workflow](docs/agents/workflow.md).

Git repositories work too ([workflows](docs/workflows.md)), and projects can be hosted so several machines and people share them ([architecture](docs/architecture.md)). Your machine controls execution; native checks run locally or through [GitHub Actions](docs/operations/github-actions-checks.md).

Checks use your CI provider’s full logs. Forge retains results, failure summaries, compact test evidence and provider links. Local log upload is opt-in with finite retention ([operations](docs/operations.md#check-logs-and-retention)).

## Where things stand

Forge is in active development and builds itself. [Status](docs/status.md) lists what works and what doesn't; [roadmap](docs/roadmap.md) lists what's next. Forge has not yet shown a token or time advantage over plain Git for single agents ([evals](evals/README.md)); multi-agent coordination is what we are measuring next.

## Hosted links

Hosted URLs use `/<handle>/<project-slug>`; previous names and ID-based links redirect
through retained aliases after the same project-access checks. See [readable URLs](docs/readable-urls.md)
for the operator backfill command (`npx convex run urlsBackfill:run '{"cursor":null}'`,
then repeat with the returned cursor until `isDone`) and settings behavior.

URL call sites use `src/project-routes.ts`: the hosted route gate and frame, project
list navigation, existing copy/share links through the shell codec, CLI/MCP agent
links (`src/agent-links.ts`), and CLI hosting output (`convex/projectHosting.ts`).

## More

[Documentation](docs/README.md) · [Why Forge](docs/why-forge.md) · [Architecture](docs/architecture.md) · [Roadmap](docs/roadmap.md) · [Development](docs/development.md) · [Security](docs/security.md) · [Operations](docs/operations.md) · [Contributing](CONTRIBUTING.md) · [License](LICENSE.md)
