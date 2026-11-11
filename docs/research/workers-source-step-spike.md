# Workers source-step spike: Option B ends at the 29k memory gate

**Verdict: stop Option B under S8a's kill rule.** One local 29k-file compose
observation reached **102,738,166 bytes (102.74 MB; 97.98 MiB)** of used isolate
memory at a diagnostic checkpoint. The agreed gate is **100 MB**, interpreted
as 100,000,000 bytes, rather than 100 MiB. It leaves 25.26 decimal MB against the
review's nominal 128 MB ceiling, but fails the stricter adoption gate. This is a
lower bound on the diagnostic peak, not a measured continuous peak or a deployed
out-of-memory failure. No later Worker samples were run after this decisive result.

The exact output pin equals the Convex provider's for the tested input. The kill
is memory, not output divergence. No production path, account change, deployment,
service purchase, new product restriction or user step is introduced.

Issue: `9e4ba8c6-be09-4ccd-bee3-2ed359f56b27`.
Review: [S8](placement-review.md#s8-byte-plane-beside-r2-owner-decision-adds-5-a-month).
Harness: [local spike](https://github.com/NanthAI/nanthai-forge/blob/3bab66a32df959344617dfd37d6081e204be607a/spikes/workers-source-step/README.md), removed from main after Option B closed (1018d0f8); the link pins the last State that holds it.
Raw observations, gaps, void and source hashes: [evidence.json](https://github.com/NanthAI/nanthai-forge/blob/3bab66a32df959344617dfd37d6081e204be607a/spikes/workers-source-step/evidence.json).

## What ran and what stopped

The experiment qualified the decisive 29k compose first. It ran the unchanged
compiled `runSourceStep` under Miniflare 4.20260730.0 / workerd 1.20260730.1,
compatibility date 2026-07-30 with `nodejs_compat`, on Node 24.22.1 / macOS arm64.
Miniflare's local R2 binding was seeded with synthetic canonical bytes. All
instances were disposed after use. No hosted workload or Cloudflare account API
was used. Forge planning/save/landing traffic is separate builder workflow traffic.

The baseline uses the existing `scaleFixture` provider harness: actual Convex
begin, descriptor resolution, Node step and commit handlers, with synthetic DB
and R2. The harness enqueues `register-state`, as the existing scale tests do,
so it exercises the general Node path rather than claiming small-compose V8
fast-path performance. The baseline ran after the Worker diagnostic solely
to check exact output equality and collect a source cost model. These are **not
interleaved A/B timing pairs**.

| Shape | Coverage | Used isolate peak / CPU ms / wall / R2 requests |
| --- | --- | --- |
| 10-file smoke | Initial qualification voided; no valid sample | Unknown; canonical page-seeding error, HTTP 500 |
| 4k deep compose (24 nested path components) | Unrun after kill | Unknown |
| 12k single-file save | Unrun after kill | Unknown |
| 29k single-file save | Unrun after kill | Unknown |
| **29k sibling compose** | **One valid Worker diagnostic and one provider baseline** | **Details below** |
| 29k sync | Unrun after kill | Unknown |
| 58k sibling compose (larger synthetic tree) | Unrun after kill | Unknown |

The fixture generator retains the existing scale-test tree sizes and change
patterns, fixes identifiers for reproducibility, and extends the same tree to
58k. It does not claim byte identity to earlier random-ID test executions. The
29k sync shape uses raw sibling inputs; the existing test's subsequent sync
through a just-produced recipe remains unqualified. Large recipes, syntax merges,
conflicts, retries, fan-out and concurrent requests also remain unqualified.

| 29k source operation | Convex provider harness | Worker diagnostic |
| --- | ---: | ---: |
| Logical source bytes read | 9,919,540 B | 9,919,540 B |
| R2 GET / HEAD / PUT | 6 / 6 / 6 | 6 / 0 / 2 |
| R2 uploaded bytes | 737,706 B | 3,306,586 B |
| Source quanta | One action; internal quanta shared | Two quanta in one request |
| CPU | 563.301 ms handler; 794.574 ms including imports | **Unmeasured** |
| Job wall / action wall | 777.311 / 634.824 ms | **Unmeasured**; debugger wall is unsuitable |
| Memory | 289,947,648 B process peak RSS; not isolate memory | At least **102,738,166 B** used isolate memory |
| Convex function calls / DB rows read / written | 8 / 136 / 44 during drain | Zero inside local adapter; future control plane absent |
| Serialized DB read / write bytes | 52,348 / 26,384 B including enqueue | Zero inside local adapter; future control plane absent |
| Load averages (1 / 5 / 15 min) | 6.288 / 8.202 / 9.659 | Not captured on diagnostic |

The Worker adapter receives small trusted synthetic descriptors in one request,
uses local R2 GET/PUT, and publishes raw objects. The provider publishes reused
State chunks, packed ranges and recipes. That explains the physical byte/count
difference; logical output equality does **not** prove physical-layout parity.
Neither transport was tuned after seeing the memory result. Runtime source was
not edited, stubbed or replaced. The bundle retains the lazy TypeScript dependency.

Input: `41304450735a443af88c9ff76ea1b5fb24bcd617f0ce5edcbdf58bd6bf4c08c4`, 622 B.
Both outputs: `342801986dde23df103810a742ecb8a4133f820a08b36a4ca48789be7acda2ac`, 340 B.
Worker State: `986119dfc36a2b74e1e87364e6d333e0e3733fa2740acc88b30777217027fe12`.

## Memory method and limits of the result

Workerd's `process.memoryUsage`, `process.resourceUsage` and `node:v8` statistics
returned zero in a capability probe. Those zeros are not used as measurements.
The harness attaches CDP to the **source Worker isolate**, pauses at transport and
quantum boundaries, and reads `Runtime.getHeapUsage`. At the largest checkpoint:

| Component | Bytes |
| --- | ---: |
| Used JS heap (`usedSize`) | 74,888,188 |
| ArrayBuffer/external-string backing storage | 27,513,386 |
| Used embedder GC heap | 336,592 |
| **Used total** | **102,738,166** |
| Allocated JS heap capacity (`totalSize`, excluded from used total) | 125,599,744 |

The [CDP schema](https://raw.githubusercontent.com/ChromeDevTools/devtools-protocol/master/json/js_protocol.json)
defines these as isolate-wide heap, embedder and backing-storage fields. Summing
used components avoids adding allocated heap capacity twice. Thirteen raw
checkpoints are retained. Inspector pauses can affect liveness and allocation;
**inspector overhead was not isolated**, so this is an instrumented local failure,
not a claim about an uninstrumented deployed isolate. It is sufficient to stop
this spike under the stated observed-memory gate; it cannot establish universal
Worker infeasibility. A 100 MiB gate would be a different owner decision.

Cloudflare documents [128 MB per isolate](https://developers.cloudflare.com/workers/platform/limits/),
including shared concurrent requests, and supports [local memory profiling](https://developers.cloudflare.com/workers/observability/dev-tools/memory-usage/).
No continuous-peak success or production-limit enforcement is inferred from a
local emulator. Checkpoint readings below a limit never count as passing it.

## Timing and adoption gates

Under [perf-claims](../agents/perf-claims.md), the intended scored plan is eleven
interleaved A/B pairs per shape, with load per sample, median paired differences
and a 95% bootstrap interval from 10,000 resamples (seed 1). Qualification failed
before scoring: **N = 0 valid pairs; no interval and no speed/cost improvement
claim**. The one provider CPU/wall observation is not a median comparison. The
initial smoke HTTP 500 is the sole voided workload sample; two earlier bundle
configuration failures were build qualification errors, not workload samples.

| Requested metric | What local work can establish | What remains unmeasured |
| --- | --- | --- |
| Time to main | Source pins and local source execution only | Source RPC, scheduling, admission, queue, check and acceptance critical path |
| Check wall | Identical source pins permit the same check input | Matched deployed check execution and dispatch wall |
| Notification latency | No production notification behavior changed | Commit-to-subscription/client delivery and network latency |

The required noise rule and at most +5% median adoption tests for all three stay
**unmet**. A deployed comparison would require a new agreed experiment after this
kill, the owner's still-open $5/month Workers Paid approval, a real signed-grant
provider with unchanged reducer authority, and matched deployed runs with billing
and byte-placement evidence. This spike authorizes none of those actions.

## Cost model, not billed savings

The following is an illustrative **source-step subtotal per 1,000 landings with
one measured-shaped compose each**, using the review's Professional marginal
rates: calls $2/million, DB I/O $0.20/GB, action allocation 0.5 GiB at $0.30/GB-hour,
and upload egress $0.12/GB. The [Convex limits/pricing page](https://docs.convex.dev/production/state/limits)
provides these plan rates. Serialized fixture JSON I/O excludes provider index
amplification. Action wall is local and includes harness I/O; it is not billed
GB-hours. Upload bodies are an egress proxy, not measured total Convex bandwidth.
[R2 rates](https://developers.cloudflare.com/r2/pricing/) are $4.50/million PUT,
$0.36/million GET/HEAD, and $0.015/GB-month. Inclusions, regional multipliers and
invoice rounding are excluded. Local service charges are zero; hosted account
billing was not read.

| Modelled source subtotal / 1,000 | Without Worker | With spike-shaped Worker |
| --- | ---: | ---: |
| Convex calls (8 retained as explicit Worker control-plane assumption) | $0.01600 | $0.01600 |
| Convex serialized DB I/O (same assumed control plane) | $0.01575 | $0.01575 |
| Convex source action compute | $0.02645 | Unknown bridge compute; optimistic $0 |
| Convex R2 upload egress proxy | $0.08852 | $0 from Worker; bridge bytes unknown |
| R2 operations | $0.03132 | $0.01116 |
| **Illustrative subtotal** | **$0.17804** | **$0.04291 + unknown bridge compute/bytes** |

[`tests/workers-source-step-spike-metrics.mjs`](https://github.com/NanthAI/nanthai-forge/blob/3bab66a32df959344617dfd37d6081e204be607a/tests/workers-source-step-spike-metrics.mjs) (removed with the harness) computed these values from the retained observation. Future Worker
orchestration is absent, so preserving baseline calls/DB bytes is an assumption,
not a measured Worker total or a promise of no added calls. No bootstrap interval
is justified for this unpaired deterministic sensitivity model.

A full 1,000-landing cost is this subtotal plus the **unmeasured other landing
operations and amortized recurring maintenance**. It is not measured or bounded
by this local spike. Recurring maintenance added by the landed spike is zero,
because it has no runtime path; future provider maintenance remains unknown.
Retained DB storage is unknown. Assuming unique uploaded objects all remain for a
month, R2 upload storage is $0.01107 without / $0.04960 with the raw Worker adapter
per 1,000 such operations; this is a sensitivity, not measured net storage growth
or a retention change.

Worker service cost is separate: [Workers Standard](https://developers.cloudflare.com/workers/platform/pricing/)
has a $5/month minimum with 10 million requests and 30 million CPU-ms included,
then $0.30/million requests and $0.02/million CPU-ms. At L monthly landings the
fixed allocation is `$5 * 1000 / L` per 1,000. CPU overage is unknown because
Worker CPU was not measured. No service was bought. Lower measured Convex+R2
cost, the $2 target and real billed usage remain unproven.

## Delivery and remaining work

The spike adds diagnostics, synthetic evidence, six behavior tests and one HEAD
event in the existing fake-R2 fixture. Production calls, DB I/O, memory, wall time
and byte placement are unchanged; idle adds zero calls at current or larger scale.
Nothing runtime can be removed: the evidence ends the proposed option rather than
replacing a production component. The harness is never imported by runtime code.
The Issue's full fixture, timing, billed-cost and owner-review gates stay open;
only exact parity on this input and the kill observation are evidenced. The lead
can take this result to the owner without enabling S8b.
