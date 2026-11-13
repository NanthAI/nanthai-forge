# Sync and resolve cost decomposition

Issue `6fbba986-3b78-439d-878d-afbd66510414` owns the remaining single-operation gap.
Live dev profiling exposes repeated descriptor/R2 rounds on legacy recipe States,
alongside the flat-State CPU and local-apply floor. Both source readers now use the
existing batched recipe preparation path. This removes unnecessary descriptor
rounds; it is not a measured hosted speedup.

State identity remains the SHA-256 of the exact flat manifest, including its
parents, message and time. The existing clean-sync reply delta remains in place.

## Live dev observations

[The live dataset](../../tests/fixtures/sync-resolve-live.json) retains ten interleaved
shape pairs: odd pairs run 4k then 29k, even pairs reverse; each shape runs clean
sync, conflict sync and its source-only resolve. This is exactly **30 operations per
shape**, the authorized bound. Each plain directory has 4,000 or 29,000 deep paths
and a shared synthetic file body. The target changes one file; the clean Lane
changes a second file, and the conflict Lane changes the target's line. Setup,
fixture saves and cleanup are outside the operation clocks. No Git commands were
issued directly; a host-status probe unexpectedly attempted Git metadata and its
failure is recorded as friction. No benchmark, smoke, zoo rerun, manual deployment
or paid service was used.

The target is an exact clean Candidate on the common hosted main, avoiding a checked
landing solely to prepare this experiment. The CLI trace confirms its normal
current-main read still happens. Resolution includes its ordinary save, source
resolution and checkout apply; it excludes the next checked landing. These are
comparable source paths, not a repetition of the zoo's complete scenario.

The installed CLI and Node 24.22.1 ran the real public Lane operations. The existing
fetch observer now also records first-network wall/CPU and HTTP methods, without
URLs, headers, credentials or source bodies. Full receipts supply source clocks;
provider completion logs retain each nested function wall and billed usage metadata.
All recorded source steps match their receipt steps; no usage fields are missing.
The first 4k clean receipt was compact, so its client phase split is unknown. One
read outside the timing window recovered its immutable server timing; replay apply
timing is not substituted. Its original total and every RPC wall remain included.

These are **N=10 observations**, below the eleven-pair reference, with no before/after
runtime claim. No timed sample was dropped or replaced. Load ranged
4.2–19.7 on ten logical CPUs;
swap used ranged 5.53–6.93 GiB.
Every sample retains both endpoints. Later pairs repeat the initially busy shape
under lower load, within the bound. CLI releases changed automatically; the dataset
names each receipt's build and records hashes of the selected recipe, source
transport, sync and apply modules. Those selected modules were unchanged across
those builds; this is not an attestation of the complete deployed graph. A hold on
other builders was not introduced. Initial nesting, driver and save-wait failures
are disclosed under setup. A disk-floor pause removed only owned regenerable
fixture copies before resuming; it discarded no timed operation.

All following times are **seconds**, medians over ten observations, except the first
4k clean client apply is absent (N=9). Columns overlap and do not add to total.
CLI-to-first-fetch is process-origin wall, not CPU; the dataset also retains CPU
and the small spawn-to-process-origin difference. Source wait includes boot; boot
must not be added again. Resolve's source columns describe the resolve job alone,
while its total also includes the nested save.

| Shape / operation | Total CLI | CLI to first fetch | Source wait (includes boot) | Source run | R2 read in flight | R2 write in flight | Nested RPC in flight | Apply / guidance |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 4k clean sync | 5.98 | 0.31 | 0.46 | 1.74 | 0.42 | 0.73 | 0.40 | 0.39 |
| 4k conflict sync | 8.56 | 0.26 | 0.44 | 3.35 | 0.68 | 1.36 | 0.67 | 1.57 |
| 4k resolve | 9.38 | 0.28 | 0.45 | 2.18 | 0.73 | 0.71 | 0.59 | 1.40 |
| 29k clean sync | 14.89 | 0.41 | 0.45 | 8.39 | 2.19 | 1.96 | 2.59 | 1.66 |
| 29k conflict sync | 28.02 | 0.46 | 0.88 | 19.24 | 4.16 | 2.44 | 4.90 | 2.44 |
| 29k resolve | 23.40 | 0.51 | 0.84 | 8.53 | 1.70 | 1.83 | 1.45 | 2.88 |

