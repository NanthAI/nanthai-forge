# Zoo conformance report

Issue `70a9bd2f-f741-4d26-8ae5-7bb11148a17c` tracks this dev-only post-flip run. All **26 fixtures pass their required functional outcomes**: 23 complete all nine paths; three hazards return their named expected refusals. The strict timing gate compares with the unchanged numeric baseline at 1.5×. Five singleton misses and their five-repeat qualification appear below. The strict timing gate remains open: both binary checked-resolution medians still exceed their unchanged bars after the runner object-fetch follow-up below.

All 26 original fixture forks are deleted. The follow-up recreated two forks, then deleted both and verified its ten new projects in Trash. The earlier 40 dev projects remain assigned to the lead for owner-person purge.

The [harness](../../scripts/bench-zoo/suite.mjs) uses public upstream forks and [synthetic recipes](../../scripts/bench-zoo/shapes.mjs). Source bytes stay in R2 and metadata in Convex. This report consolidates the superseded full-matrix narrative; original observations and failed setup proofs remain retained in execution evidence.

## Functional coverage

✓ pass, ⊘ expected named refusal, · not reached.

| Repository | import | clone | fidelity | save | sync | land | landReuse | conflict | resolve |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| go | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| python | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| rust | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| jvm | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| mixed | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| csharp | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| electron | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| elixir | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| ruby | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| php | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| swift | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| android | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| dart | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| flutter | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| cpp | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| zig | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| npmws | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| lfs | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| history | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| binaries | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| shapes-posix | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| shapes-bigbin | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| shapes-case | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| shapes-collide | ✓ | ⊘ | · | · | · | · | · | · | · |
| shapes-nonutf8 | ⊘ | · | · | · | · | · | · | · | · |
| shapes-unicode | ✓ | ⊘ | · | · | · | · | · | · | · |

`shapes-collide` and `shapes-unicode` refuse clone with `INVALID_NATIVE_SOURCE`; `shapes-nonutf8` refuses import with `GITHUB_SOURCE_UNSUPPORTED`. Their unrepresentable paths are retained as refusals, never renamed. All 23 declared plain-GitHub `zoo-ci` comparisons succeeded. No import provider-reset setup void occurred in this full pass.

## Seconds next to plain git

These are medians over paired repositories, with one observed run per repository. Forge keeps the original full-pass clocks. Git uses a separately timed corrected replay at each exact retained fixture commit, selecting the declared branch and its full reachable history. The original all-ref Git timings remain retained and are superseded for this comparison. This replay is not interleaved causal performance evidence.

| Operation | Forge seconds | Git seconds | Median paired Forge/Git ratio | Pairs |
| --- | --- | --- | --- | --- |
| import | 13.166 | 0.900 | 14.447× | 25 |
| clone | 0.756 | 0.951 | 0.860× | 23 |
| save | 2.671 | 1.575 | 1.671× | 23 |
| sync | 5.072 | 0.621 | 7.753× | 23 |
| conflict | 14.819 | 0.594 | 23.968× | 23 |
| resolve | 111.650 | 1.524 | 68.778× | 23 |
| land | 105.163 | 1.547 | 67.525× | 23 |
| landReuse | 103.620 | 2.158 | 47.619× | 23 |

`resolve` includes source conflict resolution **and a checked landing**; Git resolves, commits and pushes without CI. `land` times Lane A and legacy `landReuse` times C; neither key implies which landed first. The [sync/resolve decomposition](sync-resolve-costs.md) describes source-only work separately.

## Strict timing qualification

Baseline SHA-256 remains `2aa67a991113f947e41c22bab06680d779fd56f41fff489fa89a52149ebd5026`; no numeric baseline, 1.5 factor or operation clock was replaced. Five repeats are required to declare a miss. Every attempt is retained, including failed/unqualified attempts; a partial cohort has no median verdict. Qualification uses the normal approved CLI, the original Forge commands/clocks and unchanged fixture source commits. JVM repeats stop only after A/C acceptance, D sync and terminal B conflict. Binary rows run through checked resolution; redundant plain-GitHub CI dispatch is omitted. Unicode repeats the original expected-refusal clone. Fresh-project preparation precedes measurement at concurrency two, matching the full-pass concurrency; it also lets existing upload leases settle during checks.

