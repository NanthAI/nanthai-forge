# Source-step memory: local ceilings and a streaming sync probe

The current provider crosses 512 MiB between 60k and 100k files for sync,
sibling compose and conflict sync, and between 100k and 190k for save on this
fixture. A sorted streaming sync probe produces byte-identical States in all
15 paired comparisons, with unchanged R2 operations and bytes. Its 190k peak is
416–419 MiB, against 902–961 MiB for current sync. It still uses the production
whole-output transport, so this is a smaller linear heap, **not an eliminated
memory ceiling**. The lead owns the rewrite verdict; this document supplies
evidence and options for Issue `2f6fd9c5-a411-4597-b35c-ceab9d758010`.

## Reproduce and interpret

After `nforge heavy npm run build:core`:

```sh
nforge heavy node tests/measure-source-memory.mjs OUTPUT.json 3
node tests/summarize-source-memory.mjs OUTPUT.json
nforge heavy node --import ./tests/check-runtime.mjs --test tests/source-stream-sync.test.mjs
```

Optional final argument selects comma-separated file counts. The default is
`4000,29000,60000,100000,190000`. Use an odd repeat count for the summary helper.
[Raw observations](../../tests/fixtures/source-step-memory.json) retain every
run, action peak, exact output pin, provider call/row/byte count, load average,
timestamp and hashes of the runtime/probe sources. The measurement window is
16:31:58–16:33:04 UTC. No measured runs were voided. A prior unscored 4k
qualification passed all four phases and one exact sync A/B comparison.

The harness runs the actual Convex dispatch, begin, Node handler, transport and
commit against the existing synthetic transaction store and R2 adapter. Each
action gets a fresh Node 24.22.1 process on macOS arm64. RSS is the OS high-water
mark (`resourceUsage().maxRSS * 1024`), including imports, transport and IPC;
the phase peak is the maximum over its actions. It is not just JS heap, a
continuous isolate measurement, or a deployed out-of-memory test. Processes are
allowed to exceed 512 MiB to observe the curve. Comparisons to that action
budget are local risk evidence, not a new enforced product limit.

All fixtures share one unchanged nine-byte blob. Two siblings each change one
path, or both change the same path for conflict sync. Compose merges siblings,
not a fast-forward. Save changes one path; conflict sync produces the ordinary
marker draft and conflict page. Entries occupy 162 bytes including deep paths
and JSON metadata. Baseline manifests contain 648,112 / 4,698,112 /
9,720,112 / 16,200,112 / 30,780,112 bytes at the five sizes. Input manifests
are generated into private temporary directories, streamed from disk and
removed after each job; the fixture's tree allocation is outside the measured
action. Generated outputs still take the normal provider transport and IPC.
No source bodies are read from another repository.