The large host bootstrap is a **legacy recipe-backed State**, unlike the raw-State
local fixture below. The source writer's new large States remain flat. Resolving
that legacy recipe's page and leaves explains the extra descriptor rounds, and
conflict recomputation reads it in a second action. The current source readers
also retain the flat parse/build/hash and full-tree local validation work.

| Shape / source job | Timed read / write opens | Nested calls | Attempted PUT body MB | Wall outside measured I/O, bounds |
| --- | ---: | ---: | ---: | ---: |
| 4k clean sync | 3 / 2 | 2 | 0.649 | 0.09–1.09 |
| 4k conflict sync | 6 / 4 | 3 | 0.650 | 0.72–1.97 |
| 4k resolve | 4 / 2 | 3 | 0.649 | 0.13–1.40 |
| 29k clean sync | 10 / 2 | 11 | 4.699 | 1.67–5.92 |
| 29k conflict sync | 23 / 4 | 23 | 4.705 | 7.51–14.19 |
| 29k resolve | 7 / 2 | 7 | 4.702 | 3.40–5.41 |

Read opens are the source transport's streaming reads; writes are its timed output
stores. Direct durable-cursor I/O and retries are not all in these clocks. The raw
receipt also retains action-local signed class A/B counters: descriptor-signed GETs
run in separate mutations, so its B count is **not** the complete R2 GET count.
Step-marker read-work bytes can count logical reconstruction and cached work, so
they are not asserted to be physical GET bodies. PUT body counters include cursor
and result bodies and are not provider egress. Pure compute cannot be recovered by
subtracting read, write and call clocks: they overlap and include consumer work.
The bounds above are `max(0, run−read−write−call)` to
`run−max(read,write,call)`, summed per step; they describe unattributed wall,
not an exclusive CPU measurement. The earlier local handler CPU is a separate
measurement. This is a material remaining qualification on the full decomposition.

The dominant live path is the sequence of source descriptor/R2 operations and
flat-State processing, rather than CLI spawn or a per-file RPC inventory scan.
At 29k the descriptor waits alone account for seconds, and conflict adds an action
and repeated manifests. At 4k those waits are smaller, but source startup, input
upload and output publication still sit on the critical path. These measurements
name the current cost; they cannot allocate the historical zoo's 4.3-second gap
arithmetically because that 4.9/0.6-second cohort has different shapes, network and
cache conditions. Source-only resolve must also stay separate from the zoo's
83.6-second resolve-to-main row.

The paired 29k-minus-4k wall differences below use seed 1 and 10,000 bootstrap
resamples. Pair values and intervals are retained with the raw data. They compare
repository shapes, **not a new performance gain**; their intervals do not cover
load, swapping, network conditions or the disclosed version drift.

| Operation | Median shape difference, s | 95% bootstrap interval, s |
| --- | ---: | --- |
| clean | 8.84 | [6.01, 11.28] |
| conflict | 18.97 | [16.82, 20.68] |
| resolve | 13.86 | [12.80, 15.33] |

### Live usage and placement

The following medians cover project-attributed completion events within each CLI
operation window, including the CLI and resolve's save. Background overlap work
for the same project can be in that window; the raw data separately identifies the
merge-step execution subtree. Function walls nest and are not summed into elapsed
time. These are provider billed-usage metadata, **not an invoice** or measured
post-fix savings.