| Repository / operation | Initial seconds | Unchanged 1.5× bar | Qualified N | Repeat seconds (sorted) | Median seconds | Verdict |
| --- | --- | --- | --- | --- | --- | --- |
| jvm / sync | 9.537 | 7.492 | 5 | 4.712, 4.794, 5.305, 6.133, 6.983 | 5.305 | within bar |
| jvm / conflict | 73.368 | 20.024 | 5 | 12.918, 15.022, 15.393, 15.443, 15.756 | 15.393 | within bar |
| binaries / resolve | 174.112 | 137.123 | 5 | 148.740, 152.906, 156.821, 168.925, 170.345 | 156.821 | miss |
| shapes-bigbin / resolve | 124.437 | 106.678 | 5 | 110.085, 115.456, 126.966, 131.045, 131.960 | 126.966 | miss |
| shapes-unicode / clone | 1.165 | 1.095 | 5 | 0.469, 0.470, 0.482, 0.496, 0.597 | 0.482 | within bar |

Qualified sample landing classes (no order filter):

| Repository | Sample | A main moved / recompositions | C main moved / recompositions |
| --- | --- | --- | --- |
| binaries | 1 | no / 1 | no / 1 |
| jvm | 1 | no / 1 | no / 1 |
| shapes-bigbin | 1 | no / 0 | yes / 1 |
| jvm | 2 | no / 1 | no / 1 |
| binaries | 2 | no / 1 | no / 1 |
| shapes-bigbin | 2 | no / 0 | yes / 1 |
| jvm | 3 | no / 1 | no / 1 |
| binaries | 3 | no / 0 | yes / 1 |
| shapes-bigbin | 3 | no / 1 | no / 1 |
| jvm | 4 | no / 1 | no / 1 |
| binaries | 4 | no / 0 | yes / 1 |
| shapes-bigbin | 4 | no / 0 | yes / 1 |
| jvm | 5 | no / 0 | yes / 1 |
| binaries | 5 | no / 0 | yes / 1 |
| shapes-bigbin | 5 | no / 1 | no / 1 |

These observations compare against a historical singleton baseline. Initial inherited workflow load was removed before qualification. The fixture-fix full verification overlaps qualification and remains in source-work CI accounting; no sample is omitted for that overlap; changing provider load and CLI control-code heads prevents isolated causal attribution. Checked landing wall time includes queue/runner preparation and reconciliation, not just command execution. Timing Issue `5d689e6e` retains qualified findings and remaining work; source-only sync/resolve work stays on `6fbba986`.

## Runner object-fetch follow-up

The runner scheduling/cache fix is accepted in State `5df95aeac668559274ead5599657d9fb34cc2d0c3a9c2ffb9ec861acad403db5` (receipt `c156ada6-9996-46f8-85e6-f9a57f25de82`). It removes the serial drain between catalog prefixes for ordinary downloads, adds bounded disk prefetch for legacy recipe leaves, and shares in-flight leaf reads. Complete signed runs, exact hashes, ordered reconstruction, failure draining and the serial source-worker default remain. No queue, admission, logical State identity or source-byte placement changes were made.

Five fresh-project repeats per binary row used the unchanged harness, fixture source commits, original commands and clocks, concurrency two, and the same strict bars. CLI and runner control were pinned to the accepted fix; all 29 qualification check runs used control commit `a52a962b9e2584c4f45af6047311aa9fb245eaf0`. Runtime `9ede50f626dbaed5cae577f11c19a221cadb8541041201651bf6eb3af8ffc478` and all harness hashes match the prior qualification. Every sample completed and is retained; none was voided or filtered by landing order. The baseline SHA-256 above is unchanged. **Both five-repeat medians still miss.**

