# Sync and resolve cost decomposition

Issue `6fbba986-3b78-439d-878d-afbd66510414` owns the remaining single-operation gap.
The current finding is **bounded source-action startup plus full flat-State processing**,
not a per-file RPC loop. The local decomposition below does not establish the dominant
part of the hosted 4.9-second sync. Live phase attribution remains open.

The existing live reply delta already makes client transfer proportional to changed
paths. Retain that path. Do not revive trees in packs: the State identity is still the
SHA-256 of the exact flat manifest, including its parents, message and time.

## Scope and method

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
The normal command then performs capabilities and source preparation; the live nested
call durations are **unmeasured** because synthetic hosting failed before network.

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

## Placement finding and expected saving

The remaining source byte plane belongs to [S8a Issue 9e4ba8c6](https://nanthai-forge-dev.netlify.app/?project=mh7aafndrxmj8c2q0931zbjk2n8h4ffs&projectTab=planning&planningItem=9e4ba8c6-be09-4ccd-bee3-2ed359f56b27),
with descriptor control handled by [S5 Issue e7e35328](https://nanthai-forge-dev.netlify.app/?project=mh7aafndrxmj8c2q0931zbjk2n8h4ffs&projectTab=planning&planningItem=e7e35328-7730-436a-b229-ba11d6362987).
This finding preserves current State identity and does not authorize a Worker service
or provider change.

On the 29k fixture an R2-bound source provider could keep 18.79 MB (clean sync),
32.90 MB (conflict sync) or 23.50 MB (resolve) of GET+PUT bodies out of the Convex byte
plane per operation. That includes about **4.70 MB of attempted PUT body egress** in
each case. Those are measured current bodies and an expected placement saving,
not fewer R2 requests or a measured billed saving. The flat manifests must still be
constructed, verified and hashed beside R2. The Worker memory/pin-equality checks
remain essential and unrun here.

S5 can remove bounded descriptor rounds (3 per 29k clean sync, 7 per conflict/resolve
source job here), but cannot remove flat-manifest CPU or by itself remove the repeated
State bodies. Do not add another full tree representation to chase that floor. An
expected latency saving cannot yet be assigned honestly: hosted transit, cold-start
and nested-call clocks need the bounded dev rerun first. The old 230 ms R2 round-trip
observation in the placement review is not substituted for a new network profile.

## Guards and open evidence

`tests/sync-resolve-cost-guard.test.mjs` runs both shapes. It asserts bounded control
calls per action, at most two actions for these changes, batched descriptor calls,
fixed DB metadata bytes, GET bytes bounded by 3/6/4 flat manifests plus changed-path
allowance, bounded State/progress PUT bytes and zero idle work. Eight disjoint changed
paths use the same control-call window as one. Client apply is guarded separately:
only the changed body can transfer; missing delta still verifies the exact State.
These are regression assertions, not product limits or new user obligations.

The dev-only attempt to host an ordinary synthetic directory failed `GIT_FAILED`
before network on the installed CLI, despite help saying Git is not needed. Existing
host-robustness Issue `2abda01f-fbec-419f-907f-58f9ab340fc2` records the source trace and
workaround choice: continue local fixtures without introducing Git into this task.
No live project or sync sample was created by that attempt.

Acceptance remains honest:

- The local source/apply decomposition and guards are evidenced. Complete hosted
  preparation, R2 HEADs, billed usage and a quiet-enough paired network run remain open.
- The remainder is linked to S8a/S5 with measured byte exposure and the conditional
  expected saving; no generic runtime speed fix is claimed by this documentation.
- The **next zoo comparison stays unticked**. It must report sync and source-only
  resolve separately from the checked landing, alongside the existing resolve-to-main
  measure and Git equivalents. The current zoo's 83.6-second `resolve` includes its
  subsequent checked landing; it cannot be compared with this 755/1,694 ms source job.

This change removes an unmeasured assumption about per-file sync calls by extending
one existing measurer and guarding its budgets. It removes no runtime code, adds no
runtime calls, tables, public commands, services or State formats, and changes no
product capability.
