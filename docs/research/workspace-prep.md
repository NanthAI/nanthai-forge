# Workspace prep: retained evidence and remaining attribution

The matched 29,000-file synthetic A/B does not reproduce a current-CLI
slowdown: 11 valid interleaved pairs put current start/open prep **6.982 s
faster**, with a paired 95% bootstrap interval **[−9.875, −5.120] s**.
This is a comparison of two frozen CLIs on one synthetic workload, not the
next smoke or proof that load alone caused the historical +4.4 s.
Historical startup/RPC/swap clocks cannot be reconstructed. The Issue remains
open for its missing historical evidence and the authorized next smoke.

This analysis owns the increase against B1.5d
([c83c4451][prep]), while the remaining absolute gap to GitHub belongs to
[a245bcf0][gap]. It does not replace either Issue's acceptance contract.

## Matched CLI A/B

[Complete observations and calculation inputs](../../evals/workspace-prep-ab-results.json)
retain every process, HTTP attempt, phase, pressure sample, void and replacement.
A is B1.5d Git `0383f90dbba51600c921cd19ac5014f17fdb2d35`; B is hosted main
at work start, State `6d15c8d512b3830c84789617fd95ea9a8af92136ca0f90665d81df7d90a2b4f9`.
Both built with their own pinned lockfiles on Node 24.22.1. Source and dependency
pins stayed fixed. One dev-only fixture has 29,000 unique 4 KiB regular files
(118,784,000 source bytes) in 29 directories: each file is an ordinal header
followed by repeats of that ordinal's SHA-256 hexadecimal digest, truncated to
4 KiB. Its exact State is
`d3b9151ba40f90a33d443c60d5ae8dbddcc0fb46a568db2026c5c67d37239a77`.

The driver is `scripts/measure-workspace-prep.mjs`, with the same opt-in
`workspace-prep-trace.mjs` observer in both builds. Disposable compiled files
receive only startup/write-wait callbacks; before/after hashes are retained.
Each run executes `start {open:false}` then `open` in separate processes,
with an explicit frozen-build canary pin and no release update. Startup is the
process monotonic origin through hosted CLI dispatch, including imports and
local discovery. RPC walls in this A/B are individual HTTP attempts through
body consumption, not server time or SDK decode time. Parent process walls
exclude pressure sampling, fixture preparation, verification and cleanup.
Every completed tree was checked against all source hashes, modes and the same
State pin. All **34 opens** passed; none failed or silently changed source.

Cold means an empty machine-object cache per open, not a flushed OS page cache.
Warm means independent cached objects cloned from the same fixture before the
sequence. The 3,211,540-byte source pack is the same for both builds. The
fixture has no dependencies, hooks, submodules, model agents or landing work;
those parts of full smoke prep are not simulated. Warm-up and setup are outside
the measured windows. Builds, fixtures and test batches used the shared heavy
limiter; each measured process checked the brief's disk reserve.

The initial ABAB sequence ran 11 pairs, alternating cold/warm. A successful
dev deployment workflow (`42997254381`, `d84c5fca`) ran 09:41:12–09:42:18 UTC.
Initial pairs **6 cold, 7 warm and 8 cold** overlap that conservative window
and are void for revision drift, despite successful byte checks. Their values
remain below and in the data. Three replacement pairs used those same cache
modes, preserving 11 valid pairs (6 cold, 5 warm). The initial accepted backend
was `e7f64079`; the latest successful backend for the replacements was
`d84c5fca`. Failed deployment `42998296222` finished at 09:49:24, before the
first replacement at 09:49:34; it reported schema failure and no successful
push. There was no deployment workflow overlapping a replacement pair.
Runtime versions are workflow evidence, not a direct server build attestation.
The initial measurement window was 09:35:39–09:46:16 UTC; replacements ended
09:52:48. Total: 34 start/open runs, 68 measured CLI processes.

