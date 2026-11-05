# Bet 2 re-measure after admission D and E (2026-10-31): method and denominators

Status: **historical measurement, small sample, low load.** The short summary is in the [Phase 5 plan](../phase5-plan.md) ("Bet 2 re-measure after admission D and E"); this page carries the full method, windows, denominators and the places the data is blind. It is read-only evidence of retained records. **It is not proof of the 40-landing, comparable-load acceptance bar:** 14 landings at a load 3.5× lower than the baseline cannot stand in for that bar, and the Bet 2 target of a finish-to-main p50 under 3 minutes was **not met** (12.5 minutes measured). For any new claim use the [interleaved-pairs method](../agents/perf-claims.md), not this single before/after comparison.

## 1. Answer first

On the same reader and the same method, 14 landings after change E look much better than the 24-hour baseline, but the sample is small and the load fell with it.

| Metric | Baseline | After E | Direction |
| --- | ---: | ---: | --- |
| First-try rate | 16 of 59 = **27.1%** | 10 of 14 = **71.4%** | up (95% Wilson interval: baseline 17–40%, after 45–88%) |
| Full checks per landing | **5.46** (322 / 59) | **1.29** (18 / 14) | down 4.2× |
| Main-race attempt-minutes | **4,003** (179 attempts) | **38** (5 attempts) | down 99% |
| Finish-to-main p50 / p90 | **23.5 / 67.8 min** | **12.5 / 22.4 min** | down about 3× at p90 |
| Cancels (waste cause `cancel`) | **73 attempts, 1,189 min** | **0** | to zero; the cause of the old ones is unknown |

Three things stop this being a clean win claim:

1. **Load dropped 3.5×** (2.46 to 0.70 landings per hour; the after window included a Saturday with fewer builders). Races need concurrency, so part of the fall in main-race minutes is simply fewer overlapping submissions. The reader cannot replay the baseline load.
2. **n = 14, against the 40 an earlier review asked for.** Rates carry roughly ±20 points.
3. **The changes are not isolated.** The span also contains finish-freeze with READY-first dispatch, the contract gate, change E (scoped intersection recheck), change D, and a shard-balancing slice. A middle "interim" column separates what was in before E (section 3). The reader has no per-change attribution.

## 2. Windows and method