| Repository / checked resolve | Repeat seconds (sample order) | Median seconds | Unchanged 1.5× bar | Verdict |
| --- | --- | --- | --- | --- |
| binaries | 136.298, 136.059, 147.762, 150.540, 152.315 | 147.762 | 137.123 | miss |
| shapes-bigbin | 111.823, 102.957, 110.464, 100.746, 108.647 | 108.647 | 106.678 | miss |

Realized A/C classes (B resolution had no main movement and zero recompositions in every sample):

| Repository | Sample | A main moved / recompositions | C main moved / recompositions |
| --- | --- | --- | --- |
| binaries | 1 | no / 0 | yes / 1 |
| shapes-bigbin | 1 | no / 0 | yes / 1 |
| binaries | 2 | no / 0 | yes / 1 |
| shapes-bigbin | 2 | no / 0 | yes / 1 |
| binaries | 3 | no / 0 | yes / 1 |
| shapes-bigbin | 3 | no / 0 | yes / 1 |
| binaries | 4 | no / 0 | yes / 1 |
| shapes-bigbin | 4 | no / 1 | no / 1 |
| binaries | 5 | no / 0 | yes / 1 |
| shapes-bigbin | 5 | no / 0 | yes / 1 |

These are N = 5 observations against a historical singleton baseline, not interleaved causal speedup evidence. The preceding qualification and all its failures remain above. Source-work push workflows overlap the first follow-up samples; their compute is accounted separately. No timing threshold or sample clock was adjusted.

### Counted cause and guard evidence

A synthetic 1,382-object / 1,387-path raw binary source fetched exactly 1,382 objects and 33,964,032 bytes in four descriptor prefixes before and after the patch. The exact historical materializer's worker loop reached 48 concurrent GETs on the current fake transport; accepted pre-fix source reached only 16 because each prefix drained before the next. The patch restores 48 without another metadata request. The four pre-fix windows fetched 400 / 400 / 400 / 182 objects, respectively 9,830,400 / 9,830,400 / 9,830,400 / 4,472,832 bytes; their observed local wall times were 91.505 / 83.128 / 66.466 / 41.145 ms. Baseline/candidate windows overlap instead. These simulated-response disk timings prove scheduling and counts, not a hosted latency gain.

On the same legacy-recipe fixture, the old reader issued five metadata calls and 72 leaf GETs (18,874,368 bytes), peaking at two GETs. The new reader issued the same five metadata calls and 70 leaf GETs (18,350,080 bytes), peaking at 16; two duplicate reads of a shared in-flight leaf disappeared. Recipe prefetch is bounded to 16 consecutive leaves or 4 MiB per logical file, with no whole-file memory cache. Guards also cover corruption, whole-file verification, identical raw/recipe identity, and draining active writers after a later descriptor failure. Direct affected tests passed 140 tests; the full hosted check reported 1,084 test-file results with zero failed/flaky files. The broad transitive local preflight was stopped, not reported as passing; full verification ran on the landing runner.

### Remaining source-grant finding

The first follow-up binaries resolution spent 59.870 s in object fetch / 62.307 s materializing source; the preceding matched row's first observation was 71.822 / 74.100 s. Shapes-bigbin spent 36.619 / 38.713 s, versus the preceding observation's 52.052 / 54.750 s. These unpaired phase observations do not isolate the patch's effect.

In shapes-bigbin follow-up sample 1, 32.260 s elapsed from catalog fallback to the eight-object prepared window. During that window, project-attributed provider records contain 11 source HTTP requests, 53 internal descriptor resolves and 22 State-selection mutations. After it, about 4.36 s of the object-fetch phase remained. An authorized descriptor audit found no inline closure on any of the three large imported recipes (24 / 24 / 6 MiB); their recipe metadata is in R2. The three largest recipes in binaries also lack inline closures and have R2 metadata. The State-bound catalog path re-proves State/recipe membership on successive recipe, tree and leaf descriptor rounds; complete-run preparation also precedes the file-page workers. The landed patch does not eliminate those preparation rounds.