| Pair | Cache | A prep s | B prep s | B − A s | Use |
| --- | --- | ---: | ---: | ---: | --- |
| 0 | cold | 31.966 | 24.984 | -6.982 | valid |
| 1 | warm | 13.644 | 7.726 | -5.918 | valid |
| 2 | cold | 31.248 | 23.801 | -7.446 | valid |
| 3 | warm | 12.413 | 7.449 | -4.963 | valid |
| 4 | cold | 28.889 | 23.769 | -5.120 | valid |
| 5 | warm | 13.048 | 7.105 | -5.943 | valid |
| 6 | cold | 28.935 | 24.321 | -4.614 | void: deployment |
| 7 | warm | 13.143 | 7.090 | -6.054 | void: deployment |
| 8 | cold | 35.256 | 25.883 | -9.373 | void: deployment |
| 9 | warm | 18.329 | 7.770 | -10.559 | valid |
| 10 | cold | 32.696 | 23.840 | -8.856 | valid |
| 6R | cold | 43.248 | 26.203 | -17.045 | valid |
| 7R | warm | 18.542 | 8.667 | -9.875 | valid |
| 8R | cold | 33.042 | 28.468 | -4.575 | valid |

The [adopted method](../agents/perf-claims.md) uses 10,000 resamples and seed 1.
These are median **paired** differences; subtracting separate medians produces
a different number. Cache-stratified N=6/N=5 intervals are small-sample
observations. The combined interval covers the registered mix of cache modes,
not the distribution of a real smoke. It does not cover different source
sizes, dependency/link work, model dispatch, observer overhead, backend
interactions across epochs or unmeasured changes in machine conditions.

| Component | A median s | B median s | Paired difference s | 95% interval s |
| --- | ---: | ---: | ---: | --- |
| Start + open | 28.889 | 23.769 | -6.982 | [-9.875, -5.120] |
| Start process | 2.257 | 1.498 | -0.684 | [-0.908, -0.435] |
| Open process | 26.796 | 22.038 | -5.975 | [-8.737, -4.602] |
| Startup, both processes | 1.475 | 0.426 | -1.010 | [-1.374, -0.918] |
| Checkout core | 25.908 | 21.204 | -5.824 | [-7.920, -4.483] |
| HTTP source-body spans, summed | 1.703 | 1.550 | +0.000 | [-0.453, +0.000] |
| Cache verification/fill, inclusive | 19.686 | 16.190 | -4.226 | [-4.728, -3.905] |
| Copy/hash | 4.108 | 4.246 | +0.145 | [-0.287, +0.376] |
| Durability | 1.076 | 0.000 | -1.076 | [-1.309, -0.958] |
| Stat index | 0.110 | 0.125 | +0.022 | [+0.005, +0.043] |
| Publication | 0.066 | 0.077 | +0.012 | [+0.005, +0.014] |

Warm prep medians are **13.644 / 7.726 s**, paired difference −5.943 s
[−10.559, −4.963], N=5. Cold prep medians are **32.331 / 24.412 s**, paired
difference −7.214 s [−12.950, −4.847], N=6. Neither is a full-smoke result.
Cache work and startup are smaller in current. Copy/hash is not distinguishable
from no change. Indexing and publication have positive paired shifts of about
22 and 12 ms. These small phase associations remain disclosed: the stat-index
loop is identical in the two builds, publication gained preservation/recovery
bookkeeping, and this experiment does not isolate a generic defect behind those
shifts. They cannot account for the historical +4.4 s. No speculative runtime
optimization or component-fix guard is claimed for them.

### Concurrent opens and the write pass

One three-open warm cohort per build ran after the initial sequence, on the
same settled deployment. These are observations, not interleaved cohort pairs.

| Build | Open completion order s | Shared write-pass wait s | Total worker + write wait s |
| --- | --- | --- | --- |
| B1.5d | 13.774 / 33.992 / 51.093 | 0.001 / 5.707 / 23.162 | 0.878 / 8.125 / 27.367 |
| Current | 7.229 / 15.892 / 20.006 | 0.002 / 5.049 / 10.498 | 0.056 / 5.143 / 10.573 |

**Both builds already have the shared single write-pass lease.** Current did
not introduce it. Source inspection names `withCheckoutWritePass` in each pin;
the identical callback probe measures only that lease's admission wait, while
`slotWait` also includes worker stalls. The later old completions additionally
spent 13.967 / 12.619 s in durability; current's whole-stage durability phase
is zero. Cohort load was 9.33 for A and 7.32 for B, so the cohort wall difference
is not claimed as a causal concurrency speed-up. Existing qualification found
three overlapping APFS passes worse; this run supplies no reason to expand
concurrency or remove correctness barriers. No concurrency policy changed.