- **Reader.** The project's self-metrics reader (`nforge metrics ROOT --from … --to … --json`), which reads retained records and includes the waste and path streams. An older build reports every landing as `unknown`, so the right build matters. The numbers here came from a CLI build that has since been deleted as stale; it was a reader of retained records, not the product under test, and its commit was not recorded. A baseline classification cross-check and independently recomputed p50 values support keeping the numbers with their limits (n = 14, lower load, incomplete history). This page is **not** a fresh re-measure and does not prove the old reader had no bugs. **For any new measurement, run `nforge metrics` on the one current CLI and record that CLI's commit.**
- **Baseline window:** 2026-10-29T11:00:00Z to 2026-10-30T11:00:00Z (24.0 h, 59 landings). Re-run later with a newer reader, its path classification matched the stored baseline exactly (59 landings; 12 first-try plus 4).
- **After window:** change E landed at 2026-10-30T23:40:25.863Z (read from the landed attempt's `committedAt`). Window 2026-10-30T23:40:26Z to 2026-10-31T19:44:10Z (20.1 h), so E's own landing is excluded. Change D landed 2026-10-31T02:24:52.356Z; **"after D"** is 02:24:53Z to 19:44:10Z (17.3 h).
- **Interim window:** 2026-10-30T11:00:00Z to 23:40:26Z (12.7 h): finish-freeze and the contract gate in, E and D not.
- **p90 and terminal codes** were recomputed from the landing-attempt table (submitted time to committed time, landed attempts only; 673 rows, the whole table, read-only), because the reader prints only p50. The recomputed p50 equals the reader's for baseline (23.45) and interim (57.6) and differs by 0.1 min after E (12.6 against 12.5). The p90 values are the author's, not the reader's.

## 3. Before and after, same method

| Metric | Baseline | Interim | After E | After D |
| --- | ---: | ---: | ---: | ---: |
| Window | 24.0 h | 12.7 h | 20.1 h | 17.3 h |
| Landings | 59 | 27 | 14 | 10 |
| Landings per hour | 2.46 | 2.13 | 0.70 | 0.58 |
| Path: first-try / after-retry / after-fixer / unknown | 16 / 27 / 15 / 1 | 1 / 21 / 5 / 0 | 10 / 3 / 1 / 0 | 7 / 2 / 1 / 0 |
| **First-try rate** | **27.1%** | 3.7% | **71.4%** | 70.0% |
| After-fixer share | 25.4% | 18.5% | 7.1% | 10.0% |
| Settled attempts per landing | 8.1 | 4.0 | 2.5 | 2.6 |
| Full checks started (runs) | 322 | 48 | 18 | 14 |
| **Checks per landing** | **5.46** | 1.78 | **1.29** | 1.40 |
| Check wall-minutes per landing | 108.6 | 19.2 | 12.4 | 13.2 |
| Wall-minutes per check run | 19.9 | 10.8 | 9.7 | 9.4 |
| **Main-race attempts** | 179 | 30 | **5** | 4 |
| **Main-race attempt-minutes (elapsed)** | **4,003.1** | 1,587.2 | **38.2** | 38.2 |
| Main-race minutes per landing | 67.8 | 58.8 | 2.7 | 3.8 |
| Main-race re-check runs (scoped / total) | 0 / 147 | 0 / 21 | 1 / 1 | 1 / 1 |
| **Finish-to-main p50** (reader) | **23.5 min** | 57.6 | **12.5** | 12.6 |
| **Finish-to-main p90** (recomputed) | **67.8 min** | 121.0 | **22.4** | 24.1 |
| Runner-minutes (discarded-passed plus all) | unknown (322 runs) | 788.5, 35 runs unknown | 1,028.0, 0 unknown | 788.0, 0 unknown |
| Runner-minutes per landing | unknown | partial | 73.4 | 78.8 |
| Interventions (reader 5.5; partial in baseline) | 132 (2.24 per landing) | 29 | 8 (0.57 per landing) | 7 |

Other waste, attempts / elapsed minutes (elapsed minutes overlap in wall-clock and are neither runner nor billing minutes):

| Cause | Baseline | Interim | After E |
| --- | ---: | ---: | ---: |
| cancel | 73 / 1,188.6 | 1 / 100.1 | 0 / 0 |
| check-failed | 70 / 1,108.1 | 31 / 801.3 | 4 / 27.4 |
| conflict | 48 / 127.8 | 2 / 3.0 | 1 / 1.8 |
| supersede | 9 / 233.4 | 0 / 0 | 0 / 0 |
| stall | 2 / 785.6 | 0 / 0 | 0 / 0 |
| flake (explicit) | 0 | 2 / 11.7 | 0 |

**Reading the interim column.** The contract gate and finish-freeze were in; E and D were not. First-try was 3.7% (1 of 27), main races were 30 for 27 landings, and p50 was 57.6 minutes (the worst of the four). The collapse in main-race minutes, retries and p50 arrives in the window after E, and D adds nothing visible on top. This is consistent with "E (scoped recheck) removed the main-race cost", **not proof**. The interim p50 is worse than baseline and is unexplained; its terminal codes include 21 `ATTEMPT_REPLACED`, 12 `BATCH_FALLBACK` (batch and admission activity) and 16 `CHECK_FAILED`.

Landing-quality notes, after E:

- 5 main-race attempts, 38.2 minutes. One of them (6.3 min) settled at the instant E itself landed. Four came in two bursts when two or more submissions were in flight.
- 13 `ATTEMPT_REPLACED` attempts ("a named child or check binding replaced this attempt"): 50 minutes total, about 3.8 min each, mostly 1.5–1.8 min after submit and followed by a landing. The reader does not count them as waste; they look like the admission step doing its job.
- The earlier memo's **diminishing-returns test**: checks per landing at most 1.3 (met, narrowly at 1.29), discarded passes about zero (nearly met: 1 run, 62.4 runner-minutes), and p50 within 2 minutes of one check's wall time (not met: 12.5 against a 9.7-minute mean per run, a 2.8-minute gap; the mean is used because the median per-run wall time is not reported).

## 4. Cancels by cause

| | Baseline | After E |
| --- | ---: | ---: |
| Reader cause `cancel` (attempts / elapsed min) | 73 / 1,188.6 | 0 / 0 |
| Terminal `LANDING_CANCELLED` attempts (settled in window) | 48 | **0** |
| Other terminal codes (settled in window) | `CHANNEL_CHANGED` 302, `CHECK_FAILED` 38, `COMPOSITION_CONFLICT` 25, `LANDING_SUPERSEDED` 4, `ATTEMPT_REPLACED` 2, `CHECK_NOT_PASSED` 1 | `ATTEMPT_REPLACED` 13, `CHANNEL_CHANGED` 5, `CHECK_FAILED` 2, `COMPOSITION_CONFLICT` 1 |

**The cause of the cancels (who cancelled or why) is unknown** for both periods. The attempt row stores only the code and a fixed text; no requester or reason is recorded, and reader 5.5 reports interventions by actor only. The baseline's 132 interventions are marked partial because owner mutations (cancel, retry, restart) were not recorded then; after E the reader marks 5.5 complete (8 interventions). The two periods are not the same measurement, so they are not compared as a rate.

## 5. Where the data is blind

| Item | Status | Why |
| --- | --- | --- |
| Per-actor first-check failure rate p | **Unknown** | Every submission came from one account; agents are not separate actors in the records. Only the pooled first-try rate exists. |
| Baseline runner-minutes and runner-minutes per landing | **Unknown** | All 322 baseline runs lack shard execution durations (durations began with a later writer slice). After E: 1,028 minutes known, 0 unknown runs. Cost cannot be compared before and after, only wall time (6,408 to 174 min) and check count (322 to 18). |
| Discarded-passed runner-minutes before | **Unknown** (0 recorded, 154 runs unknown) | Same cause. |
| Main-race effect at equal load | **Unknown** | Load fell 3.5× and there is no replay. For scale, the busiest six hours had 26 landings and 267 attempts submitted in the baseline against 8 landings and 21 submitted after. |
| Contribution of D alone | **Unknown** | D landed 2 h 44 min after E; only 10 landings follow it. |
| Cancel cause (who or why) | **Unknown** | Not recorded; see section 4. |
| Caller-visible finish errors (reader 5.2) | Not comparable | Baseline is null (receipts not recorded then); after E, 21 finishes with 18 errors (`OVERLAP_UNANSWERED` 8, `CHECK_FAILED` 2, `PREFLIGHT_REQUIRED` 2, `WORK_OPERATION_CHANGED` 2, `WORK_STALE` 2, `COMPOSITION_CONFLICT` 1, `WORK_CONFLICT` 1). 18 of 21 is a first reading, not a trend. |
| Overlap delivery and acknowledgement (5.4) | Unknown in both | Historical saves and first-write events were not uniformly recorded; after-E rows are empty. |
| Reuse rate (5.6) | 0 reused, 0 missed in both | Most runs have no complete reuse key; this is not evidence of no reuse opportunity. |
| Cost (5.8), red-`main` minutes (R), hosted bytes | Partial or unknown | No provider bills entered; R and bytes need write-side accounting that did not exist yet. |
| Classification count differences | Open | The reader's `check-failed` waste is 70 (baseline) and 4 (after) attempts, against 38 and 2 terminal `CHECK_FAILED` codes. The reader's cause rules were not reconciled with raw codes. |

The reader's own caveat applies to every first-try number: classification "reads 30 days of pre-window context; older submission/save history and changes during live pagination can leave ordering incomplete". The baseline also has one landing the reader cannot classify.

## 6. What this implies

1. **Keep measuring to 40 landings** at a comparable load before treating the first-try, checks-per-landing and main-race figures as accepted. At the after-E rate (0.7 landings per hour) that is about 37 more hours; at a busy day's rate, a few hours.
2. **Record the requester and reason on cancel** and tag each submission with its Lane or agent, so cancel cause and per-agent p become measurable.
3. **Compare at equal load** once a busy window recurs: take the busiest six hours of the new period and set them beside the baseline's peak.

## 7. Reproducing it

Run the current CLI's reader once per window, with `--json`, and record the CLI commit used:

```sh
nforge metrics ROOT --from 2026-10-29T11:00:00.000Z --to 2026-10-30T11:00:00.000Z --json   # baseline
nforge metrics ROOT --from 2026-10-30T11:00:00.000Z --to 2026-10-30T23:40:26.000Z --json   # interim
nforge metrics ROOT --from 2026-10-30T23:40:26.000Z --to 2026-10-31T19:44:10.000Z --json   # after E
nforge metrics ROOT --from 2026-10-31T02:24:53.000Z --to 2026-10-31T19:44:10.000Z --json   # after D
```

`ROOT` is a hosted checkout of the project measured. The records are retained project data and the raw reader output is private; the windows above and the denominators in this page are what a re-run must reproduce. The p90 and terminal-code tables need a read-only pass over the project's landing-attempt rows (submitted to committed, landed attempts only). Because the reader build used here is gone, a new run is a new measurement, not a replay of this one.
