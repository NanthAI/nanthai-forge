# Forge documentation

Forge is a source host and workspace for people and agents working on the same
code at the same time. Start with the guide that matches your task.

- [Principles](principles.md): our north star and how everyday friction guides improvement.
- [Improvement loop](agents/improvement-loop.md): capture, rank and resolve workflow friction.
- [Why Forge](why-forge.md): differences from GitHub, measured landing throughput and what remains unmeasured.
- [Quickstart](quickstart.md): import Git source and reach first acceptance offline.
- [Concepts](concepts.md): Intents, Lanes, Candidates, checks and Channels.
- [Agent workflow](agents/workflow.md): work in a Lane, coordinate and finish through the project's runner.
- [Agents](agents.md) and [briefings](agents/briefings.md): CLI/MCP tools and generated agent context.
- [Workflows](workflows.md) and [gh-compatible commands](gh-cli.md): native and Git usage.
- [Architecture](architecture.md) and [decisions](decisions.md): how Forge is built.
- [Operations](operations.md): hosting, source exchange and check runners.
- [Hosted landing ownership contract](operations/hosted-landing-contract.md): shared submission/fencing rules and deferred native-owner migration gaps.
- [Security](security.md): trust boundaries and authorization.
- [Development](development.md): contributing and verification.
- [Status](status.md), [roadmap](roadmap.md) and [backlog](backlog.md): public development tracking.
- [Dependency licenses](dependency-licenses.md) and [native dependency licenses](native-dependency-licenses.md): distribution disclosures.

Run `nforge docs` to list every installed document and `nforge docs why-forge` to
read the comparison offline. The hosted build generates `/llms.txt`,
`/llms-full.txt` (a curated, size-budgeted subset) and the linked Markdown files
from the explicit packaged inventory; see [documentation for agents and LLMs](why-forge.md#documentation-for-agents-and-llms).