### Calls, bytes, load and pressure

Warm start/open totals are exactly **7 / 5 client RPCs** (A/B), with **0 source
GETs and 0 source-body bytes**. The core warm selection counts are **2 / 1**.
Cold totals range **63–64 / 46–47**, with exactly **17 source GETs and
7,606,875 source-body bytes per open in both builds**. The per-attempt RPC names,
walls, request/response body bytes and statuses are retained in the data; these
are actual client HTTP attempts, not inferred per-task shares of a whole cell.
The complete State descriptor is a recipe; the sampled source blob is R2.
Source bytes remain in R2 and metadata in Convex. These observations are not
provider-billed R2 traffic or TLS/header bytes.

Both provider log windows were live-proven and valid, with no coverage problem:
**1,061 project executions**, 4,622 documents read, 277 written, 2,757,201 DB
read bytes, 310,760 DB write bytes and 231,046 function egress bytes. The helper's
list-rate estimate is **$0.003686**, excluding R2 and storage; no invoice was
read. Totals include probes, voids, cohorts and replacements and cannot be
divided into a per-task bill. No monetary saving is claimed. Fixture seeding
(30,156 uploaded objects / 132,466,663 bytes) and source-pack publication are
outside those windows and outside prep time.

Every start/open retains all three load averages, free RAM, swap and VM
compressor/pageout/swap counters immediately before and after; process peak RSS
comes from `resourceUsage`. Initial one-minute load ranges were 5.35–10.68 for
A and 5.63–10.39 for B, with peak child RSS 453.95 / 423.81 MiB. All replacement
pressure samples and peaks are retained too. Endpoint samples do not establish
continuous memory pressure or remove shared-machine confounding.

### Existing receipt, with explicit scope

Open receipts now retain `prep.startupMs`, actual HTTP RPC attempt counts,
per-function complete SDK call/failure counts and summed walls, ordinary-object logical bytes, pack objects/compressed
bytes, summed download spans and `writePassWaitMs`. Executable agent observation
begins before freshness checks. Direct library checkout callers retain unknown
startup as null. [Scope and overlap rules](../operations/source-exchange.md)
explain why RPC/download walls and write-pass wait cannot all be added to total.
The SDK-level receipt includes response decode, unlike the common A/B HTTP probe.

This adds local clocks/counters to the **existing one-append receipt**, with
**zero added Convex calls, DB I/O, R2 source bytes, tables or idle work**. A
fake-clock/exact-request guard passes on the change and a receipt-attribution
assertion fails on untouched current. Tests cover failed calls, concurrent
scope isolation, freshness calls and cold/warm logical-byte receipts. No
checkout algorithm, pin, source mode or durability rule changed. This merges
the missing attribution into existing diagnostics; no runtime code can be
responsibly removed from the measured evidence alone.

## Method and populations

Read-only inputs are the retained B1.5d archive's `batches/*/batch.json`,
`runs/*/result.json`, `events.jsonl`, `samples.jsonl` and final summary,
and the settled `n3-r1-dry-a1` and `n3-r1-dry-a2` batches' matching records,
checkout metrics and open receipts. Neither smoke was rerun or modified.
B1.5d's CLI was `0383f90d`; smoke a1's State was `d4145166`, smoke a2's
`9acd7b98`. The smokes used scripted agents; B1.5d used model agents.

Medians below use the arithmetic midpoint for even sample sizes, as the
harness's `summarize.mjs` does. The earlier 19.7 s headline is compatible
with the lower middle smoke-a1 observation, 19.749 s; its ten-task midpoint
median is 19.8025 s. The B1.5d reference remains the published **15.3 s**
(p90 **33.8 s**), rather than silently substituting a different population.
The registered Forge population reconstructs to 92 non-void tasks across
10 cells, median 15.328 s. Its two registered N=3 cells contribute 17
non-void tasks, median 15.344 s. The separately disclosed extra N=3 attempt
is excluded here. The report's “11 scored cells” wording is inconsistent
with its per-N counts, which sum to ten; do not use that wording as a filter.
The published GitHub reference is 4.5 s; the same registered-record filter
reconstructs 5.185 s (74 tasks). This discrepancy is disclosed, not used to
change the registered target or to invent missing observations.