| Shape / operation | Provider executions | DB read / write B | Network egress MB | Action GB-s |
| --- | ---: | ---: | ---: | ---: |
| 4k clean sync | 13 | 185,360 / 50,877 | 0.693 | 1.393 |
| 4k conflict sync | 20 | 211,876 / 54,932 | 0.701 | 2.139 |
| 4k resolve | 21 | 372,732 / 109,908 | 1.341 | 1.602 |
| 29k clean sync | 22 | 300,736 / 50,876 | 4.810 | 4.950 |
| 29k conflict sync | 45 | 532,450 / 60,915 | 4.915 | 10.652 |
| 29k resolve | 42 | 644,697 / 124,553 | 9.555 | 7.006 |

All sampled Convex storage read/write byte counters were zero. Bounded unsigned
descriptor reads separately confirmed raw State and recipe-metadata placement in
R2, with no Convex locations; the 29k root recipe had no trusted closure projection.
The placement sample and its coverage are retained in the dataset. Client process
RSS is retained per sample; source allocation used for action billing was 512 MiB,
which is not a measured isolate heap. No cache or memory bound is raised.

## Local reference method

[Raw synthetic observations](../../tests/fixtures/sync-resolve-costs.json) retain all
three repeats, clocks, CPU, calls, bytes, load and swap. Node was 24.22.1. The built runtime and
installed CLI were pinned to State
`f9128ed455e032702fa4cd8c2aee3b81795e6c04c15af9b9c060bda5851faa23`.
The measurer was saved at State
`9f12cc66cd91d580732ee1d2d5af419a321de195287dc9db2b6f091fa4831ddd`.
The measurements change no runtime implementation.

The source fixture runs real Convex function handlers in fresh child processes, with
an in-memory transaction store and R2 transport. It submits kernel jobs as
`register-state`, not full public Lane operations; it does not measure the sync/save
prepare or final Lane CAS. Each shape has one shared file body,
4,000 or 29,000 deep paths, one changed path on each branch, a common parent and one
main advance. Its flat manifest is 648,180 or 4,698,180 bytes. The latter is deliberately
outside the existing 1–4 MiB bounded recipe writer; this is a file-count shape, not a
byte-for-byte copy of any zoo repository. Results cannot be generalized to recipe
States or every 29k repository.

For each repeat run clean sync, conflict sync and its source-only resolve. Shape order
alternates 4k/29k, 29k/4k, 4k/29k. Separately, a full local checkout changes one path
and alternates ordinary apply (A) and the existing live delta (B): AB, BA, AB. Setup is
excluded; the verified machine cache stays enabled. Finally the installed CLI is
stopped before its first network request by the existing first-network preload.
No benchmark, smoke, production operation, deployment or zoo rerun was performed.

These are **N=3 observations**, under substantial concurrent load: one-minute load
13.9–15.2 for the source samples, with 5,924–5,973 MiB swap used. No sample was voided
or silently dropped. The earlier exploratory source invocations are outside this
three-repeat dataset: two complete clean/conflict/resolve sets at 4k and one at 29k;
the first had only aggregate counters. Their observations led to adding the fuller
counters; they are not before/after measurements. The measurement script also failed
once before any sample due to a local import path, then ran successfully.

The [performance-claims rule](../agents/perf-claims.md) applies. There is no candidate
speedup here. Three pairs do not meet the eleven-pair reference; the intervals below
cover resampling only, not concurrent load, cache differences or hosted latency.

## Source operation phases

All times below are local milliseconds, medians of the three repeats. A source action
loads the handler graph and then runs the step; the fixture's `waitMs` includes fresh
process/module startup. It is not a measurement of a hosted scheduler or cold start.
`workCpuMs` includes State parse/hash/build/merge and orchestration, not merge alone.
The R2 and nested-call clocks can overlap; their sum must not be subtracted from wall
time to invent an exact compute duration. Per-step phase/stop reasons remain in the
raw observations.