The next source-materialization slice should prove and reduce that repeated preparation while preserving fresh current-access checks and exact State/recipe membership. An initial planning target is to remove half that preparation window (about 16.1 s); its full 32.260 s is an upper bound, not an isolated removable component. Neither number is a measured saving; the removable fraction must be established before a further performance claim. No authorization relaxation, repair, backfill, backend deployment or additional qualification round was initiated for this finding. A fresh matching ten-sample round exceeds the remaining approved task budget on both executions and DB I/O before another fix/landing. Issue `5d689e6e` remains open; the lead owns the remaining implementation/qualification slice.

### Follow-up cleanup and compute

All ten new dev projects are verified in Trash and both recreated fixture forks are deleted. Permanent project purge is owner-only; exact project IDs are retained in the private handoff. The earlier 40-project owner purge remains a separate lead-owned task, not silently claimed here.

The qualification used 29 successful hosted checks / 51.650 assigned job minutes, with no missing run IDs or control-code drift. The implementation's full check used 105.750 assigned job minutes; its five automatic source-push workflows used 73.750 minutes. This includes development workflows and their verification, not just timed checks. Two fixture setup adapter failures were corrected before timing; no scored/qualification sample was dropped. Source bytes continue to use R2; no new Convex byte-storage path was introduced. Provider usage is retained separately from invoices and excludes any unobserved initial read-only overhead.

## Concurrent landing order

| Repository | Lane | Main moved | Recompositions |
| --- | --- | --- | --- |
| go | a | no | 0 |
| go | c | yes | 1 |
| python | a | no | 0 |
| python | c | yes | 1 |
| rust | a | no | 1 |
| rust | c | no | 1 |
| jvm | a | no | 0 |
| jvm | c | yes | 1 |
| mixed | a | no | 1 |
| mixed | c | no | 1 |
| csharp | a | no | 1 |
| csharp | c | no | 1 |
| electron | a | no | 0 |
| electron | c | yes | 1 |
| elixir | a | no | 1 |
| elixir | c | no | 1 |
| ruby | a | no | 0 |
| ruby | c | yes | 1 |
| php | a | no | 1 |
| php | c | no | 1 |
| swift | a | no | 1 |
| swift | c | no | 1 |
| android | a | no | 1 |
| android | c | no | 1 |
| dart | a | no | 0 |
| dart | c | yes | 1 |
| flutter | a | no | 1 |
| flutter | c | no | 1 |
| cpp | a | no | 1 |
| cpp | c | no | 1 |
| zig | a | no | 1 |
| zig | c | no | 1 |
| npmws | a | no | 1 |
| npmws | c | no | 1 |
| lfs | a | no | 0 |
| lfs | c | yes | 1 |
| history | a | no | 1 |
| history | c | no | 1 |
| binaries | a | no | 1 |
| binaries | c | no | 1 |
| shapes-posix | a | no | 0 |
| shapes-posix | c | yes | 1 |
| shapes-bigbin | a | no | 1 |
| shapes-bigbin | c | no | 1 |
| shapes-case | a | no | 1 |
| shapes-case | c | no | 1 |

All A/C outcomes are retained without selecting a favorable order. Qualification receipts retain the realized A/C landing classes and exact check identities outside the measured sync/conflict clocks.

## Per-repository timings

Original Forge wall seconds, including all same-operation waits; these remain separate from miss-only repetitions.

