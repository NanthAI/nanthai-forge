# Phase 5 plan

Phase 5 is three bets, measured by Forge itself. Bet 1 is the critical path and starts on day one. Outside users come after the bets, not before. The [roadmap](roadmap.md) links here; what works today is in [status](status.md).

## Goal

Forge should run itself. Today about 30 landings a day reach main, but only with a full-time lead doing retries, fixers, kills and hand-sequenced batches. Every core-claim incident so far was found by the lead or the owner, not by a Forge check or metric. Most of them trace back to two masters (the Mac owner and hosted) kept in step by code. Phase 5 removes that cause first and proves the result with numbers Forge records about itself.

## The three bets

**Bet 1: one authority, now, then delete.** Owner: "one authority is key." Hosted main, updated by compare-and-swap, becomes the only accept path. The Mac becomes a runner and a cache. Then we delete the dual-master code: exchange push, source return, the owner relay, old Work format readers, the staleness strip and the reconcile paths. Bet 1 should have come sooner; its prerequisites go first and everything else fits around it.

**Bet 2: per-Intent contract gates; full suite continuous.** An Intent declares the tests that prove it. For trusted and autonomous actors, acceptance needs only that contract to pass on the exact Candidate. The full suite runs continuously on main after acceptance, with flake-aware culprit finding and automatic fix-forward or revert. Batches, shards and scoped checks become optimisations, not the gate.

**Bet 3: coordination that bites, then measure.** An overlap event fires at the first write, inside the agent's loop, and must be acknowledged or routed around. Two Intents whose text merges cleanly but whose contracts fail together are a first-class conflict. Edits to different declarations merge deterministically. Then we measure coordination for the first time with a valid method.

Two supporting tracks run alongside: **landing without an operator** (Q) and, after cutover, **vocabulary consolidation** (V).

## Done in Phase 4 (prerequisites, not Phase 5 slices)

These landed in Phase 4 (closed 2026-10-25). Phase 5 assumes them.

