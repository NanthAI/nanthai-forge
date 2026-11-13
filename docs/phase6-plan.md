# Phase 6 lead plan

Read this plan, the [lead rules](agents/lead.md), [Phase 5 close](phase5-close.md), [roadmap](roadmap.md) and the full linked Forge planning Issues. The roadmap is the authority for current stage names; historical drafts and old Issue stage labels are superseded. Phase 5 is closed. Phase 6 makes it solid; Phase 7 is UX and UI only; Phase 8 is the public beta; Phase 9 is growth (owner re-bucket, 2026-11-07). No outside-user count is a Phase 6 exit.

## P6 close order (owner, 2026-11-10)

Use [Baseline to beat](research/p6-baseline.md) for B1.5d's reference figures, partial P6 re-measurements and the remaining evidence gaps.

This order supersedes earlier close/start sequencing below. P6.8 starts from the
repo evidence in [data placement](data-placement.md#where-the-bytes-and-io-go-2026-11-10),
[cost to serve](operations/cost-to-serve.md#pre-bench-smoke-and-subsequent-fixes-2026-11-10)
and [decisions](decisions.md#decisions-from-10-november), plus the linked Issues
and all their comments. One-off private handoffs are not the knowledge store.
P7 is **UX and UI only**; it does not silently absorb unfinished P6 work. Live
GitLab is explicitly moved to P8 [a697aba8](https://nanthai-forge-dev.netlify.app/?project=mh7aafndrxmj8c2q0931zbjk2n8h4ffs&projectTab=planning&planningItem=a697aba8-5ca4-4e95-af2c-6ce3139700db). Flip 3 [4e4204b6](https://nanthai-forge-dev.netlify.app/?project=mh7aafndrxmj8c2q0931zbjk2n8h4ffs&projectTab=planning&planningItem=4e4204b6-9373-49b3-a8fd-3eb06208a310) and one-client/
parity [657d63ee](https://nanthai-forge-dev.netlify.app/?project=mh7aafndrxmj8c2q0931zbjk2n8h4ffs&projectTab=planning&planningItem=657d63ee-249a-44ae-94e2-55549f84eea9) are closed with evidence, including the State/hash codemod.

1. Builders finish their current slices and verify their accepted source.
2. Fable 5.2 reviews what lives in Convex versus R2 or a third stack, under
   Issue [4c8dfe6a](https://nanthai-forge-dev.netlify.app/?project=mh7aafndrxmj8c2q0931zbjk2n8h4ffs&projectTab=planning&planningItem=4c8dfe6a-3511-4d01-a36b-1158c4e42c69). Convex is preferred for realtime across web and future
   iOS, its SDK and agent notifications. Alternatives are welcome if cheaper
   within the margin of error and simpler, including consolidation on one
   platform. Near-realtime is acceptable only if savings and simplification of
   infrastructure/interdependencies are large. Time to main, check wall and
   notification latency must not regress much. Cost is major, not the only
   factor: the product must sustain itself, with a paid tier planned. These
   constraints authorize the review, not a new paid service or product limit.
3. GPT builders implement the agreed recommendations in finite slices with
   calls, bytes, memory, timing and preservation guards.
   Placement Issues: [S0](https://nanthai-forge-dev.netlify.app/?project=mh7aafndrxmj8c2q0931zbjk2n8h4ffs&projectTab=planning&planningItem=886a4694-b2eb-4e58-881f-787376038698), [S1](https://nanthai-forge-dev.netlify.app/?project=mh7aafndrxmj8c2q0931zbjk2n8h4ffs&projectTab=planning&planningItem=bea7868d-a5da-4d65-ae30-2e9fb524d9a9), [S2](https://nanthai-forge-dev.netlify.app/?project=mh7aafndrxmj8c2q0931zbjk2n8h4ffs&projectTab=planning&planningItem=27d4c1fd-ec6c-4a48-9a8c-bffbbc6273f2), [S3](https://nanthai-forge-dev.netlify.app/?project=mh7aafndrxmj8c2q0931zbjk2n8h4ffs&projectTab=planning&planningItem=324f1d97-47a4-40c4-a8a5-058bad9449d9), [S4](https://nanthai-forge-dev.netlify.app/?project=mh7aafndrxmj8c2q0931zbjk2n8h4ffs&projectTab=planning&planningItem=91df7eda-ac01-40c9-b583-32311403846c), [S5](https://nanthai-forge-dev.netlify.app/?project=mh7aafndrxmj8c2q0931zbjk2n8h4ffs&projectTab=planning&planningItem=e7e35328-7730-436a-b229-ba11d6362987), [S6](https://nanthai-forge-dev.netlify.app/?project=mh7aafndrxmj8c2q0931zbjk2n8h4ffs&projectTab=planning&planningItem=062b48cc-3043-4fe9-9627-3f7e533ba45f), [S7](https://nanthai-forge-dev.netlify.app/?project=mh7aafndrxmj8c2q0931zbjk2n8h4ffs&projectTab=planning&planningItem=b99d1ea1-3ba7-4708-8506-59800960c354), [S8a](https://nanthai-forge-dev.netlify.app/?project=mh7aafndrxmj8c2q0931zbjk2n8h4ffs&projectTab=planning&planningItem=9e4ba8c6-be09-4ccd-bee3-2ed359f56b27), [S8b](https://nanthai-forge-dev.netlify.app/?project=mh7aafndrxmj8c2q0931zbjk2n8h4ffs&projectTab=planning&planningItem=80f9bfe4-8f57-488d-bf7b-2a32b746eb48); S8a starts now alongside A, and S8b follows the spike and owner check.
4. Run the smoke and report cost per 1,000 landings **including maintenance**;
   show measured usage separately from fixture/model estimates, R2 operations,
   storage and amortized backup/expiry cost, with one-off migration/index builds
   separate. Report coverage gaps, end-to-end timing and discarded runner minutes.
5. Run the exit bench only on the owner's **explicit go**, on the final frozen
   pins and under its registered plan. A passing smoke is not that go.
6. Close out with accepted receipts, every acceptance line evidenced or explicitly
   moved by the owner, remaining caveats, and the owner decision to begin P7.

### Open P6 acceptance lines

The 11 November handover planning read for Initiative `f1ce7574-337a-485f-8a81-0938845523e8`
contains **11 live Issues: eight open, three in progress, zero proposed**. This
is the handover inventory, not a claim that old checklist text has been reconciled;
read fresh planning before close. No checkbox or Issue status changes here.

| Issue | Remaining line(s) / evidence needed |
| --- | --- |
| [8c4f126b](https://nanthai-forge-dev.netlify.app/?project=mh7aafndrxmj8c2q0931zbjk2n8h4ffs&projectTab=planning&planningItem=8c4f126b-0c04-492e-a66a-aabc6acd4981) | Aggregate exhaust/rebuildable compaction disposition and the lead's post-cleanup dashboard figure. B expiry/catch-up, C split/migration and D compaction evidence are posted; retained journal/observation bodies and other candidates need the placement review, not blanket expiry. Matched billed per-landing I/O remains unverified. |
| [298f9675](https://nanthai-forge-dev.netlify.app/?project=mh7aafndrxmj8c2q0931zbjk2n8h4ffs&projectTab=planning&planningItem=298f9675-b8ad-49d6-96c3-07d94e5f9ebd) | Both paths' final no-regression bar (time to main/check wall), zero idle/always-on work and unchanged MCP surface; lead's identical billed re-smoke and per-function split. Source/CI fixture lines are met; catalog-backed bytes do not prove every raw binding is cheaper. |
| [1018d0f8](https://nanthai-forge-dev.netlify.app/?project=mh7aafndrxmj8c2q0931zbjk2n8h4ffs&projectTab=planning&planningItem=1018d0f8-7745-447b-8e83-b2b502bc25fc) | Next smoke and post-deploy dogfood before/after discarded passed runner-minutes per landing. Root cause and reuse fix are evidenced; independent proof/negative-fixture review precedes the smoke. |
| [4c8dfe6a](https://nanthai-forge-dev.netlify.app/?project=mh7aafndrxmj8c2q0931zbjk2n8h4ffs&projectTab=planning&planningItem=4c8dfe6a-3511-4d01-a36b-1158c4e42c69) | Public-safe role/size/I/O/realtime/transaction classification for every Convex table and R2 use; two or three whole-system options with cost per 1,000, idle/10x/100x monthly and maintenance costs, timing, migration and risk; owner summary; implementation Issues only after agreement. |
| [70a9bd2f](https://nanthai-forge-dev.netlify.app/?project=mh7aafndrxmj8c2q0931zbjk2n8h4ffs&projectTab=planning&planningItem=70a9bd2f-f741-4d26-8ae5-7bb11148a17c) | Complete 26-repository/path report and timings next to Git; every failure filed and generically fixed; on-demand low-cost regression rerun and claim citations. Preserve failed/lost samples and report setup/teardown evidence; remaining teardown-suffix/fidelity cleanup is owned here. |
| [ea0bc2e6](https://nanthai-forge-dev.netlify.app/?project=mh7aafndrxmj8c2q0931zbjk2n8h4ffs&projectTab=planning&planningItem=ea0bc2e6-ed28-4fd5-adf2-0e4ac9dfdda8) | Preserve `retryAt`; wait locally with zero Convex calls after the provider's named rate refusal and resume the original import/payload. Synthetic thrown/returned-refusal, identity and healthy-call guards; replacement row with failed setup time retained. |
| [7bce7c1a](https://nanthai-forge-dev.netlify.app/?project=mh7aafndrxmj8c2q0931zbjk2n8h4ffs&projectTab=planning&planningItem=7bce7c1a-4884-4a25-b264-9d33e668258b) | Hazard rows pass only the established source-representation refusal for that phase. Auth/rate/unknown refusals fail. Guard in the existing test file and apply to the final 26-row report. |
| [95e39ecf](https://nanthai-forge-dev.netlify.app/?project=mh7aafndrxmj8c2q0931zbjk2n8h4ffs&projectTab=planning&planningItem=95e39ecf-3bcc-40ea-9549-e884fceff232) | Every pending/timeout source action reconciles the original operation/payload before the next action; unfinished journals survive. Synthetic timeout/terminal-failure guard; publish original and replacement samples. |
| [d9eded54](https://nanthai-forge-dev.netlify.app/?project=mh7aafndrxmj8c2q0931zbjk2n8h4ffs&projectTab=planning&planningItem=d9eded54-2727-4e0e-87dc-8851a8909fc5) | Automatic cache eviction retains live-process or unknown-coverage copies; delete only truly unused copies. Reuse batched process observation, retain deletion provenance, add no Convex/idle calls; verify tests/landing and disclose the lost evidence in the zoo report. |
| [6ab11d19](https://nanthai-forge-dev.netlify.app/?project=mh7aafndrxmj8c2q0931zbjk2n8h4ffs&projectTab=planning&planningItem=6ab11d19-472f-44e4-bc84-daaa27c1fdd8) | Summary/default report/baseline preserve actual A/C `mainMoved`, first-check class/reason and recompose count; `landReuse` is C, not necessarily the overtaken Lane. Keep baseline values/strict checks unchanged; exact historical matching, reversed-order guard and full report; only matched C overtakes count toward the requested five. |
| [8c9b84fc](https://nanthai-forge-dev.netlify.app/?project=mh7aafndrxmj8c2q0931zbjk2n8h4ffs&projectTab=planning&planningItem=8c9b84fc-737e-4d1e-8bca-0d0f847566e6) | Finish offline qualified-base/ten-task reconstruction and setup/harness portability proofs with receipts, then final frozen plan, estimate and owner go. Publish every N against GitHub and B1.5d: seconds to main/wall/prep/CLI/queue, correctness, rework tokens/turns, CI and Convex cost; preserve preregistered outlier/contamination rules and every void. Prove multi-agent coordination, N16 convoy bar and zero independent-order waits; report stacking A/B and weaker-model error/turn evidence. Later owner amendments soften N1 parity and CI-minute reduction; they do not waive reporting or generic regression fixes. |

Added 13 November, after the first exit-bench batches were stopped to fix conflict signals (the bench then
restarted fresh on the fixed build):

| Issue | Remaining line(s) / evidence needed |
| --- | --- |
| [83e6d0d3](https://nanthai-forge-dev.netlify.app/?project=mh7aafndrxmj8c2q0931zbjk2n8h4ffs&projectTab=planning&planningItem=83e6d0d3-adf8-4390-814c-60b680607098) | Lines 1, 2 and 4 landed (exact conflicts at save, delivery on every surface and wait, stale-check cancellation); live landing-wait and billed-cost evidence from the restarted bench. **Line 3 is bench-gated** (see 7fe54c7c). |
| [6fbba986](https://nanthai-forge-dev.netlify.app/?project=mh7aafndrxmj8c2q0931zbjk2n8h4ffs&projectTab=planning&planningItem=6fbba986-3b78-439d-878d-afbd66510414) | Sync and resolve after a conflict at about 29,000 files: two rounds landed (sync 27.7 to 19.9 s); the 10 s target is still open. |
| [d730121f](https://nanthai-forge-dev.netlify.app/?project=mh7aafndrxmj8c2q0931zbjk2n8h4ffs&projectTab=planning&planningItem=d730121f-bc82-46cf-9d3b-e7c640bbd65d) | Distinct agent run per session landed for the CLI and the bench harness; live confirmation from the restarted bench. |
| [7fe54c7c](https://nanthai-forge-dev.netlify.app/?project=mh7aafndrxmj8c2q0931zbjk2n8h4ffs&projectTab=planning&planningItem=7fe54c7c-5a64-48b9-a20f-4c6352a62e45) | **Bench-gated, may not be done at all.** Stacked checks and overtaking are built and parked (Lane f36318fb). Run a narrower round only if the restarted bench still shows overlap waits on the slow tail; otherwise the lead proposes closing it and the owner decides. |

The bench Issue retains its exact bars and amendments; this table is not a new
bench plan. Older stage-map items below are context, not additional live Issues
or authority to move an unresolved acceptance line.

### Friction carried from the run

These observations remain visible even where a workaround or fixture fix exists;
this docs slice does not declare them resolved or open a duplicate Issue.

| Friction / observation | Handover consequence |
| --- | --- |
| Owner clicks needed to connect/authorize each scratch project | Include setup time and exact connection preconditions in the next run; Flip 3 evidence [4e4204b6](https://nanthai-forge-dev.netlify.app/?project=mh7aafndrxmj8c2q0931zbjk2n8h4ffs&projectTab=planning&planningItem=4e4204b6-9373-49b3-a8fd-3eb06208a310) records the blocks. No additional product confirmation is proposed. |
| Stop hook attributed bench landings to the lead | Keep actor/operation/receipt attribution explicit; verify the hook against the actual builder before interpreting its blocker. Carried under exit-bench [8c9b84fc](https://nanthai-forge-dev.netlify.app/?project=mh7aafndrxmj8c2q0931zbjk2n8h4ffs&projectTab=planning&planningItem=8c9b84fc-737e-4d1e-8bca-0d0f847566e6). |
| Flakes passed on retry (archive memory, source CPU, recipe GET count and others) | Retain first failures/retries; a later green run alone does not diagnose a flake. Storage/cost/main-race Issues retain the relevant check receipts. |
| Spend parser missed quoted provider project/landing markers | Storage comment `090de0e9` records the fault; split builder added balanced-quote parsing. New paired attribution/coverage proof is still needed; never divide by zero or infer a saving. |
| Dry runs left fork commits | Preserve the original inputs, failed/void samples and cleanup proof under [8c9b84fc](https://nanthai-forge-dev.netlify.app/?project=mh7aafndrxmj8c2q0931zbjk2n8h4ffs&projectTab=planning&planningItem=8c9b84fc-737e-4d1e-8bca-0d0f847566e6); distinguish generated fork history from accepted product source. |
| Shared dependency cache never evicted | Reconcile retention/reclaim before the full bench; this is distinct from automatic Lane eviction deleting a live copy ([d9eded54](https://nanthai-forge-dev.netlify.app/?project=mh7aafndrxmj8c2q0931zbjk2n8h4ffs&projectTab=planning&planningItem=d9eded54-2727-4e0e-87dc-8851a8909fc5)). No deletion scope is authorized here. |
| About 34 GiB free versus about 43 GiB for the full bench | Observed run-log capacity versus modelled bench requirement: about 9 GiB short, before reserve. Resolve capacity before owner go; no cleanup or paid infrastructure is authorized by this arithmetic. |

## Stage map

**Exit:** bugs and friction filed before the exit-bench plan (8c9b84fc) is frozen are fixed or dropped by the owner, none silently deferred. After that freeze, only core-claim or severe bugs block exit. A repeat of the B1.5d benchmark shows the conflict-recovery loss fixed and no regression; idle Convex stays at 0 calls. Attribution comes before optimization. Owner rule, 2026-11-07: a phase close never waits on timings or on evidence that only builds up by dogfooding (a count of landings, a busy wave, a soak, a dated re-check). Anything that can be checked now is checked before the close; the rest moves to Phase 7 as a re-check that names what to measure, the bar, the trigger and what to do if it fails. The billed-cost target (about $0.002 or less per accepted landing, $0.001 stretch, 9db58ca6) is therefore a Phase 7 re-check over dogfood landings, Issue 686ecdde, not a close gate.

**Moved at the close (owner, 2026-11-07).** 22 non-gate Issues moved to Phase 7 with owner confirmation. 11ba7bb9, f4fa7b76, f65d8024 and bbedd496 moved to early Phase 7. Checks that need later evidence, 0ea17a29, 10b0a94b, a7de3a93, adff6f58, 7f085ec9 and 3dbe8e12, are carried as Phase 7 re-checks. 7635743a is dropped: its target was synthetic, and live open time is the measure.

- **6.1 Close the Phase 5 tail**: the B1.9 table purge (with the local owner HTTP server and native-owner code), the one-authority watch, the legacy Convex storage move and delete (Issue 40dad5e0), the stuck import cleanup, the R2 guard follow-up, idle polling, cache-path gaps and the benchmark harness findings (including the contamination rule that voided 34 tasks on false positives).
- **6.2 The landing loop under contention.** B1.5d showed Forge 24-35% faster to `main` per task, but a few tasks in conflict or overtake loops set whole-batch wall time. The work:
  - conflict recovery agents cannot fumble: landing refuses while conflict markers remain, resolve works from the Lane root, and every conflict ends with one clear next step;
  - overtakes and CI bundling, a per-Lane local lock and faster Lane open (Forge prep is 15 s against 4.5 s for a local clone);
  - overlap notices that fire only for real collisions (13 of 45 blocking notices were useful, and 22 test-file conflicts had none), then earlier detection, with push delivery to agent sessions after that;
  - sync-apply recovery for ignored build outputs (1ad05526-bc33-4b17-a90d-7f31e94b7164), and no dead ends (d910db6b): every failed check names its cause and next step, a supervisor, and rollback notices;
  - flake containment, failed-test lists, train qualification, shortest-check-first and queue reordering (after measuring), a symbol-level selector and declaration merge.
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
- **6.3 Every friction and bug.** Cluster triage sets the work, then builders fix it in parallel batches or the owner drops it, under the exit freeze rule above. It replaces the pending owner friction-triage session. Issues are measured or tested now, or dropped; none wait for an arbitrary count. 82e8ddb8 is reshaped on that basis. Hosted command parity follows the [approved disposition and seven-step order](agents/hosted-parity.md) (657d63ee), alongside CLI consolidation (df34d40f) and the measured context budget (47558a99).
- **6.4 Cost and agent surface.** Attribute billed Convex cost before optimizing toward the agreed cost target above (a Phase 7 re-check, 686ecdde, not a close gate), in-Convex first; any hosted worker or vendor comes with a monthly cost estimate and owner approval first. The agent context budget, CLI verbs V2b and V3 (alias removal, CLI generated from the MCP surface), Lane undo (e7812d8f), and enforced trust per path per actor. Lane undo and clone refresh (73ed4d28) stay in Phase 6 as core source-host behaviour.
- **6.5 Engineering health**: a codebase health pass, mechanical guards for repeat bug classes, a TLA+ model of the landing queue and a real-user scenario matrix.
- **In parallel, no product changes**: art direction, the design system and mockups for the Phase 7 design pass.

## Close growth counts

The P6 growth guard (ed28fc6b) compares the phase start with the current close snapshot from `node scripts/check-growth.mjs --print --machines`: Convex tables **181 → 179**, public error codes **501 → 485**, agent actions **88 → 62**, CLI commands **53 → 40**, and glossary terms **34 → 27**. The additional measures report machine dependencies **0 → 0** (six hosted paths guarded) and unreferenced exports **22 → 2**; counts equal the ratchet baseline. Per-change reason fragments in `tests/growth-ledger/` keep independent updates off the shared phase-start header, and unclaimed reductions fail the check until `--update` records them.

## Agreed start order

Only **6.1 is ordered**. Cluster triage sets the later sequence, not a fixed order for all remaining Issues. Bench-harness fixes d8cf81b4, 02ee5788, 108a4883 and 97c7a123 land before the exit-bench plan (8c9b84fc) is frozen.

1. Fix weekly backup `WORK_INDEX_UNAVAILABLE`: 13402039-0e4c-44dd-915a-e4e03827f285.
2. P1 legacy storage: 40dad5e0-24e4-4dbb-82b3-58ce83fde1ee with 8678148e-d246-4f05-aaca-6edc8fcddc14. About 2.5 GB remains in legacy Convex file storage; 1.93 GB is R2 duplicates, the remainder unclassified. A read-only audit comes first. Follow [backup and cleanup preconditions](operations/legacy-storage-cleanup.md).
3. Clone refresh from Forge main: 73ed4d28-8340-4a65-b363-a946da9b8105; portable CLI updater: 7af26482-1e7c-49ef-875e-6deb430df8c7. These remove the last GitHub-mirror and off-repo tool dependencies; the docs handover alone does not remove them.
4. Authority watch 02bcad74-09fe-4f46-ae86-c17b06baf0d1, idle polling 59bb75f3-8964-4377-969d-116e58b18030, then B1.9 64d7192b-4de7-4da8-9f4c-3c7231d2eae9. Its gate is backup fix 13402039 with failure notification proven, plus one manually verified backup; the two-weekly-backups wait is dropped.
5. Use the cluster triage held on 2026-11-04 in place of the pending owner friction triage. Merge duplicate groups in planning, retaining abandoned records that point to their merge target.
6. Attribute Convex cost under 9db58ca6-1bc3-4cac-8786-2c6f5e515c21 before optimization, using the agreed billed-dollar target and at least 200 accepted dogfood landings.
7. Then 6.2: conflict recovery 36a087ea-e1df-4120-8fac-08a8f85b7bdb, notice precision ee9d5738-0272-4cb4-b03c-ca35b34966ee before push delivery 11ba7bb9-bca1-4251-ad5a-cca9243b6add, sync apply blocked by ignored build outputs 1ad05526-bc33-4b17-a90d-7f31e94b7164, no-dead-ends d910db6b and the remaining contention work.

The cluster triage and numeric cost target are agreed. Phase 8 production, publication, spend and outside-user decisions remain separately owner-gated.

## Duplicate groups in planning

These cross-linked groups are being merged in planning. Merged items remain as abandoned records pointing to their target, with acceptance evidence preserved. The lead updates this table with final targets after reconciliation; it does not yet select targets. Different symptoms may still need distinct fixes.

| Group | Full Issue ids |
| --- | --- |
| Hosted diff | 0ec51bcc-097a-4b87-9cb1-2d25f2e67aa1, 982d2926-175f-48df-bf79-a9916e27f14a, 6acc0efa-a5de-42ad-8def-b1183f52e06b, cf015799-33cb-4616-9422-096c41e729f7, fb64c32a-7424-4f24-ab2d-2ccc653be8e0, 0be3a722-1377-4438-8572-61c0561066de, 4ceffb6c-5979-4260-8698-ff8d7c89b75d |
| Hosted peers | 5283a92f-f5c7-4f83-b050-40ad4f649c72, c1c52116-5a8c-44af-bd20-d3261a23d14f, ef89ee70-d9c3-49e1-bf71-87011b61a8e0 |
| Mirror messages and coauthors | b30284de-c18c-41ec-8608-8ec037517e17, 924e86df-1c78-49bf-a21b-0f599c28b8ca, d1ca4dbc-1277-4839-af92-d812aff8fc1a, d88cafa6-557e-49c6-8fae-0087829dca4c, 12cb5377-36c1-4ef7-8417-c8732ee69977, 5fdd87f9-12c0-4572-91bb-770bb1b81fcf, 699b3608-fbbb-47b4-b262-6e8408a20481, c15c93a7-0177-44a6-a41d-e7b872c2a6a2 |
| Ignored build outputs on sync/apply | c5c776d8-65d8-426b-a4c7-404780ea05cb, 20dd077c-fe7a-40e1-a8b4-6ddf7ad98997, a3197ae0-7fc3-4656-aefb-dae93748b085, 1ad05526-bc33-4b17-a90d-7f31e94b7164, 9d22ca4e-8a8b-4c73-bd07-83cd7305a957, 5ad21d52-a2bd-4bfb-8d69-e4217b647564, 25112313-c526-4c7e-b9a2-75dde7ade006, 6e4ee3bd-b1a7-4d02-bc82-bdc501d62de7 |
| Planning closure | 2acd01c4-f337-44dd-9baa-dd50b0132a44, 0b12fcfe-d387-486b-9002-503395a8021a, edc07008-7acf-4bc0-b351-3a4997587839, 1b9613cd-8fad-4055-bf0e-665f74b44875 |
| Resource and timing flakes | 6e62fd8b-e369-4866-9c20-2cd12795ccc3, eaf60320-c93b-479c-9064-608085a4b72a, fc27aaa0-1eea-485a-9318-7b44243089a9, ae8bd596-32b2-4949-8d40-609ad81391af, 8456ebc0-ca7e-4c4e-9dfa-f07aa8399c45, 0031e2d3-5e62-4226-b0ce-a3d5f91707d3, 5f3f0062-c6a9-4284-854a-5c9c886e8a4f, d3b9fc50-2e98-4265-b8df-593a086fb2bc, 487edd17-6325-4de3-929c-0e2079a66038, 27f2f399-79c3-4b4f-bc5e-03dc632ac404, 137f125c-7885-4dfe-a058-024970e04fc7, eee98080-e6d3-45ee-ba11-e547d5cc88f4, 51ff7e8e-1fff-4456-9282-9f3502340e68 |

## Open contradictions and supersession

- Two-way GitHub sync 27e13362-bb4b-4eba-bb16-22cda0bd6942 still says **OPEN DESIGN** for inbound failure, although the Phase 8 overview says decided. Branch protection, revert and divergence remain unselected options. Neither overview wording nor this handover authorizes enforcement.
- Old stage titles in Issue bodies lose to the current roadmap/parent and dated notes. Do not restore friends or production into Phase 6 or revive dropped CI adapter breadth.
- Trust thresholds 25/100 were chosen, but enablement still needs score-distribution/latency review on 7f085ec9-38fc-462e-883f-6e724817e09d and 5f673c14-5d50-4ab3-9814-554b303b54c5. This is not authorization to tighten unrelated policy.
- Old Phase 3 candidates are in the Phase 9 holding Issue below, for disposition only. Slack/Netlify-preview/WebMCP/Lakebed and sparse-checkout ideas already have abandoned planning records; they are not missing active commitments. Early no-custom-field language predates the later arbitrary-field planning vision.
- Old local lead/preamble/common rules contain obsolete stop-before-finish, model routing, fixed test caps and all-overlap instructions. Current repo self-finish, profile and blocking/advisory rules win; use the [portable brief](agents/brief-template.md).

## Read planning from a fresh checkout

From your checkout root (verified on 2026-11-04):

```sh
nforge agent . planning '{"reconcile":false,"limit":100}'
nforge agent . planning '{"reconcile":false,"limit":100,"cursor":"RETURNED_NEXT_CURSOR"}'
nforge agent . planning '{"reconcile":false,"id":"FULL_ISSUE_UUID"}'
```

Always pass `reconcile:false` on reads. The list returns `items` and **`nextCursor`**; pass that value as **`cursor`** until `nextCursor` is null. Filters apply within scanned pages. A list body can be truncated (`bodyTruncated:true`); read by full id before relying on acceptance or replacing it. The detail read returns the full body and the newest 50 comments. See the [planning contract](agents/workflow.md#the-backlog-is-forge-planning).

Writes require full UUIDs and the observed `expectedVersion`. A put changes only the fields it names (omitted ones keep the stored value; clear with `body:""`, `intentIds:[]`, `initiativeId:null`): send just `status` to move an Issue, use `expectedVersion:0` with `kind` and `title` to create, and never send a body from a truncated list summary. Comments append via `text`. Give each mutation an operation UUID, retain its exact request, and replay that request after an unknown outcome. `ITEM_CHANGED` (it names the item and both versions) requires a fresh read of that item and reconciliation; do not overwrite concurrent work. Reads and writes need current authority; no extra setup or index repair is implied here.

## Remaining phase-folder extraction Issues

This Lane extracts B01, B03, B04, B10, B16 and B17's recovery steps. B02 is already owned by 7af26482-1e7c-49ef-875e-6deb430df8c7; B17 reconstruction proof remains on 8c9b84fc-737e-4d1e-8bca-0d0f847566e6. The following records preserve all remaining move units with their scrub/acceptance requirements. No raw report or data file is moved by this handover.

| Unit | Issue | Destination | Stage |
| --- | --- | --- | --- |
| B05 | 3feb02c5-6399-433e-99db-4c8eb56f78f1 — Planning design pack and owner-vision extract | [`docs/design/planning/`](design/planning/README.md) | 7.1 prep |
| B06 | 271884c2-ab7d-47bd-9cdc-8ffc83b8c3c9 — Landing study: tentative mockup, critique and verdict | [`docs/design/landing-study/`](design/landing-study/README.md) | 7.1 prep |
| B07 | 6f9ec5d8-6705-43b7-a800-c871a445be9f — Visual reference catalog and Forge translation | [`docs/design/references.md`](design/references.md) | 7.1 prep |
| B08 | 56662beb-5918-4d87-a0a7-90249ac80a0f — Marketing scenarios with evidence annotations | [`docs/marketing/scenarios.md`](marketing/scenarios.md) | 6.3 repo hygiene |
| B09 | d8a3d743-c3f7-4421-8e72-61b721c11588 — Gate-parity disposition matrix | [`docs/operations/gate-parity.md`](operations/gate-parity.md) | 6.3 repo hygiene |
| B11 | 31f79d81-1405-421f-a575-5d5afe967dad — Test-suite value method and findings | [`docs/research/test-suite-value.md`](research/test-suite-value.md) | 6.3 repo hygiene |
| B12 | bb5dea3e-83b2-4b3c-933a-824d030c7094 — Structural merge negative result and case summaries | [`docs/research/structural-merge.md`](research/structural-merge.md) | 6.3 repo hygiene |
| B13 | 0ed227d6-a68e-40e8-b83b-dd623564098c — Bet 2 metrics method and denominators | [`docs/research/bet2-metrics.md`](research/bet2-metrics.md) | 6.3 repo hygiene |
| B14 | 868f7c3a-84b1-4117-9814-8418a2b48717 — Observe-only proposal with unapproved choices | [`docs/design/observe-only-proposal.md`](design/observe-only-proposal.md) | 7.1 prep |
| B15 | 92cdb8e9-a408-4c92-a961-9879ca2f93a9 — Historical E1 and E3 full methods | [`docs/research/e1-overlap.md`](research/e1-overlap.md); [`docs/research/e3-failing-burst.md`](research/e3-failing-burst.md) | 6.3 repo hygiene |

Audit friction and historical holding records:

- d56dfe49-4a81-4e4e-8736-7ea1339ad54f: Read-only planning must not rewrite the local address receipt (stage 6.3).
- 41a24da0-fbbc-48d6-993a-9ca428e80f1f: Prune scan without apply must preserve registry state (stage 6.3).
- 2363c256-c5d7-49ee-9dfa-ac8c1cdd3c1b: Old Phase 3 backlog candidates (owner disposition) (stage 8).

The [CLI gap inventory](agents/cli-gaps.md) maps every wrapper behavior to native support or its existing Issue. The [bench recovery recipe](../evals/bench-t3code/README.md) states what is recoverable and what remains unproven. Raw evidence is private, held off-repo by the owner; ask before relying on it.
