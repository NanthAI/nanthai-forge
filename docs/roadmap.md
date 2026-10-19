# Roadmap

What we are doing, in what order, and why. Four phases. Phases 1 and 2 are done, Phase 3 is closing, Phase 4 is a candidate list. Open work items live in the [backlog](backlog.md); what works today is in [status](status.md). Keep this page current: update the status lines when a stage changes.

Last updated: 2026-10-19.

## Direction

Forge's claim is that many agents can work on one codebase at once, aware of each other, with a human who can see and steer. Until that is proven against plain Git we prioritise: (1) never losing work, (2) landing speed, (3) live coordination, (4) a usable cockpit, (5) near-zero running cost, and we freeze new breadth. Forge builds itself: every change on this page lands through Forge's own workflow.

Product direction: an open source replacement for the GitHub workflow, cheap enough to host for many small projects, with a free core. Hosted Forge becomes the canonical home of a project; the owner's own machine stays a supported offline mode and Git stays an interchange format.

## Phase 1: foundations (done)

Goal: a trustworthy base and a way to measure.

Delivered:

- Prettier on all TypeScript; `format:check` is part of `verify`.
- One standard in-repo check (`scripts/forge-check.mjs`, Forge check `verify`).
- Accepted work is never lost: acceptance refuses stale Views; `finish` syncs `main`; a `sync` action; optional pins.
- Docs and process reset ([AGENTS.md](../AGENTS.md), about a dozen docs instead of about ninety).
- A first cost model (summarised in [status](status.md)): reads and file egress dominate at scale; identity is free; storage at rest is minor.
- A multi-agent benchmark harness and a Git-worktree baseline, kept outside this repository. Four scenarios (related tasks, mid-task contract change, disconnect and recovery, human redirect) by three agent mixes by two repetitions.

Baseline result: plain Git with worktrees passed 24 of 24 pairs, median about 110 s per pair, with 3 conflicts and 2 rejected pushes all recovered by the agents. Those scenarios are too easy to show a coordination benefit, so Forge can at best tie on success and must win on time or tokens. Harder scenarios (3 to 5 agents, longer tasks, overlapping edits that text merge accepts but that break behaviour, a contract change only coordination reveals, a larger codebase) were added for the Forge arm.

## Phase 2: make multi-agent work real (done)

Goal: the product behaves correctly with several agents at once, and a human can see it.

Delivered:

- Cockpit and UI rebuild: one screen answering who is working, what is changing, what is related and what needs a decision.
- Incremental Work metadata: source bytes, missing-object negotiation and binding validation reuse earlier checkpoints, and hosted source returns stage per-View changed-path provenance.
- Native bound exchange pushes, the hosted index, presence, Lanes, Views, Checks and the acceptance ledger.
- The Forge arm of the benchmark harness.

Closed on 2026-10-16.

## Phase 3: speed, trust and hosted groundwork (closing)

Goal: make landing fast, make checks trustworthy and cheap, decide scope with data, and lay the groundwork for hosted-first projects. Run as seven stages. Status as of 2026-10-19.

### Stage 0: throughput

Why: with about ten agents on one Mac, CPU-bound checks were the bottleneck (about one landing per hour).

Done:

- Scope-aware checks and a trimmed suite. A docs-only change lands in about 18 s end to end (target 60 s, met).
- Disjoint-change fast path as a finish policy with fix-forward on failure.
- Lock contention with typed, retried errors; automatic cleanup of regenerable copies.
- Incremental hosted push, a hosted staleness strip, owner-derived rows, and a Work-delta push format.
- Smart re-check when only overlapping files changed.
- Landing batches, flaky-test quarantine, resilience, queue controls, a Modal runner and a manual fallback runner. Burst landing throughput on remote runners: a batch window and stacked concurrent batches.
- Concurrent checkpoints (ten at once went from 29 s to 9.6 s).
- One measured cohort at about 7.5 landings per hour (single sample).

Open:

- Full `verify` still takes 11 to 12 minutes (target under 6).
- A single checkpoint takes 2.9 to 4.6 s (target 1 s).
- No post-delta live number for a one-landing hosted push (target 10 s; last measured 178 s before the delta format).
- The owner root as a current working copy of `main` landed but is off by default.
- Measured throughput numbers belong in [status](status.md); Stage 0 is not formally closed.

### Stage 1: instrument

Done: client error capture (bounded rate, 30 day retention); a per-Intent making-of record (local owners only); measured cost drivers; a performance harness and cheap web wins (eager JavaScript from 1.20 to 1.07 MB, font payload from 165 to 33 KB).

Open: making-of data has no hosted query or browser view; the harness's live timings have not been run against a deployed site, so the page-load budgets (Now and Work in 1.5 s, first Lane diff in 1 s, one-file push in 3 s) are unverified; a measured dollar table for [status](status.md).

### Stage 2: trust

Done: clean-environment checks (hygiene, not isolation); the authorization review and its fixes; the audit triage; a GitHub Actions runner (including third-party runners) with live smoke checks passing.

Open:

- Runner choice per project. All four must exist at launch and the hosted site never pays for other people's checks: (1) own machine, exists; (2) GitHub Actions through the GitHub App, mostly landed; (3) Modal with the project's own key, open (today's Modal backend is tied to the owner's account); (4) a self-hosted worker (`nforge worker`), open. Defaults: a CLI-created project uses the own machine; a browser project with GitHub uses Actions; otherwise "no runner yet, pick one". Contributor code runs only on the project's remote runner after a first-time maintainer click.
- A scheduled backup job with an off-site copy and a monthly restore drill (verifier and procedure exist; the drill is approved but unrun). See also [hosted durability](operations/hosted-durability.md).
- Public imports as personal mirrors with a verified claim (decided, not built).

### Stage 3: decide with data

Done: a decision to use Git as an interchange format (not the daily format); the duplicate local UI path removed; a proxy trial of an outside developer's first hour, which fixed first-run docs.

Open: the Forge arm of the benchmark against GitHub. Single landings measured four times out of four: Forge about 1.9 to 2.0 times faster. Burst landings, other runner configurations and the many-agent coordination series are not yet clean runs (void runs are archived with reasons). Real outside developers have not tried it. Hosted Git serving and Lane refs are Phase 4.

### Stage 4: vocabulary

Done: Issue and Intent merged into one concept (Proposed, Planned, In motion, Done; optional kind; Initiatives kept as grouping; hosted migration run on the development deployment).

Open: View becomes Candidate everywhere (UI, CLI with aliases and a deprecation notice, MCP, docs, tests), as one cohort off one mapping file. The name Channel stays and gets a glossary entry.

### Stage 5: hosted canonical

Order: hosted main and checkout, browser "New project", lossless GitHub import, hosted Lanes with save and compose from the site, a remote check worker with live output, accept, revert and abandon on hosted, qualification with every Mac offline, hosted GitHub sync.

Done: the hosted main contract with a wants-only checkout; browser project bootstrap; resumable lossless GitHub import (400 MiB fixtures). Bulk-byte storage is planned in [R2 storage plan](r2-storage-plan.md); the seam slice (R0) is in review.

Open and moved to Phase 4: hosted Lane, save and compose; hosted accept, revert and abandon; the server-side landing queue with compare-and-swap main; qualification with all Macs offline; full hosted GitHub sync; the remaining remote-check pieces.

### Stage 6: product

