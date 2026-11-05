# E1: live overlap-alert replay (historical method, two runs)

Status: **historical experiment, 2026-10-24 and 2026-10-25.** This page carries the full method and denominators behind the E1 summary in [why-forge](../why-forge.md). It is **not** the final multi-agent result: that is the real-agent [B1.5d report](b15d-report.md) (2026-11-04), which replaced the planned E2. E1 was a scratch-owner replay on local, pre-hosted infrastructure with a trusted preset, so its alert and landing numbers describe the product as it was on those two dates. Unfavourable results are kept. Raw cell transcripts, scores and traces are retained privately and are not needed to read this page.

E1 replays an incident: four coding agents edit the same paragraphs of three documentation files while other work is open, then eight Lanes finish at the same moment.

## Verdicts

| Criterion (the review's bar) | 2026-10-24 | 2026-10-25 |
| --- | --- | --- |
| At least 4 of 5 replays deliver an overlap alert to **both** agents before the second save | **5/5, pass** | **2/5, fail** |
| 0 of 40 finishes dropped | **0/40 dropped** (25 accepted, 15 returned a named-file conflict) | **0/40 dropped** (25 accepted, 15 named-file conflicts) |
| 0 `WORK_STALE` visible to agents | **0** (also 0 `WORK_BUSY`) | **0** (also 0 `WORK_BUSY`; finishes 0/0) |
| Overlapping (agent pair, file) combinations alerted while saving | **59/90 (65.6%)** | **90/90 (100.0%)** |
| Combinations whose alert reached both agents' transcripts | **37/90 (41.1%)** | **84/90 (93.3%)** |

The first run passed the review bar narrowly and its coverage beyond the first collision was partial. The second run, after overlap ranking landed, raised save-time coverage by 31 combinations and bilateral coverage by 47 (34.4 and 52.2 percentage points), but **failed the timing bar (2/5)**: in three replays the slower recipient learned of the earliest overlap only in the reply to its own next save. That improvement is the observed combined effect of a newer runtime and a newer seed, not an isolated estimate of ranking alone. The five samples do not establish the cause of the timing difference between builds; the seed and agent behavior also changed.

## Method

**Shared design (both runs).**

- **Seed.** A native import of a fresh read-only clone of the public repository's `main` at a named commit (1,581 files on 2026-10-24; 2,122 files on 2026-10-25). The live project was never opened for writing. Agent sandboxes denied reads of the live workspaces and private folders.
- **Policy.** The trusted preset plus the dogfood project's flags: disjoint fast path, integration preview, automatic Lane updates, complete-on-accept, clean regenerable copies. No hosted binding, GitHub mirror, automatic exchange or remote runner.
- **Check.** A local `verify` that fails if any of the three documents contains conflict markers, then sleeps 3 seconds. It is the benchmark check, not the Forge test suite. Main was bootstrapped by one trusted finish.
- **Per replay.** An APFS clone of the seed owner; eight Lanes started with an outcome and **no declared scope paths** (as in the incident). Four are coding-agent workers (slices R1, R4, R5, R7); four are scripted disjoint Lanes that each append one line to a different document and checkpoint once. Each of the 6 worker pairs overlaps in each of 3 files, so there are **18 combinations per replay and 90 over five replays**.
- **Agents.** Four concurrent runs of a coding-agent CLI (reasoning effort medium, user config and rules ignored, MCP disabled), each under a sandbox profile that allows writes only to its replay directory and tool caches. Each agent received the same prompt with its own tag. The prompt (not reproduced here) asks it to rewrite the same few sentences and paragraphs in the three documents, checkpoint after each document, follow the repository's AGENTS.md, **not** finish, and not run tests. Agents were **not told to look for overlap alerts**.
- **Finishes.** After all four agents exit, eight concurrent `finish {laneId, message, accept:true, operationId}` calls play the lead.
- **Instrumentation.** A pass-through `nforge` shim records every call's arguments, timing and output; agent output is timestamped per event on receipt; the source of truth for alerts is the owner's overlap journal (notice id, pair, file, regions, creation time).
- **Definitions.** *Overlapping save*: a moved checkpoint that created a journal notice or printed a high-overlap line. *Alert delivered into transcript*: the first command output in that agent's transcript that contains the notice id, or an overlap line naming the file and the peer's short Lane id. *First overlapping save*: creation time of the replay's earliest worker-pair notice. *Second save*: the next checkpoint (by either member of that pair) after it, measured at its **start** in the second run. *Dropped*: a finish that neither accepted nor returned a terminal conflict naming files. Negative delivery latency means an earlier live-path overlap signal existed.
- **Main audit.** After each replay, accepted `main` was read through `show` to confirm every accepted Lane's tag or line is present, no non-accepted Lane leaked, and no conflict markers exist (5/5 audits passed in each run).

**Differences between the runs.** Runtime: pinned build "d57" on 2026-10-24, "d59" on 2026-10-25 (both CLI 0.3.0). Seed: an earlier mirror commit against the then-current `main`. The only prompt change was a heading rename in the roadmap (the paragraph under it became the goal paragraph); anchors for the other paragraphs still existed. All five harness files were reused with directory substitutions only. A pilot replay `r0` in the first run is **excluded** (its analyzer was written after seeing it); its results matched r1–r5.

## Raw table, 2026-10-24 (r1–r5)

| Replay | Saves | Overlapping saves | Alerts raised | Alerts / overlapping save | Both before second save | Pair×file alerted at save time | Pair×file delivered to both | Finishes accepted / conflict / dropped |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| r1 | 12 | 11 | 24 | 2.18 | yes | 18/18 | 11/18 | 5/3/0 |
| r2 | 12 | 9 | 12 | 1.33 | yes | 7/18 | 6/18 | 5/3/0 |
| r3 | 12 | 11 | 20 | 1.82 | yes | 11/18 | 8/18 | 5/3/0 |
| r4 | 12 | 11 | 20 | 1.82 | yes | 15/18 | 7/18 | 5/3/0 |
| r5 | 12 | 11 | 12 | 1.09 | yes | 8/18 | 5/18 | 5/3/0 |
| **Total** | 60 | 53 | 88 | 1.66 | **5/5** | **59/90** | **37/90** | **25/15/0** |

First overlap came 11.0–17.3 s after the first save; delivery after it had a median of about 1.0 s (maximum 11.5 s); time to the second save was 9.6–19.2 s.

## Raw table, 2026-10-25 (r1–r5)

| Replay | Saves | Overlapping saves | Alerts raised | Alerts / overlapping save | Both before second save | Pair×file alerted at save time | Pair×file delivered to both | Finishes accepted / conflict / dropped |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| r1 | 12 | 12 | 24 | 2.00 | yes | 18/18 | 18/18 | 5/3/0 |
| r2 | 12 | 11 | 24 | 2.18 | yes | 18/18 | 18/18 | 5/3/0 |
| r3 | 12 | 11 | 24 | 2.18 | **no** | 18/18 | 18/18 | 5/3/0 |
| r4 | 12 | 11 | 24 | 2.18 | **no** | 18/18 | 15/18 | 5/3/0 |
| r5 | 12 | 11 | 24 | 2.18 | **no** | 18/18 | 15/18 | 5/3/0 |
| **Total** | 60 | 56 | 120 | 2.14 | **2/5** | **90/90** | **84/90** | **25/15/0** |

Delivery after the first overlapping save had a median of 0.19 s and a maximum of 5.09 s. Missed deadlines: r3 (next save began 3.54 s after the overlap; one recipient took 5.09 s), r4 (1.06 s; 2.54 s), r5 (2.09 s; 3.95 s). In all three the slower recipient learned of the overlap in the response to its own next checkpoint, so under the unchanged method these are **real misses** even though the alert was delivered.

## Other observations

- **The 15 conflicts per run are genuine same-line rewrites.** All four agents rewrote the same sentences, so once the first worker lands the other three cannot merge, and pure-insert Markdown resolution correctly does not apply. Each conflict returned a terminal sync-phase conflict naming all three files; all four disjoint Lanes accepted in every replay; the audits found no markers and nothing lost.
- **Agents read the alerts.** In the first run each agent called `peers` 1–2 times because AGENTS.md says to read peers before editing; every final summary mentioned overlap. In the second run all 20 final summaries mentioned overlap. Agents took roughly 38–122 s.
- **Finish wall time.** First run, eight Lanes with a 3 s check: min 59–90 s, median 103–164 s, maximum 112–181 s, on a laptop with a 1-minute load average near 23 from other work. Second run: min 15.5–23.9 s, median 24.9–42.7 s, maximum 34.2–50.1 s. These are observations, not a controlled performance comparison.
- **Landing order.** The proposed region owner was the first to land in 2 of 5 replays (first run) and 0 of 5 (second run). With concurrent finishes, the Lane whose check completes first lands.
- **Conflict attribution.** First run: conflict receipts named `main` rather than the Lane that landed. Second run: 15/15 losing-worker receipts included the accepted worker's Lane id in the proposed order. This checks Lane attribution, not a broader UI guarantee.

## Delivery paths and gaps

First run, four gaps behind the partial coverage:

1. **Save-time analysis covered only three peers, chosen by Lane id rather than relevance.** With seven open peers, the three analysis slots often went to disjoint Lanes, and coverage followed Lane-id order exactly (r0 and r1 where the worker Lanes sorted first got 18/18; r2 got 7/18; r5 got 8/18). An overlapping peer could go unwarned depending only on UUID order. The suggested fix, ranking peers by shared paths before the cap, is what the second run exercised.
2. **A compact receipt shows one inbox item plus a "more" count** and at most three stderr lines, so an agent overlapping three peers learned about one or two unless it ran a detailed `peers` read.
3. **Delivery is pull-only.** Notices created by an agent's last save, or during finish, reach a peer only on that peer's next Forge call; agents that had already exited never got them.
4. **The proposed order is not what lands first** (2/5).

Second run: the starvation gap did **not** recur (all 120 worker-pair notices were save-attributed, with disjoint Lanes interleaved in id order). The six missing bilateral deliveries (r4: three pairs involving one worker on one file; r5: three pairs involving another) account for the **entire remaining gap**: the notices were created after that worker's last checkpoint, and its later `handoff` returned no peer digest, so nothing reached its transcript. Finishing by the lead cannot retroactively deliver to an exited worker. First-delivery paths for distinct (pair, file, recipient) combinations were 172 by checkpoint and 2 by `peers`; handoff supplied none.

Compact receipts were sufficient for this workload, which does not establish coverage for larger Lane counts or between-call delivery.

## Not tested, and unrun

- **MCP notifications** were never exercised (MCP disabled); it is unverified whether a non-interactive agent CLI would show them to the model.
- **Declared scope paths**, the designed early signal, were not used; under a literal reading of "before the second save" meaning the save that creates the overlap, only one replay (r4, first run) had any early signal.
- **Idle worker cost.** A first-run side finding (post-accept background workers staying alive 5–38 minutes on idle scratch owners at about 0.3–1.6% CPU each, one presence worker for 50 minutes) was not re-measured in the second run; no conclusion is drawn.
- Larger Lane counts, other models or agents, other file types, and hosted infrastructure were not run.

## Voided and excluded runs

First run: two pilot attempts were **void** (a harness bug that crashed at the first Lane start with no agent run; a sandbox that blocked a process-listing binary, with the agent shell resolving `nforge` to a different install, bypassing the shim; both fixed before r0). The r0 pilot is excluded as above. Second run: none; r1–r5 are all included, with no replacement replay, no sandbox workaround, no Forge behavior change and no model substitution; no finish retries were needed.

## Cost

Agent tokens counted over r1–r5: **6.76 M input (5.93 M cached) and 27.5 k output** (first run; about 8.1 M and 33 k including pilot and probes) and **5.37 M input (4.58 M cached) and 29.0 k output** (second run). Dollar cost was not measured in the second run; the first run's rough API-equivalent was a few dollars on assumed list rates. Checks ran locally; no hosted, GitHub-write or compute-service activity.

## Limits

n = 5 replays per run, one day each, one seed each, one agent configuration, a trusted preset and a local owner. The review bar's wording ("before the second save") is ambiguous, and the two runs differ in build, seed and agent behavior. E1 says nothing about token or time advantage over plain Git for a single agent, and nothing about coordination quality in real multi-task work; see the [B1.5d report](b15d-report.md) and its coordination section for those.
