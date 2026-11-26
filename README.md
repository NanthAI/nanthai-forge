# NanthAi:Forge

Forge is a source host and workspace for people and AI agents changing the same code at the same time. Agents keep working in their own tools (Claude Code, Codex, editors); Forge gives them isolated places to work, merges their changes safely, runs checks, and shows a human what is happening.

Four ideas cover most of it:

- **Intent** — an outcome you want ("fix tax rounding").
- **Lane** — an isolated working directory where one person or agent makes that change.
- **Check** — a recorded test run against an exact snapshot of the code.
- **Channel** — accepted source, like a branch (`main`). Forge applies the project's landing policy and keeps its recorded check evidence. Accepting preserves earlier accepted work.

More in [concepts](docs/concepts.md).

For bringing a project to Forge and landing your first change, run `nforge docs quickstart`
([quickstart](docs/quickstart.md)). Browse installed documentation with `nforge docs`.

## Try it

Node 24.22.1+ (24.x):

```sh
npm ci --ignore-scripts
npm run verify                      # format, typecheck, lint, tests
```

Forge runs hosted projects only. To host a folder and browse it in the web app, run `nforge login`, then `nforge host ./demo` (a Git folder or any directory). Lanes keep working offline and land once back online.

A plain directory gets a Forge-native source bootstrap without Git. Hosting selects verified source and server authority together; use `nforge clone OWNER/PROJECT DIR` to check it out and start Lanes. Existing hosted projects retain their authority.

For agents, run `nforge agent ROOT start '{"outcome":"Update the README"}'` with your clone path as `ROOT`. Change into the returned Lane folder, edit the file, and run `nforge agent . land --save '{"message":"Update the README"}'` there. Supply your model ID in `model` or `FORGE_AGENT_MODEL` when known. See the [agent workflow](docs/agents/workflow.md) and [parallel-work defaults](docs/parallel-work-defaults.md).

Git repositories work too ([workflows](docs/workflows.md)). Forge applies the project policy at landing. If you configure checks, they can run on [GitHub Actions](docs/operations/github-actions-checks.md) or your own runners.

Checks use your CI provider’s full logs. Forge retains results, failure summaries, compact test evidence and provider links. Local log upload is opt-in with finite retention ([operations](docs/operations.md#check-logs-and-retention)).

## Where things stand

Forge is in active development and builds itself. [Status](docs/status.md) lists what works and what doesn't; [roadmap](docs/roadmap.md) lists what's next. Forge has not yet shown a token or time advantage over plain Git for single agents ([evals](evals/README.md)); multi-agent coordination is what we are measuring next.

## Hosted links

Open [Forge](https://forge.nanthai.tech) to find your projects. Hosted links use
`/<handle>/<project-slug>`. Links using a previous name or a project ID redirect
after the usual project access checks. See [readable URLs](docs/readable-urls.md).

Hosted source operations currently support up to 56,800 files and 9,200,000
logical manifest bytes per State across all phases; save and compose have larger
individual bounds. See the [repository envelope](docs/operations/source-exchange.md#supported-repository-envelope)
and [P8 streaming work](docs/roadmap.md#streaming-source-steps-p8).

## Licence

Forge is licensed [AGPL-3.0-only](LICENSE-AGPL-3.0-only.txt), copyright 2026 Ferdinando Valsecchi. Every original file is covered; third-party code keeps its own licence and the Forge marks stay all-rights-reserved. See [LICENSE.md](LICENSE.md). Outside contributions need a contributor agreement and are closed for now ([CONTRIBUTING.md](CONTRIBUTING.md)).

## More

[Documentation](docs/README.md) · [Why Forge](docs/why-forge.md) · [Architecture](docs/architecture.md) · [Roadmap](docs/roadmap.md) · [Development](docs/development.md) · [Security](docs/security.md) · [Operations](docs/operations.md) · [Contributing](CONTRIBUTING.md) · [License](LICENSE.md)