Done: UI coherence slices 1, 2 and 7a (shared icons and rows, Who's working fixes); `nforge docs`, a quickstart and a glossary; the `gh` command shim.

Open: UI coherence slices 3a, 3b (one detail layout, merged timeline), 4 (Planning list), 5 (planned Intent page), 6 (Initiative page), 7b (Code as a file tree); the vocabulary words check; `llms.txt` agent docs; performance follow-ups, which need live timings first.

### Cost and idle behaviour (cross-cutting)

Lessons from the first month of hosted use are in the [R2 storage plan](r2-storage-plan.md#why). Fixes landed: an idle browser tab stops subscribing after 30 s hidden or 5 minutes without input; the session token lives 10 minutes; key-set lookups are cached; hosted source return re-reads far less storage. The effect of the source-return fix is unmeasured until one measured push is made.

### Definition of done for Phase 3

1. Throughput: a documented cohort of ten concurrent agents lands at least 6 changes per hour; docs-only under 60 s, scoped code under 5 minutes; numbers in [status](status.md); Stage 0 formally closed.
2. Measured performance: the harness run against the deployed site; Now and Work, first Lane diff and one-file push recorded against budgets; misses listed.
3. Cost and safety: one measured hosted push shows the egress fix works; monthly running cost under the owner's limit; weekly backup running with one passed restore drill; an idle tab verified to cost nothing.
4. Runners: own machine, GitHub Actions and Modal (project's own key) selectable per project with cost per check recorded; the self-hosted worker and the contributor first-click rule specified and handed to Phase 4.
5. Vocabulary and UI: Issue to Intent complete; View to Candidate landed everywhere with CLI aliases; coherence slices 3a to 7b landed with reviewed screenshots.
6. Benchmarks published: single-landing and burst numbers on the same compute, and the first coordination pilot result, with void runs listed; the bar from the fair-test plan stated as met or not. The longer coordination series may continue into Phase 4.
7. Hosted groundwork: hosted main, bootstrap and lossless import landed and qualified; remaining Stage 5 slices written up with sizes as the Phase 4 queue.
8. Public readiness: a fresh public repository from one clean commit, the old one archived privately, automatic mirroring enabled, current docs and agent docs.
9. Housekeeping: docs batches merged; every friction item fixed, filed in the [backlog](backlog.md) or dropped; scratch folders, old Lanes and benchmark resources cleaned with owner approval; closing report written.

## Phase 4: hosted-first and sustainable (candidates)

Goal: a project can live entirely on hosted Forge at near-zero cost, and the product can pay for itself without taxing the free core. Order is not fixed; candidates, roughly in this order:

1. **Hosted Lanes** (moved from Phase 3): create, save and compose Candidates from the site; accept, revert and abandon on hosted; the server-side landing queue with compare-and-swap main (cut over after one green week); qualification with all Macs offline; full two-way hosted GitHub sync.
2. **R2 storage, later slices**: metadata-only publication, browser bytes, imports, zones and agents, backfill, purge and backups. See [R2 storage plan](r2-storage-plan.md).
3. **Runners**: the self-hosted worker, a runner picker, live logs from remote runners into hosted Checks.
4. **Public Worker and custom domain**: serve public project bytes with edge caching on a project subdomain, so anonymous reads do not call the database.
5. **Monetisation, free core**: hosted projects, presence, pushes, code view and public and private projects within fair use stay free. Candidates for paid extras: hosted runners and check minutes, storage above fair use, org features (teams, SSO, audit export, retention policies), a priority landing queue, a public-project CDN, support. Needs per-project usage counters first so fair use can be measured. Any new limit, retention rule or price needs an explicit owner decision.
6. **Cross-repo coordination**: agents coordinated across several repositories, with shared usage pools.
7. **Product depth**: making-of record in the browser, timeline and flow views, Intent discussions with per-item public or private visibility, Markdown and images on Intents, a real dependency graph in Code, open-source mode (configurable proposal limits, anonymous visibility, optional CLA), an extension model of events, actions and policies, Lane-scoped undo.
8. **Git serving**: serve Git from hosted Forge and expose Lane refs.

## Related documents

- [Backlog](backlog.md): open items and friction, grouped.
- [R2 storage plan](r2-storage-plan.md): why and how bulk bytes leave the database.
- [Status](status.md): what works today.
- [Design constraints](decisions.md), [architecture](architecture.md), [operations](operations.md).
- [Landing batches](operations/landing-batches.md), [Modal checks](operations/modal-checks.md), [GitHub Actions checks](operations/github-actions-checks.md), [runner fallback](operations/runner-fallback.md), [hosted durability](operations/hosted-durability.md).