These are deliberately long, deep paths, reusing the S6 scale shape. Typical
shorter paths can make smaller States and select the current 1–4 MiB chunk
writer; this 29k shape is already above that window and stays flat. File content
size, change count, syntax merges, descriptor fragmentation, ancestry shape,
optional metadata and GC decisions can all move the ceiling. The historical
42k conflict-sync estimate and 591 MiB save reading in
[decisions](../decisions.md#chunked-flat-states) are different experiments,
not observations to average with these production-handler runs.

## Measured phase peaks

MiB; **median of three** fresh executions, with observed minimum–maximum in
parentheses. Every action in the phase contributes to the peak.

| Files | Save | Sync | Compose | Conflict sync |
| ---: | ---: | ---: | ---: | ---: |
| 4,000 | 126.9 (126.1–126.9) | 145.1 (144.6–145.8) | 133.5 (132.7–135.1) | 162.5 (158.3–177.9) |
| 29,000 | 213.3 (210.8–213.6) | 357.7 (338.5–379.5) | 265.0 (265.0–274.3) | 364.7 (332.6–380.0) |
| 60,000 | 265.9 (263.0–279.4) | 424.4 (423.9–426.0) | 409.0 (407.4–416.0) | 451.9 (443.4–457.5) |
| 100,000 | 370.8 (370.5–387.0) | 634.8 (631.6–638.2) | 636.7 (635.6–638.2) | 646.0 (643.0–646.1) |
| 190,000 | 609.4 (597.0–659.3) | 958.6 (902.2–960.8) | 911.7 (907.8–913.1) | 1,073.4 (1,069.9–1,090.3) |

Ordinary least squares fits `peak MiB = intercept + slope * fileCount` to the
five medians, equally weighted. These are descriptive fits, not confidence
bounds, capacity guarantees, or a claim that every phase is perfectly linear.

| Phase | Intercept MiB | MiB / 1,000 files | R² | Fitted 512 MiB crossing | Observed below / above |
| --- | ---: | ---: | ---: | ---: | --- |
| Save | 122.33 | 2.545 | 0.9967 | about 153k | 100k / 190k |
| Sync | 182.99 | 4.192 | 0.9805 | about 78k | 60k / 100k |
| Compose | 149.17 | 4.204 | 0.9818 | about 86k | 60k / 100k |
| Conflict sync | 178.03 | 4.722 | 0.9921 | about 71k | 60k / 100k |

The smallest fitted crossing is therefore about 71k for this shape. It is not
the exact first failing repository size: the tested bracket is 60k–100k, and
variation in the runs and workload matters.

Median job-drain wall milliseconds, including child startup, local IPC and
synthetic DB work, excluding fixture setup:

| Files | Save | Sync | Compose | Conflict sync |
| ---: | ---: | ---: | ---: | ---: |
| 4,000 | 144.1 | 162.9 | 163.9 | 195.9 |
| 29,000 | 201.9 | 320.5 | 458.9 | 693.4 |
| 60,000 | 481.8 | 512.3 | 688.3 | 1,138.6 |
| 100,000 | 630.4 | 798.5 | 977.1 | 1,758.0 |
| 190,000 | 971.1 | 1,470.1 | 1,720.2 | 3,561.3 |

## One-phase streaming prototype

The test-only [reader](../../tests/source-stream-manifest.mjs) consumes compact,
sorted manifests as three iterators. The [sync probe](../../tests/source-stream-sync.mjs)
merge-walks their paths using production `mergeFileMetadata`, writes the output
sequentially to a temporary spool, hashes incrementally, then sends it through
the unmodified production upload transport. All three input pins and the two
tips' recorded parent lists are verified before publication. The
[provider adapter](../../tests/source-stream-provider.mjs) retains actual begin,
descriptor resolution, storage and commit. No runtime imports these modules.

The comparison orders current A then prototype B for each pair, interleaved
with the other phase measurements. N = 3 pairs per size, 15 pairs total;
**small-sample observations** under [perf-claims](../agents/perf-claims.md).
Every pair compares the complete result manifest and the actual State byte
buffers, not just hashes. All 15 are identical. The eight focused guards also
exercise one-byte chunk boundaries, escaped Unicode paths, additions, deletions,
modes and explicit failures before publication for invalid or unsupported inputs.

| Files | Peak MiB A / B, medians | Paired B−A MiB, median [95% interval] | Job wall ms A / B, medians | Paired B−A ms, median [95% interval] |
| ---: | ---: | ---: | ---: | ---: |
| 4,000 | 145.1 / 125.8 | −19.5 [−19.8, −19.4] | 162.9 / 141.6 | −18.3 [−21.3, −17.3] |
| 29,000 | 357.7 / 153.4 | −204.2 [−226.0, −185.3] | 320.5 / 266.1 | −55.9 [−58.7, −43.9] |
| 60,000 | 424.4 / 222.1 | −201.8 [−212.3, −201.7] | 512.3 / 435.0 | −89.7 [−133.6, −58.6] |
| 100,000 | 634.8 / 286.2 | −349.8 [−352.0, −343.9] | 798.5 / 619.4 | −181.5 [−181.7, −138.2] |
| 190,000 | 958.6 / 415.7 | −543.0 [−545.0, −482.9] | 1,470.1 / 1,081.8 | −388.3 [−417.8, −367.5] |

Intervals are bootstrap medians of paired differences, 10,000 resamples, seed 1,
using the shared helper. All exclude zero in this sample; the observations do
not establish hosted speedups or repeatability across machines. The interval
does not cover changing load, architecture, network, unmodeled workload
differences, or the prototype's reduced feature coverage. No samples were dropped.
The paired median difference need not equal the difference of the two medians.

The probe supports sibling, single-base, metadata-only clean syncs in compact
native writer order. General JSON order/whitespace, optional State metadata,
unsorted legacy inputs, arbitrary DAGs and recursive bases, stacks, text/doc
resolution, conflict pages, file/directory collision validation and durable
resumption are **not implemented**. Its explicit research assertions are never
on a product path. This is not a shippable sync replacement.

The merge walk retains a chunk and one entry per input plus a small output
buffer; the spool grows with State bytes on local temporary disk. Publication
still allocates the whole output and parses it in
`convex/projectConvexSourceTransport.ts:prepareOutput`, and projected recipe
reads can still assemble a whole input closure. Those paths prevent a claim
of constant total memory. Removing just the merge's Maps/parsed trees is useful
in this fixture but does not solve all source phases or all State layouts.

## Calls, I/O and cost scope

No deployment workload calls were made: **zero live Convex calls and zero live
R2 requests**. Forge's own planning/save/landing traffic is separate builder
workflow traffic. No deploy, paid service, account change or live billing read
is part of this experiment. Every simulated byte remains in fake R2, not Convex
file storage. Idle drain adds zero calls and zero reads in every measured job.

For clean sync, every pair has exactly the same physical GET/HEAD/PUT counts,
uploaded bytes, downloaded bytes and provider function-call count in A and B:

| Files | R2 GET / HEAD / PUT | PUT body B | GET body B | Simulated function calls A = B |
| ---: | ---: | ---: | ---: | ---: |
| 4,000 | 4 / 3 / 2 | 648,552 | 1,944,870 | 6 |
| 29,000 | 4 / 3 / 2 | 4,698,553 | 14,094,872 | 7 |
| 60,000 | 4 / 3 / 2 | 9,720,553 | 29,160,872 | 7 |
| 100,000 | 4 / 3 / 2 | 16,200,554 | 48,600,874 | 7 |
| 190,000 | 4 / 3 / 2 | 30,780,554 | 92,340,874 | 7 |

Both have one source action per sync. A/B DB documents are 95 reads / 31 writes
at 4k, 102 / 32 at the other sizes. Serialized fake DB I/O is about 37.7 / 17.6 KB
read/write at 4k and 41.4 / 17.7 KB above it. These exclude fixture setup and
enqueue, cover the drain, and do not measure provider index amplification or
billed bytes. Tiny differences in durations/serialized timings are retained in
the raw data; they are not interpreted as savings.

Other phase budgets below are identical in all three repeats at each size;
R2 counts are GET/HEAD/PUT. Rows and bytes are fake DB drain I/O only.

| Phase and files | Actions / calls | DB documents read / written | R2 requests | PUT B | GET B |
| --- | ---: | ---: | --- | ---: | ---: |
| Save, 4k | 1 / 6 | 95 / 31 | 4 / 3 / 2 | 648,423 | 648,927 |
| Save, 29k | 1 / 6 | 95 / 31 | 4 / 3 / 2 | 4,698,424 | 4,698,928 |
| Save, 60k | 2 / 11 | 128 / 37 | 6 / 5 / 4 | 9,902,136 | 9,902,640 |
| Save, 100k | 2 / 11 | 128 / 37 | 6 / 5 / 4 | 16,502,484 | 16,502,988 |
| Save, 190k | 2 / 11 | 128 / 37 | 6 / 5 / 4 | 31,353,408 | 31,353,912 |
| Compose, 4k | 1 / 8 | 109 / 35 | 6 / 3 / 2 | 648,635 | 1,945,535 |
| Compose, 29k | 2 / 14 | 150 / 41 | 9 / 4 / 3 | 4,701,094 | 23,494,352 |
| Compose, 60k | 2 / 14 | 150 / 41 | 9 / 4 / 3 | 9,723,094 | 48,604,352 |
| Compose, 100k | 2 / 14 | 150 / 41 | 9 / 4 / 3 | 16,203,099 | 81,004,358 |
| Compose, 190k | 2 / 14 | 150 / 41 | 9 / 4 / 3 | 30,783,099 | 153,904,358 |
| Conflict sync, 4k | 1 / 7 | 108 / 37 | 7 / 5 / 4 | 649,611 | 1,944,890 |
| Conflict sync, 29k | 2 / 14 | 156 / 44 | 11 / 6 / 5 | 4,704,557 | 28,194,306 |
| Conflict sync, 60k | 2 / 14 | 156 / 44 | 11 / 6 / 5 | 9,726,557 | 58,326,306 |
| Conflict sync, 100k | 2 / 14 | 156 / 44 | 11 / 6 / 5 | 16,206,562 | 97,206,312 |
| Conflict sync, 190k | 2 / 14 | 156 / 44 | 11 / 6 / 5 | 30,786,562 | 184,686,312 |

Save DB read/write is about 37.5/17.3 KB at 4k–29k and 54.9/22.0 KB above;
compose is 44.9/18.6 KB then 67.0/23.3 KB; conflict sync is 41.9/19.5 KB then
67.7/24.4 KB. Counts are per operation, not per file, and stay bounded here as
file count grows. The production implementation is unchanged at every scale.

**Expected rewrite effect, not billed savings:** a one-phase merge rewrite can
cut the large per-path heap while keeping the same State and R2 bytes. It has
no measured storage or R2 request saving in this experiment. Lower local wall
could reduce billed action duration, but action allocation remains 512 MiB and
actual billing/network/queue effects were not measured. At 190k, 30.78 MB of
new sync output still needs publication; memory work alone does not recover the
byte savings of the dropped chunking experiment. Fixed service/maintenance
cost added by this research is zero; a future implementation's cost and broader
physical-layout parity remain unqualified.

## Which repositories meet these ceilings?

| Repository evidence | Readable size | Implication from this spike |
| --- | --- | --- |
| Forge | Accepted base has 4,222 tracked files; research checkout first save has 4,227, including five new harness modules. The existing dogfood fixture is 4,096 ([review](placement-review.md#what-the-evidence-says)). | Well below every measured crossing for this shape; no current Forge memory failure demonstrated. |
| Bench zoo, recorded imports | 6–1,387 files across the 21 rows with retained counts; history 402, binaries 1,387. [Catalog attribution](zoo-mini-report.md#fresh-import-catalog-attribution) has each row. Counts for Go, Python, Rust, JVM and the refused non-UTF8 import are absent from that table. | No documented counted zoo repository approaches a crossing. The missing rows remain unknown; do not claim all 26 have measured sizes. |
| 29k bench / smoke repository | About 28,900 files ([planning vector](placement-review.md#whole-system-options)); synthetic comparison uses exactly 29,000. | All four current phases stay below 380 MiB in these samples; it does not establish a ceiling failure at the current bench size. |
| Larger real path sets in earlier experiments | Kubernetes about 31.7k; LLVM about 190k ([decisions](../decisions.md#trees-in-packs)), synthetic contents. | 31.7k is below the fitted crossings; a 190k-shaped repository exceeds all four current peaks. These real sizes motivate capacity work, but this spike does not execute their actual source trees. |

Long paths make the 29k fixture's manifest larger than some existing 29k
provider guards. Those observations are consistent with file count being an
imperfect proxy. This research demonstrates a large-repository risk, not a
current-memory incident in Forge, the counted zoo rows, or the 29k smoke.

## Cheapest options for the lead to weigh

No option below is selected or filed as new implementation work by this spike.
Effort ranges are engineering estimates, not measurements or commitments.

| Option | Expected scope and effect | Remaining cost / risk | Estimated work |
| --- | --- | --- | --- |
| Document the observed envelope | Land this evidence; no production rewrite or user restriction. | No memory or byte saving. Large repositories keep the risk; the envelope is descriptive, not enforced. | This spike only; cheapest immediate delivery. |
| Rewrite one phase | Clean sync merge plus streaming input validation/publication, with existing authority, retries and exact State identity. The probe shows 29k 357.7→153.4 MiB and 190k 958.6→415.7 MiB locally before removing whole-output parsing. | Conflict sync is still the smallest fitted ceiling; compose/save also fail at large scale. General ancestry/text/recipe/retry coverage and billed comparison needed. R2 calls/bytes must stay flat. | About 3–5 builder-days plus review/qualification. |
| Rewrite all source phases | Shared streaming State reader/writer and bounded validation, then save, sync, compose and conflict drafts; keep logical identity and authority. | Broad correctness proof across legacy JSON, recursive bases, docs/text conflicts, resumption and physical layouts. Additional spill/continuation must not raise R2 calls or add user steps. No proof of all-phase boundedness yet. | About 8–15 builder-days plus review/qualification. |

Incremental hashing can preserve SHA-256 State identity without retaining all
manifest entries simultaneously. It must still process the exact logical byte
sequence. Historical descriptions of identity requiring a whole *in-memory*
manifest describe the then-current implementation, not a mathematical constraint.

This research replaces an unsupported single ceiling estimate with reproducible
phase measurements. Nothing production can be removed: no production reader,
writer or source phase is replaced. Runtime calls, bytes, access, retention,
capabilities and user steps are unchanged. Live billing, hosted timing, other
machines, realistic content/change distributions and general streaming semantics
remain unverified. The owner-facing verdict is the Issue's third Done-when line
and remains with the lead.