| Repository | Import | Clone | Save | Sync | A landing | C landing | Conflict | Checked resolve |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| go | 13.534 | 0.673 | 2.816 | 5.940 | 185.467 | 226.122 | 13.070 | 277.756 |
| python | 12.649 | 1.036 | 2.448 | 5.823 | 71.562 | 86.501 | 13.595 | 95.287 |
| rust | 13.296 | 0.964 | 2.709 | 8.503 | 103.520 | 101.484 | 14.819 | 111.770 |
| jvm | 13.124 | 0.670 | 2.692 | 9.537 | 440.294 | 632.939 | 73.368 | 630.493 |
| mixed | 16.068 | 0.761 | 2.650 | 4.489 | 132.805 | 130.801 | 16.444 | 167.891 |
| csharp | 10.992 | 0.872 | 2.546 | 4.722 | 95.780 | 93.777 | 15.064 | 101.986 |
| electron | 12.437 | 0.808 | 2.707 | 5.818 | 67.648 | 85.735 | 12.553 | 98.958 |
| elixir | 13.871 | 0.682 | 2.691 | 5.260 | 70.297 | 68.284 | 14.498 | 92.138 |
| ruby | 13.166 | 1.017 | 2.731 | 5.641 | 105.163 | 103.652 | 12.906 | 111.650 |
| php | 8.177 | 0.839 | 2.747 | 4.670 | 105.630 | 103.620 | 14.895 | 88.491 |
| swift | 16.010 | 0.756 | 2.632 | 4.608 | 145.909 | 143.878 | 15.306 | 158.825 |
| android | 12.207 | 0.674 | 2.638 | 4.518 | 189.591 | 187.560 | 14.102 | 182.186 |
| dart | 12.197 | 0.835 | 2.651 | 6.615 | 80.354 | 89.343 | 13.373 | 103.005 |
| flutter | 12.933 | 0.777 | 2.683 | 4.717 | 149.412 | 147.404 | 14.989 | 150.773 |
| cpp | 13.218 | 0.759 | 2.662 | 4.482 | 184.598 | 182.595 | 14.971 | 206.019 |
| zig | 13.140 | 0.626 | 2.598 | 4.709 | 173.193 | 171.173 | 14.413 | 185.606 |
| npmws | 12.739 | 0.611 | 2.682 | 5.925 | 77.466 | 75.451 | 14.887 | 84.095 |
| lfs | 19.324 | 0.711 | 2.671 | 5.926 | 70.759 | 86.522 | 13.418 | 105.329 |
| history | 13.781 | 0.750 | 2.792 | 4.566 | 76.635 | 74.623 | 16.402 | 109.642 |
| binaries | 32.970 | 1.137 | 2.682 | 5.072 | 136.938 | 134.927 | 17.226 | 174.112 |
| shapes-posix | 7.990 | 0.654 | 2.525 | 5.831 | 61.749 | 76.089 | 13.292 | 69.209 |
| shapes-bigbin | 29.883 | 0.701 | 2.585 | 4.775 | 129.344 | 127.342 | 14.566 | 124.437 |
| shapes-case | 13.371 | 0.665 | 2.663 | 4.798 | 57.296 | 55.293 | 14.999 | 72.219 |
| shapes-collide | 13.784 | 1.518 | – | – | – | – | – | – |
| shapes-nonutf8 | 1.555 | – | – | – | – | – | – | – |
| shapes-unicode | 7.975 | 1.165 | – | – | – | – | – | – |

## Fresh-import catalog attribution

25 successful imports retain counts; the refused non-UTF8 import has no completed size observation. These are logical imported files/source bytes, not billed DB storage or R2 request counts.

