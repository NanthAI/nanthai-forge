# Cost architecture options

Keep Convex as the authority while cutting repeated large reads and source/CI
steps. Moving board updates alone is unlikely to save money at the measured load.
Cloudflare has a credible lower infrastructure price at scale, but moving landing
correctness is a phase of work. A single inexpensive VPS does not meet Forge's
requirement to operate independently of one machine.

This is a design comparison, not authorization to change plans, services, access,
retention, quotas or user steps. No new service, export, benchmark or deployment
was run. Runtime delta from this document: zero calls, database I/O, stored runtime
bytes, idle work, memory or operation latency. Prices are USD, before tax;
provider prices were checked on 2026-11-10. Labor and existing CI/frontend/R2 costs
are excluded from replacement quotes unless stated. Estimates are not capacity
or latency measurements.

## Evidence and attribution

The [local meter](convex-spend.md) prices observed completions at the operating
rates: $2/million calls, $0.20/GB database I/O, $0.30/GB-hour actions,
$0.12/GB egress, $0.11/1,000 query-GB search. These differ from published Starter
rates. Its frozen report contains 1,459 executions, 125,386,875 I/O bytes,
13,816,160 egress bytes, 0.01542206 action GB-hours and 29,821,148 search query-bytes.
Known cost is $0.03428321 over 609.217 watched seconds, with nine gap markers.
Coverage is partial, including possible silent provider drops. Storage, provider
exports, other deployments, R2 and invoice adjustments are outside this meter.

The following groups sum exactly before rounding. Daily figures extend that
short, active sample by `86,400 / 609.217 = 141.821387`; **they are conditional
projections, not observed daily spend**. The last column additionally assumes
100 landings/day (`daily * 10`), not a measured landing denominator. This preserves
an auditable allocation without inventing a job-tagged trace.

| Endpoint job | Observed sample $ | Projected $/day | Conditional $/1,000 landings |
| --- | ---: | ---: | ---: |
| Landing/source/compose/CI results/finish, mirror and shared auth/control | 0.01612999 | 2.288 | 22.88 |
| Explicit save/sync and overlap endpoints | 0.00096015 | 0.136 | 1.36 |
| Planning writes, searches and record pages | 0.00045542 | 0.065 | 0.65 |
| Reactive workspace/detail/live-Lane views | 0.00021079 | 0.030 | 0.30 |
| Board notifications | 0.00003087 | 0.004 | 0.04 |
| Metrics | 0 observed | Unknown outside sample | Unknown |
| Import status endpoints; no export in sample | 0.00010204 | 0.014 | 0.14 |
| Work migration copy/compare/retire/mode, separate from serving | 0.01639395 | 2.325 | 23.25 |
| **Known total** | **0.03428321** | **4.862** | **48.62** |

Reproduce the grouping on `today.perFunction`, in this order:

```text
migration: projectWorkStore:* and projectWorkIndexStore:retirePayload
save/sync: projectHostedSaves:*, projectHostedSaveJobs:*, projectHostedSync:*,
           syncActions:*, sync:*, projectHostedOverlaps:*, projectHostedConflicts:*
planning: projectWorkCommand:*, projectWorkIndex:records,
          projectHostedPlanning*, projectHostedFriction:*
web: projectWorkIndex:workspace, projectWorkIndex:detail, projectHostedLiveLanes:*
notifications: projectBoard:*
metrics: identifiers containing Metrics:
imports/exports: imports:*, identifiers containing Import or Backups:
landing/shared: every remaining identifier
```

The frozen sample has 142 migration calls and 80,549,736 migration I/O bytes;
landing/shared has 1,103 calls and 38,865,886 I/O bytes. Shared source operations
also serve saves/sync; endpoint names cannot identify their initiating command.
Planning record queries can serve the browser too. Therefore explicit save and web
rows are partial allocations, not complete marginal job prices. `projectBoard:post`
measures notification writes, not delivery or all alert generation. No observed
metrics/export execution does not establish a zero cost for those jobs.

For comparison, the brief's earlier operating-rate baseline is approximately
$2.50/day. The short sample's $4.86 projection contains $2.33 migration/day and
leaves $2.54/day before omitted cost classes. Do not combine these observations
into a claimed sustained daily saving.