| Population | Tasks | Prep median s | Start s | Open s | Dependency link s | Relay s |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| B1.5d registered Forge, all N | 92 | 15.328 | 1.590 | 12.801 | 0.165 | 0.002 |
| B1.5d registered Forge, N=3 | 17 | 15.344 | 1.397 | 13.397 | 0.148 | 0.002 |
| Smoke a1 Forge | 10 | 19.803 | 1.918 | 16.546 | 0.636 | 0.009 |
| Smoke a2 Forge | 10 | 19.372 | 1.953 | 16.673 | 0.576 | 0.009 |
| Smoke a1 GitHub | 10 | 12.765 | — | — | — | — |
| Smoke a2 GitHub | 10 | 10.066 | — | — | — | — |

These are separate component medians; they do not add to the median total.
Against the pooled Forge reference, a1's open component grew 3.745 s,
start 0.329 s and dependencies 0.471 s. Against the matched N=3 population,
open grew 3.149 s. Dependency linking still uses one shared install and
31 module directories / 272 cloned entries per smoke task; no per-task
package installation was introduced. `setup.mjs` prepares the environment
outside the measured task; `run-cell.mjs` measures through dependency linking
before dispatch. The model or scripted agent starts afterwards.

## Per-task decomposition

All times are seconds. Each Forge prep executes **two CLI child processes**:
start at the anchor and open at the task root (`forge-arm.mjs`). Their startup
is included inside the start/open columns, not an additional timed phase.
Neither smoke nor B1.5d retained a separate startup clock. “Outside checkout”
is open CLI wall minus the checkout metric; it includes startup, discovery,
network transit, submodule handling and final bookkeeping, so it is only an
upper bound on startup. It must not be labelled pure spawn time.

The B1.5d rows retain both registered N=3 cells; daggered tasks were voided
by the published contamination rules and are excluded from aggregate figures.
They are displayed rather than silently dropped. No smoke task was voided.

### B1.5d N=3 r2

| Task | Prep | Start | Open | Dependencies | Relay |
| --- | ---: | ---: | ---: | ---: | ---: |
| t23766 | 21.421 | 1.866 | 19.421 | 0.133 | 0.001 |
| t23938 | 18.233 | 1.602 | 16.307 | 0.322 | 0.002 |
| t22302 | 15.392 | 2.715 | 11.235 | 1.431 | 0.011 |
| t27456 | 10.831 | 1.378 | 9.303 | 0.145 | 0.005 |
| t19456 | 13.556 | 1.312 | 11.969 | 0.271 | 0.004 |
| t27521 | 10.059 | 1.359 | 8.565 | 0.133 | 0.002 |
| t27514 | 15.344 | 1.199 | 13.993 | 0.150 | 0.002 |
| t26563 | 11.259 | 1.302 | 9.808 | 0.148 | 0.001 |
| t26770 | 15.409 | 1.568 | 13.667 | 0.173 | 0.001 |
| t27069 | 21.591 | 1.338 | 20.106 | 0.144 | 0.002 |

### B1.5d N=3 r3

| Task | Prep | Start | Open | Dependencies | Relay |
| --- | ---: | ---: | ---: | ---: | ---: |
| t19456 † | 19.105 | 1.425 | 17.547 | 0.132 | 0.001 |
| t27456 | 15.866 | 1.635 | 13.916 | 0.314 | 0.001 |
| t22302 | 13.224 | 1.642 | 10.124 | 1.446 | 0.012 |
| t27069 | 30.290 | 1.264 | 28.882 | 0.139 | 0.005 |
| t23938 | 16.585 | 1.397 | 14.860 | 0.325 | 0.003 |
| t23766 | 11.455 | 1.308 | 10.004 | 0.139 | 0.004 |
| t26770 | 12.208 | 1.532 | 10.532 | 0.143 | 0.001 |
| t27514 | 15.312 | 1.774 | 13.397 | 0.136 | 0.005 |
| t27521 † | 11.324 | 1.505 | 9.666 | 0.152 | 0.001 |
| t26563 † | 7.951 | 1.202 | 6.613 | 0.134 | 0.002 |