| Shape / source operation | Wall | Handler CPU | Step run | Step wait/start | Nested calls in flight | R2 reads in flight | R2 writes in flight |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 4k clean sync | 578 | 218 | 154 | 416 | 13 | 37 | 37 |
| 4k conflict sync | 837 | 387 | 337 | 450 | 22 | 46 | 41 |
| 4k resolve | 755 | 267 | 261 | 427 | 12 | 55 | 44 |
| 29k clean sync | 1,457 | 788 | 925 | 387 | 35 | 86 | 185 |
| 29k conflict sync | 2,490 | 1,826 | 1,735 | 746 | 61 | 124 | 184 |
| 29k resolve | 1,694 | 1,082 | 858 | 828 | 35 | 93 | 185 |

The 4k job pays more for local fresh-process startup than its step body. At 29k,
flat-State work dominates CPU and bytes. Conflict sync and resolve finish their small
inline text/marker calculation, yield with `stop:recompute`, then read the large
manifests again in a fresh action. The 8 MiB action byte cache and the fresh-heap
boundary explain the repeated bytes; raising those bounds without memory evidence
is not a root fix. Peak source-process RSS across the retained repeats is at most
344 MiB. Node RSS is not a Worker heap measurement and does not decide S8a's kill rule.

## Calls, database I/O and byte placement

Counters cover the source job; CLI capabilities/main/prepare/upload, the caller's save
for resolve, final Lane publication outside the fixture and subscriptions are not
included. DB bytes are serialized fixture documents, not provider billing. GET/PUT
bytes are attempted R2 bodies, not headers, signatures, HEAD requests or invoices.
The small control data stays in Convex and all source bodies stay in R2.

| Shape / source operation | Actions | Convex function calls | Descriptor calls | R2 GETs / bytes | R2 PUTs / bytes | DB read / write bytes |
| --- | ---: | ---: | ---: | --- | --- | --- |
| 4k clean sync | 1 | 6 | 2 | 4 / 1,944,871 | 2 / 648,552 | 41,034 / 20,132 |
| 4k conflict sync | 1 | 7 | 3 | 7 / 1,945,017 | 4 / 649,737 | 45,270 / 22,071 |
| 4k resolve | 1 | 7 | 3 | 5 / 1,297,901 | 2 / 648,940 | 45,219 / 19,651 |
| 29k clean sync | 1 | 7 | 3 | 4 / 14,094,873 | 2 / 4,698,553 | 44,750 / 20,290 |
| 29k conflict sync | 2 | 14 | 7 | 11 / 28,194,434 | 5 / 4,704,683 | 71,051 / 26,975 |
| 29k resolve | 2 | 14 | 7 | 9 / 18,798,150 | 3 / 4,702,024 | 70,879 / 24,249 |

Idle after each drained job makes zero function calls and zero object reads. The
source fixture does not run future operational-expiry tasks; those are outside idle
source work and outside this measurement. No live billing reduction is claimed.

## CLI and local apply

CLI CPU before the first fetch is 407/452/459 ms for sync and 473/445/467 ms for resolve
(medians 452 and 467 ms). This is startup to first-network CPU, not end-to-end CLI wall.
The live section above now records the real command's capabilities, preparation and
nested-call walls. These earlier CPU probes remain a separate local reference.

| Shape | Ordinary / live apply pairs, ms | Median paired B minus A | 95% bootstrap interval |
| --- | --- | ---: | --- |
| 4k | 465/384, 359/348, 352/323 | −29 ms | [−81, −11] ms |
| 29k | 1,471/1,479, 1,495/1,443, 1,541/1,640 | +8 ms | [−52, +99] ms |

Intervals use seed 1 and 10,000 resamples. The 29k timing difference is not
distinguishable from no change. Both rows are small-sample observations of existing
paths, not a newly delivered performance gain. Full-tree validation and local State
reconstruction still scale with the flat file list even when transfer is tiny.