| Repository | Files | Source bytes | Exact fixture commit |
| --- | --- | --- | --- |
| go | 217 | 2793187 | `29cd1e4f03f98117617328f6832015ca7ab167a3` |
| python | 58 | 433485 | `3965d0f62e2c863818f31aeb52eb29d36eee131e` |
| rust | 228 | 3238566 | `de270090aeb3a65f18d7948b9d962ab414ed6c3a` |
| jvm | 195 | 1670332 | `c228eb76c16af89f877d86073524757ba2541438` |
| mixed | 88 | 1397257 | `a05a2df211971d2b09134dca468d234140e8efb0` |
| csharp | 101 | 2065631 | `978719ac022c93b1095bd6e63a2e6aceb6af3227` |
| electron | 18 | 40842 | `9a927814308fb9a7e6cb32154ac827e513cb5ca2` |
| elixir | 108 | 774815 | `996428a499dd8e3bf2c4e26005d354ea86c65688` |
| ruby | 294 | 951210 | `48f1de1c65318935e423e289459705bdd7d796d3` |
| php | 127 | 1123755 | `d463b19718506be41992e3bcdded164ba0679c76` |
| swift | 287 | 1969905 | `227363e8c1b6a8d3894b64c6e504046577fcba0c` |
| android | 44 | 757000 | `524ee7cc207703893102b4fbe6bf96558002001c` |
| dart | 35 | 397626 | `4322479e70e27af129a39d24b6a7a6864cae6969` |
| flutter | 141 | 489342 | `accfc59ab84a141c1c1d6770a4371f0c38918896` |
| cpp | 149 | 3184209 | `a3488b1973343a3db3195eeae10cc46d017c5fa5` |
| zig | 22 | 128061 | `6a1ddb8e63e529822ce6fb22a6477c6d94c1b76b` |
| npmws | 23 | 45450 | `5c82e9ce27a0a2a2e72fcaa7bf930adbf5c0948d` |
| lfs | 188 | 11903767 | `2642c46281767c50f35bc95640edf446f45fb038` |
| history | 402 | 7484303 | `220b6fab63da4505d289cd9581107350309b49fd` |
| binaries | 1387 | 36082483 | `41883133ef9f8ad911c3b5ed7c16bb254e4519f0` |
| shapes-posix | 12 | 1350 | `b5a5ec29f31a3712460c020fbcb72854d361a72b` |
| shapes-bigbin | 8 | 56624304 | `1197ac7dcd23495d07da398ae520dd1af56066d0` |
| shapes-case | 6 | 946 | `04dfea9da55782cefd4e20d2283fd89d910d3a3a` |
| shapes-collide | 8 | 1018 | `732fc2a110e41c0a15840fa3d4d71d9431e9576a` |
| shapes-nonutf8 | unknown/refused | unknown/refused | not published |
| shapes-unicode | 6 | 919 | `bc1e24a2e36752e0bba9f07c0a2e2f37b71db306` |

## DB I/O and catalog reads

Continuous provider usage capture starts before fixture imports and continues through cleanup attempts and the report handoff. Permanent project purges are blocked by person-only authorization, as recorded below. It retains executions, DB read/write bytes and documents, egress and action GB-hours. Project-tagged totals below include fixture preparation, workloads, evidence reads and unsuccessful cleanup requests, rather than only the timed CLI windows. Untagged routing and owner-catalog reads remain in a conservative all-dev stream, which also includes peers and Forge source work and cannot be attributed exclusively to this run. Read-only authority/catalog preflight before stream attachment is outside capture. R2 signatures and logical purge bytes are not an executed-request invoice; R2 billing/storage and actual process peak RSS remain unmeasured. No causal byte/call reduction is claimed.

| Captured usage | Fixture-tagged total | Conservative all-dev total |
| --- | --- | --- |
| Executions | 24638 | 41058 |
| DB read bytes | 468364153 | 660244724 |
| DB write bytes | 74183020 | 109065200 |
| Documents read | 266600 | 404454 |
| Documents written | 46245 | 80311 |
| Egress bytes | 652175774 | 1281790625 |
| Action GB-hours | 0.435233 | 1.221243 |

| Fixture scope (all captured phases, including attempted cleanup) | Projects | Executions | DB read+write bytes |
| --- | --- | --- | --- |
| Initial full-pass projects | 25 | 13412 | 262549176 |
| Fresh qualification projects | 15 | 11226 | 279997997 |

The table is captured through attempted cleanup before the final report landing. Project purge I/O remains unrun. Subsequent report-governance work stays in the live budget meter and final handoff, rather than being backfilled into workload timings. Pre-job import refusals and untagged routing cannot be assigned to these project groups.

Missing usage fields: 0; capture closed early: no. Whole-task authorization is 60,000 executions / 1.4 GB DB I/O, with an 80% stop at 48,000 / 1.12 GB. The original 26-row pass has its own 30,000 / 0.7 GB ceiling including cleanup. Attempted-cleanup and qualification accounting is retained separately from timed operation windows; counters are observations, not account charges. Source/runtime paths add zero calls and zero idle work: fixes are harness-only. Fixture GitHub preparation performs one paged inventory plus calls per discovered workflow; no new production polling or service is introduced.

## CI accounting and fixture isolation

