# Limits, errors and costs

Use the receipt's next action and distinguish a project setting from a service capability.

## Recover from an error

CLI failures carry a structured code, message, next action and learning link. Keep the original operation id for an unknown outcome. Follow the exact continuation; generating a new id starts new work. The [generated error reference](reference/errors.md) lists public codes and their recovery templates from source. The [generated CLI help topics](reference/cli.md#help-topics) explain retry, conflict, wait, check and access failures, with the next command.

## Read complete evidence

Paged responses say how to continue. Source reads, diffs, logs and provenance disclose their bounded coverage. Their [enforced JSON schemas](reference/cli.md) carry field constraints; the [agent workflow](agents/workflow.md#hosted-reads-and-coordination-limits) explains how to request the rest. An omission is not proof that an object or relationship does not exist.

## Project settings

[Parallel-work defaults](parallel-work-defaults.md) describes the current configurable defaults. [Checks and admission](pre-queue-checks.md) explains exact-source checks and docs-only behavior.

## Costs and availability

[Cost to serve](operations/cost-to-serve.md) records measured usage and what remains unmeasured. [Account billing](guides/billing.md) says which billing parts are stubs; charging is not available yet. [Status](status.md) is the current capability inventory. Forge has no published package or public production service yet.
