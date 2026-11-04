# Phase 6 lead plan

Read this plan, the [lead rules](agents/lead.md), [Phase 5 close](phase5-close.md), [roadmap](roadmap.md) and the full linked Forge planning Issues. The roadmap is the authority for current stage names; historical drafts and old Issue stage labels are superseded. Phase 5 is closed. Phase 6 makes it solid; Phase 7 is the public beta; Phase 8 is growth. No outside-user count is a Phase 6 exit.

## Stage map

**Exit:** bugs and friction filed before the exit-bench plan (8c9b84fc) is frozen are fixed or dropped by the owner, none silently deferred. After that freeze, only core-claim or severe bugs block exit. A repeat of the B1.5d benchmark shows the conflict-recovery loss fixed and no regression; idle Convex stays at 0 calls. Billed Convex dollars per accepted landing over at least 200 dogfood landings are about $0.002 or less, with a $0.001 stretch target (9db58ca6); attribution comes before optimization.

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
- **6.3 Every friction and bug.** Cluster triage sets the work, then builders fix it in parallel batches or the owner drops it, under the exit freeze rule above. It replaces the pending owner friction-triage session. Issues are measured or tested now, or dropped; none wait for an arbitrary count. 82e8ddb8 is reshaped on that basis.
- **6.4 Cost and agent surface.** Attribute billed Convex cost before optimizing toward the agreed exit target above, in-Convex first; any hosted worker or vendor comes with a monthly cost estimate and owner approval first. The agent context budget, CLI verbs V2b and V3 (alias removal, CLI generated from the MCP surface), Lane undo (e7812d8f), and enforced trust per path per actor. Lane undo and clone refresh (73ed4d28) stay in Phase 6 as core source-host behaviour.
- **6.5 Engineering health**: a codebase health pass, mechanical guards for repeat bug classes, a TLA+ model of the landing queue and a real-user scenario matrix.
- **In parallel, no product changes**: art direction, the design system and mockups for the Phase 7 design pass.

## Agreed start order

Only **6.1 is ordered**. Cluster triage sets the later sequence, not a fixed order for all remaining Issues. Bench-harness fixes d8cf81b4, 02ee5788, 108a4883 and 97c7a123 land before the exit-bench plan (8c9b84fc) is frozen.

1. Fix weekly backup `WORK_INDEX_UNAVAILABLE`: 13402039-0e4c-44dd-915a-e4e03827f285.
2. P1 legacy storage: 40dad5e0-24e4-4dbb-82b3-58ce83fde1ee with 8678148e-d246-4f05-aaca-6edc8fcddc14. About 2.5 GB remains in legacy Convex file storage; 1.93 GB is R2 duplicates, the remainder unclassified. A read-only audit comes first. Follow [backup and cleanup preconditions](operations/legacy-storage-cleanup.md).
3. Clone refresh from Forge main: 73ed4d28-8340-4a65-b363-a946da9b8105; portable CLI updater: 7af26482-1e7c-49ef-875e-6deb430df8c7. These remove the last GitHub-mirror and off-repo tool dependencies; the docs handover alone does not remove them.
4. Authority watch 02bcad74-09fe-4f46-ae86-c17b06baf0d1, idle polling 59bb75f3-8964-4377-969d-116e58b18030, then B1.9 64d7192b-4de7-4da8-9f4c-3c7231d2eae9. Its gate is backup fix 13402039 with failure notification proven, plus one manually verified backup; the two-weekly-backups wait is dropped.
5. Use the cluster triage held on 2026-11-04 in place of the pending owner friction triage. Merge duplicate groups in planning, retaining abandoned records that point to their merge target.
6. Attribute Convex cost under 9db58ca6-1bc3-4cac-8786-2c6f5e515c21 before optimization, using the agreed billed-dollar target and at least 200 accepted dogfood landings.
7. Then 6.2: conflict recovery 36a087ea-e1df-4120-8fac-08a8f85b7bdb, notice precision ee9d5738-0272-4cb4-b03c-ca35b34966ee before push delivery 11ba7bb9-bca1-4251-ad5a-cca9243b6add, sync apply blocked by ignored build outputs 1ad05526-bc33-4b17-a90d-7f31e94b7164, no-dead-ends d910db6b and the remaining contention work.

The cluster triage and numeric cost target are agreed. Phase 7 production, publication, spend and outside-user decisions remain separately owner-gated.

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

- Two-way GitHub sync 27e13362-bb4b-4eba-bb16-22cda0bd6942 still says **OPEN DESIGN** for inbound failure, although the Phase 7 overview says decided. Branch protection, revert and divergence remain unselected options. Neither overview wording nor this handover authorizes enforcement.
- Old stage titles in Issue bodies lose to the current roadmap/parent and dated notes. Do not restore friends or production into Phase 6 or revive dropped CI adapter breadth.
- Trust thresholds 25/100 were chosen, but enablement still needs score-distribution/latency review on 7f085ec9-38fc-462e-883f-6e724817e09d and 5f673c14-5d50-4ab3-9814-554b303b54c5. This is not authorization to tighten unrelated policy.
- Old Phase 3 candidates are in the Phase 8 holding Issue below, for disposition only. Slack/Netlify-preview/WebMCP/Lakebed and sparse-checkout ideas already have abandoned planning records; they are not missing active commitments. Early no-custom-field language predates the later arbitrary-field planning vision.
- Old local lead/preamble/common rules contain obsolete stop-before-finish, model routing, fixed test caps and all-overlap instructions. Current repo self-finish, profile and blocking/advisory rules win; use the [portable brief](agents/brief-template.md).