[The ledger](../../src/speed-budgets.json) and
[cost-to-serve model](cost-to-serve.md) supply the longer-window serving evidence:
raw capture #4 is $9.49/1,000; subtracting $3.53 of drills, scratch landings,
purges and test imports gives a **$5.96/1,000 operating-rate serving proxy**,
about $6.56 at Starter marginal rates. This exceeds the $2 target by about $4.56.
Its corrected total has no corrected per-family breakdown: raw source/objects
$2.99 and CI results $1.36 cannot be summed as corrected job costs. The six-landing
fixture's roughly $0.58/1,000 excludes waits, mirror and real CI; its 3.26 GB-seconds
are modeled. Neither is an isolated billed outside-user trace.

Issue `686ecdde` also records historical metrics expense of $0.16–$0.93/day,
backup exports estimated at $0.25–$0.55/export, and migration I/O of
0.6–2.7 GB/day. At Starter, 75% less metrics I/O would save about
$0.13–$0.77/day, conditional on the old read frequency. These are prior
observations/models, not missing entries to insert into the sample total.
Search was mispriced in an earlier Issue comment: 6.9 query-GB/day costs
$0.000759/day before allowances, not $1.38. The existing one-page workflow removes
calls and returned-data reads; no sevenfold search-index reduction was shipped.

## Convex plan choice