At 4k, ordinary apply downloads the 648,000-byte State plus the 15-byte changed file;
live apply downloads only those 15 bytes, with one descriptor window and the final
current-access fence. At 29k, ordinary apply downloads the 4,698,000-byte State and
live apply downloads nothing: the same synthetic changed blobs are already verified
in the machine cache from the 4k run. Cache hits need no new descriptor or access read.
A separate guard uses fresh changed bytes and allows either a verified hit or at most
one changed-file transfer. Neither live path downloads an unchanged file or a State.

## Generic fix and remaining S5 saving

Both `MemorySourceReader` and `SourceWorkerReader` called `readObjectRecipe`
without its existing bounded preparation callback. The shared recipe iterator
already supplies the current node and up to 99 known siblings. Passing that window
to the transport in disjoint windows removes a separate descriptor RPC for each leaf, keeps every
physical and whole-object hash check, and prefetches no bodies. Transports without
preparation remain supported. Only the current window’s at most 100 pin identities are retained;
a moving one-leaf lookahead must not turn later windows back into point calls. This fixes the class for every recipe-backed source
object and every project, without a new format or another tree representation.

On the 4,698,137-byte synthetic State, each reader's guard failed before the fix:
8 descriptor windows. The fixed readers use 3 windows and the same 8 physical
reads, with byte-identical output. Existing raw-State source guards remain unchanged.
A separate 128-distinct-leaf guard fails with a sliding window (31 descriptor
rounds) and passes with four disjoint rounds, still reading the same 130 physical
objects. The new negative cases retain corrupt-leaf rejection and propagate current-access
failures. No new access restriction or user step is introduced. The fix's hosted
latency and billed-usage delta are **unrun**: no deployment or extra samples beyond
the brief's bound were authorized.

