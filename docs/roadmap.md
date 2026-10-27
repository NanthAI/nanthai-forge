# Roadmap

What we are doing, in what order, and why. Six phases. Phases 1–4 are done. Phase 5 is next. Phase 5 is private alpha; Phase 6 is public beta. Open work items live in the [backlog](backlog.md); what works today is in [status](status.md). Keep this page current: update the status lines when a stage changes.

Last updated: 2026-10-25.

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

## Phase 4: we're happy using it (done)

Goal: the Forge team uses Forge end to end on its own project and is happy with it.

Started on 2026-10-21. Work in order:

1. **R3 metadata-only publication and return — done**, except the big-backlog measurement. Routine push fell from 95 minutes to about 3 minutes; push #21 took 186 seconds. See the [R2 storage plan](r2-storage-plan.md#r3-owner-derived-publication-and-source-return-done).
2. **Carried-over fixes — done**: P03, P04, P12, P15 and P27; hosted-unsynced state; incremental deploy export; the Modal estimate.
3. **Hosted Lanes — built** (H01–H18b, H22a and H22b): start, save, compose, land, revert and abandon from the site with all Macs offline, through a server-side landing queue with compare-and-swap main. Checks run on the project's own GitHub Actions or Blacksmith runners. The H22b live smoke with a registered GitHub App moves into Phase 5 Bet 1, where the hosted path becomes the only accept path.
4. **The lead's routine in the product — done**: `nforge land` batch landing with `--wait` progress, the landing train (S01–S17), automatic exchange, the release command and GitHub sync.
5. **Off-machine recovery — done**: inventory, restore and reconnect, and weekly backups. The recovery drill passed on 2026-10-24 (recover in 9 seconds; see the [recovery drill](operations/recovery-drill.md)).
6. **Predictive overlap warnings — done**: overlap alerts on save, and overlap-aware landing order.
7. **CI speed — added 2026-10-23**: native TypeScript (typecheck 76 s → 34 s), timing-balanced shards, smarter test selection, fake timers in the slowest tests, reuse of a passed check, oxlint and oxfmt, and a landing that never stalls on one lost run.
8. **Closure fixes — added 2026-10-24**: automatic Lane snapshots after file changes, read-only commands that never write, no-op landings that finish themselves without empty GitHub commits.

Moved to Phase 5: the agent-coordination benchmark (forge-bench R3), which now runs after overlap at first write exists (Bet 3), and the big-backlog push measurement.