### smoke a1

| Task | Prep | Start | Open | Dependencies | Relay | Checkout | Queue wait | Copy/hash | Outside checkout |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| t27514 | 17.510 | 1.653 | 13.864 | 1.958 | 0.035 | 10.174 | 0.139 | 8.454 | 3.690 |
| t27521 | 30.727 | 1.897 | 28.339 | 0.487 | 0.004 | 24.959 | 15.557 | 6.938 | 3.380 |
| t22302 | 22.668 | 1.886 | 20.118 | 0.660 | 0.004 | 16.715 | 8.474 | 5.910 | 3.403 |
| t27456 | 19.922 | 2.662 | 16.590 | 0.647 | 0.022 | 11.942 | 0.217 | 7.476 | 4.648 |
| t19456 | 19.856 | 2.567 | 16.501 | 0.777 | 0.011 | 12.045 | 0.150 | 9.351 | 4.456 |
| t27069 | 26.899 | 2.202 | 24.007 | 0.681 | 0.008 | 18.683 | 0.217 | 14.103 | 5.324 |
| t26770 | 19.749 | 2.036 | 17.070 | 0.624 | 0.019 | 12.795 | 0.187 | 8.668 | 4.275 |
| t23938 | 15.651 | 1.712 | 13.411 | 0.523 | 0.005 | 9.666 | 0.137 | 7.229 | 3.745 |
| t23766 | 16.009 | 1.939 | 13.599 | 0.466 | 0.005 | 10.280 | 0.153 | 6.720 | 3.319 |
| t26563 | 15.048 | 1.468 | 13.285 | 0.285 | 0.010 | 10.877 | 0.101 | 5.096 | 2.408 |

### smoke a2

| Task | Prep | Start | Open | Dependencies | Relay | Checkout | Queue wait | Copy/hash | Outside checkout |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| t27514 | 45.738 | 1.727 | 43.346 | 0.654 | 0.010 | 37.007 | 19.885 | 15.341 | 6.339 |
| t27521 | 21.208 | 1.561 | 17.473 | 2.099 | 0.075 | 13.077 | 0.150 | 11.352 | 4.396 |
| t22302 | 27.711 | 1.681 | 25.348 | 0.677 | 0.004 | 21.047 | 11.939 | 7.536 | 4.301 |
| t27456 | 18.301 | 2.166 | 15.705 | 0.423 | 0.007 | 12.365 | 0.144 | 8.779 | 3.340 |
| t19456 | 18.653 | 1.855 | 14.795 | 1.993 | 0.009 | 10.260 | 0.143 | 7.784 | 4.535 |
| t27069 | 15.049 | 2.027 | 12.610 | 0.398 | 0.014 | 9.331 | 0.135 | 5.884 | 3.279 |
| t26770 | 16.996 | 2.079 | 14.453 | 0.458 | 0.006 | 10.964 | 0.204 | 7.210 | 3.489 |
| t23938 | 18.539 | 1.961 | 16.025 | 0.547 | 0.006 | 12.521 | 0.167 | 8.694 | 3.504 |
| t23766 | 20.090 | 2.282 | 17.322 | 0.469 | 0.017 | 13.656 | 0.236 | 8.949 | 3.666 |
| t26563 | 20.278 | 1.945 | 17.721 | 0.604 | 0.008 | 14.035 | 0.338 | 9.384 | 3.686 |

## Load, memory and checkout work

The sampler records load and free RAM every 30 seconds. The following values
are the sample nearest the midpoint of each prep window: **one-minute load /
free GiB**. They are coarse context, not continuous memory-pressure traces.
Neither historical capture records swap, compressor activity or page-in rates;
low free RAM alone does not establish memory pressure.