The only remaining placement link is [S5 Issue e7e35328](https://nanthai-forge-dev.netlify.app/?project=mh7aafndrxmj8c2q0931zbjk2n8h4ffs&projectTab=planning&planningItem=e7e35328-7730-436a-b229-ba11d6362987).
[S8a's memory verdict](workers-source-step-spike.md) closed Option B and S8b; this
finding does not reopen them or propose a service beside R2. Moving the descriptor
manifest alone does not remove flat-State CPU, source body PUT egress or repeated
State reads.

The model below uses each source job's observed nested-call wall divided by its
call count. The callback fix removes five legacy-recipe rounds on the 29k clean
path and ten on its two-action conflict path. Resolve's measured source inputs
are already raw, so no recipe-round saving is assigned there. S5 then assumes one
bulk grant round per source action. These are **gross addressable waits**, before
S5's new manifest GET and verification cost, not additive measured speedups or a
net saving. The same physical State/body reads remain. A separately authorized
paired deployed run must judge the actual change.

| Shape / job | Fix rounds removed | Modelled fix wait, s | Further S5 rounds removed | Gross S5 wait, s |
| --- | ---: | ---: | ---: | ---: |
| 4k clean sync | 0 | 0.00 | 1 | 0.20 |
| 4k conflict sync | 0 | 0.00 | 2 | 0.45 |
| 4k resolve | 0 | 0.00 | 2 | 0.40 |
| 29k clean sync | 5 | 1.18 | 5 | 1.18 |
| 29k conflict sync | 10 | 2.13 | 11 | 2.34 |
| 29k resolve | 0 | 0.00 | 5 | 1.04 |

Nothing here can make the full flat manifest disappear under the current State
identity. The raw local body table remains useful as byte exposure, but its old
conditional S8 saving is no longer an actionable placement proposal. S5 owns the
bounded descriptor saving above; the rest remains an explicitly measured floor
and an open attribution question, not a reason to revive trees in packs.

## Guards and open evidence

`tests/sync-resolve-cost-guard.test.mjs` runs both shapes. It asserts bounded control
calls per action, at most two actions for these changes, batched descriptor calls,
fixed DB metadata bytes, GET bytes bounded by 3/6/4 flat manifests plus changed-path
allowance, bounded State/progress PUT bytes and zero idle work. Eight disjoint changed
paths use the same control-call window as one. Client apply is guarded separately:
only the changed body can transfer; missing delta still verifies the exact State.
These are regression assertions, not product limits or new user obligations.

Plain-directory hosting is now fixed and both live projects were created without
Git. Cleanup outcomes are tracked on the Issue. The nested-clone address
failure and immediate save-wait failures were linked to their existing planning
Issues; neither is silently counted as a timed sync failure.

Acceptance remains qualified:

- Live CLI totals, individual RPC walls, nested source-step spans, logical work,
  attempted PUT bodies, full client apply and provider usage are retained. Exact
  exclusive compute versus R2 wait and physical GET/HEAD body accounting remain
  unmeasured; overlapping counters are not substituted for them.
- The generic descriptor fix is guarded locally; its deployed paired latency and
  billed-usage delta remain unrun. S5 has the conditional gross wait estimate above.
  Option B stays closed.
- The **next zoo comparison stays unticked**. It must report sync and source-only
  resolve separately from the checked landing, alongside resolve-to-main and Git
  equivalents. No new zoo, smoke or benchmark was run here.

This change removes per-leaf descriptor round trips by sharing the existing
preparation window in both readers. It adds no Convex call, table, public command,
service, State format, source-body buffer, user obligation or product restriction.

## Conflict recovery source path

The exit-bench incident supplied four complete operation windows. The two syncs
spent 41.756 / 54.727 seconds in the CLI; their phase clocks account for
39.909 / 52.606 seconds. Both were Candidate-resolution syncs. Their source steps
spent 24.050 + 10.485 / 35.788 + 10.762 seconds, with 101 + 18 / 185 + 18
read opens. The first steps alone had R2 reads in flight for 14.923 / 25.724 seconds.
They stopped for `recompute`, then loaded the same three State manifests again.

The two resolves spent 28.294 / 28.556 seconds in the CLI. Their phase clocks were
26.609 / 26.680 seconds: save 9.893 / 10.243, source submit 0.948 / 0.929,
source wait 12.849 / 12.330, apply 2.169 / 2.424, selection 0.750 / 0.753.
The source jobs each repeated their two large States in a second action; their
step walls were 6.362 + 5.701 / 6.139 + 5.820 seconds. Save itself had one source
action (5.409 / 6.300 seconds). CLI startup, capability reads and command teardown
are outside those phase clocks, accounting for the remaining 1.6–2.1 seconds.
These observations do not identify that residual as pure CPU. The retained read,
write and call clocks overlap; none is an exclusive compute clock.

Filtered, read-only inspection recovered the second sync's missing server timing
from its original operation. Selected ancestry rows already had recorded parents,
generations and physical manifests. The extra reads were not missing parent
metadata: ordinary descriptor lookup tried the physical file manifests of every
cached ancestor. Those manifests do not contain State descriptors. Searching one
new object could therefore open dozens of unrelated R2 roots and buckets.

The source transport now excludes ancestry hints from file-binding lookup and
sends known State descriptors directly to the existing catalog page. Selected
file manifests and catalog fallback keep their existing integrity and access
checks. Descriptor-only graph probes share the existing four-window allowance;
body acquisition still obeys the original byte windows.

Small text calculations now discard tentative generated outputs and replay on
the same verified, parsed inputs, rather than allocating another input tree. Input
sets above two existing 8 MiB windows keep the fresh-action path. Small resolve
pages validate markers while their saved and draft States are already loaded.
Large pages, created-blob dependencies and the time boundary retain continuations.
Resolve also reconstructs its metadata-only final State from the verified saved
checkout and pinned resolution receipt. The existing delta hash check proves the
exact bytes; a legacy or mismatching encoding retains exact-State download.
No State encoding or identity, repository limit, user step, timer or policy changes.

### Local count and byte guards

The 60-ancestor lookup fixture failed before the fix with 60 R2 probes for a State
and 61 for one file. It now permits zero for the State and three for a file found
in the second of two explicitly selected States. Missing membership still reaches
the catalog access fence. The new speed thresholds live in
[`src/speed-budgets.json`](../../src/speed-budgets.json).

The following are real-handler/R2-fake observations on the same 29k, 4,698,180-byte
raw-State shape. They exclude the CLI, prepare, save-before-resolve and final Lane
publication. DB byte counts are serialized fixture accounting, not billed usage.
Existing call, query, byte and cost guards have not been relaxed.

| Source operation | Actions before → after | Convex calls before → after | DB read / write B before → after | R2 GET body B before → after |
| --- | ---: | ---: | --- | ---: |
| clean sync | 1 → 1 | 7 → 6 | 46,037 / 21,820 → 42,324 / 21,656 | 14,094,873 → 14,094,873 |
| conflict sync | 2 → 1 | 14 → 7 | 72,523 / 28,470 → 46,584 / 23,603 | 28,194,434 → 14,095,019 |
| source-only resolve | 2 → 1 | 14 → 7 | 71,712 / 24,823 → 45,751 / 20,212 | 18,798,150 → 9,397,902 |

Conflict sync PUT bodies fall from 4,704,683 to 4,699,738 B; resolve from
4,702,024 to 4,698,941 B, by removing continuations. Idle executions remain zero.
The qualified 29k action peak observations were 346 MiB for conflict sync and
248 MiB for resolve; these are fresh local process high-water marks, not deployed
isolate heap measurements. Larger-tree memory routing remains in place.

### Paired source-kernel CPU

[`measure-conflict-reentry.mjs`](../../tests/measure-conflict-reentry.mjs) compares a
frozen installed baseline with the Lane build. The
[raw pairs](../../tests/fixtures/conflict-reentry-pairs.json) retain eleven AB/BA
pairs per shape and operation, exact output hashes, CPU, wall and load. Both
implementations produced identical output bytes in qualification and all 44
measured pairs; no sample was voided. Module load, fixture setup, Convex transport,
network, checkout and action cold starts are excluded. Each run starts a new object
map, retaining no prior calculation cache. Process RSS in that dataset is cumulative
and is not attributed to either build. Concurrent machine load and GC remain outside
the bootstrap interval's coverage.

Milliseconds; interval is the median paired candidate-minus-baseline CPU difference,
10,000 resamples, seed 1. These results establish a local kernel CPU change, not a
hosted latency or billed-cost improvement.

| Shape / operation | Baseline median CPU | Candidate median CPU | Paired difference, 95% interval |
| --- | ---: | ---: | --- |
| 4k conflict sync | 53.8 | 43.5 | −10.3 [−16.9, −7.4] |
| 4k resolve | 30.5 | 17.3 | −13.6 [−15.1, −4.3] |
| 29k conflict sync | 466.5 | 371.6 | −93.0 [−98.8, −83.8] |
| 29k resolve | 272.8 | 156.0 | −123.6 [−126.4, −112.3] |

### Complete-operation target

A fresh private dev reproduction has 29,000 synthetic paths and a 4.84 MB manifest,
one conflicting path and no checked landing in its source-resolution clock.
The installed baseline took 23.140 seconds for conflict sync and 19.310 for resolve
(N=1, exploratory). Sync phase time was 21.404 seconds: submit 10.222, source wait
8.686, conflict apply 2.149 and settle 0.347. Resolve phase time was 18.097 seconds:
save 6.179, submit 1.181, source wait 8.587 and apply 2.150. Source work again used
two actions. This light ancestry differs from the incident's larger cached history.
The separate save and resolve still publish two full flat States. The local paired
kernel result alone cannot establish the complete ten-second target or Git parity;
post-acceptance dev evidence belongs with the Issue's exact runtime and request ids.