The declared 23 plain-GitHub comparisons succeeded and consumed **22.817 assigned job minutes**. The initial fixture setup also launched **61 inherited workflow runs**, including **14 failures** (Electron 4, Ruby 5, LFS 5), consuming **1245.933 assigned job minutes**. This exceeded the 250–500-minute pass forecast. Those jobs are part of the run’s overhead and remain reported; declared-scenario success does not erase them. All inherited runs are terminal. The custom-label `codspeed-macro` job was cancelled with no runner assigned; its 127.117 minutes of queued elapsed time is excluded from assigned-runner minutes. No paid/custom-runner execution was observed. These duration sums are not a billing statement. Forge check jobs and the separate fixture-isolation proof are additional overhead, retained by their run IDs.

Observed Forge-side CI accounting, including setup and optional source-pack jobs:

| Scope | Runs | Assigned jobs | Assigned job minutes |
| --- | --- | --- | --- |
| Initial fixture checks | 54 | 108 | 112.900 |
| Miss-only qualification checks | 32 | 64 | 98.533 |
| Source changes: two accepted checks and one withdrawal | 3 | 42 | 286.183 |
| Automatic verification, signing and dev web after source acceptance | 6 | 28 | 136.850 |
| Fresh-fork isolation proof | 1 | 1 | 0.067 |

All recorded source/fixture check identities are reconciled against GitHub metadata; missing known run IDs: 0. The intentional withdrawal remains cancelled. These job-duration sums exclude unassigned queued time and do not assert account billing. The final report landing and its subsequent automation occur after this table’s cutoff and remain in the final handoff.

