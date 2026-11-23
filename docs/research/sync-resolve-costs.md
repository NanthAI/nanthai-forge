# Sync and resolve cost decomposition

Issue `6fbba986-3b78-439d-878d-afbd66510414` owns the remaining single-operation gap.
The current 4k/29k full-path cohort identifies source submission, serial recovery,
R2 transfer and flat-State processing as the dominant elapsed path. Separate local
native-work clocks do not establish exclusive provider CPU attribution.

State identity remains the SHA-256 of the exact flat manifest, including its
parents, message and time. The existing clean-sync reply delta remains in place.

## Current full-path observations

The [current dataset](../../tests/fixtures/sync-resolve-decomposition.json) retains
**11 alternating 4k/29k pairs**, each with one single-path conflict sync and its
source-only resolve: **44 successful timed operations**, none repeated or discarded.
Resolve includes saving the edited marker file and applying the final State; it
excludes the subsequent checked landing to main. Setup, Lane opening and cleanup
are outside both operation clocks. Each operation uses the same saved left/right
inputs for its shape and a fresh process of the approved installed CLI. The shapes
contain 4,000 and 29,000 deep paths with shared synthetic bodies.

CLI State `f65c824c` matches the deployed mirror `ba5393ca`; automatic dev deployment
[43733046198](https://github.com/NanthAI/nanthai-forge/actions/runs/43733046198)
completed before the first timed command, and the final deployment read retained
that revision. Timing held the shared machine lock. Node was 24.22.1; one-minute
load ranged 2.32–6.15 on ten logical CPUs. Raw observations retain load and swap.
This compares repository shapes on one build; it is **not a before/after speedup**.

Seconds, medians over eleven observations. Source columns include the save and
resolve source steps together for recovery. They overlap the client phases and
each other; they must not be added to total or subtracted as exclusive CPU.

| Shape / operation | CLI total | Process to first fetch | Source submit / save phase | Local apply | Source run | R2 read in flight | R2 write in flight | Nested calls in flight |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 4k conflict sync | 7.031 | .149 | 4.911 | 1.192 | 2.896 | .868 | 1.151 | .600 |
| 4k source-only resolve | 8.094 | .139 | 7.321 | .229 | 3.392 | 1.207 | 1.394 | .740 |
| 29k conflict sync | 14.531 | .319 | 10.510 | 1.848 | 8.344 | 2.705 | 1.739 | 1.210 |
| 29k source-only resolve | 13.778 | .310 | 11.479 | .877 | 6.811 | 2.336 | 2.254 | .779 |

The dominant elapsed path is **source submission and serial save/resolve control,
R2 transfer and flat-State processing**, rather than CLI startup. The dataset
retains every client HTTP call's function, method, status and wall to headers,
and every attributed provider execution's function and wall. Internal action and
nested-call spans overlap. Header spans exclude response-body consumption and
WebSocket observation. Receipts retain the full server/client phase split; resolves
retain their save split separately. No exclusive provider CPU is inferred.

The paired 29k-minus-4k CLI difference is **7.678 s [7.050, 10.112]** for sync and
**5.784 s [5.214, 7.099]** for resolve (median difference, 95% bootstrap interval,
10,000 resamples, seed 1). Both intervals exclude zero. They establish the size
penalty in this cohort, not a causal engine change. Network, load, GC and fixture
layout differences remain outside the interval's coverage.

### Separate native State work

The existing real-handler fixture now optionally measures synchronous
`MemoryMergeSource` parse, metadata merge and State encode/hash work. An outer call
owns nested work once; asynchronous network waits are excluded. This is a **local
replay**, not exclusive deployed CPU or the whole action's compute. Text calculation,
transport hashing, recipe work and other processing outside those methods remain
outside this narrow clock.

| Shape / operation | Native synchronous wall, ms | Process CPU in those spans, ms | Handler CPU, ms |
| --- | ---: | ---: | ---: |
| 4k sync | 24.7 | 42.4 | 109 |
| 4k resolve | 14.1 | 26.6 | 76 |
| 29k sync | 151.4 | 187.3 | 397 |
| 29k resolve | 81.2 | 107.0 | 260 |

Eleven alternating measurement-off/on pairs per shape preload identical modules;
every sync and resolved State hash matches. Instrumentation wall/CPU differences
are not distinguishable from no change in every final interval. Earlier probes
front-loaded different lazy imports; they are exploratory, retained privately and
excluded from these comparisons. Process CPU can exceed wall through runtime
threads. These numbers cannot be substituted for provider compute seconds.

### Calls, bytes, idle and placement

Provider medians count project-attributed, uncached completions during each CLI
window; they include wrappers and controls, unlike the narrower source guard.
DB I/O is provider usage metadata, not a cumulative invoice. Source PUT bodies are
attempted State/progress/result/other bodies, not total egress. R2 signed requests
include unused descriptors and are **not complete executed physical GET/HEAD/PUT
counts**. No billed-saving claim is made.

| Shape / operation | Provider executions | DB read / write bytes | Source read / write opens | Attempted source PUT bytes | Signed R2 A / B |
| --- | ---: | ---: | ---: | ---: | ---: |
| 4k sync | 16 | 209,276 / 52,507 | 8 / 4 | 669,646 | 5 / 14 |
| 4k resolve | 16 | 386,210 / 106,186 | 7 / 4 | 1,337,527 | 6 / 13 |
| 29k sync | 19 | 275,185 / 68,267 | 16 / 10 | 3,200 | 8 / 47 |
| 29k resolve | 17 | 401,930 / 122,277 | 18 / 14 | 4,891 | 14 / 74 |

The 29k writer reuses byte-range recipe chunks; 4k remains below that writer band,
so physical PUT bodies need not increase with logical manifest size. All sampled
saved-tip rows (four) point to R2; none uses Convex file storage. Every provider
window reports zero Convex storage read/write bytes. An **82.2-second quiet window**
after the cohort recorded **zero fixture executions and zero DB read/write bytes**.
All 363,000 physical file reads across the 22 resolved checkouts match the expected
contents, with an identical file/mode vector per shape.

The cross-size guard compares one and eight changed paths directly: growing from
4k to 29k adds **zero control calls, descriptor windows or body requests**; GET
increase is bounded by three flat manifests plus 4 KiB of encoding, PUT increase by
two manifests plus 4 KiB, with bounded metadata I/O and zero idle calls. Existing
per-shape, legacy-recipe, recovery, access and exact-State guards stay in place.
No runtime, State identity, routing bound, service, policy or user step changed.
The report replaces the older full-path observation section and extends the
existing measurer rather than adding another source engine.

### Remaining evidence and cleanup

Done-when 1 remains qualified: exclusive provider compute and complete physical
R2 request/body attribution are still unavailable from the current clocks. The
separate native replay narrows the question without claiming that attribution.
The existing [S5 placement finding](placement-review.md) remains the design-review
route; no new engine work or tree-root identity is proposed. The full ten-second
and Git-parity targets are not established by this source-only cohort.

The accepted zoo reporter already emits sync and resolve Forge/Git medians
(`scripts/bench-zoo/suite-lib.mjs`). Zoo resolve includes landing to main and must
remain distinct from source-only resolve here. Its concurrent rerun stopped before
provision because its 15k–30k execution forecast exceeds its brief's few-thousand
budget (Issue `70a9bd2f`); **no fresh zoo comparison is supplied**. The compound
Done-when 3 stays open for that owner/lead budget decision and run.

All 46 synthetic Lanes are abandoned and both active lists are empty. Two dev
synthetic projects remain: permanent deletion was refused to device credentials
with `PROJECT_UNAVAILABLE`, requiring an owner-person session. Exact cleanup
identities are in the private handoff; no access boundary was bypassed. Save-wait
and cleanup-addressing friction are linked on existing Issues `75b4d062`,
`31392506` and `470ef29b`. No production operation, manual deployment, setting
change, backup or export was performed.

## Earlier local reference method

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

The only remaining placement link is [S5 Issue e7e35328](https://dev.forge.nanthai.tech/?project=mh7aafndrxmj8c2q0931zbjk2n8h4ffs&projectTab=planning&planningItem=e7e35328-7730-436a-b229-ba11d6362987).
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
The separate save and resolve still process whole logical States. The local paired
kernel result alone cannot establish the complete ten-second target or Git parity;
post-acceptance dev evidence belongs with the Issue's exact runtime and request ids.

## Legacy recipe replay and multi-MB recovery

The fixed reader assembles a legacy recipe into one logical buffer and retains
verified leaf views into that buffer. It counts distinct backing allocations for
inline replay, preserving the 16 MiB routing bound. Exact parsed States also
supply sync deltas without a second complete parse. A bounded save reads its baseline and first delta page in one wave. State content
and its derived file-binding manifest publish concurrently and settle together before their
bindings become visible. Failure of either keeps publication incomplete.

The existing path-anchored recipe writer covers 1–8 MiB States, with the same flat
identity and recipe format. States outside that band, cold baselines without
verified reusable bindings, and representations with no byte saving keep the
flat writer. This adds no control RPC or idle work. The owner approved the extra
physical binding work for this extension.

The synthetic real-handler fixture executes conflict sync from a legacy recipe
base, then an actual one-path save and source-only resolve at 29,000 files.
Eleven interleaved AB/BA pairs retain identical logical sync, saved and resolved
State hashes. Protocol result hashes can differ because their exact input pins
bind different physical recipes. Raw pairs are in
[`sync-resolve-recovery-pairs.json`](../../tests/fixtures/sync-resolve-recovery-pairs.json).
This is local DB/R2 accounting, excluding deployment latency, CLI checkout and
invoices.

| Source operation | Function calls before → after | GET body bytes before → after | PUT body bytes before → after | New PUT bodies before → after |
| --- | ---: | ---: | ---: | ---: |
| Legacy conflict sync | 19 → 10 | 28,196,508 → 14,096,056 | 4,704,683 → 4,699,738 | 5 → 4 |
| Save edited draft | 6 → 6 | 4,699,066 → 4,699,066 | 4,698,428 → 450,104 | 2 → 6 |
| Resolve saved draft | 7 → 7 | 9,397,902 → 9,397,986 | 4,698,941 → 2,201 | 2 → 5 |

The recovery pair adds twenty output bindings and fourteen record writes, about
23 KB of DB I/O, seven PUTs and twenty-one executed GET/HEAD requests. Existing
100-object commit pages accommodate it. Idle drain performs zero calls. Using
the approved model rates, added request cost is about $0.039 per 1,000 recoveries;
added DB I/O is about $0.005, before compute and avoided upload-body egress.
These are measured fixture quantities priced by the model, not a billed saving.

With seed 1 and 10,000 bootstrap resamples, local wall paired differences
(95% intervals) are: sync -349 ms [-397, -303]; save 19 ms [-4, 46]; resolve -45 ms [-63, -22]. These clocks include fixture action
startup and IPC but no network. They cannot establish the complete-operation
ten-second target. No qualified pair was discarded.

Direct reader guards cover each phase's exact manifest-byte envelope, allowing
only 64 KiB of recipe/index metadata beyond the logical allocation. Larger input
sets retain continuations. Full process memory qualification remains incomplete:
three interleaved near-envelope legacy-recipe observations show old-main RSS
445–604 MiB and changed RSS 458–610 MiB across save, compose, clean sync and
conflict sync. Both exceed the configured 512 MiB action allocation in some
shapes. Removing duplicate retained buffers does not prove complete heap safety;
these observations neither raise an envelope nor justify increasing one. The
existing source-envelope and byte/query guards remain unchanged.


## Reuse across the serial save and resolve

A Node save retains the inline resolve-chain option through delegation. A bounded one-page
save can run the resolve in that same Node action, retaining hash-verified source bytes and
parsed States within the existing 16 MiB routing allowance. The new job keeps its own current
authority/execution fence and describes its two cached inputs and right parent together through
the existing descriptor-only probe. Those fresh bindings also seed byte-range publication;
reusing bytes without the bindings would regress to a full-State upload. Larger saves retain
the independent chain and continuations, with unchanged source envelopes and action allocation.

Sync composition, docs handling, conflict drafting and details reuse one exact metadata merge
per calculation round, previously four. Both tips, selected ancestor sets and insertion order
form the key. Inline replay clears it before calculation answers change.

Eleven alternating AB/BA real-handler pairs at 29,000 files preserve identical draft, saved and
resolved State hashes. Each Node action uses a fresh local process, with synthetic DB/R2; setup,
network, client apply and invoices are excluded. Raw observations and the separate 4k/29k kernel
pairs are in [`sync-resolve-serial-pairs.json`](../../tests/fixtures/sync-resolve-serial-pairs.json).
No qualified final-code pair was discarded. Earlier exploratory timestamp and writer prototypes
are excluded from this final-code comparison.

| Save plus resolve source/control metric | Before | After |
| --- | ---: | ---: |
| Node actions | 2 | 1 |
| Function executions after preparation | 17 | 14 |
| GET body bytes | 14,182,255 | 4,728,105 |
| GET / HEAD / PUT requests | 14 / 12 / 12 | 5 / 12 / 12 |
| PUT body bytes | 497,416 | 497,416 |
| Median DB read / write bytes | 243,826 / 73,820 | 237,492 / 73,805 |
| Median maximum Node-process RSS, MiB | 235 | 219 |

The summed Node action wall difference is -169 ms, 95% bootstrap interval [-178,-164]; work CPU
is -162 ms [-175,-155], seed 1 and 10,000 resamples. The process-peak paired difference is
-20 MiB [-26,-15]. This does not qualify deployed heap safety
at larger envelopes. The shared coordinator keeps V8 step registration out of the Node import graph: 195 source
modules, below the unchanged 220-module guard. The unchanged 512 MiB guard passes; the independent-chain routing boundary
also has a larger-source guard. Byte, query and R2 ceilings are unchanged or tighter.

The pure kernel comparison separately measures metadata merge reuse; it does not include
save-to-resolve sharing or prove complete-operation latency. The current repeated live cohort above retains the full ten-second and Git-parity
qualifications; exclusive provider attribution and the next zoo remain open.