Closed on 2026-10-25. Experiments E1 and E3 are published in [why-forge](why-forge.md#when-one-change-in-the-burst-fails): overlap alerts now reach every overlapping pair at save time, but not always before the next save; with one failing change, a tuned GitHub merge queue landed about 5.2× faster. Both feed Phase 5. Closing also fixed two idle Convex cost leaks: a sync drainer that retried a failing publish, and a project-delete purge that rescheduled itself forever.

## Phase 5: one authority, three bets, then private alpha (planned)

Goal: Forge runs itself for the Forge team, with numbers to show it, before outside users arrive. The full plan with slices, acceptance criteria, metrics and the stage-by-stage critical path is in the [Phase 5 plan](phase5-plan.md). Reads that never write and automatic Lane snapshots are Phase 4 prerequisites.

1. **Stage 5.1: self-metrics and decision records.** Forge records eight numbers about itself, including operator interventions per landing, and owner decisions become records shown in Now, briefs and the making-of.
2. **Bet 1: one authority, now, then delete (critical path, starts day one).** Prerequisites first: the authority switch with writer fencing, finish through the hosted landing queue, a one-time hosted seed, browser accept on the hosted path, a pull-based Mac runner and recovery that folds hosted-only work. Then cutover: hosted main is the only accept path, the Mac is a runner and a cache, and about 13,000–16,000 lines of dual-master code are deleted.
3. **Storage spike, both ways.** A native store on R2 against Git-native objects, on the same criteria; the winner is decided after. Either way, Lanes become APFS reflink clones with snapshots.
4. **Landing without an operator.** Land is a desired state driven by a server controller; no-op entries finish themselves; a stall alarm; check reuse keyed on content, so restarts, sleep and Wi-Fi loss re-run nothing and strand nothing.
5. **Bet 2: per-Intent contract checks**, with the full suite continuous on `main`, flake-aware culprit finding, and trust earned per path per actor (owner approves defaults first).
6. **Experiments E1–E3**, published next to the 2.36× landing figure whichever way they go.
7. **Bet 3: coordination that bites.** Overlap at first write through a pre-edit hook for Claude Code and Codex, semantic conflicts from contract tests, and deterministic merge of edits to different declarations. The R3 coordination benchmark runs only after the hook lands.
8. **After cutover: vocabulary consolidation.** Candidates first-class, Lanes as workspaces, about 37 actions down to start, save and land plus reads, and a CLI generated from the MCP surface.

**Frozen until E1 and E3 have numbers and Bet 1 is cut over:** browser editing (H19a), two-way GitHub sync (H23 and H24), H19b, H20 and H21, hosted landing gaps not needed by Bet 1, CI adapters, the landing timeline UI and CI insights.

**After the bets:** a trial with outside users, a polished first project through GitHub import, and newcomer docs.

## Phase 6: public beta (planned)

Goal: open Forge to public use with a free core and sustainable hosting.

- **Public Worker and custom domain**: serve public project bytes through the edge cache.
- **Open-source mode**: configurable proposal limits, anonymous visibility and an optional CLA.
- **Monetisation with a free core**: use the Phase 5 usage counters to inform decisions. Any limit or price needs an owner decision.
- **Cross-repo coordination** with shared usage pools.
- **Git serving** from hosted Forge, with Lane refs.
- **Product depth**: making-of, timeline and flow views, discussions, Markdown and images, a dependency graph, an extension model and Lane-scoped undo.
- **Landing safety beyond text conflicts.** A clean text merge can still break: today's real cases are a database test that failed after another change moved columns, two release changes that merged cleanly and then looped, and two readers that needed a hand merge. The landing queue already checks the exact composed result on current `main` and re-checks when `main` moves; these make the failures earlier, rarer and cheaper. Phase 5 Bets 2 and 3 cover contract checks, flake-aware culprit finding and overlap at first write; this list is the rest.
  - **Order-sensitive paths**: migrations, schema, lockfiles, generated files and configuration form classes. When an entry ahead touches the same class, the queue-ahead preview is actionable even without a text overlap.
  - **Migration collisions**: two Lanes adding the same migration number, or a migration that uses a column another entry removes, are reported at compose time with the fix.
  - **Symbol drift**: an entry ahead that renames or removes a declaration your Lane newly uses is reported from the existing declaration index, before the check.
  - **Opt-in early check**: on request, run the affected tests on your Lane plus the entries ahead before submitting, within a stated budget. Off by default.
  - **Flake quarantine**: done early, in Phase 5 (2026-10-27), on every check provider.
  - **Selection blind spots**: tests that depend on data or configuration rather than imports get explicit mappings; while work is active, `main` runs a periodic combined full check, never while idle. Every miss is recorded as friction.
  - **Release ordering**: a release refuses mixed installs and checks old-client/new-backend compatibility in both directions before switching.
  - **Stacked Lanes**: when the Lane underneath changes, is abandoned or fails to land, dependents restack or get one clear notice.
  - **Breakage after landing**: a failing `main` audit finds the culprit, reverts it while keeping its Lane, and tells queued entries.
  - **Long-lived drift**: a Lane far behind `main` on paths others keep changing gets a nudge naming those landings.
  - **Queue order**: priority and reordering, with fairness between agents.
- **Landing page redesign (tentative)**: the 2026-10-27 landing-page-skill trial produced a mockup with on-page proof, how it works, a FAQ, a final call to action and corrected title, description and repository links. Accept it as a tentative direction only. Before public beta, assess critically whether it is better overall than today's page, and make the page striking, not only complete. Keep `DESIGN.md` as the visual authority and never invent testimonials or logos.
- **Later R2 slices**: browser bytes, imports, zones, agents and proposals, backfill, purge and backups. See the [R2 storage plan](r2-storage-plan.md). Retention or deletion changes still need an owner decision.

## Workflow friction

- Lifecycle mutations can commit their Lane head long before the CLI returns its advisory peer receipt. During writer contention, check the canonical saved head before replaying the same operation; expose durable mutation completion before expensive advisory hydration so builders can distinguish a committed save from a queued one.

- A concurrent `start` reserved an active Lane before returning its receipt, then
  spent several minutes waiting and preparing advisory output. Recovery required
  reading the retained start operation from `records`. Emit the durable Lane ID
  and path before optional peer analysis so a builder can safely use its own Lane
  without retrying or guessing among other builders' new directories.

- Agent `start` can activate a Lane but hang before returning its receipt. Recovering the exact Lane requires manual discovery; return the durable activation receipt promptly.

- Overlap incident replays can interrupt a check with only `CHECK_RECOVERY_FAILED`, hiding the controller startup error. Diagnosing it currently requires instrumenting a generated build.

- Repeating sync on a Lane with a pending merge returns `MERGE_PENDING` without listing its conflicting paths. Include the pending sync target and conflicting paths in that diagnostic so a merge agent can resume from the receipt.

- Core finish/publication edits select 217 of 349 test files, including hosted and UI suites. Finite implementation agents need a phase-focused validation selection alongside the conservative landing selection; the broad local run competes with concurrent Lanes for check capacity and disk writes.

- A launchd `.plist` template selects the full test suite as an unclassified path. Finite agents forbidden from full verification must use affected backup/signer tests instead; the selector needs explicit template ownership.

- The weekly backup launchd template selects the full test suite as an unclassified `.plist` path, including when R7 consumes that prerequisite. Add a scoped mapping for backup orchestration/adapter tests so finite agents can run the returned selection without a forbidden full-suite run.

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
