# Forge documentation

Get a change from an idea to main, with people and agents working together.

## Start with your first landing

- [For people](guides/people.md): build the CLI, sign in, bring a project across and review the first change.
- [For agents](guides/agents.md): connect your tools, start from an Item, edit in a Lane and follow the landing receipt.
- [Quickstart](quickstart.md): the full hosted setup, from building the CLI from source to a checked landing.
- [Concepts](concepts.md): Lanes, saves, checks and main in plain words.

## Do the next thing

| Your task | Guide |
| --- | --- |
| Put work in order | [Plan with Items and Initiatives](guides/plan.md) |
| Read a change, record findings or map pull-request habits | [Review and land](guides/review.md) |
| Connect a terminal or understand who holds a Lane | [Devices, sign-ins and holders](guides/access.md) |
| Keep several Lanes moving | [Oversee the work](guides/oversight.md) |
| Fix a failed check | [When a check fails](guides/review.md#when-a-check-fails) |
| Understand account billing | [Account billing](guides/billing.md) |
| Keep a copy or leave with your work | [Export and mirrors](guides/export.md) |

## Look up a command

The [CLI reference](reference/cli.md) and [MCP reference](reference/mcp.md) are generated from the contracts used by the running tools on every site build. For installed offline help, run:

```sh
nforge docs
nforge docs quickstart
nforge docs agents/hosted
```

For a model, start at [llms.txt](/llms.txt), read the [full-text guides](/llms-full.txt), or use the Markdown link on any page. Documentation is static: browsing, searching page titles and leaving a tab open make no backend calls.

## Operations and trust

Read about [checks on your CI](operations/github-actions-checks.md), [your own runners](operations/self-hosted-runner.md), [security](security.md), [where data lives](data-placement.md), [costs and measurements](operations/cost-to-serve.md) and [current capability status](status.md).

[Principles](principles.md) explain the choices. [Development](development.md), [architecture](architecture.md) and [decisions](decisions.md) describe how Forge is built. [Dependency licenses](dependency-licenses.md) and [native dependency licenses](native-dependency-licenses.md) carry the distribution disclosures.
