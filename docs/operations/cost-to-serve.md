# Cost to serve an outside repository

For a 10,000-file repository, this model budgets **about $2.16/month for a solo
developer with two agents, $9.88 for five agents, $57.35 for twenty agents, and
$0.0043 while idle**, using published Starter marginal rates. These are estimates
of Forge's Convex and R2 expense, before provider allowances, not customer prices.
CI can be much larger; its payer follows the configured runner repository.

The model freezes today's implementation. It separates serving from Forge's own
migrations, metrics investigations, compares, experiments, drills, benchmark and
zoo imports, backup-export experiments, deployments and development workflows.
A customer's first import is onboarding expense, shown separately. Taxes, support,
agent/model tokens, fixed web-hosting plans and developer seats are outside these
infrastructure units. No production workload was run to produce this document.

## Prices and calculation basis

The brief/capture basis is calls $2/million, actions $0.30/GB-hour, database I/O
$0.20/GB and Convex egress $0.12/GB. **Those are currently Professional rates.**
The [published pricing page](https://www.convex.dev/pricing) lists Starter at
$2.20/million, $0.33/GB-hour, $0.22/GB I/O, $0.132/GB egress,
$0.22/GB-month database storage, $0.55/GB-month search storage and
$0.11/1,000 query-GB. The matching capture-basis storage rates are $0.20 and
$0.50. Starter Convex file storage is $0.033/GB-month; new source bytes use R2,
so that meter contributes zero here. GB means decimal GB in these calculations.

[R2 Standard](https://developers.cloudflare.com/r2/pricing/) is $0.015/GB-month,
$4.50/million Class A operations and $0.36/million Class B operations; egress
and deletes are free. Counts below use marginal prices, without subtracting
shared allowances. Actual invoices apply account-level allowances and rounding,
so a single tiny repository need not incur its modeled fractional charge.
Published Starter allowances also differ from earlier account-specific billing
notes; this document does not infer a private account's invoice or change its plan.

At the brief rates, operation expense is:

```text
2e-6 * calls + 0.30/3600 * action_GB_seconds
+ 0.20 * database_read_and_write_GB + 0.12 * Convex_egress_GB
+ 0.00011 * search_query_GB + 4.5e-6 * R2_A + 0.36e-6 * R2_B
```

Multiply the first four terms by 1.1 for published Starter; search already uses
Starter's published rate. Storage is added separately. R2 uploads from a Convex
action incur Convex egress even though subsequent R2 downloads have free egress.

## Evidence and the allocation we cannot yet measure

The [`costs` ledger](../../src/speed-budgets.json) and
[`landing-cost-guard.test.mjs`](../../tests/landing-cost-guard.test.mjs) measure a
six-landing fixture: solo, recompose/recheck, and a batch of four. Per landing it
records 27.5 mutations, 9.83 V8 actions, 0.67 Node actions, 806,895 read bytes,
248,852 write bytes, 3.17 R2 A and 11.67 R2 B operations. Its 3.26 GB-seconds
are modeled, using nominal durations. It excludes client waits, the GitHub mirror
and real CI activity. Pricing that fixture gives roughly $0.00058/landing;
it is a partial fixture, **not** a production cost forecast.

Capture #4 in Issue `3e3f9fe6` observed ten landings over 56.9 minutes:
737 executions, 17.23 MB read, 3.03 MB written, 8.73 MB egress and 35 GB-seconds
per landing, $9.49/1,000 at brief rates. Subsequent attribution removed $3.53/1,000
of save/sync drills, scratch landings/purges, test imports and backup polls:
**$5.96/1,000 is the corrected serving proxy** ($5.92 in capture #3).
This is an observed workload priced at list rates, not an isolated outside-user
trace or a billed cost per user. Later fixes suggest $5.75/1,000, unmeasured;
that saving is not assumed here.

To avoid adding a full agent-day on top of an already mixed capture, the model
allocates the $0.00596 proxy between a landing and non-landing agent activity.
At an assumed calibration load of ten landings per agent-day:

```text
agent_extra_day = 0.0060949964
landing = 0.00596 - agent_extra_day / 10 = 0.00535050036
agent_extra_day_after_search_cut = 0.0053947982
agent_day_with_k_landings = selected_agent_extra_day + k * landing
```

This split is **modeled**, not a measured marginal landing price. It assigns a
landing its save, check orchestration, merge, main/mirror update and normal live
wait. The agent-day below contains additional commands outside those landings.
Changing that allocation changes forecasts when landings per agent-day change;
a serving-only trace tagged by initiating command is the single missing measurement.

## Per-unit budget

| Unit | Brief/capture rates | Published Starter | Evidence |
| --- | ---: | ---: | --- |
| Landing, including its save and wait | $0.005351 | $0.005886 | Allocation of corrected capture |
| Extra active agent-day, before/after a02991a7 resolution | $0.006095 / $0.005395 | $0.006697 / $0.005930 | Modeled 92 search pages before, 46 after |
| Agent-day with ten landings, after search cut | $0.05890 | $0.06479 | Sum of the preceding two units |
| Human web session | $0.000408 | $0.000448 | Modeled 30-minute session |
| Idle repo-month, 10k files, 100 MB source | $0.004045 | $0.004295 | Modeled retained bytes below |

Extra agent-day assumes 20 saves, ten syncs, 92 planning-search pages, 100 status
commands, twenty changed-file snapshots, ten planning writes and fifty wait-page
updates unrelated to its landing waits. These are workload assumptions inspired
by current habits, not a measured per-agent histogram. The before model assumes
46 duplicate checks with two search pages each; the after model uses the shipped
one-page search with limit 10: 46 pages/day. The old pages-per-check distribution
is unmeasured; a one-page user saves nothing, a three-page user saves two pages.
A search page is a new query, including continuation pages. All other counts stay
unchanged, and per-search result I/O is conservatively held constant.

| Extra operation | Calls | DB I/O | Action GB-s | Convex egress | R2 A/B | Brief-rate $/operation |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Save | 12 | 100 KB | 0.5 | 100 KB | 2 / 3 | 0.000107747 |
| Sync | 10 | 80 KB | 0.5 | 100 KB | 1 / 5 | 0.000095967 |
| Planning-search command/page | 3 | 30 KB | 0 | 20 KB | 0 / 0 | 0.000015222 |
| Status command | 3 | 20 KB | 0 | 10 KB | 0 / 0 | 0.000011200 |
| Changed snapshot | 1 | 10 KB | 0 | 0 | 1 / 0 | 0.000008500 |
| Planning write | 1 | 20 KB | 0 | 0 | 0 / 0 | 0.000006000 |
| Extra wait update | 1 | 13 KB | 0 | 0 | 0 / 0 | 0.000004600 |

All rows in this table are modeled command budgets. The snapshot's one call and
one PUT, and planning write's one mutation, have fixture guards. Other counts,
bytes and action durations need a tagged command trace. Reactive web re-executions
belong to web sessions, not the planning-write row.

Issue `a02991a7` resolved a billing misunderstanding and shipped a one-page
duplicate-search workflow (GitHub `7bc11e7a`). It did not ship the proposed
search-only table. The observed 7.47 MB/search is the whole search index,
not returned document bytes: [Convex search costs](https://docs.convex.dev/search/text-search#costs).
At 920 searches/day this is $0.000756/day before allowances, **not $1.38/day**.
The shipped cut saves a modeled $0.0007002/agent-day at brief rates
($0.0007664 at Starter) from 46 fewer commands, including their calls and result
I/O. An unshipped sevenfold index reduction alone would save only $0.0000648 per
92-search agent-day; calls and result DB I/O would remain. In a shared index, query-GB can grow with
all projects' indexed records; 1,000-repo extrapolation assumes the same search
index bytes per query. Even a 1,000-fold index growth would add about $2.27 per
active agent-month at 92 searches/day (about $1.13 at 46); measure this rather than calling it linear.

A human session budgets 100 query executions including subscription reruns,
0.9 MB DB reads, 0.2 MB Convex egress and ten R2 GETs: $0.0004076 at brief rates.
[`hosted-work-index.ts`](../../web/src/hosted-work-index.ts) supplies Work views;
ledger `planning-reruns` records six reruns for three open tabs per planning write.
A quiet connected page does not repeatedly poll; busy projects and multiple tabs
increase actual reruns. Static page delivery is outside this Convex/R2 subtotal.

## Adding a repository, including history

File count alone cannot price an import. This example assumes distinct files
averaging 10 KB, no LFS payloads, a successful archive import without retries, and
300 bytes/file of manifest/catalog metadata. The archive path packs source in
bounded windows, without one Convex call per file:
[`projectGithubImportArchive.ts`](../../convex/projectGithubImportArchive.ts),
[`projectGithubImportUpload.ts`](../../convex/projectGithubImportUpload.ts), and
[`github-import-pages.ts`](../../src/github-import-pages.ts).

For N files and B GB source, use P = ceil(B bytes / 8 MiB), calls = 10 + 3P,
DB I/O = 2 * 300N bytes, action duration = 5 + 2,000B seconds at 0.5 GB,
Convex egress = B GB and R2 Class A and Class B each = P + 3 operations. These are explicit model
inputs, not observed import totals. The 1,005-second largest example spans action
continuations (the archive worker yields after six minutes); it is not one action.

| Files / source | Snapshot only | With illustrative 100-commit history | With illustrative 1,000-commit history | Snapshot only, Starter |
| --- | ---: | ---: | ---: | ---: |
| 1k / 10 MB | $0.00242 | $0.01263 | $0.04315 | $0.00266 |
| 10k / 100 MB | $0.02191 | $0.12369 | $0.42890 | $0.02409 |
| 50k / 500 MB | $0.10856 | $0.61730 | $2.14339 | $0.11939 |

History examples assume compressed Git packs H = 5B and 20B respectively;
**commit count does not establish pack bytes**. Actual changed content, binaries,
compression and deduplication determine H. Additional history budget is
20 calls + 2,000H seconds at 0.5 GB + H GB Convex egress +
ceil(H bytes / 32 MiB) R2 A and B operations. Multiply its Convex terms by 1.1 for
Starter. [`projectHistoryImport.ts`](../../convex/projectHistoryImport.ts) streams
32 MiB chunks to R2; `projectHistoryFields.ts` defines that chunk size. Indexing,
framed serving copies, retries, LFS and slower transfers add expense; none was
measured here. Add $0.015H/month for the stored original history pack, plus any
measured auxiliary copies. No import or export was run for these estimates.

## Idle storage and an active month

An initially idle project is modeled as 10 MB Convex rows including indexes,
1 MB search index and source plus 300N manifest/catalog bytes in R2:

| Files / source | Brief-rate idle $/month | Starter idle $/month |
| --- | ---: | ---: |
| 1k / 10 MB | 0.002655 | 0.002905 |
| 10k / 100 MB | 0.004045 | 0.004295 |
| 50k / 500 MB | 0.010225 | 0.010475 |

These storage sizes are assumptions. Capture #4's deployment held about 10.99 GB
of R2 bytes, including 2.90 GB backups and 1.07 GB check logs; that multi-project,
retained-history total is not a bytes-per-new-repo measurement. The ranked table
on Issue `686ecdde` separately attributes metrics reads, migration compares,
backup exports and test imports; none is recurring outside-user landing expense.
A truly idle repository with no users, scheduled checks, backup activity or edits
has zero operation calls in this model. Operator-scheduled backups and checks,
if configured, are additional, not storage-only idle expense.

For an active 30-day month, L landings, A active agents every day and S sessions:

```text
operations = L * 0.00535050036 + 30*A * 0.0053947982 + S * 0.0004076
average_DB_GB = 0.010 + (0.0005 * L)/2
average_search_GB = 0.001
average_R2_GB = 0.103 + (0.0002 * L)/2 + 0.001*(L/30)*7 + 0.0001*20*A*14
storage = 0.20*average_DB_GB + 0.50*average_search_GB + 0.015*average_R2_GB
```

Storage assumes 0.5 MB new retained DB rows and 0.2 MB new unique source per
landing, 1 MB check logs/landing retained seven days and twenty 0.1 MB snapshots
per agent-day retained fourteen days. These are modeled byte budgets, not new
retention policy or a claim that every installation automatically expires logs.
Halving new retained bytes models growth from zero during the first month; rolling
logs/snapshots use a conservative full window. Without configured cleanup they
accumulate instead. Each additional month adds retained Work/source/history;
there is no fixed lifetime repo cost. Existing retained bytes must be added.

## Monthly scenarios

All use the 10k-file, 100 MB starting repository, no historical pack, 30 active
days, existing customer-owned CI, and no new imports. Solo has two agents (one
agent is about $0.18/month less at Starter); sessions are one, five and twenty per
day. These are the after-a02991a7 estimates. Before, Starter totals were
$2.20 / $10.00 / $57.81 / $0.0043; the difference assumes the search-page mix above.

| Scenario | L / month | Agent-days | Brief-rate $/month | Starter $/month | 1,000 such repos, Starter | Dominant Forge expense |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| Solo, 10 landings/day | 300 | 60 | 1.96 | 2.16 | 2,158.08 | Landing/source/check orchestration |
| Small, 50 landings/day | 1,500 | 150 | 8.98 | 9.88 | 9,881.55 | Landing/source/check orchestration |
| Busy, 300 landings/day | 9,000 | 600 | 52.14 | 57.35 | 57,349.96 | Landing/source/check orchestration |
| Idle | 0 | 0 | 0.004045 | 0.004295 | 4.30 | Retained storage |

One thousand of **each** means 4,000 repositories: about $69,393.89/month Starter.
An equal mix totaling **1,000** repositories (250 of each) is about $17,348.47.
These are arithmetic extrapolations, not measured capacity or volume discounts.
For a shared-deployment stress case with 1,000 times the search index bytes, the
1,000-repo columns become about $4,424 / $15,546 / $80,006 / $4.30. An equal mix
of 1,000 becomes about $24,995/month. This assumes index bytes grow proportionally
with repository count; actual retained Work rows determine the index, so it is a
sensitivity, not a measured forecast. A 22-day
working month replaces L, agent-days and sessions with 22-day totals and recomputes
retained bytes; it does not multiply storage by 22/30.

## Who pays CI minutes

- **Forge runner:** the owner chooses `configuration.repository` in
  [`projectHostedActionsConfigure.ts`](../../convex/projectHostedActionsConfigure.ts).
  [`projectHostedActionsDirect.ts`](../../convex/projectHostedActionsDirect.ts) dispatches
  `repos/{configuration.repository}/actions/workflows/forge-check.yml/dispatches`.
  GitHub bills that repository's owner. The Forge App dispatch credential does not
  make Forge the payer. A customer's own mirror/runner means customer-paid CI;
  a Forge-owned configured runner means Forge-paid CI. The configuration can name
  a different runner repository, so customer payment is not universal.
- **ci-status provider:** [`ci-status.ts`](../../src/ci-status.ts) publishes the
  Candidate branch in the project's configured CI repository. Its existing workflow
  executes there; that repository/provider account pays. Forge pays the Convex
  publication and status processing, not a second copy of the CI job.
- **Forge development:** [forge-check.yml](../../.github/workflows/forge-check.yml)
  uses the configured runner labels; [foundation.yml](../../.github/workflows/foundation.yml)
  separately runs Verify Forge on mirror pushes. Deploy/sign/smoke workflows are
  Forge development expense. They do not run once per outside-user landing.

The ledger measured 77.9 stored shard runner-minutes/landing, distinct from
12.3 wall minutes. Capture #4 reconciled about 86.4 GitHub forge-check minutes,
22 Verify Forge minutes and 2.6 deploy/sign/smoke minutes per landing. Use 86.4,
not their sum, as the illustrative Forge-runner budget. This is Forge's large test
suite, not a measurement of arbitrary customer tests; docs/scoped checks can be
much smaller. At [GitHub's Linux x64 rate](https://docs.github.com/en/billing/reference/actions-runner-pricing)
of $0.006/minute, a metered Forge-owned runner would add **$0.5184/landing**:
$155.52 / $777.60 / $4,665.60 per scenario-month, or
$155,520 / $777,600 / $4,665,600 for 1,000 of each active scenario. Standard
public-repository runners are currently free; observed Forge billed minutes were
$0. Private allowances, per-job minute rounding, OS/runner selection, artifacts
and cache storage change the bill. Self-hosted runner hardware/cloud is paid by
its operator. No paid runner or new service is introduced by this analysis.

## Largest driver, cheapest fix and remaining measurements

With customer-paid CI, source/action steps and CI-result database I/O dominate
Forge serving expense. Capture #4 attributed $2.99/1,000 to source/objects and
$1.36 to CI results before workload correction; these family numbers do not sum
to the corrected proxy. Reusing the existing batched result path and avoiding
repeated source steps are the cheapest implementation candidates (already tracked
under `686ecdde` and `65534f20`); savings still require measurement. Fewer unnecessary
CLI reads are cheap but calls were under $0.05/day in the ranked sample. Search
index surgery would save pennies at the measured scale. With a paid Forge-owned
CI runner, CI dominates by roughly two orders of magnitude; reducing applicable
check work/batching matters far more than search optimization. No new product
restriction, mandatory step or payer policy follows from these findings.

| Modeled or unresolved quantity | One measurement that firms it up |
| --- | --- |
| Landing/agent allocation and ten-landings calibration; updated serving rate | One log-only serving window tagged by initiating commands, with receipt count and development/test jobs excluded |
| Save/sync/status/wait command call counts, bytes and GB-s; agent habit mix | One agent-day command-attributed trace, separating landing-internal commands from extra activity |
| Web session's 100 executions, bytes, reruns and ten GETs | One synthetic browser session under representative concurrent planning writes, recording billed reruns and R2 requests |
| Imports: 10 KB/file, 300 B metadata/file, throughput, pages, publication overhead and retries | One already-approved import's per-phase logs, R2 counters and retained-byte deltas; no new import is authorized here |
| History depth-to-pack multipliers, upload throughput, auxiliary copies and indexing | One approved import with known pack bytes and final original/framed/index byte counts |
| New-repo DB/search/R2 footprints; 0.5 MB Work, 0.2 MB source and 1 MB logs/landing; snapshot size and actual expiry | One retained-byte inventory before/after a serving-only month, by project and object family |
| Shared-index growth, old pages/check and a hypothetical sevenfold reduction | One per-query index-byte reading after the existing store change; the per-query index size was not reduced |
| Actual customer's CI minutes, account payer, OS, rounding, cache/artifact costs | One configured run's repository binding and provider billing detail, including artifacts |
| 1,000-repo concurrency, retries and batching | One approved representative multi-project trace; linear multiplication alone proves no capacity claim |
| Actual allowances, web delivery/hosting and other fixed operator expense | One operator billing reconciliation by provider and deployment, outside this marginal Convex/R2 model |

No fresh Convex workload, metrics read, export, import or log sample was needed:
this analysis reuses the ledger, guard, capture #4, Issue `686ecdde`'s ranked table,
a02991a7's billing finding, source code and public provider documentation. Nothing
runtime is added or removed; this document consolidates the existing evidence
into one serving model rather than creating a second cost ledger or alert path.
