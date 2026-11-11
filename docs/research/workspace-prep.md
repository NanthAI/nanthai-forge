# Workspace prep: retained evidence and remaining attribution

The two scripted N=3 smokes locate most of the increase against B1.5d in
Lane open. They do **not** distinguish a product regression from machine load.
No runtime fix or speed-up is claimed. The prep Issue stays open; a new smoke
is outside this analysis's authorization.

This analysis owns the increase against B1.5d
([c83c4451][prep]), while the remaining absolute gap to GitHub belongs to
[a245bcf0][gap]. It does not replace either Issue's acceptance contract.

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

- Decomposition: start/open/dependencies/relay, two CLI spawns per task,
  checkout phases, logical transfer bytes and recorded load/free RAM are
  evidenced above. Separate historical startup time, prep-attributed Convex
  calls and actual memory-pressure/swap samples are **not retained**. The
  first Done-when line remains open for that missing attribution; a later
  run cannot retroactively supply a historical clock.
- Conditional regression fix: open is the grown component, but a causal
  product regression is unproven. No speculative runtime change or build
  guard is presented as a fix. The second line stays open pending a diagnosis
  with interleaved B1.5d/current local fixtures, capturing each CLI process,
  actual RPCs, checkout phases, bytes, load and swap. If a component regresses,
  fix it generically and add the failing call/byte/fake-clock guard there.
- Next smoke: **unrun and unticked**. With unchanged runtime and comparable
  shared-machine conditions, the working expectation is about **19.4 s**,
  based on a2, not a demonstrated return to 15.3 s. The unchanged acceptance
  target is at most **16.83 s** (15.3 s +10%). At a2's observed medians,
  Forge's remaining GitHub gap is **9.306 s** (19.3715 − 10.0655), owned by
  [a245bcf0][gap]; a1's gap was 7.038 s. B1.5d's published gap was 10.8 s.
  A new owner-authorized smoke must record the missing timings/calls/load
  and show the target; this analysis authorizes no such run.

This evidence replaces an unexplained headline with measured components and
explicit unknowns. No product code can responsibly be removed or merged from
these observations alone; no new policy, restriction, process or cost is added.

[prep]: https://nanthai-forge-dev.netlify.app/?project=mh7aafndrxmj8c2q0931zbjk2n8h4ffs&projectTab=planning&planningItem=c83c4451-a30a-4f0e-8b45-1ff35300a001
[gap]: https://nanthai-forge-dev.netlify.app/?project=mh7aafndrxmj8c2q0931zbjk2n8h4ffs&projectTab=planning&planningItem=a245bcf0-b1ff-4ea5-ba8d-a2c9c9e14dff