- **Reads never write.** `nforge agent peers` previews and every other read return without writing owner or hosted state.
- **Automatic Lane snapshots.** Lanes are snapshotted automatically, so a lost process or machine never loses unsaved work beyond the last snapshot.
- **No-op landings finish themselves.** A landing whose head equals main finishes without a queue entry or an empty GitHub commit.
- **Minimal child environments.** Background and detached children start from an explicit allow-list of environment variable names; credentials pass only to the child that uses them (review risk #14).

## Owner decisions (decided)

1. **Briefly red main is accepted** for trusted and autonomous actors, with automatic fix-forward or revert. Supervised projects keep the strict full gate.
2. **SP1 chose neither pure arm** (2026-10-25): "Git objects for source bytes, Forge identities for everything, a Forge packed store for everything else". A State stays a Forge SHA-256 record pointing at a Git tree, with a deterministic commit derived for export; existing native States stay readable through an alias table. Source lives in a local bare Git repository and immutable packs plus a catalog on R2. Work, evidence, edit streams, decisions and analysis live in Forge's own packed, collectable store. This replaces design constraint 7 ("Native is the daily format") in [decisions](decisions.md). B1.4a remains independent; P5-RC starts now and P5-SG follows B1.5b.
3. **Structural merge** is either mergiraf or our own merge on the existing source graph (declarations from the TypeScript and Lezer parsers). SP2 compares them. Output is always gated by the contract check, never by parse success.
4. **Web breadth is frozen** until E1 and E3 are published and Bet 1 is cut over. Hosted landing gaps G1–G10 are frozen with it, except those Bet 1 needs (G1, G2, G3, G6). See [Freeze](#freeze).
5. **Bet 1 is imperative** and starts at Phase 5 start. Its prerequisites are the first slices built.
6. **Trust per path per actor** (B2.6) is a new access rule. The owner approves its defaults before it is enabled.
7. **Vocabulary consolidation** is a real slice set, built after the Bet 1 cutover. No functionality is lost.
8. **Bet 3 build waits only for E1 and E3** (confirmed 2026-10-24). E2 runs during Bet 1 and must be published before B3.5.
9. **Every point of the 2026-10-24 review is tracked** in [Review coverage](#review-coverage); none is dropped silently.
10. **Disk stays bounded per project** (2026-10-24). Automatic Lane snapshots of completed or abandoned Lanes are collected after the 7-day retention window; the latest snapshot of every open Lane is always kept. Forge watches free space and per-project growth (see P5-M2) and warns before either crosses its budget.

## How we work

- GPT/Codex builders take bulk slices; Claude takes design judgement and UI direction only.
- One task per agent, with a handoff for any follow-up.
- Agents run targeted tests. The landing check is the one full run.
- Keep Claude use steady per five-hour window.
- Never print environment values.
- Sizes: **S** ≤ 1 agent-day, **M** 1–3, **L** 3–5. Every L is split below before building.

## Order and critical path

The critical path is Bet 1: **B1.2a → B1.2b–d → B1.2e → B1.5a → B1.5b → B1.6**, with B1.4b joining before B1.5a. SP1 is decided; B1.4b uses a two-method object interface and does not wait for P5-SG. Everything else fills spare builder capacity. Stages run in order; each is as long as its work takes, with three to four parallel builders. Stage 5.1 was planned as a week and took about a day.

| Stage | Critical path (Bet 1) | Alongside |
| --- | --- | --- |
| 5.1 | B1.1 published; B1.2a authority switch and fencing; B1.2c hosted seed | M1 metrics; D1 decision records; SP1 decision recorded; P5-RC records packing and collection starts; **E1 and E3 published — done** ([results](why-forge.md)) |
| 5.2 | B1.2b finish to hosted queue; B1.2d browser accept (Claude design, GPT build); B1.3a runner lease | M2, M3; X1 schema compatibility check; P5-RC continues; B1.4a clonefile Lanes; Q3 reuse key; E2 starts on six independent slices |
| 5.3 | B1.2e Mac stops accepting; B1.3b runner evidence; B1.4b cache reads hosted; B1.5a recover folds hosted work | Q1 landing controller; B2.1 contract; B3.1 first-write hook |
| 5.4 | B1.5b cutover, forced upgrade and drill | Q2 self-finishing entries and stall alarm; Q4 lifecycle drill; B3.1 ack metric; E2 published |
| 5.5 | B1.6a–c, B1.7, B1.8 deletions; P5-SG Git source layer and projection deletions | B2.2 policy gate; SP2 merge spike; V1 vocabulary design |
| 5.6 | B1.9 table purge (owner approves) | B2.3 audit; B2.4a–b culprit finding; B3.2 semantic conflict; B3.4 declaration merge; V2a |
| 5.7 | | B2.5, B2.6 (owner approves defaults); B3.3; V2b, V3; B3.5 re-measure including R3 |
| 5.8 | | X2 end-of-phase items; exit criteria; outside-user trial preparation |

## Self-metrics (first)

Every slice reports against these metrics at landing: the values before and after, and the one it was meant to move. A slice that regresses a "must not regress" metric does not close until the regression is fixed or the owner accepts it.

**Baseline period:** 2026-10-14 to Phase 4 close. Backfilled from owner records and published as a table in this file when M3 lands. Where a metric needs a record that did not exist in that period, the baseline is marked **partial** and the gap is named; it is never estimated from free text.

**Common terms.** A *landing* is an accepting `channelMoves` entry on `main` (reverts and compensating Candidates are counted separately). A *submission* is one `landingEntries` input (Lane, head, attempt). A *finish* is one `finish` or `land` request, counted once per `operationId`. Days are UTC. After cutover the same terms read from the hosted landing queue and hosted channel moves.

| # | Metric | Definition |
| --- | --- | --- |
| 5.1 | Landings per day, by path | Landings per day, each classed by its Intent's submission history. **First-try:** the landed head is the head of the Intent's first submission and no earlier run for it failed or was interrupted. **After-retry:** an earlier submission of the same head ended failed, interrupted or superseded and the same head was resubmitted. **After-fixer:** the landed head was saved after an earlier submission for the Intent ended failed, by any actor. |
| 5.2 | Agent-visible lifecycle errors per 100 finishes | Structured error codes returned to the caller by `start`, `checkpoint`, `sync`, `finish` or `land`, by code, per 100 finishes. One count per `operationId` and code; internal retries that end in success are not counted. Target: `WORK_STALE` 0; `WORK_BUSY` retried internally. |
| 5.3 | Dropped landings | Submissions that entered a batch or queue, did not reach main, and have no terminal outcome delivered to the requester: no `landed` or `terminal-failed` state, and no progress event (run, batch step or acceptance) for 60 minutes. Target: 0. |
| 5.4 | Overlap alerts delivered ÷ overlapping saves; acknowledgement rate | An *overlapping save* is a save (checkpoint, and first write once B3.1 lands) in Lane B touching a path that another active, unlanded Lane A has changed against its base. An alert is *delivered* when an overlap event is recorded as returned to B's actor (lifecycle receipt, MCP response, hook output) before B's next save. Also report median time from save to delivery, and, from B3.1, acknowledged or routed-around ÷ delivered. |
| 5.5 | Operator interventions per landing | Owner-mutating commands that are not `start`, `checkpoint`, `finish` or `land` (for example `cancel`, `accept`, `revert`, `abandon`, `take`, `set-policy`, a retry, a manual owner-service restart, a manual queue nudge), by actor, ÷ landings. Requires a requester on every mutation, including cancellations. **Target: near zero** (Q track). |
| 5.6 | Check minutes per landing; reuse rate | Runner minutes (sum of shard durations, the billing basis) and wall minutes for all runs in the period, whatever their outcome, ÷ landings. Continuous-audit minutes count. Reuse rate: check requests satisfied by an existing passed run with the same reuse key ÷ (those requests + full checks started). The **reuse key** is tree + check definition + lockfile + Node major.minor + declared inputs. Install paths and runtime fingerprints that change on restart are not part of it. |
| 5.7 | Authority lag | **Before cutover:** for each owner revision, owner revision − hosted revision and seconds until hosted reaches it, p50 and p95 per day, plus contradiction minutes (time any hosted page showed a Lane, Intent or Candidate state that owner records contradict). **After cutover:** Mac cache lag behind hosted (p50, p95) and contradiction minutes on any surface, CLI, MCP or web. |
| 5.8 | Dollars per landing | Runner (Blacksmith, Actions; saved legacy costs) + hosted (Convex, Netlify) + storage (R2) ÷ landings, per month, at billed price and at list price. Bills are entered as records. Estimator error: (estimate − bill) ÷ bill. |
| R | Red-main minutes per day | Minutes per day during which the current main head has a failed full-suite result on its exact State, or is a descendant of a landed Intent later named as a culprit, until a main head passes the full suite. Before B2.3 the source is full runs on main heads plus public GitHub Verify on the mirror; report both. |

Bet metrics also need one tag: **no-owner incidents**, errors in metrics 2 and 3 whose cause is a run, worker or batch with no live owner of record.

### Reading self-metrics

`nforge metrics ROOT --from DATE --to DATE --json` reports metrics 5.1–5.8,
red-main minutes and disk observations, per UTC day and for the whole window.
Windows are half-open: `[from,to)`. The default is the last seven days ending
now. Each metric includes its source-record count, `partial` flag and named
coverage gaps; an unknown value is `null`. Context records before the window
remain available for classification and red-main intervals. Dollar figures
retain the recorded monthly billing allocation; daily rows are not new invoices.
JSON is the default for agents and redirected output; a terminal gets a short
text table (`--text` also selects it explicitly).

`nforge agent ROOT metrics '{"from":"2026-10-14","to":"2026-10-25"}'`
and MCP `forge_work_overview` action `metrics` expose the same JSON. Owner status
includes a compact last-seven-day summary. With source authority mode `server`,
metrics read the hosted project through owner/maintainer-only, indexed pages of
at most 100 rows. Status reads at most four hosted pages and labels omitted
records. Native-owner and server-shadow bindings keep native metric reads.
Spanning windows join native evidence before the recorded cutover timestamp and
hosted evidence at/after it, naming that authority seam. Hosted context is bounded
to one day before the window; pages are live observations, not a cross-page
snapshot. Missing inputs, caller delivery, full-suite selection, reuse keys,
requester history and billing evidence stay named gaps. Trusted finish-to-main
p50 uses submission/acceptance timestamps under the recorded attempt policy,
never free text. An older deployment without `projectSelfMetrics` returns
`METRICS_UNAVAILABLE` with coverage gaps. Deploy Convex before the client.

For native authority, status reuses its selected Work rows,
reads at most 256 KiB of receipt history, and never reads source trees or scans
disk. If that receipt tail omits older records, its summary names the gap; the
full metrics command reads the retained records. Status reuse keys are omitted
because they are not a headline metric.

`nforge metrics ROOT --from AFTER --to END --compare BEFORE..AFTER --report FILE.md`
writes all metrics with before/after values, record counts and coverage gaps.
Without `--compare`, the report has one value column. Report export writes only
the named output file; metric reads never wake an owner service or write receipts.

For native authority, on the first existing committed Work write in a UTC week, Forge queues a detached
worker to write the previous completed ISO week's report to
`.forge/work/metrics/weekly-YYYY-Www.json`. Existing snapshots are retained on
retry. The write does not wait for record collection or hold its writer lock for
that work. An exclusive `.weekly-YYYY-Www.json.pending` marker admits one worker;
a failed attempt records its timestamp in `.weekly-YYYY-Www.json.failed`. The
next write after one hour can retry. There are no timers or idle reads. The file excludes the live revision
and later observations so its JSON is reproducible from that week's records.
Remove that generated file to undo the automatic snapshot; a subsequent write
can regenerate it. Completed snapshots describe retained evidence at collection
time; newly supplied historical evidence can change a later recomputation.

Server-authority weekly snapshots on local reads are not yet written: a complete
previous-week collection can exceed the four-page status budget. A truncated
current-window status sample must not be saved as a completed-week report. There
is no hosted schedule, timer, background collector or idle Convex usage.

### Published baseline

The baseline uses UTC `[2026-10-14,2026-10-25)` (through October 24), computed
read-only from the dogfood owner's Forge records at Work revision 25741. No
logs, prompts, friction prose or external bills were inferred. All nine rows
are partial because their historical evidence has the named gaps below.

| Metric | Value | Source records | Coverage |
| --- | --- | --- | --- |
| 5.1 Landings by path | 345 (118 first-try, 16 retry, 42 fixer, 169 unknown); reverts unknown, compensating unknown | 345 | partial: Submission history or saved-head/failure ordering is unavailable for unclassified landings. Records do not uniformly distinguish ordinary, revert and compensating main moves; the denominator includes unclassified accepting main moves. |
| 5.2 Lifecycle errors per 100 finishes | unknown / unknown finishes; rates unknown | 0 | partial: Caller-visible lifecycle receipts and operation IDs were not recorded for the whole period. Argument-validation and incompatible-store refusals have no local lifecycle receipt. |
| 5.3 Dropped landings | 149 | 455 | partial: Terminal-outcome delivery and timestamped batch progress were not recorded for the whole period; dropped rows are candidates where delivery is unknown. |
| 5.4 Overlap delivery and acknowledgement | unknown/unknown delivered; acknowledgement unknown; median unknown s | 0 | partial: Overlapping-save collection is partial; historical saves and first-write events were not uniformly recorded. Acknowledgement and routed-around records do not cover the whole period. |
| 5.5 Interventions per landing | unknown (unknown interventions) | 0 | partial: Requester-attributed owner mutations (including cancel, retry, service restart and queue nudge) were not recorded for the whole period. Manual owner-service restarts outside Forge have no requester record. |
| 5.6 Check minutes per landing and reuse | 10.173 runner, 43.98 wall; reuse unknown; total 3509.583 runner / 15173.145 wall min | 1080 | partial: Check request/adoption receipts were not recorded for the whole period; reuse rate is unknown. 896 runs lack shard execution durations (local billed-zero cost is not execution time). |
| 5.7 Authority lag and contradictions | owner-hosted 0 revisions; p50/p95 unknown/unknown s, unknown/unknown revisions; hosted-cache 0 revisions; p50/p95 unknown/unknown s, unknown/unknown revisions; contradictions unknown min | 0 | partial: Revision observations are incomplete or pending; missing catch-up time is unknown, never zero. Revision streams are comparable only within an authority epoch. Cache authority timestamps observed on writes measure a lower bound from observation, not the unobserved hosted commit time. Surface observations do not cover all CLI, MCP and hosted pages for the period. Contradiction minutes are a measured lower bound. |
| 5.8 Dollars per landing | 2026-10: $unknown billed / $unknown list; estimator error unknown | 0 | partial: Only entered project bills are included. Missing provider/month bills, list prices and estimates stay partial. Run-linked bills join exact saved inputs; unjoined runs and shared services are allocated evenly over the month's ordinary landings. |
| R Red-main minutes | forge: 805.193; github-verify: unknown | 857 | partial: Forge full-suite results and public GitHub Verify are reported separately. Missing exact-State or mirror-to-State mappings remain partial; no result is inferred from a Candidate status. Culprit descendants count from their accepted main records. |

### P5-M1. Metric recorder

- **Size:** M. **Depends on:** none. **Stage:** 5.1.
- **Changes:** rows for metrics 1, 2, 3, 5 and 6 from `channelMoves`, `landingEntries`, `landingBatches`, `runs`, `automations` and `frictionEvents`. Adds the two records the baseline lacks: a lifecycle receipt (action, actor, `operationId`, error code) and a requester on every mutation, including `cancel`. Backfills the baseline period. Readers work against both owner and hosted records so the metrics survive cutover.
- **Acceptance:** each metric has a fixture test with hand-computed values, including a dropped submission, a same-head retry and a fixer save. Replaying the 2026-10-23 batch that waited with no leader counts it as dropped. Replaying the 2026-10-21 eight concurrent finishes counts seven `WORK_STALE` errors. Baseline gaps are reported as partial, not zero. **Metrics:** creates 1, 2, 3, 5, 6. Must not slow `finish` p50 by more than 5%.

### P5-M2. Metric joins

- **Size:** M. **Depends on:** M1.
- **Changes:** metric 7 in both forms, metric 8 (bill records, per-landing join, estimator error), metric 4 (overlapping saves and delivery records, instrumented now even if the count is low) and red-main minutes. Also **disk per project**: local bytes by kind (objects, records, Lanes, check workspaces, snapshots, backups) and hosted/R2 bytes, growth per day and per landing, and free space on the owner volume, with a budget per project and a warning in status before free space or growth crosses it (owner decision 10).
- **Acceptance:** fixture tests per metric. Replaying the "Closed without landing" hosted page records contradiction minutes. A fixture project growing faster than its budget raises one warning, not one per write. A main head with a failed full run records red minutes until the next passing head. No new polling: sampling happens on existing writes, so an idle project costs nothing. **Metrics:** creates 4, 7, 8, R.

### P5-M3. Metric surface

- **Size:** S. **Depends on:** M2.
- **Changes:** `nforge metrics` (JSON), a status page section, a close-report export and a weekly snapshot file. Baseline table added to this file.
- **Acceptance:** all metrics computed from Forge records only; the baseline table is published; the weekly snapshot reproduces from records alone. **Metrics:** reports all.

### P5-D1. Owner decision records

- **Size:** M. **Depends on:** none. **Stage:** 5.1, next to M1. Claude design pass for the display, GPT build.
- **Changes:** a `decision` record on an Intent or project: who decided, what, why, and which earlier decision or default it overrides. Created by CLI, MCP and the site; shown in Now, in agent briefs and in the making-of. Superseded decisions stay visible with a link to the one that replaced them.
- **Acceptance:** an agent brief for an Intent lists its decisions with the overrides; a superseding decision marks the old one. This plan's owner decisions are entered as records. **Success:** the lead's STATE.md shrinks to links to decision records. **Metrics:** moves 5 (fewer "ask the lead" interventions). Must not regress 2.

## Spikes

Each spike ends in a short decision memo agreed with the owner and recorded as a D1 decision. Neither ships product code.

### SP1. Storage: native on R2 vs Git-native, head to head

- **Decision:** owner, 2026-10-25: neither pure arm. Adopt "Git objects for source bytes, Forge identities for everything, a Forge packed store for everything else". A State stays a Forge SHA-256 record pointing at a Git tree, with a deterministic commit derived for export. Existing native States stay readable through an alias table; migration of native States and Git-backed owners is explicit and reversible.
- **Layout:** a bare Git repository locally; immutable packs plus a catalog on R2. Work, evidence, edit streams, decisions and analysis live in Forge's own packed, collectable store.
- **Evidence:** both arms measured the dogfood history; the [comparison and limits](research/sp1-storage.md) distinguish measured results from estimates. MB are decimal.

| Storage measure | Result |
| --- | --- |
| Current native source store | 720 MB measured |
| Git history, excluding one-time migration carry | 24 MB measured; 75.50 MB for the full converted bare repository |
| Improved native history with manifest and blob deltas | 18 MB estimated; comparable to Git for 2–3× the code |
| Why native is big | 53% full per-State manifests; 26% blobs without deltas; 21% one-time carry |
| Work records | 418 MB measured; only ~85 MB reachable |
| Git integration | ~1,500 LOC added, ~1,567 removed; 5–10 agent-days estimated; dogfood conversion 65–85 s measured |

- **Order:** B1.4b uses `get(id)` / `put(bytes)` by object identity and does not wait for the Git layer. P5-RC runs now, in stage 5.1. P5-SG lands after B1.5b alongside B1.6–B1.8, deleting the native→Git projection code it replaces. B1.4a remains independent.

### SP2. Structural merge: mergiraf vs our own

- **Size:** M, date-boxed to three agent-days. **Depends on:** B2.1.
- **Arm M:** mergiraf. **Arm S:** our own merge on the source graph: declarations from the TypeScript and Lezer parsers, already indexed for test selection and overlap.
- **Method:** replay the real conflict corpus (the 33 sync-conflict episodes in coord-evidence and the conflict entries in the friction log). Measure the share of cheap conflicts (imports, registries, lists, docs) resolved, edits to different declarations in one file resolved, and the wrong-but-plausible rate, each judged by the Intent contract check. Also the dependency cost of Arm M and the lines Arm S needs.
- **Decision rule:** adopt the arm that resolves more of the different-declaration class with no contract-passing resolution wrong on review. Arm M must also resolve at least half of the cheap class to justify a native dependency. Feeds B3.4.

## Storage delivery

### P5-RC. Records and evidence packing and collection

- **Depends on:** no Git source-layer work. **Stage:** 5.1, starting now (owner decision, 2026-10-25).
- **Changes:** pack and compress Work records and evidence, deduplicate evidence, and collect unreferenced versions. Of 418 MB of records, only ~85 MB is reachable.
- **Retention approved by the owner:** collect only what current Work, a kept backup, a 7-day snapshot or a pending operation does not reference; full directory backup before first apply.
- **Acceptance:** report bytes before and after; verify every retained root and restore the backup on a scratch owner. **Target:** growth ~1–2 GB/yr from ~12 GB/yr (estimate). **Metrics:** disk per project and 8; must not regress 2, 3 or recovery.

### P5-SG. Git source layer

- **Size:** M–L, split if L; estimate 5–10 agent-days. **Depends on:** B1.5b. **Stage:** 5.5, alongside B1.6–B1.8.
- **Changes:** implement the SP1 layout and Forge State identities, reversible migration and aliases. Delete the native→Git projection code it replaces. GitHub outbound mirroring becomes a push of the derived commit; inbound external merges and git-push contributions become a fetch plus one State record. Actions checks need no per-run export.
- **Acceptance:** exact source trees and historical Forge pins survive conversion and rollback; retained roots survive collection; backups restore. Dogfood conversion measured 65–85 s in the spike; production migration remains unrun. **LOC:** ~1,500 added, ~1,567 removed (estimate, including tests). **Metrics:** disk per project, 6 and 8; must not regress 2, 3 or 7.

## Bet 1: one authority, then delete

**Bet metric:** no-owner incidents → 0; one accept path on the dogfood project. Lines removed reported per deletion slice. Metrics 3, 5 and 7 must not regress.

**Inventory (B1.1 input, 2026-10-24).** Non-test LOC removable, with test LOC that exists only for the deleted path:

| Group | Slice | Non-test LOC | Test LOC |
| --- | --- | --- | --- |
| A. Exchange push, bound exchange, checkpoint publication | B1.6a | 3,373 | 5,227 |
| B. Source return | B1.6b | 3,406 | 4,348 |
| C. Owner relay consumer, listener, activity relay | B1.6c | 1,838 | 1,857 |
| D. reconcile-hosted-work and exchange baselines | B1.8 | 990 | 1,267 |
| E. Auto exchange worker and push spend pause | B1.6a | 770 | 915 |
| F. Hosted staleness strip and unsynced projections | B1.8 | 151 (+~80 edits) | 191 |
| G. Owner-derived display publication (conditional) | B1.6c | 957 | 448 |
| H. Work format ladder and converters | B1.7 | 686 (+~150 edits) | 1,752 |
| I. Legacy hosted-selection accept UI (gross; review parts re-parented) | B1.8 | 1,751 (+~75 Convex) | 91 |
| Split edits in surviving modules | all | ~1,900 | ~2,000–3,300 |
| **Total** | | **~15,800** (+748 scripts, ~900 doc lines) | **~18,100–19,400** |

Without the conditional G and replace-first I: about 13,100 non-test. To add: about 3,600–5,400 non-test and 3,000–4,000 test (seed and fencing 1,000–1,400; checkout and recovery folding 900–1,300; finish routing and bridges 300–600; Mac runner 700–1,000; browser accept 400–700; Work migration 200–300; forced upgrade ~100). **Net: roughly −10k to −12k non-test.** A later stage-2 compaction of the legacy hosted Work journal removes about 5,700 more and is not in this phase.

**Rule for every deletion slice:** Convex table definitions stay until their data is exported and purged (B1.9). Removing a table that still holds documents breaks schema push and Route A restores of older weekly backups.

### B1.1. Cutover plan and rollback point

- **Size:** S (docs). **Depends on:** none. **Stage:** 5.1.
- **Changes:** publish the inventory above with per-module LOC and last callers in [operations](operations.md); cutover steps, rollback point and forced-upgrade path.
- **Acceptance:** every module in B1.6–B1.8 is listed with LOC and its last caller; the rollback point is tested on a scratch owner. **Metrics:** none moved; LOC baseline.

### B1.2a. Authority transition mutation and writer fencing (G1)

- **Size:** M. **Depends on:** B1.1. **Critical path.**
- **Changes:** an epoch-pinned transition mutation in `convex/projectSourceAuthority.ts` (today only `current` exists), driven by `nextSourceAuthority`. Every bound writer checks the epoch: `ownerAcceptance.complete`, `projectExchange.publish`, `projectWorkActions.acceptChannel`, native `accept-channel` and `projectHostedChannels.seed`.
- **Acceptance:** a stale old-owner completion and a stale upload after the switch are refused with a structured error; same-head and new-receipt races resolve to one winner; the switch is idempotent under replay. **Metrics:** moves no-owner incidents. Must not regress 2.

### B1.2b. Finish routes to the hosted landing queue (G3, G6)

- **Size:** M. **Depends on:** B1.2a.
- **Changes:** bound CLI and MCP `finish` and `land` submit to `projectHostedLanding:enqueue` over the existing hosted-agent transport. Either the G3 submission ID bridge and G6 journal bridge, or a "drain the owner queue before the switch" rule; B1.1 picks one.
- **Acceptance:** with the Mac offline, a submitted Lane lands on hosted main. Two concurrent submissions against the same main resolve by CAS; neither is lost. Incident replay: the 2026-10-21 eight concurrent finishes land or fail terminally with no `WORK_STALE` visible to agents. **Metrics:** moves 2 (`WORK_STALE`) and 3.

### B1.2c. One-time hosted seed replaces push-based host creation

- **Size:** M. **Depends on:** B1.2a.
- **Changes:** a one-time seed of native main and records into hosted, pinned, paged and validated (migration invariants 1–2). `nforge host ROOT` creates projects through it instead of `prepareNativeExchange`/`pushNativeExchange` and `completeHistory`.
- **Acceptance:** a fresh hosted project and the dogfood project both seed without a push; a seed interrupted midway resumes from its last page; the seeded main digest equals native main. **Metrics:** none moved; unblocks deletion of group A.

### B1.2d. Browser accept on the hosted landing path

- **Size:** M. **Depends on:** B1.2a. Claude design pass against the existing review mockups, GPT build.
- **Changes:** the site's accept, request-changes and revert actions call `projectHostedLanding`/`projectHostedAcceptance` (today only `src/hosted-agent-*` does). Review components (Story, Check, RequestChanges, Revert) are re-parented onto it.
- **Acceptance:** accept from the site lands through the hosted queue with all Macs offline; no "Requested / Waiting for machine" state remains on that path; the legacy accept UI (group I) has no remaining caller. **Metrics:** must not regress 3 or 5.

### B1.2e. The Mac stops accepting for the dogfood project

- **Size:** S. **Depends on:** B1.2b–d.
- **Acceptance:** a local accept attempt on the dogfood project returns a structured error naming the hosted path; the Mac's landing worker accepts nothing for bound projects; unbound native projects are unchanged. **Metrics:** moves 7. Must not regress 3 or 5.

### B1.3a. Pull-based Mac runner

- **Size:** M. **Depends on:** B1.2a.
- **Changes:** `nforge worker` registers on hosted as a `HostedCheckProvider`, claims runs with a lease, heartbeats via signed callbacks, uploads output through `projectHostedOutputApi`, and has its runs requeued once when the lease expires. No run starts without a live owner of record.
- **Acceptance:** incident replay of the 2026-10-23 landing worker wedge: leases expire, runs requeue once, no landing waits on a run with no controller, and `cancel` completes without a restart. The runner fetches source from hosted and R2 directly: no `forge-check/<runId>` GitHub ref is pushed on the landing path, so GitHub is not a dependency of landing speed (review risk #12). **Metrics:** moves no-owner incidents and 3. Must not regress 5.

### B1.3b. Mac evidence and its trust rule

- **Size:** S–M. **Depends on:** B1.3a.
- **Changes:** evidence provider `mac` alongside `github-actions` (legacy `modal` evidence remains readable). Proposed rule (owner approves): Mac evidence counts for trusted and autonomous actors on projects the Mac's owner controls; supervised projects and outside contributors need hosted-runner evidence. The receipt names the machine and the reuse key.
- **Acceptance:** a supervised Candidate with only Mac evidence is not accepted; a trusted one is; evidence from a revoked machine is refused. **Metrics:** moves 6 and 8. Must not regress 3.

### B1.4a. Lanes as APFS reflink clones with snapshots

- **Size:** M. **Depends on:** none (independent of SP1). **Stage:** 5.2.
- **Changes:** Lane materialisation uses `clonefile` from the cached main tree, with a copy fallback off APFS. Automatic snapshots (Phase 4) use the same mechanism.
- **Acceptance:** creating a Lane on the dogfood tree takes under one second and near-zero extra disk until edited; a snapshot restores byte-identical; non-APFS volumes fall back with a recorded reason. **Metrics:** moves 6 (Lane setup wall time). Must not regress 8.

### B1.4b. The Mac as cache of hosted

- **Size:** M. **Depends on:** B1.2a; SP1 decision is recorded. Does not wait for P5-SG.
- **Changes:** `hosted-main-checkout.ts` reads schema-2 main from `projectHostedChannels:current` (`projectMain:current` returns `SOURCE_UNAVAILABLE` in server mode). Lanes materialise from hosted and R2; checkpoints upload directly through hosted saves and R2 presign; no exchange push. Storage uses a two-method object interface (`get(id)`, `put(bytes)`) over current R2 keys; Git objects and packs sit behind it in P5-SG.
- **Acceptance:** a fresh Mac materialises a Lane and checkpoints without a push; killing the Mac mid-checkpoint loses no saved head; exchange `pull`/`open` have no remaining caller. **Metrics:** moves 7 (cache lag). Must not regress 6 or 8.

### B1.5a. Recover folds hosted-only accepted work (G2)

- **Size:** M–L, split. **B1.5a1:** paged folding of hosted queue, record and acceptance tables, including H14 acceptance snapshot deltas, into a restorable state with exact receipts. **B1.5a2:** Route B rewritten as "recover a runner and cache from hosted", no longer restoring a native owner with acceptance authority.
- **Depends on:** B1.2b, B1.4b.
- **Acceptance:** work accepted only on hosted after cutover survives `nforge recover` on a clean machine; pending completions and stale source returns are restored exactly. Must precede any deletion of group A, `journal()` or group B. **Metrics:** must not regress 3.

### B1.5b. Cutover, forced upgrade and recovery drill

- **Size:** S–M. **Depends on:** B1.2e, B1.3b, B1.4b, B1.5a.
- **Changes:** the dogfood project moves to hosted authority; old CLIs are refused with an upgrade message.
- **Acceptance:** Route B passes on a clean machine; Route A is re-measured after the R2 purge of push-era objects (retaining every object referenced by kept backups). Times published in [operations](operations.md). One authority: every accept on the project goes through hosted CAS for seven days. **Metrics:** must not regress 3, 5 or 7. Metric 7 switches to its after-cutover form. No background process: like Git, a user needs no always-on local process after cutover (browser accepts and metadata sync work with the Mac asleep), and the dogfood login service is retired. Anything still kept running is opt-in, has one stated job and sends 0 Convex calls while idle.
- **Status:** cutover applied 2026-10-28. The dogfood project now has server authority (epoch 1) on a fresh seed at owner revision 30028, taken during a write freeze, with main `77232cfe`. Hosted source work (save, compose, sync, finish) runs inside Convex in bounded, fanned-out steps; Modal is not used. Route B, the R2 purge, Route A and the seven-day watch are still open.

### B1.5c. Big-repo onboarding benchmark

- **Size:** S. **Depends on:** B1.5b.
- **Why:** the dogfood cutover found cost bugs that tests with small, plain files missed: rejected batch calls falling back silently, per-chunk lookups for large files and eager line counts (2026-10-27). New users onboarding a large GitHub repository go through the same upload, index and read paths.
- **Changes:** import a large public GitHub repository (first candidate: `pingdotgg/t3code`, MIT, about 600 MB) into a throwaway NanthAI test project. Run the existing rate guard during the run; delete the project afterwards.
- **Acceptance:** published Convex calls, documents read and written, peak action memory and wall time for import, index build, first Now and Code views, and opening a few large files. Each is within the budget stated before the run. Every miss becomes a slice. Idle after the run is 0 calls.

### B1.5d. Replayed multi-agent benchmark on a real repository

- **Size:** M. **Depends on:** B1.5c (same repository), the self-metrics recorder.
- **Why:** Forge's published wins are landing bursts on its own repository; single-agent coding cost (14% more input, 7% more time than plain Git) and coordination quality are not yet measured on someone else's code.
- **Design:** start `pingdotgg/t3code` at an earlier commit. Pick a set of later merged pull requests that touched overlapping areas and turn each into a task prompt. Run the same agents (same models, prompts, concurrency and subscriptions) twice: on Forge, and on a fork in the NanthAI GitHub organisation using branches, pull requests and the GitHub merge queue. Randomise task order, repeat each side at least three times, and never open anything upstream. Delete the fork and project afterwards.
- **Measures:** wall time until every task is on main, agent tokens and time, check runs, conflicts and rework, broken main, and correctness against each original pull request's tests.
- **Acceptance:** usage estimate approved by the owner before the run (agent subscriptions and Convex); results published in [why Forge](why-forge.md) with method, including any measure where GitHub wins. Every Forge loss becomes a slice.

### B1.6. Delete the push and relay code

Split by group; all depend on B1.5b. SP1 is decided; P5-SG lands alongside B1.6–B1.8 and deletes the native→Git projection code it replaces. B1.6 does not wait for that layer. Each reports actual LOC removed at landing; `verify` passes with no remaining import; hosted and Mac-offline landing tests still pass.

- **B1.6a. Exchange push and auto exchange (A, E).** Size M. Includes the push half of `native-exchange.ts`, `exchange-client.ts` and `projectExchangeActions.ts`; keeps the download, upload and transport layer. Estimate 4,143 non-test, 6,142 test.
- **B1.6b. Source return (B).** Size M. Keeps `work-source-return-chunks.ts` for historic journal replay. Estimate 3,406 non-test, 4,348 test.
- **B1.6c. Owner relay and owner-derived publication (C, G).** Size M. G only if the server projection covers the same pages; otherwise G is reported as kept. Estimate 1,838 (+957) non-test, 1,857 (+448) test. **Metrics:** must not regress 3, 5 or 7.

### B1.7. Create at the current format; delete the format ladder

- **Size:** M. **Depends on:** B1.5b, B1.6b (for the hosted half).
- **Changes:** new stores are created at the current Work format (22), not schema 11 with lazy promotion. A one-time migration moves formats 1–21 to 22 (<15 bumps to 15, then 15/17/19/21 convert, unified 16/18/20 relabel), preserving `legacyIntentMerge`, `intentMergeReceipt` and `intentAliases`. The promotion ladder and `.refine` feature gates are removed; the converter stays behind `restore-native` only. Historic journal commands and request hashes are never rewritten. Records and evidence packing and collection run earlier in P5-RC, independently of this format migration.
- **Acceptance:** the dogfood owner migrates with a receipt and verifies; an old-format store outside restore returns one `WORK_UPGRADE_REQUIRED` error; restoring an old backup still works; per-format fixtures are deleted. **LOC:** estimate 686 non-test plus ~150 of gate edits, 1,752 test. **Metrics:** must not regress 2.

### B1.8. Delete reconcile, staleness strip and legacy accept (D, F, I)

- **Size:** M. **Depends on:** B1.5b, B1.2d.
- **Acceptance:** one acceptance engine remains; hosted pages read hosted state with no "catching up" or "not yet synced" path; tests for removed paths are gone, not skipped. `native-companion-types.ts` stays (Work schema). **LOC:** estimate 2,892 non-test plus ~155 of edits, 1,549 test. **Metrics:** must not regress 7.

### B1.9. Purge retired tables

- **Size:** S. **Depends on:** B1.6–B1.8 landed for two weekly backups. **Owner approves** (retention change).
- **Changes:** export, then purge and remove definitions for `ownerAcceptanceTables`, `publicationTables`, `metadataPublication`, `ownerDerived`, `intentMigration`, `projectReturnSupersessions` and `exchangeCleanup*`.
- **Acceptance:** the export restores into a scratch deployment; schema push passes; Route A on the newest backup still passes.

## Landing without an operator (Q)

**Metric:** operator interventions per landing (metric 5) → near zero. Owner: restarts, sleep and Wi-Fi loss are normal and must not invalidate reuse or strand work.

### Q1. Land as desired state

- **Size:** M. **Depends on:** B1.2b.
- **Changes:** `land` records a desired state ("this head should reach main") on hosted. A server-side controller drives it to a terminal outcome and survives the death of the client that asked. Clients only observe.
- **Acceptance:** killing the requesting CLI, MCP session or Mac at each step still ends in `landed` or `terminal-failed`, delivered to the requester on reconnect. **Metrics:** moves 3 and 5.

### Q2. Entries finish themselves; stall alarm

- **Size:** S–M. **Depends on:** Q1, M2.
- **Changes:** entries that become no-ops (already on main, superseded, empty against base) finish themselves with a stated outcome. A stall alarm fires when an entry makes no progress for 15 minutes, naming the step and the missing owner.
- **Acceptance:** replays of the 2026-10-23 leaderless batch and a superseded same-head entry finish or alarm without a human command. **Metrics:** moves 3 and 5.

### Q3. Content-keyed check reuse

- **Size:** M. **Depends on:** M1.
- **Changes:** reuse key as defined in metric 6. Runtime and install-path fingerprints move to the receipt, not the key.
- **Acceptance:** after an owner restart, a sleep and a Node patch upgrade, a passed check on the same tree is reused; a lockfile or Node minor change re-runs it. **Metrics:** moves 6.

### Q4. Machine lifecycle drill

- **Size:** S–M. **Depends on:** Q1, Q3, B1.3a.
- **Acceptance:** restart the owner mid-landing → **zero re-runs of passed checks, zero stranded entries**. Same for sleep for 30 minutes and Wi-Fi loss for 10 minutes during a run. Runs as a repeatable scripted drill. **Metrics:** moves 5 and 6. Must not regress 3.

## Bet 2: per-Intent contract gates; full suite continuous

**Bet metrics:** finish-to-main p50 under 3 minutes for trusted actors; check minutes per landing (metric 6, audit minutes included) at one fifth of the M1 baseline; red-main minutes per day reported and bounded.

### B2.1. Intent contract

- **Size:** M. **Depends on:** M3.
- **Changes:** an Intent declares its proving tests: new tests plus the derived affected set (`agent tests` proposes, the agent confirms). Budget under 90 seconds. Stored on the Intent and shown in review.
- **Acceptance:** a contract over budget is refused with the measured time; review shows the contract; a contract-less Intent falls back to the full gate. **Metrics:** none moved yet; must not regress 2.

### B2.2. Policy gate

- **Size:** S–M. **Depends on:** B2.1, B1.5b.
- **Changes:** trusted and autonomous actors accept on contract pass on the exact Candidate; supervised keeps the full gate (decision 1). Docs and UI say plainly that main may be briefly red and fix-forward is automatic.
- **Acceptance:** policy tests per actor class; a supervised Candidate with a passing contract and no full run is not accepted. AGENTS.md and status describe the rule. **Metrics:** moves finish-to-main p50 and 6. Must not regress 3.

### B2.3. Continuous main audit

- **Size:** M. **Depends on:** B2.2.
- **Changes:** the full suite runs on main at a coalesced cadence (every N landings or M minutes, whichever first). Red main pauses auto-accept until main is green.
- **Acceptance:** a seeded failing landing turns main red, pauses auto-accept and records red minutes; a passing audit resumes it. Identical main heads are never audited twice. **Metrics:** moves R. Audit minutes count in 6 and must stay within the bet target.

### B2.4. Flake-aware culprit finding

- **Size:** L, split. **B2.4a:** rerun-based flake classification. **B2.4b:** bisection over accepted Intents, then the existing fix-forward or compensating revert. **Depends on:** B2.3.
- **Acceptance:** a seeded flaky test is classed as a flake and causes no revert. A seeded real failure among five landed Intents names the right culprit, and the revert or fix-forward says what it did and how to undo it. The 2026-10-24 diagnosis loop (same head re-checked six times) replays as one run. **Metrics:** moves R and 6. Must not regress 5.

### B2.5. Demote batches, shards and scoped checks; delete dead code

- **Size:** S–M. **Depends on:** B2.4.
- **Acceptance:** trusted landings pass without a batch; `verify` passes with dead paths removed. LOC removed reported at landing. **Metrics:** must not regress 1 or 6.

### B2.6. Trust per path per actor

- **Size:** M. **Depends on:** M3, B2.2. **Owner approves defaults before enabling.**
- **Changes:** trust is earned per path and per actor from green landings, weighted by contract size, and lost on culprit findings. An actor from a new vendor starts supervised everywhere. People can delegate areas to an actor explicitly. The effective level is shown on the Intent and in briefs.
- **Acceptance:** fixture histories produce the expected levels; a culprit finding lowers trust on that path only; a delegation is a D1 decision record; disabled by default until the owner approves the defaults. **Metrics:** moves finish-to-main p50 and 5. Must not regress R.

## Experiments

Each result is published next to the 2.36× burst-4 figure in [why-forge](why-forge.md) and in the forge-bench results, whichever way it goes. Method and bars follow the review's evidence audit, §4.2.

### E1. Live overlap-alert replay ×5

- **Status:** published. Run 1 (2026-10-24, d57) passed all three bars, but only 37 of 90 overlapping agent-pair×file combinations reached both agents. Run 2 (2026-10-25, d59, after overlap ranking) reached 90 of 90 at save time and 84 of 90 in both transcripts, but only 2 of 5 replays delivered the first alert to both agents before the second save: alerts arrive with an agent's next Forge call, and in three replays that call was the second save, 1–3.5 s later. Delivery at first write (B3.1) is the fix. Results: forge-bench `results/E1-2026-10-24.md` and `results/E1-2026-10-25.md`. **Cost:** about $10.
- **Method:** on a scratch owner seeded from main, four Codex agents edit the same three docs, plus eight concurrent finishes, five repetitions. Record alerts per overlapping save, time from the first overlapping save to an alert in the agent's transcript, `WORK_STALE` and `WORK_BUSY` counts, and dropped landings.
- **Bar:** at least 4 of 5 replays deliver an alert to both agents before the second save; 0 of 40 finishes dropped; 0 `WORK_STALE` visible to agents.

### E2. Git control arm for one real wave

- **Cost:** about $0 (free GitHub-hosted runners on the public repository and existing builder budget). **Stages:** 5.2–5.4.
- **Method:** six mutually independent S/M slices from stages 5.2–5.3, paired by size (candidates: B1.4a, B1.3a, B1.2d, Q1, Q3, M2): three through Forge, three in a plain Git worktree with a GitHub PR and merge queue. Same builders, instructions and time box. Per slice: wall-clock to green main, builder tokens, lead interventions (every manual command), conflicts and red-main minutes. Git-arm results come back into Forge as one Candidate each; that import is excluded and reported.
- **Bar:** Forge wins on lead interventions and time to main with no red main. If Git wins on interventions, that is the headline.

### E3. Failing-change burst-4 vs a tuned merge queue

- **Status:** published 2026-10-24: **the bar failed**. The tuned GitHub merge queue landed the three good changes in a median 189 s; Forge took 989 s (about 5.2× slower; about 2.4× even if every Forge check had been as fast as a GitHub PR check). Neither side landed the bad change or turned main red. The landing work that answers it is in [Landing without an operator](#landing-without-an-operator-q) and Bet 2. Result: forge-bench `results/E3-2026-10-24.md`. **Cost:** about $5.
- **Method:** P2 burst-4 on Blacksmith with one of four changes failing a test, three runs each side. GitHub's merge queue is tuned (batching and `max_entries_to_build`), not default.
- **Bar:** Forge lands the three good changes faster than the tuned queue and never lands the bad one.

## Bet 3: coordination that bites, then measure

**Bet metric:** metric 4, delivered and acknowledged, recorded by Forge. Build starts after E1 and E3 are published; E2 must be published before B3.5.

### B3.1. Overlap at first write, in the agent's loop

- **Size:** M. **Depends on:** E1, M2. **Must land before the R3 benchmark.**
- **Changes:** a pre-edit hook for Claude Code and Codex calls `nforge agent peers --path` (a read, which never writes) before the first edit of a path and blocks until the overlap is acknowledged or routed around. Every nforge CLI and MCP response also carries the caller's unacknowledged overlaps. Acknowledgements are records, so metric 4 gains its acknowledgement rate. Never a lock on source. The same hook records the agent session and turn behind each save, so a saved State, its automatic snapshots and later each hunk link back to the conversation that produced them; making-of, review and decision records (D1) show that link, and a snapshot can be restored to the turn it came from.
- **Acceptance:** incident replay of the 2026-10-21 four Lanes editing the same docs: both agents see the alert before their first overlapping write, and each acknowledgement is recorded. The hook adds under 200 ms p95 to an edit and fails open with a recorded event if Forge is unreachable. A save made through the hook names its agent session and turn; transcript text stays with the agent unless the owner opts in. **Metrics:** moves 4. Must not regress 2.

### B3.2. Intent semantic conflict

- **Size:** M. **Depends on:** B2.1.
- **Changes:** when a text merge is clean, run the union of both Intents' contract tests on the composed Candidate. A failure is a first-class conflict naming both Intents.
- **Acceptance:** replays of the four semantic clashes in coord-evidence (duplicate import, cleanup helper, batching default, OOM verdict) each raise a named conflict where the contracts cover them; clean pairs raise nothing. **Metrics:** moves 4 and 1 (fewer after-fixer landings).

### B3.3. Unacknowledged overlaps in Now

- **Size:** S. **Depends on:** B3.1. Claude design pass, GPT build.
- **Changes:** per-agent unacknowledged overlap count and acknowledge action in Now.
- **Acceptance:** built against the mockup; the count matches metric 4's records. **Metrics:** moves 4.

### B3.4. Deterministic declaration-level merge

- **Size:** M. **Depends on:** SP2 decision, B2.1.
- **Changes:** first deliverable of the SP2 winner: when two Intents edit different declarations in the same file, Forge merges them deterministically. Every merge is gated by the contract check (and B3.2 when both Intents have contracts).
- **Acceptance:** the different-declaration cases in the conflict corpus merge with the same output on every run; a merge whose contract fails is a conflict, not a landing. **Metrics:** moves 1 (fewer after-fixer landings) and 5.

### B3.5. Re-measure, including R3

- **Size:** M. **Depends on:** B3.1 with its acknowledgement metric, B3.2–B3.4, E2.
- **Changes:** rerun E1, then the coordination benchmark (forge-bench R3) using metric 4. A no-model preflight of every arm runs first. R3 does not run before B3.1 exists.
- **Acceptance:** a valid R3 result for every arm, published next to E1–E3 whichever way it goes.

## Vocabulary consolidation (V)

After the B1.5b cutover. Goal: fewer concepts and actions, the same functionality, a better workflow.

### V1. Model memo

- **Size:** S. **Depends on:** B1.5b. Claude.
- **Changes:** Candidates become first-class (what is reviewed, checked and landed). A Lane is a workspace (directory, presence and scope), not a lifecycle. A mapping table from each of the ~37 current actions to its new home, with nothing dropped. Agreed with the owner as a D1 decision.

### V2. Consolidate actions

- **Size:** L, split. **V2a:** `start`, `save` and `land` absorb the lifecycle actions, with old names as aliases that print the new form. **V2b:** reads consolidate and aliases are removed after one release. **Depends on:** V1.
- **Acceptance:** every row of the V1 mapping has a test through the new surface; agent briefs and AGENTS.md use only the new verbs. **Metrics:** moves 2 and 5. Must not regress 1.

### V3. CLI generated from the MCP surface

- **Size:** M. **Depends on:** V2a.
- **Changes:** CLI commands are generated from the MCP tool definitions. Operator verbs (`cancel`, `take`, `set-policy`, repair commands) move behind `nforge x`.
- **Acceptance:** CLI and MCP list the same actions with the same arguments; a drift test fails on any mismatch.

## Hardening and end-of-phase items (X)

### X1. Schema compatibility check

- **Size:** S. **Depends on:** nothing. Stage 5.2.
- **Changes:** the shared schema (one Zod file used by CLI, Convex and web) gets a check that compares it with the last released schema and refuses removals, renames and narrowing unless a migration is declared. "Additive-only" becomes a check, not a convention (review risk #11).
- **Acceptance:** a fixture removing a field or narrowing an enum fails the check with the field named; adding an optional field passes; the check runs in `verify`.

### X2. End-of-phase items

Scheduled for stage 5.8, kept here so they are not lost:

- **Bundle hygiene** (review risk #15): replace the 611 KB PNG monogram with SVG, subset or drop the 165 KB font, and split the 471 KB main chunk. Acceptance: first-load bytes reported before and after.
- **Hotspot files** (review A2): files every change edits, such as `CHANGELOG.md`, are generated from accepted Intents instead of hand-edited, so they never serialise landings or conflict.
- **Experimental checks and sampled human review** (review C9): a check can run in observe-only mode before it gates, and supervised review can sample instead of reviewing every Candidate. Design memo first; needs B2.2.
- **Git call sites in the native path** (review risk #6): SP1 is decided. P5-SG makes Git the source layer and deletes the separate native→Git projection, sync conversion and per-run Actions export.
- **Agent usage budgets** (review C10) stay in Phase 6 with cross-repo usage pools.

## Freeze

Frozen under decision 4:

- Browser code editing (H19a).
- Two-way GitHub sync (H23, H24).
- Remaining hosted Lane rows (H19b, H20a, H20b, H21a–H21d).
- Hosted landing gaps not needed by Bet 1 (G4, G5, G7–G10).
- CI adapters (Azure DevOps, GitLab, GitHub).
- Landing timeline UI and CI insights.
- Review comments anchored to declarations or text ranges that survive later edits, instead of to a Candidate snapshot (prior art: Delta anchors comments to exact text, diff lines and plan steps). Builds on the declaration identity from SP2 and B3.4.

**Unfreezes when** E1 and E3 are published and B1.5b (cutover) has landed. Bug fixes to frozen surfaces are allowed.

## After the bets

The rest of the old Phase 5 list follows: an outside-user trial, a polished first project through GitHub import, and newcomer docs. Carried friction stays documented in the roadmap's Workflow friction section and is not scheduled; the hub-module split for test selection is likely dissolved by B2.1.

## Gate parity (G1–G8, added 2026-10-28)

**Target:** a full check of 10 minutes or less on free GitHub-hosted Actions, a scoped check of 5 minutes or less, $0
for public repositories, and idle 0. **Reference point:** an outside multi-agent project cut its gate from 40–70 minutes to
about 6 minutes with paid on-demand VMs, warm snapshots and parallel boxes. These slices run after the hosted Actions
runner is qualified.

| # | Slice |
| --- | --- |
| G1 | Warm dependencies and build on Actions: cache keyed by lockfile and toolchain; build once, reuse it across shards. |
| G2 | Shard count from measured timings, toward the free concurrent-job limit. |
| G3 | Scoped checks on, with post-accept full main checks active. Merged with B2.5. |
| G4 | Flake containment: retry a failed test file once; a pass on retry is recorded as flaky and surfaced, never silently green. Merged with B2.4. |
| G5 | The check report lists every failed test file. |
| G6 | A runner label for the hosted Actions runner, so hosted projects can keep their own runners (BYOCI parity). |
| G7 | Per-machine content cache and direct R2 reads for Mac and self-hosted check workers. |
| G8 | Measure and publish gate time (p50/p90), dollars per landing, and grouped landings against a GitHub merge queue. Re-run E3. |

Paid compute providers need owner approval and a spend limit first.

A check must not share its machine with agents' builds or test runs: on 2026-10-28 a Mac check that overlapped five builders' test suites failed three timing-sensitive files that pass when the machine is quiet. Hosted Actions shards avoid this by design.

## Exit criteria

Phase 5 closes when all of these hold:

1. Each bet metric and metric 5 are met, or honestly reported with the measured value and the reason.
2. E1–E3 and R3 are published next to the 2.36× figure.
3. Bet 1 is cut over with one authority, and B1.6–B1.8 have landed with LOC removed reported.
4. The Q4 lifecycle drill passes.
5. The outside-user trial is ready to start: newcomer docs and a first project through GitHub import work for someone who did not build Forge.

## Review coverage

The 2026-10-24 external review (four reports: history and state, architecture, evidence, prior art) is kept with the lead notes outside the repository. Every point it raised maps to work here or to Phase 4:

| Review point | Where it is handled |
| --- | --- |
| Incidents 2.1–2.7; blind spots 1–8; the eight metrics | M1–M3, D1, red-main minutes in M2 |
| Blind spot 9, benchmark debt | E1–E3, B3.5 (R3) |
| A1 one global suite; C2 contracts; C4 continuous audit | Bet 2 |
| A2 hotspot files | X2 |
| A3 line merge; C3 structural merge; C5 declaration level | SP2, B3.4 |
| A4 laptop authority; C6 hosted only; risks #5, #7, #13 | Bet 1 |
| A5 format sprawl; risk #3 | B1.7 |
| A6 advisory coordination; C1 soft leases; C12 Intent conflict; risk #8 | B3.1–B3.3 |
| A7 porcelain sprawl; C11 Candidate first; risk #10 | V1–V3 |
| A8 lead as queue operator | Q1–Q4, metric 5 |
| A9 cost at the wrong layer | Metric 8, dollars per landing |
| A10 cockpit before coordination | Freeze |
| C7 Git-native storage; risk #2 no packing or GC | SP1 decision; P5-SG source layer; P5-RC records and evidence |
| C8 trust per path | B2.6 |
| C9 experimental checks, sampled review | X2 |
| C10 agent budgets | Phase 6 |
| Risk #1 records outweigh source | Phase 4 reads never write; P5-RC packing and collection, stage 5.1 |
| Risk #4 seven queues | Q1 controller; B1.6 deletes the push queues |
| Risk #6 Git in the native path | SP1 decision; P5-SG deletes the projection |
| Risk #9 `peers` writes | Phase 4 reads never write |
| Risk #11 schema lockstep | X1 |
| Risk #12 checks through GitHub refs | B1.3a |
| Risk #14 child environments | Phase 4 minimal child environments |
| Risk #15 bundle size | X2 |
| Delta (Zed) prior art, 2026-10-24 | B3.1 session and turn provenance; SP1 prior art; Freeze list (anchored comments) |