## Read planning from a fresh checkout

From your checkout root (verified on 2026-11-04):

```sh
nforge agent . planning '{"reconcile":false,"limit":100}'
nforge agent . planning '{"reconcile":false,"limit":100,"cursor":"RETURNED_NEXT_CURSOR"}'
nforge agent . planning '{"reconcile":false,"id":"FULL_ISSUE_UUID"}'
```

Always pass `reconcile:false` on reads. The list returns `items` and **`nextCursor`**; pass that value as **`cursor`** until `nextCursor` is null. Filters apply within scanned pages. A list body can be truncated (`bodyTruncated:true`); read by full id before relying on acceptance or replacing it. The detail read returns the full body and the newest 50 comments. See the [planning contract](agents/workflow.md#the-backlog-is-forge-planning).

Writes require full UUIDs and the observed `expectedVersion`. A put replaces the whole item: retain the full title/body/status/Intent links/Initiative, use `expectedVersion:0` to create, and never replace from a truncated list summary. Comments append via `text`. Give each mutation an operation UUID, retain its exact request, and replay that request after an unknown outcome. `PLANNING_CHANGED` requires a fresh full read and reconciliation; do not overwrite concurrent work. Reads and writes need current authority; no extra setup or index repair is implied here.

## Remaining phase-folder extraction Issues

This Lane extracts B01, B03, B04, B10, B16 and B17's recovery steps. B02 is already owned by 7af26482-1e7c-49ef-875e-6deb430df8c7; B17 reconstruction proof remains on 8c9b84fc-737e-4d1e-8bca-0d0f847566e6. The following records preserve all remaining move units with their scrub/acceptance requirements. No raw report or data file is moved by this handover.

| Unit | Issue | Destination | Stage |
| --- | --- | --- | --- |
| B05 | 3feb02c5-6399-433e-99db-4c8eb56f78f1 — Planning design pack and owner-vision extract | `docs/design/planning/` | 7.1 prep |
| B06 | 271884c2-ab7d-47bd-9cdc-8ffc83b8c3c9 — Landing study: tentative mockup, critique and verdict | `docs/design/landing-study/` | 7.1 prep |
| B07 | 6f9ec5d8-6705-43b7-a800-c871a445be9f — Visual reference catalog and Forge translation | `docs/design/references.md` | 7.1 prep |
| B08 | 56662beb-5918-4d87-a0a7-90249ac80a0f — Marketing scenarios with evidence annotations | `docs/marketing/scenarios.md` | 6.3 repo hygiene |
| B09 | d8a3d743-c3f7-4421-8e72-61b721c11588 — Gate-parity disposition matrix | `docs/operations/gate-parity.md` | 6.3 repo hygiene |
| B11 | 31f79d81-1405-421f-a575-5d5afe967dad — Test-suite value method and findings | `docs/research/test-suite-value.md` | 6.3 repo hygiene |
| B12 | bb5dea3e-83b2-4b3c-933a-824d030c7094 — Structural merge negative result and case summaries | `docs/research/structural-merge.md` | 6.3 repo hygiene |
| B13 | 0ed227d6-a68e-40e8-b83b-dd623564098c — Bet 2 metrics method and denominators | `docs/research/bet2-metrics.md` | 6.3 repo hygiene |
| B14 | 868f7c3a-84b1-4117-9814-8418a2b48717 — Observe-only proposal with unapproved choices | `docs/design/observe-only-proposal.md` | 7.1 prep |
| B15 | 92cdb8e9-a408-4c92-a961-9879ca2f93a9 — Historical E1 and E3 full methods | `docs/research/e1-overlap.md; docs/research/e3-failing-burst.md` | 6.3 repo hygiene |

Audit friction and historical holding records:

- d56dfe49-4a81-4e4e-8736-7ea1339ad54f: Read-only planning must not rewrite the local address receipt (stage 6.3).
- 41a24da0-fbbc-48d6-993a-9ca428e80f1f: Prune scan without apply must preserve registry state (stage 6.3).
- 2363c256-c5d7-49ee-9dfa-ac8c1cdd3c1b: Old Phase 3 backlog candidates (owner disposition) (stage 8).

The [CLI gap inventory](agents/cli-gaps.md) maps every wrapper behavior to native support or its existing Issue. The [bench recovery recipe](../evals/bench-t3code/README.md) states what is recoverable and what remains unproven. Raw evidence is private, held off-repo by the owner; ask before relying on it.