[Published pricing](https://www.convex.dev/pricing), US East, lists $25 per
Professional developer/month. The [pricing FAQ](https://www.convex.dev/pricing/faq)
counts resource usage per Convex team, not per seat:

| Resource, monthly | Starter included; excess rate | Professional included; excess rate |
| --- | --- | --- |
| Calls, millions | 1; $2.20 | 25; $2 |
| Actions, GB-hours | 20; $0.33 | 250; $0.30 |
| DB I/O, GB | 1; $0.22 | 50; $0.20 |
| Egress, GB | 1; $0.132 | 50; $0.12 |
| DB storage, GB | 0.5; $0.22 | 50; $0.20 |
| Search storage, GB | 0.5; $0.55 | 1; $0.50 |
| Search queries, thousands of query-GB | 3; $0.11 | 50; $0.10 |

For usage vector `u`, included vector `a`, rates `r` and `n` operator/developer
seats, use `sum(max(0,u-a)*r)` plus `25*n` for Professional. Outside customers
are application users, not automatically paid developer seats. No account change
is made here. Private billing notes describe different allowance treatment;
the public comparison cannot reconcile an actual invoice or establish eligibility.

Current and 2x scenarios preserve the frozen meter's class mix, including migration,
normalized to $75 and $150/month at operating rates, with 7.5 GB DB storage,
negligible search storage and no Convex file storage. Their monthly usage vectors
`[million calls, DB GB, action GB-h, egress GB, thousand query-GB]` are
`[3.191795,274.303807,33.738216,30.225056,0.065239]` and twice those quantities.
Storage is held constant at 2x activity.

| Scenario | Published Starter | Professional, 1 / 2 / 3 seats |
| --- | ---: | ---: |
| Current, normalized $2.50/day operating-rate workload | $74.88 | $69.86 / $94.86 / $119.86 |
| 2x activity | $157.37 | $125.98 / $150.98 / $175.98 |
| 1,000 small teams, modeled serving envelope below | $9,781.05 | $8,769.34 / $8,794.34 / $8,819.34 |

For the **current mix and fixed storage**, solve the formula above: Professional
breaks even at operating-rate monthly operation expense $61.38 / $130.01 /
$208.12 for 1 / 2 / 3 seats, or $2.05 / $4.33 / $6.94 per day.
Five seats break even at $364.35/month ($12.14/day). These are mix-dependent,
not universal revenue/spend thresholds. If the account receives no Starter
allowances, the current comparator is $84.15 before other meters, strengthening
the one-seat case; confirm contractual rates and allowances before a decision.

Outside scale means 1,000 teams, each five agents, 50 landings/day, five human
sessions/day, 30 days: 1.5 million landings, 150,000 agent-days and 150,000 sessions.
The existing serving model totals $9,881.55/month including R2 at marginal prices.
For plan arithmetic, approximate its Convex operation component as $9,700 at
Starter, allocate that across calls/I/O/actions/egress in raw capture #4's dollar
ratio `1.47:4.05:2.92:1.05`, and divide by each Starter rate. This is a **modeled
allocation, not measured corrected class usage**. It gives
`[682.967717,18816.457515,9044.289044,8130.568062,51.543]`, plus
385 GB DB and 1 GB search storage. Search assumes 46 searches/agent-day at
7.47 MB/query. Provider allowances produce the table's ~$9,781 Convex; roughly
$93 R2 remains separate. The small difference from $9,881.55 is rounding/model
allocation. A 1,000x shared index adds roughly $5,664 Starter search cost/month;
this sensitivity and growing retained bytes can overwhelm small plan savings.

Professional is a low-effort owner decision when eligible and cheaper at the
actual seat count. It does not alone close the serving target gap. Recompute after
migration ends: this I/O-heavy development mix is not the outside serving mix.

## Replacement prices by job

All alternatives below keep R2 source bytes. Managed realtime is evaluated only
for notifications and board/view updates; it cannot replace source transactions,
landing acceptance, CI orchestration or durable metrics. The table gives a
**standalone monthly price for the slice** at current modeled activity
(100 landings/day, ten agent-days/day, ten sessions/day) and at 1,000 small teams.
Included allocations and fixed fees are shared: do not add standalone rows to
claim a whole-system quote. Bridge and remaining Convex costs are additional.

| Job | Keep Convex; modeled cut and slice cost now / 1,000 teams | Cloudflare replacement now / 1,000 teams | Self-hosted Convex | Managed realtime |
| --- | --- | --- | --- | --- |
| Landing/source/compose/CI/finish | Keep atomic authority; 25% less proxy orchestration gives $14.75 / $7,375.50 versus $19.67 / $9,834 before cut; savings unmeasured | Workers + DO authority + Queues: ~$5.50 / $265–$565 | Shared fleet below | Not a replacement |
| Extra saves/sync beyond landing allocation | Batch existing metadata; 30% cut: $0.72 / $360 versus $1.03 / $514 | Workers + DO: ~$5 / $149–$419 | Shared fleet below | Not a replacement |
| Planning records/search/writes | Existing one-mutation writes; no proven new cut. ~$0.25 / $125 for modeled search/write operations | Workers + indexed D1: ~$5 / $9 | Shared fleet below | Broadcast only; records stay Convex |
| Reactive web views | Narrow dependency sets; 25% cut: $0.10 / $50 versus $0.13 / $67 | Hibernating DO + Worker: ~$5 / $5.62 | Shared fleet below | Supabase: $25 / $100, plus bridge |
| Notifications/alerts | Meter endpoint projection $0.14/month now; scale unknown; reuse current writes | Share DO view transport; $5 base if isolated, near-zero marginal within its allocations | Shared fleet below | Shares the preceding $25 / $100; no extra plan needed |
| Metrics | 75% less I/O: ~$1.20–$6.98/month at old operating-rate frequency; outside illustrative 30k 1-MB reports costs ~$1.67 Starter after cut | Workers + D1/R2 compact summaries: ~$5 / $5 at that report load | Shared fleet below | Not a replacement |
| Imports/exports | Reuse an existing artifact when suitable; preserve requested import/export capability. 1,000 new 10k-file snapshots: $24.09 once; steady imports $0 | Streaming Worker + R2: ~$5 minimum / ~$5 floor for those imports, plus CPU formula; not a validated runtime fit | Shared fleet below | Not a replacement |

Landing row uses `0.00596*1.1*L`, including some save/wait activity, rather than
treating the fixture as production. Extra-save row is only the explicit
`20 saves + 10 syncs` per agent-day in the serving model:
`1.1*(20*0.000107747+10*0.000095967)`; R2 terms in that approximation are slightly
overpriced by the multiplier. Planning assumes 46 searches and ten writes per
agent-day: `1.1*(46*0.000015222+10*0.000006)`. Web assumes
`0.000448/session`. These slices are approximations with shared duties; they do
not add to a second calibrated serving forecast. Notification fanout is unknown.
No assumed design cut is a measured gain or a change to product limits.

### Cloudflare calculation and correctness work

[Workers](https://developers.cloudflare.com/workers/platform/pricing/) costs
$5/month, with 10M requests and 30M CPU-ms; excess is $0.30/M requests and
$0.02/M CPU-ms. [Queues](https://developers.cloudflare.com/queues/platform/pricing/)
includes 1M operations; excess is $0.40/M, normally three operations per
message up to 64 KB. Retries add operations. No per-team queue is assumed.

[Durable Objects](https://developers.cloudflare.com/durable-objects/platform/pricing/)
includes 1M requests and 400k GB-seconds, then $0.15/M requests and $12.50/M
GB-seconds; duration is billed in allocation-sized units. Outgoing WebSocket
messages are uncharged. SQLite storage includes 5 GB, then $0.20/GB-month;
row allowances/rates match [D1](https://developers.cloudflare.com/d1/platform/pricing/):
25 billion reads, 50 million writes, then $0.001/M reads and $1/M writes.
D1 storage is $0.75/GB-month beyond 5 GB. Index writes count too.

For landing replacement, assume 60 Worker requests at 20 CPU-ms, 30 DO requests,
100–300 physical row writes including indexes, 1,000 row reads, one second of
active DO time at 0.128 GB, and ten small queued messages per landing. At 1.5M
landings: Workers $64.40 + DO requests $6.60 + row writes $100–$400 + DO storage
$76 (385 GB) + queues $17.60 = $264.60–$564.60. Duration fits its allowance.
D1 is a planning/search projection, not a second landing authority.

Extra saves/sync: 4.5M commands/month, ten Worker and ten DO requests/command,
20 CPU-ms/request, 30–90 physical writes/command, 100 GB storage and one queued
message/command gives $32.90 + $6.60 + $85–$355 + $19 + $5 = $148.50–$418.50.
Planning: 8.4M Worker requests at 5 ms, 45M physical writes, indexed reads below
25B and 10 GB D1 gives $5.24 + $3.75 = $8.99. FTS/query equivalence is unproved.

Views/notifications assume 100 delivered events/session, three receivers per
publish, 5M publishes and 150k connection upgrades/month, 5 ms Worker CPU/publish
and 10 ms DO active time/publish. Worker $5 + 4.15M excess DO requests at $0.15/M
= $5.6225; duration is below allowance. Keep storage below 5 GB for this transport.
[WebSocket hibernation](https://developers.cloudflare.com/durable-objects/best-practices/websockets/)
keeps sockets connected without idle duration billing; constructors must restore
attachments/state. Real fanout, heartbeat behavior and burst CPU remain unmeasured.

DO transactions can serialize one project's acceptance, but migration must preserve
exact-head checks, operation-id replay, authorization and lost-reply reconciliation.
Queues provides [at-least-once delivery](https://developers.cloudflare.com/queues/reference/delivery-guarantees/):
a durable outbox and deduplication are required to prevent lost or duplicate
side effects. Splitting a commit across Convex, D1 and a message broker is not
atomic. Keep one authority, then publish versioned projections. Reconnect must
recover missed versions; current membership/revocation must govern delivery.
Otherwise stale board views, leaked private data or duplicate acceptance regress
correctness. Edge placement alone proves no end-to-end latency improvement.

### Self-hosted Convex: cheap host, unpriced reliability

The [official guide](https://github.com/convex/convex-backend/blob/main/self-hosted/README.md)
uses a backend/dashboard, persistent storage and SQLite by default, with optional
SQL and S3 storage. Client/reactive semantics can largely remain. This project
already has self-host tooling; it still needs endpoint/auth/deploy/restore and
scheduler qualification. Two active backends sharing local SQLite are not an HA
configuration. Off-host backups enable recovery; they do not provide failover.

[DigitalOcean](https://www.digitalocean.com/pricing/droplets) lists 2-GB/1-vCPU at
$12/month, 4-GB/2-vCPU at $24, and 8-GB/4-vCPU at $48.
[Weekly VM backups](https://docs.digitalocean.com/products/backups/details/pricing/)
add 20%. A 4-GB single-host trial is therefore $28.80/month plus R2, labor and
recovery tests. It is an experiment price, **not an equivalent production option**.

For a multi-machine budget, two 4-GB hosts plus weekly images are $57.60/month.
[Routing](https://www.digitalocean.com/pricing/load-balancers) starts at $12;
[managed PostgreSQL](https://www.digitalocean.com/pricing/managed-databases)
lists a 2-GB node at $30.45. Budgeting two DB nodes gives
`57.60 + 12 + 2*30.45 = $130.50/month`, plus R2 and any extra disk/backup cost.
At 1,000 teams, ten shards, each two 8-GB backend hosts with weekly images,
are $1,152; ten routing nodes add $120 and twenty 2-GB DB nodes add $609:
**$1,881/month before extra disk**. Reserving ten more GB per DB node at
$0.215/GiB adds $43, or roughly **$1,924/month plus R2 and labor**.
Those are hardware budgets, not validated service capacity or an HA guarantee.
The [SQL guide](https://github.com/convex/convex-backend/blob/main/self-hosted/advanced/postgres_or_mysql.md)
warns that database distance affects query latency. Fence a single backend leader
and qualify standby promotion, SQL failover, scheduler recovery, consistent backup
and restores before claiming independence of one machine. A second unfenced
backend is not proven safe simply because the SQL service has replicas.

Budget 1–3 engineer-days to qualify one host; a phase to prove multi-machine
recovery, upgrades and failover, then 4–12 operator-hours/month as a planning
allowance. At an illustrative $100/hour, labor alone adds $400–$1,200/month.
Patching, monitoring, TLS/auth keys, disk growth, corruption recovery, backup
consistency and incident response become Forge's responsibility. The
[backend license](https://docs.convex.dev/self-hosting) is FSL with conversion to
Apache after two years, rather than Apache for all current backend code. These
costs and portability constraints persist for every job; hosting one tiny board
slice on another backend rarely repays the fixed operations burden.

### Managed updates only

[Supabase Pro](https://supabase.com/pricing) starts at $25/month for one project.
[Realtime](https://supabase.com/docs/guides/realtime/pricing) includes 5M messages
and 500 peak connections, then $2.50/M messages and $10 per 1,000 connections.
At 15M billed messages and 5,000 peak connections, conservatively rounding excess
connections to five blocks gives `$25 + $25 + $50 = $100/month`. At today's
modeled 30k events and 50 sockets it is $25. These are one shared project, not
1,000 individually billed projects; connection concurrency is assumed.

Use Broadcast for notifications and versioned board projections; keep Convex
records authoritative. Five million publishes can add around $11/month in
Starter function calls plus action compute/egress/auth reads before broker cost;
a bridge needing reads per recipient would be worse. Initial data, reconnect
catch-up and permissions still need authoritative reads, so $67/month of modeled
Convex sessions cannot all be counted as eliminated. Publication failure between
commit and send needs an outbox. Replacing Convex `useQuery` subscriptions with
invalidation/refetch can increase latency and calls. At this volume Convex is
already cheaper than a standalone paid broker for views; no saving is established.

## Migration effort, ranking and decision

These are code-reading estimates, not patches or mechanically exact dependency
counts. Count both public and internal functions; inspect schema field modules,
shared source transport and the [reactive client](../../web/src/hosted-work-index.ts).
The inspected broad repository surface has about 179 `defineTable` sites and
910 exported Convex function declarations, including unrelated areas. A slice
cannot be estimated as changing only the few metered hot functions.

| Slice | Tables / functions / lines likely touched | Effort and principal risk / lock-in |
| --- | --- | --- |
| Metrics compact projection in Convex | 1–2 / 3–8 / 300–800 | 2–4 days; preserve missing-coverage semantics; current Convex dependency |
| Source steps + CI row/result batching in Convex | 2–6 / 10–25 / 800–2,500 | 3–8 days; lost replies/OCC/reuse correctness; no new vendor |
| Extra save/sync batching in Convex | 0–3 / 5–15 / 500–1,500 | 2–5 days; exact source/head recovery; current dependency |
| Cloudflare metrics/import stream | 1–5 / 5–15 / 1k–3k | 1–3 weeks; auth, recovery, streaming limits; Worker/queue bindings |
| Cloudflare planning + DO views | 4–10 / 20–50 / 3k–8k | 3–6 weeks; FTS/auth/reactive parity; DO/D1 coupling |
| Cloudflare landing/source/control authority | 30–70 / 100–250 / 15k–40k | 8–16 weeks; transaction, scheduler, receipts, acceptance and security parity; strong DO coupling |
| Self-host complete backend | All existing tables/functions deployed; 0 domain-schema rewrites; 1k–4k config/tooling lines | 1–3 days trial, 4–8 weeks reliable service; smallest domain rewrite, largest operations transfer |
| Supabase updates bridge | 1–3 outbox/projection tables / 8–20 functions / 1k–3k lines | 1–3 weeks; delivery/revocation/initial snapshot; broker protocol plus second auth boundary |

| Rank | Option | Conditional saving | Effort / risk | Horizon |
| --- | --- | --- | --- | --- |
| 1 | Compact metrics reads on existing calls (Issue `405c8aa2`); drain migration after its existing completion | Metrics ~$4–$23/month Starter; sample migration $2.33/day operating-rate ceiling while it runs | 2–4 days; low–medium; migration saving is episodic, not annual recurring | Days |
| 2 | Reduce source continuations and batch CI results (`ac5200f5`, `65534f20`) | Illustrative 25% of serving proxy: ~$4.92/month at 100 landings/day, ~$2,459/month at 1,000 teams | 3–8 days; medium; validate counters and exact acceptance | Days |
| 3 | Professional when eligible and below seat break-even | Current saves ~$5/month for one seat, costs ~$20 more for two; 2x saves ~$31 / $6 for one / two; outside ~$1,012 / $987 | Hours for owner decision; low migration risk; account eligibility/allowances unresolved | Days |
| 4 | Batch extra save/sync metadata | Illustrative 30%: ~$0.31/month now, ~$154/month at 1,000 teams | 2–5 days; medium; do not double-credit landing-owned saves | Days |
| 5 | Cloudflare landing/control, retaining R2 | Gross outside slice ~$9,834 to ~$265–$565/month, ~$9,269–$9,569 infrastructure headroom before remaining Convex/bridge/ops | 8–16 weeks; high; full correctness and capacity parity unproved | Phase |

For 1,000 teams, rank 2 buys roughly $307–$820/month of infrastructure saving
per engineer-day; rank 4 buys $31–$77. Rank 5 offers roughly $116–$239/month
per engineer-day over 40–80 working days, before risk, ongoing labor or overlap.
These ratios use hypothetical savings and estimated effort, not measured returns.
Ranks weight saved dollars against work and correctness risk, not only the largest
hypothetical bill reduction. Do not sum these savings: plan discounts and cuts
overlap, and the Cloudflare quote replaces much of the path cut in rank 2.
The current $1.50/day goal primarily needs development-overhead reductions;
rank 2 alone is too small at 100 landings/day. Backup-artifact reuse can avoid
$0.25–$0.55 per unnecessary export, but changing backup cadence or denying exports
is an owner decision. The sample's migration work must complete correctly, not be
silently disabled to meet a budget. Existing capabilities/wait cuts are already
landed and are not new savings. Search-index surgery is not a quick dollar win.

Self-hosting ranks behind the five: its single-host price is attractive but does
not satisfy the reliability rule, and labor can exceed current Convex expense.
Managed realtime also ranks below retaining Convex at current fanout. If measured
large fanout later dominates, evaluate DO hibernation first, preserving authority
and durable delivery. Imports/exports should first avoid needless retransfers on
the present backend; long-lived archival bytes already belong in R2.

Before selecting a migration, obtain a serving-only command-tagged trace and
same-window invoice reconciliation; measure physical DB writes, retained bytes,
source CPU, subscription fanout and revocation/reconnect behavior. Run isolated
synthetic replay/failover tests only within an approved budget. The Issue's billed
200-landing test and live R2 calibration remain separate acceptance work. No new
measurement or service is authorized by this document. It consolidates existing
meter, ledger and serving-model evidence; there is no predecessor runtime to remove.