| Task | B1.5d r2 | B1.5d r3 | Smoke a1 | Smoke a2 |
| --- | ---: | ---: | ---: | ---: |
| t27514 | 3.81 / 4.95 | 1.67 / 0.77 | 16.10 / 0.48 | 17.44 / 0.29 |
| t27521 | 4.90 / 2.28 | 6.62 / 1.37 | 16.10 / 0.48 | 17.21 / 0.63 |
| t22302 | 4.13 / 0.85 | 2.39 / 0.40 | 16.10 / 0.48 | 17.21 / 0.63 |
| t27456 | 2.45 / 4.20 | 2.39 / 0.40 | 18.20 / 0.29 | 17.46 / 0.32 |
| t19456 | 2.06 / 3.66 | 2.39 / 0.40 | 19.62 / 0.43 | 15.62 / 0.28 |
| t27069 | 8.12 / 3.00 | 4.16 / 4.24 | 34.63 / 0.41 | 21.30 / 0.55 |
| t26770 | 8.12 / 3.00 | 13.24 / 2.61 | 23.16 / 0.74 | 23.92 / 0.54 |
| t23938 | 4.13 / 0.85 | 4.73 / 2.65 | 25.56 / 0.46 | 14.15 / 0.59 |
| t23766 | 4.13 / 0.85 | 4.66 / 4.76 | 18.21 / 0.44 | 16.94 / 0.40 |
| t26563 | 25.97 / 2.91 | 1.92 / 0.47 | 12.61 / 0.41 | 20.03 / 1.04 |

For the 17 non-void B1.5d N=3 tasks, nearest-sample median load/free RAM
was 4.13 / 2.65 GiB; smoke a1 was 18.205 / 0.45 GiB and a2 was
17.325 / 0.545 GiB. The initial three smokes' opens contend for a shared
write pass. The second/third completion incurs 8.474 / 15.557 s queue
wait in a1 and 11.939 / 19.885 s in a2. These waits are measured inside
open, not extra charges to add again.

Across ten original task opens, median checkout-core time was 11.994 s
in a1 and 12.799 s in a2; copy/hash was 7.353 / 8.736 s and cache
preparation was 1.834 / 2.210 s. Full-tree durability phase was zero
(the whole-stage path uses a directory barrier rather than per-file fsync).
Peak per-process RSS was 384.3 / 370.3 MiB. The trees had 28,881–28,891
files, so file-count growth cannot explain seconds of extra work. B1.5d
has no comparable retained checkout-phase or process-RSS measurements.

The shared queue mechanism is the same in the two smoke CLI builds.
Changes to the checkout/cache modules between them are import relocation
into `state/`, not a new materialization algorithm. This does not establish
parity with the older B1.5d build. Both arms' slower prep, higher load,
different dispatch workload and lower free RAM are confounders; none is
proof that the entire increase is load. There are no interleaved old/new
build pairs here, so no causal performance claim or bootstrap interval
is justified under [perf-claims](../agents/perf-claims.md).

## Convex calls and bytes

The retained provider summaries count whole cells, including reset, landing,
recovery, observation and oracle work. They do not attribute calls to task
prep. Dividing those totals by ten would mislabel landing work as prep.
For context, a1/a2 recorded 12/12 `projectHostedStart:start` executions,
45/49 `projectHostedLanes:select` and 36/44
`projectObjectDownloads:lanePage`; these are **cell totals**, not per-task
call counts. B1.5d has aggregate meter totals but no per-function breakdown
in its retained result records.

Open receipts do establish the following logical downloaded bytes. All other
source objects came from the shared cache. These logical bytes do not measure
physical R2 traffic or provider egress (a recipe may change the physical reads).

| Task | a1 downloaded objects / bytes | a2 downloaded objects / bytes |
| --- | ---: | ---: |
| t27514 | 0 / 0 | 0 / 0 |
| t27521 | 0 / 0 | 0 / 0 |
| t22302 | 0 / 0 | 0 / 0 |
| t27456 | 1 / 4,907,393 | 1 / 4,907,398 |
| t19456 | 1 / 4,907,720 | 1 / 4,907,720 |
| t27069 | 1 / 4,907,840 | 1 / 4,907,773 |
| t26770 | 1 / 4,907,951 | 1 / 4,907,951 |
| t23938 | 1 / 4,908,219 | 1 / 4,908,219 |
| t23766 | 1 / 4,908,395 | 2 / 4,908,420 |
| t26563 | 1 / 4,908,459 | 1 / 4,908,459 |

