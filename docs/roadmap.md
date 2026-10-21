# Roadmap

What we are doing, in what order, and why. Six phases. Phases 1–3 are done. Phase 4 is in progress. Phase 5 is private alpha; Phase 6 is public beta. Open work items live in the [backlog](backlog.md); what works today is in [status](status.md). Keep this page current: update the status lines when a stage changes.

Last updated: 2026-10-21.

## Direction

Forge's claim is that many agents can work on one codebase at once, aware of each other, with a human who can see and steer. Until that is proven against plain Git we prioritise: (1) never losing work, (2) landing speed, (3) live coordination, (4) a usable cockpit, (5) near-zero running cost, and we freeze new breadth. Forge builds itself: every change on this page lands through Forge's own workflow.

Product direction: an open source replacement for the GitHub workflow, cheap enough to host for many small projects, with a free core. Hosted Forge becomes the canonical home of a project; the owner's own machine stays a supported offline mode and Git stays an interchange format.

## Phase 1: foundations (done)

Goal: a trustworthy base and a way to measure.

Delivered:

- Prettier on all TypeScript; `format:check` is part of `verify`.
- One standard in-repo check (`scripts/forge-check.mjs`, Forge check `verify`).
- Accepted work is never lost: acceptance refuses stale Candidates; `finish` syncs `main`; a `sync` action; optional pins.
- Docs and process reset ([AGENTS.md](../AGENTS.md), about a dozen docs instead of about ninety).
- A first cost model (summarised in [status](status.md)): reads and file egress dominate at scale; identity is free; storage at rest is minor.
- A multi-agent benchmark harness and a Git-worktree baseline, kept outside this repository. Four scenarios (related tasks, mid-task contract change, disconnect and recovery, human redirect) by three agent mixes by two repetitions.

Baseline result: plain Git with worktrees passed 24 of 24 pairs, median about 110 s per pair, with 3 conflicts and 2 rejected pushes all recovered by the agents. Those scenarios are too easy to show a coordination benefit, so Forge can at best tie on success and must win on time or tokens. Harder scenarios (3 to 5 agents, longer tasks, overlapping edits that text merge accepts but that break behaviour, a contract change only coordination reveals, a larger codebase) were added for the Forge arm.

## Phase 2: make multi-agent work real (done)

Goal: the product behaves correctly with several agents at once, and a human can see it.

Delivered:

- Cockpit and UI rebuild: one screen answering who is working, what is changing, what is related and what needs a decision.
- Incremental Work metadata: source bytes, missing-object negotiation and binding validation reuse earlier checkpoints, and hosted source returns stage per-Candidate changed-path provenance.
- Native bound exchange pushes, the hosted index, presence, Lanes, Candidates, Checks and the acceptance ledger.
- The Forge arm of the benchmark harness.

Closed on 2026-10-16.

## Phase 3: speed, trust and hosted groundwork (done)

Goal: make landing fast, make checks trustworthy and cheap, and lay the groundwork for hosted projects.

Delivered:

- Scope-aware checks, concurrent checkpoints, landing batches and remote runners. Landing measured 2–3× faster than the GitHub merge queue on the same runners. A full check takes about 5–6 minutes on Blacksmith. About 134 landings completed.
- Clean-environment checks, authorization fixes and runner qualification. The restore drill passed.
- Performance instrumentation, client error capture and cheaper idle tabs and source returns.
- Intent vocabulary, UI coherence, quickstart, glossary and agent docs.
- Hosted main, browser project creation and resumable lossless GitHub import.

Closed on 2026-10-20. Current measurements and capabilities are in [status](status.md). Remaining work follows below and in the [backlog](backlog.md).

## Phase 4: we're happy using it (in progress)

Goal: the Forge team uses Forge end to end on its own project and is happy with it.

Started on 2026-10-21. Work in order:

1. **R3 metadata-only publication and return — done**, except the big-backlog measurement. Routine push fell from 95 minutes to about 3 minutes; push #21 took 186 seconds. See the [R2 storage plan](r2-storage-plan.md#r3-owner-derived-publication-and-source-return-done).
2. **Carried-over fixes — done**: P03, P04, P12, P15 and P27; hosted-unsynced state; incremental deploy export; the Modal estimate.
3. **Hosted Lanes**: start, save, compose, land, revert and abandon from the site with all Macs offline. Use a server-side landing queue with compare-and-swap main.
4. **The lead's routine in the product**: batch landing and the routine deploy and push workflow.
5. **Off-machine recovery**: recover the project without the owner's Mac.
6. **Predictive overlap warnings**: show likely overlap while agents work.
7. **Last: the agent-coordination benchmark**. Run forge-bench R3 with Forge coordination on, Forge coordination off and GitHub PRs. Use a real-history track on NanthAI Edge OSS and a synthetic track. Run a no-model preflight of every arm before the benchmark.

## Phase 5: private alpha (planned)

Goal: a few invited developers can use Forge on their own projects.

- Trial with outside users.
- A polished first project through GitHub import.
- A self-hosted check worker (`nforge worker`) using the project's own compute, with contributor first-click approval.
- Per-project usage counters.
- Newcomer docs.

## Phase 6: public beta (planned)

Goal: open Forge to public use with a free core and sustainable hosting.

- **Public Worker and custom domain**: serve public project bytes through the edge cache.
- **Open-source mode**: configurable proposal limits, anonymous visibility and an optional CLA.
- **Monetisation with a free core**: use the Phase 5 usage counters to inform decisions. Any limit or price needs an owner decision.
- **Cross-repo coordination** with shared usage pools.
- **Git serving** from hosted Forge, with Lane refs.
- **Product depth**: making-of, timeline and flow views, discussions, Markdown and images, a dependency graph, an extension model and Lane-scoped undo.
- **Later R2 slices**: browser bytes, imports, zones, agents and proposals, backfill, purge and backups. See the [R2 storage plan](r2-storage-plan.md). Retention or deletion changes still need an owner decision.

## Workflow friction

- Repeating sync on a Lane with a pending merge returns `MERGE_PENDING` without listing its conflicting paths. Include the pending sync target and conflicting paths in that diagnostic so a merge agent can resume from the receipt.

- Core finish/publication edits select 217 of 349 test files, including hosted and UI suites. Finite implementation agents need a phase-focused validation selection alongside the conservative landing selection; the broad local run competes with concurrent Lanes for check capacity and disk writes.

- A launchd `.plist` template selects the full test suite as an unclassified path. Finite agents forbidden from full verification must use affected backup/signer tests instead; the selector needs explicit template ownership.

- Central agent lifecycle edits produce a broad local scoped selection: predictive-overlap work selected 210 files, and a two-worker run was interrupted after 49.5 minutes with unrelated synthetic Git setup timeouts. Actions dispatch edits likewise select over 220 files through Work's transitive importers; finite local validation needs the Actions and affected replay suites and must report the other selected files as unrun. Local task validation needs a focused selection distinct from the combined remote landing selection; it must retain coverage and report any unrun files rather than silently treating the broad selection as passed.

- Browser byte work touching one Convex endpoint selects the whole backend namespace and shared native parser consumers (311 test files). This scoped selection is nearly a full suite for a finite implementation Lane. Expose narrower endpoint dependencies while retaining broad combined landing validation.

- Modal cost-model edits to `scripts/modal-check/cost.py` and analysis-worker edits to `netlify/functions/analyze-background.mts` select the full test suite as unclassified paths. Finite agents forbidden from running full verification cannot run the returned selection; the selector needs explicit mappings to the Modal bridge, cost-model and analysis-worker artifact tests.

- `agent tests` compares a saved Lane against the latest main. Concurrent accepted additions can appear as deletions in an unsynced Lane and force a full-suite fallback for unrelated work. Expose a pinned comparison for task-scoped validation without requiring a sync; the existing comparison remains useful for landing validation.

## Related documents

- [Backlog](backlog.md): open items and friction, grouped.
- [R2 storage plan](r2-storage-plan.md): why and how bulk bytes leave the database.
- [Status](status.md): what works today.
- [Design constraints](decisions.md), [architecture](architecture.md), [operations](operations.md).
- [Landing batches](operations/landing-batches.md), [Modal checks](operations/modal-checks.md), [GitHub Actions checks](operations/github-actions-checks.md), [runner fallback](operations/runner-fallback.md), [hosted durability](operations/hosted-durability.md).