The first qualified binary attempt’s resolved check ran commands for 4.164 seconds within a 115.400-second check window. Its runner source phase took 74.100 seconds, including 71.822 seconds fetching source objects, 0.622 fetching State, 0.043 writing and 0.184 verifying. This is attribution for that sample, not a matched causal comparison with the historical baseline. [The retained job](https://github.com/NanthAI/nanthai-forge/actions/runs/43751951954/job/132927638466) is linked on timing Issue `5d689e6e`.

The generic correction pauses Actions before fixture pushes. After all pushes complete, it enables workflow discovery, disables inherited workflows, and leaves only `zoo-ci.yml` active before returning the fixture. Enabling Actions emits no push event. Any incomplete discovery or disable failure pauses Actions again and fails preparation. The first fresh-fork proof exposed GitHub’s hidden inventory while Actions was paused; the pending landing was withdrawn before acceptance. The corrected fresh-fork proof observed no inherited push runs, one successful free Ubuntu comparison job and deletion/404 of its temporary fork. All original fixture source commits remained unchanged during manual isolation and qualification.

## Generic fixes and verification

- Issue `c3ba84eb`: retain declared nondefault upstream branches, set the fork default to the declared ref, and select that same full-history branch in every measured Git clone. This removes three duplicated clone argument lists rather than creating a repository-specific exception.
- Issue `2ba51fb8`: isolate declared CI on disposable fixtures and cover hidden/incomplete inventory and provider failures. Provisioning moves from the suite into one referenced module; no runtime API, public error, table, command or product restriction is added.
- Issue `127db380`: all 40 permanent-delete requests were refused by the existing owner-person authority boundary. Exact targets and retained operations are handed to the lead; no credential or policy change is made.
- Issue `c01d5457`: large-binary sample 2 retained a 600.129-second lost cohort finish wake, then recovered the original operation. Its C landing took 801.618 seconds. The exact stalled window contains 169 project-tagged executions and 4,237,090 DB read+write bytes; tags do not prove exclusive causal attribution. The retained owner is `cohort finish controller` with `finishWake: pending`. This source-engine finding stays open outside the brief’s stable-engine scope; no engine or timeout setting changed.
- Issue `5d689e6e`: retain the five initial misses and all five repeats per operation; no threshold relaxation or landing-engine change. Existing import/auth and storage follow-ups `2abda01f`, `537e73d9` and `8c4f126b` remain separate and are not closed by this green functional matrix. The already accepted teardown fix is reused.

The declared-branch setup fix landed as receipt `98b56679-78f6-4bd5-b80b-d0ff57bb97d0`, State `ffc89230c99271fc4b49914090d071222c1fcd903cde3fcf8b8049688d9477e9`: 1,084 hosted test files, zero failures/flakes, 99.150 job minutes. Both later harness changes pass 52 targeted tests. The final pre-report preflight passes 11 test files and four static checks in 24.8 seconds, peak RSS 435 MB. Landing `90bd69e9` was withdrawn after the fresh proof failed; it never became accepted source. Its check work remains rework, not a successful landing. Corrected harness fixes subsequently landed as receipt `01049f49-b76e-4d8f-ae4d-0d6d54bc3454`, State `e307fd7c09c9faeb889f74f48eb25cbda7ffc7d3dfa872912b075dc1df0cd70a`, with 1,084 hosted files and zero failures/flakes. A separate pull and all five named-file SHA checks matched accepted bytes. Saves reported two trial-merge conflict paths (suite and tests); canonical composition was clean and acceptance required zero recompositions. Three duplicated Git clone argument lists are merged, provisioning is extracted from the suite, and the report consolidates the superseded narrative.

## Source and runner qualification

The full pass used accepted harness State `ffc89230`; the normal CLI advanced to `af9dfb4381d43cf21490ad08965a01e3fd6c820b22fda216d209ddb39fc43803`. Executable `src/` and `convex/` TypeScript, package metadata and lockfile compare equal. Corrected Git replay and miss qualification begin with the saved, locally verified harness candidate; those exact bytes were accepted as e307fd7c during the cohort. The normal CLI advances from af9dfb43 to e307fd7c without a settings change; executable runtime and dependency bytes compare equal. Exact harness hashes and actual CLI heads are retained per sample. The runner runtime digest remains `9ede50f626dbaed5cae577f11c19a221cadb8541041201651bf6eb3af8ffc478`. Actual CLI heads and check sources are retained per batch/sample; matching runtime bytes do not imply identical complete checkouts or identical provider load. Node is 24.22.1. Timing holds the shared machine lock; global concurrency is two and disk stays above the 20 GiB floor.

## Rust check and overtake diagnosis

Landing wall time includes setup, runner scheduling and any additional check. Aggregate GitHub job time is not one Cargo command’s duration. Rust declares the same `cargo build --verbose --workspace` and `cargo test --verbose --workspace` on both systems; no Rust-only cache or timing exemption is introduced. The current full pass retains actual A/C order and its complete clocks above.

## Targeted admission-pipeline verification

The separate accepted admission-pipeline proof on [implementation `8105f2fe`](https://github.com/NanthAI/nanthai-forge/commit/8105f2fe9634051f256ce1e2c409b1d664cfff1d) qualified five actual Rust C overtakes: 90.210, 96.377, 91.263, 83.292 and 95.507 seconds. Median 91.262979 seconds is 1.107477× the unchanged 82.406232-second baseline, below its 123.609348-second bar. All ten passed run-plan heads equal accepted heads, and each C Candidate names A’s exact accepted base/receipt. The proof used two full checks per pair rather than three and the same runtime digest. It remains a targeted path proof, not an isolated causal performance comparison: historical baseline source identity is unknown. Its six disposable projects completed purges and both forks were deleted; its separate usage ledger is not mixed into this rerun’s totals.

## Cleanup and limits

All 26 original public fixture forks are deleted and absence is verified; both sequential fresh-proof forks were also deleted, as was the first failed PHP setup fork before its recreation. All 40 task-created dev projects remain active. Each permanent-delete request was refused with PROJECT_UNAVAILABLE because the device credential is an agent, and deletion requires the owner person in a browser. No project purge began or completed. Ownership was verified before allocation, but person-only deletion authority was a missed precondition. Credential, environment, retention and policy settings were not changed. Cleanup remains incomplete pending the supported owner-person operation; exact targets and retained request identities are in the private handoff. The user explicitly leaves the owner-person cleanup step with the lead.