Thus only the first three opens per smoke were fully warm; later opens
usually downloaded the new main State. Do not describe every open as zero
R2 traffic. The pinned checkout code makes one selection on a full cache hit
and another before installation after downloads. Missing objects are described
in pages, not by one call per file. CLI discovery, release checking, retries
and server-internal executions are outside those core counts. Their exact
historical per-task totals remain unknown; source inspection is not a billed
measurement. No runtime or storage path changes in this analysis, so added
Convex calls, DB reads/writes and stored source bytes are **zero**, including
at idle. Source-byte placement remains R2.

## Local synthetic observations

The smoke-a2 build was exercised locally, with a fake transport and no hosted
requests: 28,881 unique 4 KiB files (118,296,576 source bytes), a prefilled
machine cache, Node 24.22.1, filesystem pool of ten, three alternating N=1 /
N=3 cohorts. This is smaller in bytes than t3code and excludes CLI startup,
remote start, network and dependency linking. It cannot predict full prep.

| Repeat | N=1 checkout s | N=3 checkout s, in completion order | N=3 queue waits s |
| --- | ---: | --- | --- |
| 1 | 5.705 | 5.963 / 10.930 / 16.161 | 0.113 / 5.275 / 10.233 |
| 2 | 5.515 | 6.079 / 11.099 / 16.718 | 0.116 / 5.276 / 11.201 |
| 3 | 6.224 | 8.793 / 15.177 / 21.605 | 0.098 / 7.960 / 14.327 |

All 12 opens asserted one selection callback, zero signing/download callbacks
and zero downloaded bytes; these callbacks are fake, not billed Convex calls.
Peak child RSS was 208.7 MiB. Before/after one-minute loads for the six cohorts
were 6.55–7.46, 7.46–8.37, 8.58–8.42, 8.42–9.63, 10.00–11.68 and
11.68–14.71. Free RAM ranged 0.41–1.96 GiB; used swap was 5,924–5,948 MiB.
Every sample retains all three load averages, free RAM and swap before/after.
One fixture attempt failed during cache validation because synthetic cached
files had the wrong access mode; it produced no successful timing. Correcting
that setup to private object modes produced the twelve completed opens above.
No successful sample was omitted.

This is N=3 cohorts on one build, an observation of queue/load sensitivity,
not an interleaved performance comparison of baseline/candidate code. The
machine was not quiet enough for a clean performance claim. A quiet repeat
was not available during these observations; no speed-up is claimed.

## Acceptance and next measurement

- Decomposition: historical per-task start/open/dependency/relay and checkout
  phases remain below, with the matched CLI experiment above supplying startup,
  actual client RPC/byte attribution, RSS and endpoint swap/VM samples for its
  own runs. The historical smoke and B1.5d separate startup/RPC/swap clocks were
  not retained and cannot be retroactively supplied. The first Done-when line
  stays open for that historical and post-fix smoke coverage.
- Conditional regression fix: the matched synthetic workload does not reproduce
  the seconds-scale current-CLI regression. It does not prove load alone caused
  the historical increase. No runtime or queue fix is invented. The small
  indexing/publication associations are named above, without a diagnosed
  component defect or a claimed fix. The second line stays open rather than
  claiming an unevidenced root-cause correction; the telemetry guard fixes the
  separately observed missing-attribution defect.
- Next smoke: **unrun and unticked**. The acceptance bar remains **16.83 s**
  (15.3 s +10%). Synthetic warm prep is not a smoke prediction. Smoke a2's
  recorded GitHub gap remains **9.306 s** (19.3715 − 10.0655), owned by
  [a245bcf0][gap]; the remaining absolute gap is not reassigned here.

[prep]: https://nanthai-forge-dev.netlify.app/?project=mh7aafndrxmj8c2q0931zbjk2n8h4ffs&projectTab=planning&planningItem=c83c4451-a30a-4f0e-8b45-1ff35300a001
[gap]: https://nanthai-forge-dev.netlify.app/?project=mh7aafndrxmj8c2q0931zbjk2n8h4ffs&projectTab=planning&planningItem=a245bcf0-b1ff-4ea5-ba8d-a2c9c9e14dff
