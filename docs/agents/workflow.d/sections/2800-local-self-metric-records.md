### Local self-metric records

Agent `start`, `checkpoint` (`save`), `sync`, `finish` and `land` responses append
local lifecycle receipts with the requester, operation ID and final structured
error codes. Work commits append requester-attributed mutation receipts, including
cancellations; nested phases retain the original requester. Automatic writes name
the Forge owner as their system requester. These append-only records live in
`self-metrics.jsonl` beside Work metadata. Hosted clients append to
`<checkout>.forge-metrics.jsonl` beside the checkout, so a failed capability lookup
creates neither an owner nor a recovery cache. `land` also appends a `wait` receipt before and after its outcome wait (last observed phase, status, time since a change), so a killed client still names its phase. Recording adds no hosted mutation or polling. A receipt-write failure
reports `METRIC_RECEIPT_UNAVAILABLE` without changing the action's outcome.
Mutation receipts are emitted only after the Work commit pointer is published,
with its committed revision; no-op, refused and aborted writes emit none.
Format/compatibility refusals and argument-validation failures emit no lifecycle
receipt. Errors rejected before opening a valid store are outside metric 2's
coverage; recording them must not create files in the refused store.

`readSelfMetrics(reader, { from, to, asOf? })` in `src/self-metrics.ts` calculates
metrics 1–8, red-main minutes and per-project disk use. The period includes `from` and excludes `to`; days are UTC
and `asOf` fixes the dropped-submission test. `nativeSelfMetricsReader(owner)`
reads a pinned Work manifest directly, without constructing a Work service or
waking workers. `hostedSelfMetricsReader(source)` accepts revision-pinned hosted
table pages, immutable object bytes and local lifecycle receipts through the
same small reader interface. Missing receipts, input pages, runner durations,
reuse facts and delivery history produce named partial results. Unknown values
are `null`; available timing sums remain partial subtotals. Friction prose and
automation definitions never substitute for execution or caller-delivery facts.
Manual service restarts outside Forge have no requester record and remain a
coverage gap. The metrics command and full metrics surface are separate from these readers.
Metric B (proved-reuse back-stop) counts hosted acceptances that landed on a
cross-head reuse proof, failed full main audits (red episodes), those whose audited
range holds a reuse acceptance, flake clears, proven culprits and culprits that were
reuse acceptances. A non-zero reuse-culprit count means a proof let a breaking change
through. It is derived from receipts and audit events on the first acceptances page:
no write and no extra call.
Readers ignore an unterminated final journal line without changing its bytes.
The output counts it in `incompleteReceiptRecords` and marks receipt-dependent
metrics partial; complete earlier receipts remain available. Malformed complete
records still fail explicitly.

The M2 observation recorder accepts structured bills, revision acknowledgements,
surface comparisons, overlap deliveries/answers, exact-State full-suite results,
culprit identities and hosted/R2 byte accounting. Bills retain billed, list and
estimated dollars separately. GitHub-hosted Actions for this public Forge project
have a real billed price of $0; `githubHostedZeroBill` records that basis without
zeroing list price or execution minutes. A zero invoice has undefined percentage
estimator error. Missing provider bills remain partial. Monthly shared charges
and otherwise unjoined runs are allocated over ordinary landings; exact run/input
or landing identities take precedence.

Hosted intervention receipts (metric 5.5) record agent or person from the signed-in
identity, as landing policy does: a device credential is an agent, a browser sign-in
is the person. Older receipts, which named only the account, are shown as
`account:NAME` with a gap, never as a person.

Checkpoint overlap observations count shared changed paths against active,
unlanded peers, including edits in different regions. Delivery records describe
what the lifecycle response actually returned. Only a delivery for the saved head
before the next save counts. First-write and acknowledgement coverage remain
partial until their producers supply records. Authority revision streams are
scoped to one comparable epoch; source publication acknowledges the captured
owner revision. Schema-2 cache writes record hosted and cache revisions. Surface
comparison records retain observed contradictory intervals, including a hosted
page showing a closed Intent while authority still records it as unlanded.

Disk sampling runs only after committed Work writes, at most once per UTC day
across processes. The scan stops after 100,000 entries or 250 ms, follows no
symlinks and retains incomplete bytes as lower bounds. It separates objects,
records, Lane directories, check workspaces, snapshot metadata and backups
(including registered record-collection backups), and samples volume free space.
Growth requires two complete samples; missing hosted/R2 accounting stays unknown.
The retained per-project advisory budget defaults to 10 GiB total, 100 MiB/day
growth and 1 GiB free-space reserve, with a one-day forecast.
`setSelfMetricDiskBudget` changes these values. One combined warning appears in
status at 90% of a size/growth budget or within 10% of the free-space reserve,
including forecast growth; it never blocks a write. Status reads only the retained
sample and does not scan, poll storage or schedule work.
