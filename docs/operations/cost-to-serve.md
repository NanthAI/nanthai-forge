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

<a id="pre-bench-smoke-and-subsequent-fixes-2026-11-10"></a>

## Pre-bench smoke and subsequent fixes

**Measured live usage, with explicit price bases:** the pre-bench smoke
(20:13–20:54 UTC, dry `n3-r1`, harness GitHub `4b092a6c`, ten Forge landings on
the bench deployment) cost $0.0894 in the driver meter: **$8.94 per 1,000**
(reported rounded as $8.9), against B1.5d $9.40. The driver uses $2.20/million
calls, $0.22/GB I/O, $0.132/GB egress and $0.30/GB-hour actions; this is a mixed
historical basis, not the complete Starter tariff. The independent journal's
$0.0869 uses the Professional capture rates above; at the driver's rates its
same window is $0.0928. The independent capture has zero detected gaps. These are
captured Convex usage priced at list, not invoices. The target is about $2 per 1,000; the driver
reading is 4.47 times that target. R2, stored bytes and maintenance have separate coverage and allocation below. This smoke is distinct from the earlier dev
whole-deployment window below.

Source-worker uploads are generated States/recipes, results and durable progress
sent from Convex to project R2; they are not source downloads sent to GitHub.
The 146 MB live total was not split exactly between State, progress and replay.
The new `forge-source-step.putBytes` counters separate attempted state/progress/
result/other/refused/avoided body bytes, including failed attempts, but are not
billed egress. HEAD-only reuse saved zero bytes in healthy sequential-save
fixtures and was withheld; replay-only savings were not admitted as landing gains.

### Post-fix smoke (`n3-r1-dry-a2`)

The post-overnight-fixes smoke is `n3-r1-dry-a2` (2026-11-11 07:24:20–08:10:03 UTC),
against `n3-r1-dry-a1` above. Harness and bench deployment are Git
[`9a083d5e0a12`](https://github.com/NanthAI/nanthai-forge/commit/9a083d5e0a12d0589a0844dac9ff01bbf9e1762d);
the bench CLI is accepted State `9acd7b983e3e`, mapped to that same Git commit.
[Verify Forge](https://github.com/NanthAI/nanthai-forge/actions/runs/42977707945)
and the authorized [bench deployment](https://github.com/NanthAI/nanthai-forge/actions/runs/42979013818)
are green at that commit. Both arms use the same concurrent N=3 schedule, ten-task
order and seed `b15d-rerun-2026-11-01/n3/r1` as the original dry. Both retain
`agent: scripted-no-model`: configured Codex `gpt-6.1-sol` / high is a version pin,
not twenty model executions. Tokens are not applicable in either arm. No scored
cell runs; `qualifiedHarness`, `PLAN.md` and the registered plan stay unchanged.
The batch version guard passes with no changed measurement pin; moving accepted
Forge/GitHub main is recorded separately.

**Convex serving falls 30.0%, from $8.936 to $6.253 per 1,000 landings, on the
original driver's four rates.** The independent numeric capture has complete
coverage and zero detected gaps/missing usage fields in both whole-batch windows.
At those same rates it is $9.282 → $6.795 per 1,000; at Professional capture rates,
$8.689 → $6.376. It includes reset/setup, collection and deployment-wide webhook
traffic, while the driver attributes its task window to the bench project. The
after capture sees eleven acceptance markers, including reset; serving uses the
ten task receipts. The older journal has no acceptance markers, so its denominator
also comes from the retained receipts, not an invented zero.

| Cost per 1,000 task landings | Before `a1` | After `a2` | Basis / coverage |
| --- | ---: | ---: | --- |
| Convex serving | $8.936 | $6.253 | Measured driver usage, original driver rates |
| R2 operations | $0.0251 | ~$0.184 | Before: signer model; after: bucket-wide executed counts, 31.9 A / 112.0 B per landing, 54 free deletes and 60 userError requests total; see [reconciliation](#r2-counters-and-executed-bucket-operations) |
| Weekly backup I/O allocation | $0.415 | $0.399 | Model below; recurring expiry is unmeasured |
| Covered serving + R2 + maintenance subtotal | $9.376 | ~$6.836 | Mixed measured usage and maintenance model, not the complete invoice total |
| Covered subtotal / ~$2 target | 468.8% | ~341.8% | Unmeasured components are not zero |
| Complete serving + R2 + maintenance total | Unknown | Unknown | Net retained bytes and recurring expiry missing; before full operation counts missing |

Repricing the driver's identical usage at Professional rates gives $8.366 →
$5.868 per 1,000 before R2 and maintenance. The configured Professional plan's
captured usage remains within its period inclusions, so the captured marginal
usage overage is $0; that is not a $0 service cost or a complete invoice. The
$25/month subscription is separate, its shared allocation is not inferred, and
uncaptured usage and storage prevent invoice reconciliation. No plan changes.

The R2 counters retain all ten task receipts in each arm: Class A / B requests
signed by compose are 54 / 22 → 55 / 24, or 5.4 / 2.2 → 5.5 / 2.4 per landing.
Signed PUT lengths are 58,969,878 → 54,068,880 B total, or 5,896,988 → 5,406,888
B/landing. They count signatures, not every executed/retried R2 operation, and
exclude other upload/download paths. They do **not** measure stored bytes added:
create-only reuse, failed/duplicate bodies and retention are not a net inventory.
Net R2 stored-byte growth per landing remains unknown; no storage charge is
silently set to zero.

Backup allocation uses one weekly export at the retained mean 3.94 / 3 =
1.313333 GB read, or $0.262667 at Professional I/O rates. The complete preceding
seven-day accepted-receipt windows have 633 landings before and 659 after (22
bounded pages each), giving $0.414955 → $0.398584 per 1,000. This models a weekly
export, not all three manual experiments as recurring work, and excludes other
export resources. Recurring expiry lacks a representative measured period and
stays unknown. Catch-up expiry, migrations, index builds and scratch purges in
the maintenance table remain one-off costs; none is amortized into this smoke.

**Per-function driver attribution over ten landings.** MB is decimal; every cell
is before → after. Calls are the driver's project-attributed executions; the
older 549-call / 90-MB CI summary uses the wider independent window. Both meters
are valid; the different scopes are retained.

| Function | Calls | DB read / write MB | Egress MB | Action GB-hours | $ / 1,000 |
| --- | ---: | ---: | ---: | ---: | ---: |
| `projectConvexSourceNode:step` | 70 → 76 | 0.000 / 0.000 → 0.000 / 0.000 | 146.369 → 155.710 | 0.062290 → 0.050229 | 3.8162 → 3.5790 |
| `projectHostedActionsSource:resolve` | 543 → 114 | 89.143 / 0.000 → 13.848 / 0.000 | 0.000 → 0.000 | 0.000000 → 0.000000 | 2.0806 → 0.3297 |
| `projectConvexSourceObjects:resolve` | 414 → 290 | 14.464 / 0.000 → 4.086 / 0.000 | 0.000 → 0.000 | 0.000000 → 0.000000 | 0.4093 → 0.1537 |
| `POST /checks/actions` | 616 → 189 | 0.000 / 0.000 → 0.000 / 0.000 | 1.114 → 1.186 | 0.007337 → 0.001840 | 0.3703 → 0.1125 |
| `projectHostedReuse:prove` | 10 → 8 | 0.000 / 0.000 → 0.000 / 0.000 | 0.760 → 0.526 | 0.010783 → 0.007953 | 0.3357 → 0.2473 |
| `projectConvexSourceStore:commit` | 71 → 82 | 6.404 / 0.992 → 7.421 / 1.058 | 0.000 → 0.000 | 0.000000 → 0.000000 | 0.1783 → 0.2046 |
| `projectHostedFinishDriver:step` | 102 → 95 | 6.871 / 1.256 → 6.419 / 1.194 | 0.000 → 0.000 | 0.000000 → 0.000000 | 0.2012 → 0.1884 |
| All functions | 3,629 → 2,682 | 151.338 / 8.118 → 62.869 / 8.250 | 148.260 → 157.439 | 0.089073 → 0.067342 | 8.9356 → 6.2531 |

The live gain is concentrated in CI lookup: 543 → 114 calls and 89.143 → 13.848
MB read (−84.5%). Source-worker egress **increases 6.4%**, 146.369 → 155.710 MB;
its compute decreases, but this smoke does not prove the fixture's State-upload
saving. It remains 57.2% of the new driver cost. Total captured DB writes also
increase, 8.118 → 8.250 MB. Fixture savings and physical/index storage savings
are not substituted for these live observations.

**Timing observation, not a scored exit result.** Seconds unless labelled; ranges
are over the ten tasks. Shared-machine load is recorded in both arms; a single
dry pair does not establish a causal performance distribution.

| Metric | Before Forge | Before GitHub | After Forge | After GitHub |
| --- | ---: | ---: | ---: | ---: |
| Time to main, median (range) | 312.1 (183.4–793.4) | 433.2 (250.3–791.8) | 223.0 (172.9–528.5) | 400.5 (304.9–784.5) |
| Wall to all landed | 1451.1 | 1703.0 | 1279.0 | 1580.3 |
| Workspace prep, median (range) | 19.8 (15.0–30.7) | 12.8 (7.6–24.0) | 19.4 (15.0–45.7) | 10.1 (8.1–17.4) |
| All check wall / landing | 347.4 | 404.2 | 301.1 | 370.6 |
| Landed check wall, median (range) | 169.4 (139.1–346.1) | Unmeasured | 158.0 (132.6–183.6) | Unmeasured |
| Submit/queue to accept, median (range) | 202.6 (149.4–404.3) | Unmeasured | 178.7 (136.0–404.6) | Unmeasured |
| CI billed-equivalent minutes | 67 | 83 | 56 | 81 |
| CI runs / jobs | 18 / 21 | 34 / 34 | 19 / 19 | 31 / 31 |

Forge all-check wall uses reservation through CI end; GitHub uses check-job
start through end, including job setup. The mean divides all runs by ten task
landings. Forge submit-to-accept includes its queue and check; GitHub's matching
merge-queue stamp is not retained. Those missing intervals stay unmeasured.
Public GitHub-hosted runners incur no paid CI spend in either arm.

**Main-race and reuse figures are “pre-fix b5cf317 code”.** The batch pin predates
[`b5cf317`](https://github.com/NanthAI/nanthai-forge/commit/b5cf317768ff7f0a59b827287160a0175cb61a0c),
which preserves global risk for identical shared configuration/lock/workflow
paths. Main races are 12 → 11 attempts and 17.590 → 12.149 elapsed minutes.
Discarded passed runner-minutes are 5.02452 → 5.74582 total, or **0.50245 →
0.57458 per landing**. Each has three discarded passed runs and zero unknown
runner runs; both have seven accepted reuse proofs. Inspection covers all ten
new acceptance receipts and all thirty retained attempts: seven proofs, all
`clean-disjoint-v2`, none with `identicalPaths`, and no global-risk paths in their
candidate/main path sets under the pinned risk rule and check entries. The unsafe
identical-global-risk path is not exercised. These are pre-fix context only:
they do **not** tick or satisfy the smoke half of Issue 1018d0f8's measured line;
a post-safety-fix smoke and the dogfood half remain open.

Both arms land 10/10, with zero voids, strict 0/10 and identical lenient score
0.332868; existing suites are green. The zero strict score is the scripted dry's
expected oracle result, not model correctness evidence. The after whole-batch
capture is $0.067955 at driver rates / 78.042 MB DB I/O, below the $0.30 / 500-MB
brief budget. Load mean/max is 13.29 / 25.12 for Forge and 13.37 / 25.12 for
GitHub. Swap starts at 3,629.88 MB and ends at 4,617.25 MB; both arms keep N=3.
Disk stays above the 22-GiB floor (lowest observed budget sample 26.16 GiB).

The full five-minute post-batch capture has no gap and no source or landing-worker
calls, but strict deployment-wide zero calls is **not demonstrated**: one
landings read, five capability reads, five check-summary reads and four webhook
handler executions remain. These are observations, not attributed to an invented
background worker. Whole-deployment idle and the complete cost total remain
open coverage bars. The driver's own workspaces and both oracle branches are
cleaned. The manifest-verified temporary fork is reset to the qualified base,
and this dry's agent branches are removed. Pinned harnesses, inputs, raw evidence,
the shared fixture project/fork and shared caches are retained.

### Landed fixes and fixture evidence

All before/after figures in this table are **synthetic fixtures**, not a new
smoke or measured invoice saving. They overlap and must not be added into a
cost forecast. Storage/expiry figures use net serialized JSON documents; DB-I/O
figures count reads/writes in their own guards; upload figures count PUT bodies.

| Landed change | Before → after fixture | Calls / scope and limitation |
| --- | --- | --- |
| Bounded trusted State recipes and both reader families (Cost A2) | Ten sequential one-file saves at 29k files: 3,306,429 → 737,549 PUT B/save (3.31 → 0.74 MB, −77.7%); 12k: 1,368,429 → 737,192 B | Six Convex calls/save unchanged. Trusted closure/ranges arrive in the existing bounded authorized read; legacy first save can remain flat. |
| State compose / sync reuse | Three paired 29k runs: 3,306,586 → 737,706 PUT B/compose; 3,306,554 → 737,622 B/sync | Eight / six Convex calls unchanged. 29k save mean handler CPU 0.341 → 0.266 s, wall 452 → 349 ms, peak RSS 233 → 203 MB; fixture worker time, not time to accepted main. |
| Larger bounded CI descriptor windows (Cost B) | Complete 6k-file job: 16 → 3 source-resolver calls; 2,162,042 → 2,110,510 DB B | Same 6,002 storage GETs, 48-stream ceiling. One paired plan/job timing 12.747 → 11.020 s is a sample, not a distribution. |
| Trusted recipe leaves in Actions (Cost B2/A2) | Two-State fixture: 5 → 2 source calls, 16 → 8 storage GETs; bounded parallel deduplicated leaf prefetch later makes 8 → 7 GETs in the A2 integration fixture | Eliminates recipe-tree rounds. Raw 29k object metadata stays 10,226,466 B; closure alone does not fix the per-file DB floor. |
| Catalog-backed cold CI lookup (StoreD) | 29k full job: 10,226,466 → 2,105,060 DB B (10.23 → 2.11 MB, −79.4%); 6k: 2,110,450 → 437,952 B | Eleven / three calls unchanged. Applies to imported/migrated catalog bindings; new/unmigrated raw descriptors retain their old cost. |
| Compact callback receipts at write time (StoreD) | Fresh landing 4,332 → 1,038 B; dogfood-shaped landing 8,676 → 2,088 B | Full-input digest and retry/reuse identity preserved. No extra normal call or R2 request. |
| Compact successful source tasks at terminal write (StoreD) | Two successful rows, 4,096 files/128 changed: 16,880 → 560 B (8,440 → 280 B/row) | Eighteen source-function calls/190 document writes unchanged; failed/fenced inputs and completed output retained. |
| Lossless final report encoding (StoreD) | 20k-file report, six pages: 1,470,479 → 790,776 B | Exact report digest, hydration, failures/flakes/attempts retained; no added R2 call. |
| Approved expiry (StoreB) | Dogfood-shaped main race/two large checks: 931,822 → 360,486 retained B (932 → 360 KB); fresh 53,279 → 50,417 B | Original StoreB measurement, immediate versus after expiry, including maintenance receipts; before the later write-time cuts. Not a live deployment or physical/index byte figure. |
| Work index split (StoreC) | Copy sensitivity 19 → core 11 / planning 17 / data 9; frozen shape 5.88 → 2.83 GB | Modelled indexed storage, not fixture/provider billing; ordinary calls unchanged. See [placement](../data-placement.md#work-projection-index-domains). |
| Main-race check reuse | Identical shared changes: 25 → 0 discarded passed runner-minutes/landing in two-landings/50-minute-check fixture | Same six proof pins, no added calls. Exact matching blobs/modes/deletions and ancestry-only changes reuse; unsafe changes still recheck. |

State saves trade fewer uploaded bytes for more bounded physical metadata:
R2 reads 4 → 8 / 10 at 12k / 29k; synthetic DB documents 95 → 112–113 / 118–122,
writes 31–32 → 35–37 / 35–40. There is no added Convex round or idle work.
The remaining 190k-file flat-manifest memory failure is unresolved. The
[bounded encoding decision](../decisions.md#2026-11-10-bounded-state-recipes)
records how this differs from the rejected large-State experiment.

**Measured historical runner waste:** early dogfood, 36 landings, 4.653 discarded
passed runner-minutes/landing; smoke, ten landings/twelve main races, 0.502.
Smoke races were seven reused passes, three discarded passes (two text conflicts,
one tested-document change) and two zero-runner transitions. The 52.5-minute
alert landing waited on protected-workflow owner review. The later rolling
20-landing mean of 5.107 minutes largely predates the patch and is not causal
proof. Cost A2 subsequently reported another 3,299 discarded runner-seconds;
the post-safety-fix smoke/dogfood comparison remains open; the pre-fix smoke context is above.

Evidence: cost Issue [298f9675](https://nanthai-forge-dev.netlify.app/?project=mh7aafndrxmj8c2q0931zbjk2n8h4ffs&projectTab=planning&planningItem=298f9675-b8ad-49d6-96c3-07d94e5f9ebd) (A2 completion `99be677c`, B/B2 and catalog
comments), storage Issue [8c4f126b](https://nanthai-forge-dev.netlify.app/?project=mh7aafndrxmj8c2q0931zbjk2n8h4ffs&projectTab=planning&planningItem=8c4f126b-0c04-492e-a66a-aabc6acd4981) (inventory and B/C/D receipts), and
main-race Issue [1018d0f8](https://nanthai-forge-dev.netlify.app/?project=mh7aafndrxmj8c2q0931zbjk2n8h4ffs&projectTab=planning&planningItem=1018d0f8-7745-447b-8e83-b2b502bc25fc). Accepted runtime commits include
[State writer `acdd3980`](https://github.com/NanthAI/nanthai-forge/commit/acdd3980b25007a3de4accd98a4b5d4ce53075b4),
[CI windows `5afc36a6`](https://github.com/NanthAI/nanthai-forge/commit/5afc36a6f41093e072c425238ec585a986c83b17),
[Actions closure `840097f2`](https://github.com/NanthAI/nanthai-forge/commit/840097f27b0f77647297f69b8061b0198aa99e4e),
[catalog guard `0987b76c`](https://github.com/NanthAI/nanthai-forge/commit/0987b76c631e590cd953f990d8eca9e034b121ec),
[split `fa45aaa1`](https://github.com/NanthAI/nanthai-forge/commit/fa45aaa1acb342ec80171717714e2c97b77abaca),
and [main-race reuse `6fbb7511`](https://github.com/NanthAI/nanthai-forge/commit/6fbb751155058b10775f04d69a09f9c0bd3d0adf).

### Maintenance cost and unmeasured work

Maintenance is part of the eventual cost per 1,000 landings. Amortize recurring
weekly backup/expiry work over the same period's accepted receipts; report
one-off purges, migrations and index builds separately. Do not divide unrelated
team investigation traffic by a small landing count and call it serving cost.
The following are **measured provider/dashboard usage**, except explicit models:

| Maintenance | Measured bytes / work | Accounting consequence |
| --- | --- | --- |
| Weekly full database export | Three manual exports on 10 Nov read 3.94 GB total; approximately 1.31 GB/run (derived mean) | At capture I/O rate, model about $0.263/run, before other export costs; not 21.47 GB indexed storage read per run. Manual dispatch needs lead OK. |
| Initial bounded expiry | Two calls: 59,932 read + 6,355 written B; 17,888 logical B reclaimed before receipts | A pilot, not the complete backlog. |
| Legacy expiry catch-up | Ten walks; 611,581,842 read + 13,500,509 written B, plus 6,912,037 audit read B: 0.632 GB | 2,878 requests / 2,894 executions (16 OCC retries), zero failed requests. 22.18-minute active drain; provider time 605.321 s including audit; no function egress. |
| Catch-up retained overhead | 187,619,745 gross logical B reclaimed minus 6,326,334 B in 8,106 receipts = 181,293,411 net B | 7,106 callbacks compacted, 29,369 tasks and 6,287 batches removed; zero eligible 30-day check details or unprotected generations. Physical/index saving unmeasured. |
| Work split migration | 0.839689 GB read + 0.529574 GB write; verification 0.055927 GB read; total 1.425189 GB | One-off 3,538 transactional pages across ten partitions; modelled envelope about 1.4 GB. Ordinary landing I/O is separate. |
| Object catalog migration | 113,975,442 read + 49,290,133 written B; verification 21,133,458 read B; total 184,399,033 B | One-off 1,421 steps / 38,003 descriptors; wider inspection envelope 258,220,078 B includes peers. |
| New planning index backfill | 1.01 GB DB I/O in the owner's 10 Nov dashboard | One-off index build, not a per-landing fee. |
| Approved scratch purge/inventory | Five projects, 81,486 rows / 57.327738 recorded MB and 31,354 R2 objects / 2.216819257 GB removed; captured-function I/O envelope 236.633655 MB | Envelope includes peers; row counters exclude physical/index reclamation. R2 deleted sizes are not downloaded bytes. |

Catch-up receipt audits and normal control/source/CI work have separate attribution
gaps; the captured totals above are not a complete invoice. Expiry saves retained
storage, not the initial write already paid. Recurring expiry uses the existing
terminal wakes and bounded pages, with zero calls when no work is due. Its
[reader/windows and fixture guard](#operational-expiry-and-storage-per-landing)
remain the operational contract.

R2 charges per operation, not just per byte. At the linked Standard rate, one
million one-object PUTs cost $4.50 before allowances even if the bodies are tiny;
GET/HEAD cost $0.36/million and egress is free. Batch immutable writes when that
reduces operations without rewriting dense pages for small changes. Convex-to-R2
PUT bodies still incur Convex egress. Queries/mutations cannot fetch R2 directly,
so an immutable-body move must include action/call/transaction effects in its
cost model. A proposed State-bound descriptor manifest could replace about
2.069 MB of cold 29k-job catalog reads, but its trusted incremental writer is
unbuilt; no extra whole-descriptor scan per State is an acceptable saving claim.

Still **unmeasured/unverified**: complete invoices, R2 operation/net-storage
coverage and recurring expiry; post-cleanup dashboard documents/indexes/storage;
190k-file memory within the action limit; a post-b5cf317 smoke and post-deploy
dogfood runner-waste comparison; and the ci-status submit-to-GitHub-created
overhead. The post-overnight-fixes dry above measures captured write I/O and
check-wall/time-to-main, without a causal or scored exit claim. The latter is **measured but unexplained** at 7.601 s versus 2.384 s
normal (about +5.217 s), in three samples per path. Overall client means were
246.567 versus 249.066 s, but blocked cohorts, moving CLI pins and different
provider matrices prevent a causal speedup claim (Flip 3 Issue [4e4204b6](https://nanthai-forge-dev.netlify.app/?project=mh7aafndrxmj8c2q0931zbjk2n8h4ffs&projectTab=planning&planningItem=4e4204b6-9373-49b3-a8fd-3eb06208a310)).
The quoted-provider-log marker bug caused missing project/landing attribution;
the split builder added balanced-quote parsing, but a new paired coverage-checked
window is still required. No missing metric is treated as zero.

## Evidence and the allocation we cannot yet measure

The [`costs` ledger](../../src/speed-budgets.json) and
[`landing-cost-guard.test.mjs`](../../tests/landing-cost-guard.test.mjs) measure a
six-landing fixture: solo, recompose/recheck, and a batch of four. The current
ledger, after source-step, driver, CI batching and Work-store cuts, budgets per
landing 27.17 mutations, 9.83 V8 actions, 0.50 Node actions, 795,595 read bytes,
253,855 write bytes, 3.17 R2 A and 10.67 R2 B operations. Its 2.85 GB-seconds
are **modeled**, using nominal durations. At brief rates this guarded core is
$0.541/1,000 landings ($0.593 Starter). It excludes initial save/compose,
client observers, outbound mirror and real CI; it is a partial fixture, not a
whole-command or production price.

### Current ledger model per 1,000 landings

These are separate guarded slices, priced by the formula above. They overlap;
**do not sum the rows**. Driver rows isolate large retained reports; the tiny core
cannot measure those sizes. CI batch replaces callbacks already represented in
the core and adds R2 inbox traffic. Work writes are outside the landing denominator. Core/inbound Convex egress includes
their R2 PUT payload bytes; other unmetered response egress is excluded. CI includes
its measured result and plan replies; its runner-originated inbox uploads are R2 traffic.
The historical $5.96 corrected live proxy below remains the forecast calibration for
this older model. The later pre-bench smoke above is a distinct measured workload;
neither has a comparable post-fix capture establishing a new serving total.

| Guarded slice | Current quantities per landing or operation | Brief-rate $/1,000 | Starter $/1,000 |
| --- | --- | ---: | ---: |
| Six-Candidate core, after source continuations cut | 37.50 calls; 1.049 MB DB I/O; 2.85 modeled GB-s; R2 A/B 3.17/10.67 | 0.541 | 0.593 |
| Dependency-aware wait observer, separate | 8.83 queries; 82,540 read B | 0.034 | 0.038 |
| GitHub inbound fixture, one new 24 B blob | 52 calls; 0.836 MB DB I/O; 6.1375 modeled GB-s; R2 A/B 5/15 | 0.811 | 0.889 |
| Packed twelve-shard CI batch ingest, excluding compute | 6 calls; 288,826 DB B; 20,084 reply B; R2 A/B 14/90 | 0.168 | 0.175 |
| Completed dogfood-sized driver tail, reads only | 2,070,233.5 read B; calls unchanged | 0.414 | 0.455 |
| Flip 5 planning primary write, I/O only, per 1,000 planning writes | 14,934 read B + 12,225 written B; 0 migration writes | 0.005 | 0.006 |

The source-step cut lowered the core's modeled Node executions from 0.67 to 0.50
and action GB-s from 3.26 to 2.85; the driver and metrics projections remove
repeated row reads. The CI batch includes its deferred timing aggregation and
plan-handshake egress. Its R2 requests must remain in the price even when Convex
calls/compute fit the operator's allowance. Ledger sources name the guarded
fixtures and their decisions; these are resource models, not billed savings.

### Live whole-deployment upper bound and other providers

The lead's dev meter window **2026-11-10 16:10–17:58 UTC**, after CI batching,
contains **7 accepted landings**: 8,046 calls, 196.4 MB database I/O, 111.7 MB
egress and 0.0921 GB-hours. At the same operating list rates as captures 1–4,
that is **$0.0964 total / $13.77 per 1,000**, or **$12.41** after removing
`projectWorkIndex:records` planning scans. This is **live whole-deployment,
upper bound**, alongside the **modeled core $0.541/1,000** above. It includes
zoo/scratch runs, the inbound sample and purge retries, builder planning reads,
and **nine meter coverage-gap records**. Seven landings is a thin denominator;
this is an overhead-inclusive allocation, not a proven mathematical upper bound
when logs can be missing, a serving attribution, an invoice, or a comparable
post-cut replacement for corrected capture #4's $5.96.

One bounded `cf sql query` of `events.r2CombinedOperations` selected the dev
bucket and the same window, grouped by status (six returned rows, weighted by
`SUM(sampleInterval)`). It measured **7,421 sampled/weighted requests**, about
**1,060.14 per landing**, including scratch/zoo traffic across the bucket.
The provider reported 167 ms and 157,066,139 internally scanned bytes; the result
contains aggregate numbers only, with no source-object download or Convex call.
Its SQL dataset has no operation type. Therefore the split below is **measured
total, modeled split**, using ledger Class A/B **3.17/10.67**, not billed classes.
The code classifies PUT/multipart/LIST/copy as A and GET/HEAD as B; DELETE is free.
See `tests/landing-cost-guard.test.mjs` request instrumentation and
`convex/presign.ts`; live accept-write R2 stamps cover compose requests only and
cannot replace whole-bucket operation measurement.

| R2 request pricing scenario | A/B requests per 1,000 landings | List $/1,000 | After free allowance, modeled $/1,000 |
| --- | ---: | ---: | ---: |
| Measured total, ledger split (22.90% A / 77.10% B) | 242,822 / 817,321 | 1.38693 | 0 |
| All Class B lower-price bound | 0 / 1,060,143 | 0.38165 | 0 |
| All Class A upper-price bound | 1,060,143 / 0 | 4.77064 | 3.27064 |

The after-allowance column assumes **3,000 landings/month**, this workload alone,
and the full shared **1M Class A / 10M Class B monthly free allowance** available.
For monthly totals A and B, expense is
`4.5e-6 * max(0,A-1e6) + 0.36e-6 * max(0,B-1e7)`; divide by monthly landings/1,000.
If the team has already consumed its allowance, use the list column as marginal
expense. The all-B/all-A bounds conditionally price every measured request as
billable; deletes and nonbillable errors can lower actual expense further, to
zero. Status alone cannot identify them. The exact billed class split remains an
owner dashboard reconciliation in R2 Metrics, as documented by
[Cloudflare's metrics API](https://developers.cloudflare.com/r2/platform/metrics-analytics/).
No token extraction, GraphQL fallback or new bucket scan was performed. Earlier
R2 stored-byte evidence remains **10.99 GB**, **$0.165/month list**, or
**$0.055/1,000 at 3,000 landings/month**; it is a prior storage gauge, not a new
same-window measurement. Account storage allowance is shared separately.

**Netlify: modeled $0/1,000 within the existing Free plan allowance**, not a
measured invoice. The connected provider confirms the worker site's team is Free.
The one requested same-window bandwidth read returned 1,381,414 bytes but clamped
its metadata start to **16:59:06.303 UTC**, so it cannot price the agreed window.
Edge bandwidth also lacks worker invocation GB-hours and billed units. The
[legacy Free allowance](https://docs.netlify.com/manage/accounts-and-billing/billing/billing-for-legacy-plans/legacy-pricing-plans/)
is 100 GB/month bandwidth, 300 build minutes and 125,000 serverless invocations
per site/month. This allocation assumes usage fits those existing allowances;
team usage elsewhere and invoice/plan changes need separate reconciliation.
The partial traffic figure is not extrapolated into an exact serving bill.
No additional Netlify usage read, new plan or paid service was introduced.

At list prices, the same-window whole-deployment allocation is therefore
**$15.16/1,000** (Convex $13.77 plus measured-total/modeled-split R2 $1.38693),
before stored bytes, backups and any Netlify excess. With R2's assumed free
allowances it stays **$13.77**. These figures share the seven-receipt and coverage
limitations above; they do not sum with the overlapping fixture slices. Against
the $2/1,000 target, Convex is 688.5%, the R2 modeled split is 69.35%, and the
combined list allocation is 757.85%; Netlify within its allowance adds 0%.

### GitHub inbound share

`github-inbound-fixture` in the same landing-cost guard measures a GitHub main
push through the real webhook queue mutation, Node import action, prepare/PUT/
HEAD/commit windows, source composition, `submitDesiredLanding`, check, acceptance
and mirror queue drain. Bootstrap is outside the meter. One new 24-byte blob
puts 2,188 bytes including metadata, uses ten GitHub requests including token
setup and the post-acceptance mirror step, and runs one synthetic check. This
separate denominator preserves the six-Candidate core's zero-query guard.
It uses an operator-proven synthetic binding; the live product's stored binding
adds its own proof calls. Real provider delivery, CI ingest, LFS, retries and
large trees remain outside this fixture.

For an inbound fraction f, the **partial fixture** mixture is
`(1-f) * 0.541 + f * 0.811` dollars per 1,000 (Starter:
`(1-f) * 0.593 + f * 0.889`). At 25% inbound that is $0.608 ($0.667 Starter).
Each inbound replaces a core landing in this calculation; adding its whole cost
to every ordinary landing would double-count the landing. This is not a new
whole-serving forecast: initial ordinary save/compose and inbound imports cover
different starting points, and the historical allocation has no measured inbound share.

One authorized synthetic dev sample changed a 24-byte JavaScript file in a
two-file scratch mirror. It accepted in 65 seconds (GitHub push to Forge
acceptance), with one real `node --check` CI run. The project-attributed log
subtotal, after excluding thirteen observation/verification executions, was
79 executions, 1,031,992 read B, 343,581 written B, 49,932 egress B and 6.675 GB-s:
**$0.000995 per inbound landing at brief rates, $0.001095 Starter** (Convex only).
The full observation window read/wrote 1.466 MB, below its 30 MB cap. The instrument
reported no missing usage fields or detected stream problem. Attribution cannot
include the initial push webhook/queue request, which has no project marker;
silent log loss cannot be excluded. R2 operation billing, storage, runner list
minutes and invoice discounts were not measured. This N=1 subtotal is not a
complete bill or evidence of a post-cut dogfood average. The scratch resources
are removed after the sample; receipts and exact pins are retained on Issue `3e3f9fe6`.

The guard also budgets the finish observer separately: one dependency-aware
subscription per waiting client in the same six-landing mix. It refreshes only
when its selected read set changes, including the four separate batch clients;
there is no timer or forced query after every task. Keeping observer calls and
bytes separate preserves the core's zero-query regression guard.

`hosted-actions-result-growth.test.mjs` guards a separate CI ingest window:
twelve shards, 886 synthetic file reports, inline logs, two replayed results and
the independent provider conclusion. Its `ci-result-fixture` ledger entries cover
HTTP and nested mutation counts, database read/written bytes, HTTP response
bytes and inline-log upload bytes. Setup/dispatch, source downloads and CI runner minutes
are outside this measurement. The generic check callbacks in the six-landing
fixture already carry some CI bookkeeping: do not add both fixture totals to
claim a full landing price. These scenarios replace diagnostic-only cost output
with assertions while retaining report, retry and provider-verdict evidence.

The fixture starts from already-composed Candidates; it does **not** measure a
whole `land --save` (the batch starts after its four enqueue mutations). It exercises a real source-job recompose when main moves,
but its tiny source tree does not reproduce large manifests, many durable source
quanta or concurrent OCC attempts. Nominal action durations cannot measure time
waiting on R2 or GitHub, and a mirror needs a separate provider fixture. Those
remain live/isolated-fixture coverage gaps, rather than measured zero costs.

For offline attribution, intersect the meter's coverage intervals with one
bounded landing-history window and count receipts committed in that intersection.
A window with fewer than twenty receipts cannot satisfy the live-gap measurement.
The day journals contain function IDs and usage, without project IDs or initiating
command/job IDs. Function coverage can identify missing endpoint families, but
cannot split a shared source step into landing, save, sync and scratch work, or
separate extra quanta/retries from its first execution. Report those ambiguities;
never force an exact causal a/b/c split or reuse the old corrected $5.96 denominator
for a different window. Provider gaps and work crossing window boundaries remain
limitations even with twenty receipts.

For Professional development workloads whose calls and action compute fit
included usage, rank proposed fixes by **database I/O bytes saved**, showing each
item's I/O and egress GB/day beside list-price dollars.
Compute active-window projections as `observed bytes / covered seconds * 86400 /
1e9`; these are conditional rates, not observed daily totals or invoice savings.
The 50 GB/month I/O and egress allowances each average about 1.67 GB/day over a
30-day month; apply allowances once to the team, never once to every function.
Outside-user forecasts continue to use list rates for every resource.

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


## Operational expiry and storage per landing

Operational data has two finite windows, measured from a terminal transition,
not creation time. These windows are the selected diagnostic/retry grace periods;
the readers below need the data while execution is active, not forever afterwards.

| Table / data | Window and reader | What remains |
| --- | --- | --- |
| `projectHostedCheckCallbacks` raw `value` | Seven days after the run ends. `receiveHostedCheckCallback` in `convex/projectHostedCheckCallbacks.ts` reads retained event IDs/digests for deduplication; the raw payload has no later execution reader, and terminal results are immutable. | Event IDs/digests/timestamps for original retries; full same-tree reuse aliases/provenance; the check run’s verdict and exact source/provider pins. `projectHostedCheckRead` and `projectHostedCheckVerdictReuse` require aliases indefinitely. |
| `projectSourceTasks`, `projectSourceBatches` | Seven days after the **whole job** ends. `projectConvexSourceFanout.results` joins completed siblings while the parent is active; `sourceStep` refuses terminal jobs. Physical scheduled executions are checked before deletion. | Original job/operation records, output references, source objects and step timing. |
| `projectHostedCheckRuns` detailed `contractReports`; `projectHostedCheckShards`; `projectHostedActionsResults` | Thirty days after the run ends. `hydrateCheckReports`, `restoreShardReports` and `projectHostedCheckRead` read execution/detail copies. This keeps a longer diagnostic window than the raw callback inbox. | The run row, verdict and digest, summary counts/test files, flakes, proof, source/check/configuration pins, provider/receipt links, output/cost references and all immutable acceptance evidence. Full report detail is no longer available after the window. |
| Superseded/failed `projectWorkGenerations`, `projectWorkRecords`, `projectPlanningRecords`, `projectWorkDataRecords`, `projectReturnPages` and replaced payload parts | No age window: retire only when the existing publication/sweep proves the binding is superseded, or the build failed. `selectedGeneration` and `recordPartition` select the current projection. | Current generation, its shared record partition, migration-pinned generations, original backups, Git/source history, Work events, audit trail and planning. |

`projectOperationalExpirySchedule.ts` schedules two one-shot Forge-runner check wakes and one
Convex-source-job wake in their existing terminal mutations; replay of a terminal source
job schedules nothing. There is no periodic project scan, new index backfill or
idle cron. Summary-only ci-status checks and non-Convex source providers arm no
cleanup. Each cleanup mutation reads/compacts or deletes at most eight detail/task rows;
continuations drain only that run or job, then stop. Callback pages keep receipt
rows and advance an indexed cursor, bounded to the run’s original seven-day
window; they clear raw values and retain digest receipts and reuse aliases. Source cleanup also reads
one batch, the job and a bounded pool, and checks the physical scheduled-task
identities. A still-running physical task gets a targeted one-hour continuation,
not permission to delete its input. A first/manual page can pass `continue:false`
to return its progress without scheduling the rest. An operation id and page number reuse the existing maintenance receipt store:
a lost reply returns the original numeric result, without deleting a second page.
Each continuation advances the page number; no per-row receipt is added. Logs report numeric removed
rows and JSON bytes only, without repository contents.

The existing `projectWorkIndexStore.publish` retires its previous generation and
schedules its bounded generation sweep. Retirement now also drains return pages
and interrupted alias-owned records before deleting their generation; failed
builds are included even when their source binding matches. Both retirement and
replaced-payload cleanup use up to 100 rows with a 1 MiB read target (plus at
most one document of overshoot), keeping small-row cleanup cheap. No original State, Git object,
landing receipt, audit or planning record is eligible. Old unarmed operational
rows are discovered by a versioned catch-up in `projectOperationalExpiryCatchup.ts`.
The first due expiry arms one project-local walk through existing indexed run/job
headers; a fixed creation cutoff prevents new work extending the walk. The same
expiry pages recheck terminal state, age and physical executions before modifying
anything. Younger terminal rows receive their missed future wake; active work
keeps its terminal hook. The cursor and cumulative per-table counts/JSON bytes
reuse one existing maintenance receipt. Explicit step numbers reconcile lost
replies without repeating work. Catch-up steps batch up to sixteen existing pages with a 256 KiB conservative
read target (plus one bounded page of overshoot), then yield one second between scheduled
steps, pause without polling if queue depth rises or landing service time exceeds
its starting value by 25%, and can resume on a later due expiry or explicit step.
The first step records the observed queue depth and service time, so stable
existing landings do not prevent cleanup. An explicit `resume:true` adopts a
newly observed baseline after a pause; subsequent growth pauses the walk again.
Generation discovery uses the existing retirement protections. A completed walk
schedules nothing, and later due expiries do not restart it. No idle scan, new
index, table, worker or retention window is introduced. Operators can drive the
same steps with `continue:false` for budgeted, measured drains; each returned
step and cumulative total is durable. Callback catch-up uses its fixed start time
as its upper bound, including late legacy raw callbacks while retaining aliases.

`tests/landing-cost-guard.test.mjs` measures **net stored JSON document bytes**
per table around one complete check/acceptance with a controlled clock and fixed synthetic source-timing input on a fresh synthetic project and
a dogfood-shaped 4,096-file project with 128 changed files, a main-race
recomposition and two checks with 1,000 reports/ten completed shards each. It compares
immediate storage with the same landing after both retention windows. Its
`tests/fixtures/landing-storage-budget.json` records every application table,
including zero-growth tables; new tables and a per-table rise fail the check.
The `immediate` and `retained` maps count per-landing deltas. A separate
`perProject` map ratchets full stored bytes and row counts for the three
singletons this fixture writes: `projectHostedChannels` (main),
`projectHostedLandingQueues` (main) and `projectHostedOverlapMain`. Each stays at
one row per project. Reading full rows here includes the seeded Channel bytes,
which a delta would miss. Mixed tables, including shared finish projections and
the bounded overlap history log, remain in the per-landing map. The fixed capsule bootstrap cursor/revision is also accounted separately by kind
inside `projectFinishReadRows`; all other rows in that mixed table remain per landing.
The history guard
advances the same paths through 128 more accepted sequences and rejects both a
duplicate singleton and history appended inside its row.
This is a fixture measurement, not billed physical storage: indexes, Convex
system-job retention and R2 objects are excluded. Source bytes remain in R2.
The fixtures do not model every save, large source fan-out or a whole user month.

| Fixture | Per-landing immediate ceiling | Per-landing retained ceiling, including page receipts | Fixed per-project full rows, each phase |
| --- | ---: | ---: | ---: |
| Fresh project, two test shards | 42,067 B | 30,288 B | 1,070 B / 3 rows immediate; +240 B / 1 index row retained |
| Dogfood-shaped, main race / two large checks | 813,380 B | 226,443 B | 97,716 B / 3 rows immediate; +240 B / 1 index row retained |

These are the committed fixture ceilings, not an observed saving. The fixed
rows' respective byte ceilings are 638 / 279 / 153 B (fresh) and
668 / 281 / 96,767 B (dogfood). The former combined retained ceilings of
50,417 / 360,486 B included their *deltas* (532 / 97,178 B), which must not be
charged again for every landing. The joint S1/S2 retained targets of
15,000 / 60,000 B apply to per-landing rows; the fixed rows keep their own
ratchets. The accounting split itself changes no runtime calls, DB I/O, byte
placement or retention. Compact live observations subsequently lower their
fixture ceiling from 15,145 to 7,473 B fresh and from 30,998 to 15,654 B
dogfood-shaped, by sharing immutable request fields with the current snapshot.
History answers and selected document-read counts remain identical; these are
serialized fixture bytes, not a billed storage or performance claim.

The retained scenario explicitly enables S1 in the fixture, packs after eight days,
then runs the existing detail/source expiry windows. Its original callback expiry
receipts are verified in the capsule; future detail/source replay records remain
in compact transaction ledgers. Global cleanup-row ceilings are 320 / 320 B.
S1 alone observes 30,269 / 226,261 B retained and complete capsules of approximately
4.4 / 5.9 KB (one PUT and two verification/reconciliation GETs). These are N=1
observations per shape, not paired performance measurements or billed savings.
The guard rejects a dogfood capsule above 100 KB and compressed egress above
relocated row bytes plus a fixed 2 MiB document/header envelope; schema-valid
incompressible historical errors travel whole, without a new user limit. A synthetic
360,000-character error measured 277,020 compressed B (381,805 relocated row B),
with one complete object.

An isolated Node-action probe replays the actual fixture's V8 mutation replies
and uses local fake R2, excluding the DB fake's heap from the action process.
Two fresh/dogfood samples measured process peak RSS of
110,919,680–114,917,376 / 111,525,888–116,211,712 B, including module loading
(baseline RSS about 70 MB). Action walls were 27.5–37.8 / 23.9–43.0 ms;
replayed page-call maxima were 0.34–0.47 / 0.63–1.25 ms, excluding provider latency. The real in-process mutation fixture observed maximum page
walls of 2.66 / 25.84 ms in a separate run. These N=2 observations per shape ran on a shared
machine (preceding load/swap samples 4.85/6.07/7.71 with 4,655 MiB used,
and 5.38/5.38/6.78 with 3,943 MiB used at the second launch); they establish no
latency benefit, provider peak or billed GB-seconds. Complete capsule encoding
retains O(total landing history bytes) in the Node action, while DB capture and
removal use bounded pages. Very long attempt chains and provider limits beyond
these fixtures remain unverified.

Immediate attempt/projection ceilings increase by 21 / 46 timestamp bytes and
246 / 558 metric-projection bytes, and the dogfood compose row carries its
Candidate identity (+53 B), all written in existing transactions. Relocated
canonical history tables ratchet to zero; exact policy/acceptance pins, metric
scalars and replay ledgers explain the retained finish-projection ceiling.
S2 still owns superseded Work record/body and operation history (90,887 and
87,504 B respectively in this dogfood observation); the joint 15,000 / 60,000 B
targets remain open. No S1 history is dropped to reach those targets.

The dominant reclaimed table
is `projectHostedCheckRuns` (dogfood 573,484 → 7,440 bytes). Callback digest receipts then live in the capsule with compact retry pins; shards fall from
720 / 1,448 to zero. The larger
retained dogfood footprint includes its changed-path index, canonical Work and
operation records; expiry does not cut that source/audit history. Every other table's
budget, including zero-growth tables, is recorded in the JSON guard. These are
before/after **expiry** measurements of the same synthetic landing, not a claim
about a measured dashboard reduction or a live pre-change deployment.

### S2 journal capacity and reader inventory

`tests/landing-journal-storage.test.mjs` partitions the same complete landing
fixture after S1 packing and existing expiry. This is a measured capacity
check before implementing S2, not an archive rollout or a saving. Whole-row
serialized JSON includes escaped body strings and metadata; only `_creationTime`
is normalized to zero, as in the existing storage guard. Membership in
`projectHostedRecordHeads.recordId`, rather than the largest version number,
identifies current records. Bodies shared with a current record stay current.
Prepared lifecycle versions are separate, never credited as superseded history.
Every table's category deltas must sum to its existing per-landing measurement.
The committed landing-storage ceilings are unchanged.

Each fixture represents one already-started Issue's Intent and Lane through one
landing. The fresh fixture already has its Candidate; the dogfood main race adds
a second immutable Candidate and a source job. These are incremental bytes per
landing and per represented Issue completion, **excluding** starting the Issue,
planning comments and earlier saves. The month columns explicitly model thirty
such Issues with one landing each (one per day in a thirty-day month); they are
30 times the measured increment, not a measured month or a whole Issue lifecycle.
An Issue with several landings needs its actual workload mix rather than this
normalization. Zero current-row *counts* can still have positive byte deltas when
an existing head or current body is replaced with a longer terminal state.

| Row kind and placement class | Fresh B / landing / Issue completion | Dogfood B / landing / Issue completion | Fresh B / model month | Dogfood B / model month |
| --- | ---: | ---: | ---: | ---: |
| Version headers: current:candidate | 0 | 422 | 0 | 12,660 |
| Version headers: current:intent | 7 | 9 | 210 | 270 |
| Version headers: current:job | 0 | 354 | 0 | 10,620 |
| Version headers: current:lane | 5 | 3 | 150 | 90 |
| Version headers: superseded:intent | 316 | 316 | 9,480 | 9,480 |
| Version headers: superseded:job | 0 | 2,118 | 0 | 63,540 |
| Version headers: superseded:lane | 365 | 369 | 10,950 | 11,070 |
| Version bodies: current:candidate | 0 | 80,667 | 0 | 2,420,010 |
| Version bodies: current:intent | 5 | 6 | 150 | 180 |
| Version bodies: current:job | 0 | 1,507 | 0 | 45,210 |
| Version bodies: current:lane | 4 | 3 | 120 | 90 |
| Version bodies: superseded:intent | 470 | 470 | 14,100 | 14,100 |
| Version bodies: superseded:job | 0 | 7,666 | 0 | 229,980 |
| Version bodies: superseded:lane | 566 | 568 | 16,980 | 17,040 |
| Heads: current:candidate | 0 | 286 | 0 | 8,580 |
| Heads: current:intent | 5 | 6 | 150 | 180 |
| Heads: current:job | 0 | 266 | 0 | 7,980 |
| Heads: current:lane | 4 | 3 | 120 | 90 |
| Operations: active | 0 | 1,013 | 0 | 30,390 |
| Operations: terminal | 3,261 | 86,491 | 97,830 | 2,594,730 |
| Closed-Lane save pages, display rows, snapshots/pages/heads, coordination events | 0 | 0 | 0 | 0 |

The zero rows describe this fixture's coverage only. In particular it exercises
no coordination history, snapshot chain, saved-page stream, planning history or
ninety-day replay. They cannot supply savings against this fixture's target.
The partition retains their categories for future populated workload probes;
it is test instrumentation, not production archive eligibility logic.

| Capacity quantity | Fresh B / landing | Dogfood B / landing |
| --- | ---: | ---: |
| Observed retained after S1 | 30,268 | 226,242 |
| Superseded version headers and bodies | 1,717 | 11,507 |
| Entire terminal operation rows (optimistic removable upper bound) | 3,261 | 86,491 |
| Optimistic retained floor after both moves, zero index/receipt overhead | 25,290 | 128,244 |
| Approved joint target | 15,000 | 60,000 |
| Rows outside S2's journal table set, alone | 25,260 | 43,699 |

These observations differ slightly from S1's earlier sample because timestamp
and timing digits contribute serialized bytes; they fit the unchanged ceilings.
Even treating all terminal operation receipts as free cannot meet either target.
Real compact receipts and segment index rows would raise the floor. At the stated
thirty-Issue mix, retained increments are 908,040 / 6,787,260 B per model month;
the optimistic floors are 758,700 / 3,847,320 B. Existing project rows and source
objects remain additional costs. These logical bytes exclude physical indexes,
system jobs and R2; they establish no billed storage reduction.

The new dogfood Candidate's **current** body alone is 80,667 B, including
71,345 B of inner `governance` JSON with 4,222 exact paths. Its outer stored
string includes additional escaping. It did not exist before this landing and
is therefore not seeded overhead. S2 keeps current versions and heads, so that
one body exceeds the entire 60,000 B target before any other rows or pointers.
The six superseded source-job versions account for only 2,118 B of headers and
7,666 B of bodies. Relocating those cannot solve current-Candidate growth.

The fresh floor is independently blocked by non-journal rows. In the full
post-fixture `projectFinishReadRows` inventory, S1's private capsule pointer,
owner/replay controls and acceptance-page ledgers occupy 5,693 / 2,741 / 1,147 B
fresh and 7,671 / 5,904 / 2,312 B dogfood. These are whole retained rows, not
incremental deltas or a second charge to add to the table above. Their exact
transaction pins belong to S1; S2 cannot silently remove them.

The cheapest next investigation is a lead placement review of current Candidate
path bytes and S1's private transaction/replay metadata. Current paths are read
inside mutations by `projectHostedAcceptancePublish`, `projectHostedGate`,
`projectHostedTrust`, `projectHostedLandingBatchPublish` and `projectHostedCulprit`;
queries also use them in `projectHostedLandingOvertake`,
`projectHostedLandingPrecompose` and `projectHostedLandingWouldConflict`.
An R2 pointer alone cannot replace those transaction reads. Reuse S4's existing
Candidate file-list work where applicable, while proving exact current-policy
checks and old-Candidate replays first. This is an investigation proposal, not
an approved format, scope expansion or weakened target.

The inventory before any move is:

| Stored family | Current readers and transaction constraints | Required expansion before a writer |
| --- | --- | --- |
| Record versions and bodies | Central `recordVersion`, `readHostedRecord`, `hostedRecordBody` serve queries and mutations. `writeHostedRecord` replays an exact old version before CAS; lifecycle overlays/materialization retain original row ids. Direct history ranges exist in `projectHostedProvenanceRead`, `projectHostedLiveLanes`, `projectWorkStoreReads` and `projectSelfMetrics`. | Authorized redacting server actions for explicit versions, Lane history, planning versions and provenance, preserving exact cursors. Retain transaction-needed digest/identity/replay summaries; do not turn a missing archived version into permission to rewrite it. |
| Work event provenance on record bodies | `projectWorkEventStore.findWorkEvent` is also used by metadata mutations for operation deduplication; `projectWorkEventPage.retainedEventPage` requires contiguous revisions across both legacy events and record bodies. `projectWorkStore` and `projectWorkStoreDigests` compare exact historical versions. | Range-indexed segment reads plus compact mutation receipts; preserve canonical event request/command/revision and current identity mapping. |
| Terminal source operations | `beginHostedOperation` and family-specific save/sync/compose/check/lifecycle loaders parse the full envelope; terminal results can themselves embed the whole Candidate. `projectHostedCulprit` stores recovery state separately on the same row. | Compact replay representation must reconstruct the original result and original first-attempt ids/pins inside existing mutations for ninety days. No new retry denial. Current implementation still retains full envelopes and prunes under its existing ninety-day rule. |
| Closed-Lane save pages | `projectHostedSaves` checks original page digests on replay. Save/sync/state rows also provide provenance through `projectHostedProvenanceRead.sourceOperation`. | Preserve exact page digest replay and provenance; prove terminal ownership before relocation. |
| Snapshot/display families | `projectHostedSnapshots` validates referenced versions in mutations and reconciles old page/publication retries. `projectHostedSnapshotRead` reads exact published pages; `projectHostedProjection` derives display rows from those pages. | Expand exact-version and snapshot readers before merging tables. Display rows have no authority reader; removing their table still requires updating its writer and purge inventory. |
| Coordination detail | `coordinationFeed.feedRows` uses creation-time/id positions and scoped indexes; `projectCoordinationReads.related` scans the same feed. `coordinationWrite.eventByOperation` and emit paths use event identity for deduplication; `projectCoordination:publish` also replays it. Messages, handoffs and acknowledgements have inbox/receipt readers. | Archive only activity/change/claim/release older than fourteen days, through current-access server actions with the same feed boundaries. Keep messages/handoffs/acks in Convex. No existing recovery-hosted table branch exports coordination events, so complete archive export needs explicit coverage rather than assuming S1 already includes them. |
| Export, restore and administration | `projectRecoveryHosted` exports records/bodies/operations/save pages; S1 merges its nine capsule families using `projectLandingCapsuleRecovery` and fences relocation with a revision. Generic purge inventory and legacy storage accounting read physical tables. | Reuse S1's verified codec and recovery merge, with a journal range identity and recovery fence. Extend the full export/drill for snapshots and coordination, which are absent from `recoveryTables` today. Keep physical accounting honest during partial removal. |

The continuation's server-only reader expansion accepts exact old record versions,
bounded Lane provenance and contiguous Work event pages from verified journal
segments. It reuses S1's complete gzip codec and private GET/PUT transport; no
second packer or client object grant exists. Immutable version digest/identity
pins remain transaction-readable. A replay of the same version compares those
pins before returning its supplied exact bytes; it cannot rewrite history.
Recovery extends S1's live/capsule merge into journal segments and includes
coordination and snapshot/display tables. A physical journal-revision fence
invalidates an export that crosses relocation. No writer or automatic relocation
is installed by this reader expansion. Planning-version and Lane history pages,
coordination feed/recent/related reads and Lane metric facts accept both forms.
A dedicated segment table isolates archive range-index cost from hot finish rows.
Readers also accept self-contained compact source-operation receipts (including
the complete terminal result), compact Work command retry facts and closed-save
digest ledgers. The writer follows separately. Receipt result bytes, index rows
and coordination deduplication receipts are charged as retained overhead.

The reader fixture proves exact old-version parity, current-version access,
immutable retry, access revocation during GET, corruption rejection, contiguous
archived/live event pages and exact journal recovery rows. Existing S1 capsule
round trips and recovery drills remain covered. Reader expansion changes no
retained rows; storage ratchets are not lowered until the writer is measured.
The measured-floor restatement is 25,290 / 128,244 B plus the actual segment-index
and compact-receipt overhead, as settled on the Issue. A fixture result does not
qualify live billing, provider memory or speed distributions. The weekly-export
line **needs two dev exports after the setting is on**.

The archive budget remains one action and at most two mutations per
100-row/500-KiB page, one PUT per segment, one server action and one GET per
segment read, zero added landing hot-path calls and zero idle calls. Live pages
retain their original query path when no segment is needed. A cold action
reauthorizes in its projection query after every GET. Fixture and live usage
measurements accompany the implementation evidence on the Issue.

Controller-only test budgets report delayed retention allocations separately,
keeping their original source/controller ceilings. The raw fixture counters and
cumulative landing cost guard still include **all** system-job writes and bytes.
Execution fixtures keep seven/thirty-day work outside their immediate controller
queues; retention tests execute it under a controlled aged clock and assert the
two check phases/one source-job wake. No cost or wake ceiling is raised.

The per-table measurement and the retained/source-task byte tests complement the
existing cumulative-I/O landing guard; write traffic is not stored footprint.
Budget changes need the owning Issue's explanation, and savings lower the
recorded budgets. The guard removes no product capability and sets no user quota.

At 1,000 Forge-runner check runs, the two due phases create 2,000 initial maintenance calls
plus eight-row continuations. A terminal source job with T tasks and B batches
uses bounded task pages plus a final empty-batch probe; calls scale with pages,
not source files. At most eight maximum-size task rows plus a job/batch/pool and
physical execution records are live in one transaction (roughly 12 MiB of row
payload, before runtime/JSON overhead). A check page holds a run plus eight rows
(roughly 9 MiB before overhead). These are conservative payload bounds, not
measured heap ceilings. The completed catch-up's provider usage is recorded [above](#maintenance-cost-and-unmeasured-work);
JSON bytes and reserved-memory figures still do not establish heap or physical-storage savings.
No new vendor, worker or paid service is introduced.

## State size metadata

The approved source-envelope guard (Issue `5975c9e0`) adds logical `fileCount` and
`manifestBytes` beside each State's existing descriptor. In the whole-document
storage-per-landing fixture this adds **204 serialized bytes** to the dogfood
`projectObjects` budget: 3,297 → 3,501 bytes, both immediately and after exhaust
expiry. Fresh remains 738 bytes; fixed per-project storage and source identities
are unchanged. The ratchet records exactly this metadata cost, with no new table,
source object, RPC, backfill or idle worker. Bytes remain in R2; these numbers are
serialized synthetic document bytes, not provider/index amplification or billed
savings. The [supported envelope](source-exchange.md#supported-repository-envelope)
and [margin evidence](../research/source-step-memory.md#supported-source-step-envelope)
explain why both dimensions are needed. Legacy successful loads enrich metadata
inside the existing completion call; sized inputs add no metadata write.

## Backup export cadence

`hosted-backup.yml` stays weekly (Monday 03:00 UTC). Manual dispatches require
the lead's OK: each snapshot export reads the whole database. Three manual
exports on 10 November consumed **3.94 GB of database I/O**, according to the
owner's Usage evidence on Issue `8c4f126b`. Cleanup/measurement must not dispatch
another export as an inventory shortcut. This changes no workflow or backup
contents; the existing weekly recovery path remains in place.

## Measured placement inputs (S0)

This is an observation of the settled `n3-r1-dry-a2` cell, not a new run or a
causal before/after claim. Its ten landings ran from 07:29:13.891 to
07:50:49.416 UTC on 11 November. Recorded load averages were
12.931 / 6.781 / 5.232 before and 6.216 / 7.508 / 10.026 after.
The retained `result.json` meter reports valid coverage, no missing usage fields,
no execution failures and no voids. The separate smoke report owns its verdict,
pricing and timing comparison. The measurements here supply the placement vector;
R2 reconciliation and indexed-patch billing remain open.

### Calls and database I/O by family

All quantities below are the retained project meter divided by ten accepted
landings, including preparation, retries/recompositions and observation in that
meter's window. They are not isolated marginal transactions. Read/write bytes
are provider `databaseIoReadBytes` / `databaseIoWriteBytes`; GB-s is billed action
memory-time, not CPU. Executions include cached query completions; the parenthetic
subset identifies those explicitly. The existing meter prices all its executions,
so its call-cost line must not be mistaken for a separately reconciled invoice.

| Family | Executions/landing (cached subset) | Read B/landing | Write B/landing | Egress B/landing | Action GB-s/landing |
| --- | ---: | ---: | ---: | ---: | ---: |
| `projectConvexSourceNode:step` | 7.6 (0) | 0.0 | 0.0 | 15,570,999.5 | 18.0823 |
| Finish driver and observer | 53 (0.1) | 1,331,497.9 | 150,686.6 | 733.4 | 0.6902 |
| Source control and V8 | 24.4 (0) | 1,079,630.4 | 193,606.3 | 0.0 | 1.2964 |
| `projectHostedActionsSource:resolve` | 11.4 (0) | 1,384,810.8 | 0.0 | 0.0 | 0.0000 |
| Landing and acceptance | 18.4 (0) | 634,579.8 | 268,181.3 | 0.0 | 0.1673 |
| `projectHostedReuse:prove` | 0.8 (0) | 0.0 | 0.0 | 52,608.4 | 2.8630 |
| CI orchestration and results | 28.1 (0.4) | 429,280.0 | 105,232.1 | 613.9 | 0.2571 |
| `projectConvexSourceObjects:resolve` | 29 (0) | 408,578.7 | 0.0 | 0.0 | 0.0000 |
| Object upload, download and packs | 28.8 (5.4) | 338,523.8 | 12,588.4 | 0.0 | 0.0368 |
| Save, sync, compose and conflict resolution | 11.7 (0) | 360,023.1 | 31,456.4 | 256.5 | 0.0965 |
| `POST /checks/actions` | 18.9 (0) | 0.0 | 0.0 | 118,643.0 | 0.6626 |
| Agent, authorization and workspace | 24.5 (9) | 114,387.6 | 21,595.8 | 0.0 | 0.0000 |
| Reuse store | 4 (0) | 138,335.6 | 29,517.8 | 0.0 | 0.0000 |
| Metrics and placement | 1.3 (0) | 49,014.6 | 0.0 | 0.0 | 0.0271 |
| GitHub webhook | 3.7 (0) | 0.0 | 0.0 | 0.0 | 0.0639 |
| Work projection and commands | 2.6 (0.2) | 18,233.8 | 12,182.7 | 0.0 | 0.0000 |
| **Total** | **268.2 (15.1)** | **6,286,896.1** | **825,047.4** | **15,743,854.7** | **24.2432** |

The 80 named functions reconcile exactly to 2,682 completions, 62,868,961 read B,
8,250,474 write B and 157,438,547 egress B. Excluding the 151 cached completions
leaves 2,531 uncached executions. Family membership is by module name:

- Source control/V8: `projectConvexSourceStore`, `projectConvexSource`,
  `projectSourceRunStore`, `projectSourceRun`.
- Finish: `projectHostedFinishDriver`, `projectHostedFinishObserve`.
- Landing/acceptance: every `projectHostedLanding*` module and
  `projectHostedAcceptance`.
- CI: every other `projectHostedActions*` module, `projectHostedCheckDefinitions`
  and `projectHostedMainAudit`.
- Save/sync/compose: `projectHostedSaves`, `projectHostedSync`,
  `projectHostedCompose*`, `projectHostedResolveChain*`.
- Object transport: `projectObjects`, `projectObjectCommit`,
  `projectObjectDownloads`, `projectSourcePacks`.
- Reuse store: `projectHostedReuseStore`.
- Metrics: `projectSelfMetrics`, `projectSelfMetricBills`, `projectBytePlacement`,
  `projectLandingSpeedIssue`.
- Agent/workspace: `projectHostedAgent`, `deviceStore`, `projectHostedConflicts`,
  `projectHostedStart`, `projectHostedOverlaps`, `projectHostedLanes`,
  `projectHostedChannels`, `projectHostedLifecycle`, `projectHostedBatchAbandon`.
- Work: `projectWorkIndexStore`, `projectWorkCommand`. GitHub webhook is
  `POST /github/webhook`. The five individually named functions are excluded from
  all grouped rows.

The old **24% unnamed** headline was a remainder of a rounded summary, not an
unattributed billing bucket. Reading the original settled pre-fix cell identifies
its other families below. In that retained meter the five headline functions sum
to 78.47%, leaving **21.53%**, rather than exactly 24%. Its CI resolver/HTTP counts
are 543/616, whereas the earlier summary reported 549/626; these scopes are not
silently equated. Shares use the original meter's own price basis.

| Previously unnamed family | Share of original retained meter |
| --- | ---: |
| Finish driver and observer | 6.04% |
| Source control and V8 | 4.83% |
| Landing and acceptance | 2.90% |
| Object upload, download and packs | 2.28% |
| CI orchestration and results | 2.27% |
| Save, sync, compose and conflict resolution | 1.48% |
| Agent, authorization and workspace | 0.88% |
| Reuse store | 0.66% |
| GitHub webhook | 0.16% |
| Metrics and placement | 0.02% |

### Source steps, bodies and wall time

Three bounded creation-time reads (64 rows and a 262,144-byte target per page)
found 43 source-job rows in the cell window, with 76 recorded step entries.
These match all 76 Node-step completions in the meter. Two reset jobs before the
cell were excluded. No `register-state` job, fan-out batch or child task was
present in this window. The 11 additional `projectConvexSource:step` V8 action
completions are delegation/control overhead, not eleven additional terminal
source steps; a submitting action can also delegate inline.

| Kind | Jobs | Recorded steps | Steps/landing | R2 read-busy s/landing | R2 write-busy s/landing | Nested-call-busy s/landing | Recorded run s/landing | Job wall s/landing |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Save | 13 | 13 | 1.3 | 1.1626 | 1.2728 | 0.5285 | 4.7674 | 5.6523 |
| Sync | 6 | 12 | 1.2 | 1.2547 | 0.9853 | 0.9173 | 6.6992 | 7.1701 |
| Compose | 24 | 51 | 5.1 | 5.8854 | 2.0701 | 4.3990 | 21.6343 | 24.2233 |
| Registration | 0 | 0 | 0 | — | — | — | — | — |
| Fan-out child | 0 | 0 | 0 | — | — | — | — | — |
| **Total** | **43** | **76** | **7.6** | **8.3027** | **4.3282** | **5.8448** | **33.1009** | **37.0457** |

Each busy clock measures the union within its own category. Reads, writes and
nested calls can overlap each other, so subtracting their sum does not produce
an exact compute split. Per-step union bounds put R2 busy wall at
9.6570–12.6309 s/landing; wall with none of those three categories active is
14.6252–22.6508 s/landing. That residual includes parse/hash/merge and uninstrumented
work; it is not measured CPU. Job wall sums `doneAt - queuedAt`; overlapping jobs
make it different from the cell's elapsed wall or time to accepted main. Queue
wait totals 3.6911 s/landing; Node boot totals 0.4780 s/landing and can overlap
that queue accounting. The recorded run begins after the initial `begin` read
and its timing is captured before terminal commit, so neither belongs in a
claimed exclusive CPU bucket.

The later read-only provider-log snapshot retained only 13 of the 76 Node-step
lines (07:44:03.341–07:47:39.742 UTC). Its attempted PUT bodies are:

| Kind / observed steps | State B | Progress B | Result B | Other B | Refused B (already included) |
| --- | ---: | ---: | ---: | ---: | ---: |
| Save / 1 | 4,908,769 | 0 | 246 | 0 | 0 |
| Sync / 4 | 9,817,605 | 6,868 | 1,438 | 61 | 61 |
| Compose / 8 | 14,726,526 | 10,798 | 1,562 | 600 | 0 |
| **Observed subtotal** | **29,452,900** | **17,666** | **3,246** | **661** | **61** |

These 29,474,473 attempted body bytes cover a tail, not ten complete landings.
Avoided bytes are zero in that tail. The full timing rows retain 152,272,690
signed PUT bytes (15,227,269 B/landing); the full Node-action meter records
155,709,995 egress B (15,570,999.5 B/landing). Neither reconstructs the missing
State/progress/result split, and their 3,437,305-byte difference is unallocated.
Do not extrapolate the tail or subtract overlapping refused bytes again.
The smoke meter reads usage and project markers but discards these structured
step lines; `attribution.mjs` assigns oracle test cases, not source-byte costs.

### Compose and fusion qualification (S6)

The S0 retained timing aggregate above is 24 composition jobs over ten landings,
with 51 steps: 2.4 jobs per landing and 2.125 steps per job. It is not one action
per input. Its 27 continuation steps have no retained phase/stop breakdown here;
the eight tail log lines identify three State-sized PUT bodies, not eight State
uploads. Those totals do not establish that the three State digests were equal.
The source loop explains several causes: a byte/compute boundary, inline text
calculation followed by recomputation, ordered selection quanta, and a new exact
composition when main moves. Retries reconcile the original operation. The finish
controller already reuses an exact-main precompose; a different main requires an
exact new composition, not borrowing its old result or check.

Two generic avoidable costs are removed. A proven one-input fast-forward finishes
its small result immediately instead of yielding after reading its tips. State
and State-chunk writes use the existing checksum-confirmed R2 reuse path before
sending bytes. An identical recomposition or a lost PUT reply therefore needs no
second State body. This adds no Convex call or DB record. A new physical State or
chunk adds one R2 HEAD; an existing object replaces PUT plus confirmation with a
HEAD. No savings in billed usage or time to accepted main are established here.
`tests/source-compose-reuse.test.mjs` guards one action, zero State/progress PUT
bytes for the three 29k fast-forward orientations, exact recomposition reuse and
a main advance that retains both sides' changes. Storage guards cover lost replies,
checksum mismatch and retryable HEAD failures. Distinct new States still need
storage; these fixes do not promise to remove their bytes.

The [synthetic qualification](../../tests/fixtures/source-fusion-qualification.json)
runs the actual Convex provider handlers with a fake transaction store and R2,
fresh processes per action, three interleaved A/B pairs per 29k shape. A is three
separate jobs **with the compose fix**, B is a test-only fused job. B drops completed
cursor trees, clears intermediate byte-cache entries, retains only the verified
base across save/sync and clears it after sync. Parsed trees do not cross phases.
The raw file records each pair, cumulative peak RSS at each phase, current RSS,
heap/external/buffer bytes, calls, PUT categories and exact State pins.

| 29k shape | Separate peak RSS B, pairs 1/2/3 | Fused peak RSS B, pairs 1/2/3 | Actions A / B | State PUT B, A = B |
| --- | --- | --- | --- | ---: |
| Clean save/sync/compose | 312,229,888 / 308,674,560 / 312,082,432 | 389,906,432 / 388,202,496 / 388,759,552 | 3 / 1 | 9,396,423 |
| Save/conflict sync/conflicted compose | 378,175,488 / 366,903,296 / 366,116,864 | 450,641,920 / 453,017,600 / 452,722,688 | 6 / 1 | 9,396,356 |

Fusion fails the non-rise memory gate in every pair. It is not enabled; the probe
is qualification code only. The clean path's three State pins match exactly. A separate
[confirmation dataset](../../tests/fixtures/source-fusion-qualification-confirmation.json)
retains six additional AB pairs after adding exact result-manifest equality,
including both conflict roots. All comparisons pass; all six additional memory
comparisons also fail the gate. They replace none of the first samples. The
conflict path has saved/draft pins and a conflicted result, with no clean composed
State. This does not prove equivalence on every fixture or unknown public
landing outcome. First-action completion writes no progress in these probes and
in the ordinary provider. Calls per drained pipeline are 21 to 13 (clean) and 42
to 13 (conflict); idle drains make zero calls/reads. DB byte totals include setup
and are serialized fake documents, not billed I/O. PUTs are attempted bodies, not
an invoice; physical source/progress bytes stay in synthetic R2, with no Convex
file-storage writes. Three pairs are small-sample observations. Concurrent load
was not recorded, and these local walls exclude public preparation, checks,
acceptance and real scheduler/R2 latency. No speedup, complete memory
qualification, live billing reduction or time-to-main claim follows. The source
fixture and CI dev deployment do not replace a separately authorized billed
comparison. Fusion acceptance lines stay open.

### R2 counters and executed bucket operations

These are signed requests counted by `presign`, not a reconciled count of
executed bucket operations. Reusing a signed URL, retrying it, or signing in a
nested mutation separates the signer count from actual requests. In particular,
253 timed source reads coexist with only 37 Class B signatures in the action
clocks: pre-signed descriptor reads are not counted again by that clock.

| Caller / job kind | Class A signatures/landing | Class B signatures/landing | Signed PUT B/landing |
| --- | ---: | ---: | ---: |
| Source worker / save | 2.6 | 0 | 6,380,636.8 |
| Source worker / sync | 2.1 | 0.8 | 2,947,185.6 |
| Source worker / compose | 6.9 | 2.9 | 5,899,446.6 |
| **Covered source subtotal** | **11.6** | **3.7** | **15,227,269.0** |
| CLI uploads/downloads, CI source/results, reuse, mirror and maintenance | Unknown | Unknown | Unknown |

There is no retained whole-cell counter split for those other callers. Their
requests are not zero, and source/compose copies of the same counters must not
be added twice. The old 1,060 requests/landing was a different, whole-dev-bucket
window; neither its scope nor the fixture ledger's A/B ratio supplies this cell.

The owner approved the read-only analytics credential on 11 November, and the
lead performed the aggregate read through `r2OperationsAdaptiveGroups` (S0
comment `1eb0c8dc`). For the ten-landing window, **07:29:13–07:50:50Z**, the
bucket-wide executed counts are:

| Action | Success | userError |
| --- | ---: | ---: |
| GetObject | 973 | 0 |
| PutObject | 297 | 4 |
| HeadObject | 109 | 38 |
| ListObjects | 18 | 0 |
| DeleteObject | 36 | 18 |

This is **319 Class A (31.9/landing), 1,120 Class B (112.0/landing),
54 free deletes and 60 userError requests**. At list rates of $4.50/million A
and $0.36/million B, operations price to **about $0.184 per 1,000 landings**,
versus $0.026 modelled. Dogfood volume is within the monthly free tier; this
is list-rate marginal pricing, not a billed overage.

The bucket executes about 2.7 times the source signer's Class A and 30 times
its Class B counts. Reused descriptor URLs execute multiple GETs, and other
callers (CLI, CI source/results and reuse) are outside the signer ledger, so
that table under-counts executed operations. The analytics dataset exposes no
caller split. Setup/reset or other non-landing traffic in this bucket-wide
window is included; no caller attribution or retry split is inferred. The
approved read is complete; no objects, settings or retention changed.

The window-specific executed/signature coverage factors are 2.75× A and
30.27× B; they are not multipliers for other workloads. Net retained R2 bytes
and full caller/maintenance attribution remain unmeasured.

The 60 userError requests cannot be assigned from bucket aggregates. S7 removes
legacy per-log verification HEADs and scratch DELETEs along with duplicate log
copies; packed discovery skips its own slot and stops at the first missing required
slot. Missing-slot HEADs and conditional PUT races are expected discovery/retry
outcomes, so they are still reported. An exact mapping of the historical 38 HEAD,
18 DELETE and 4 PUT errors remains with S0's executed-request attribution follow-up
(Issue 886a4694); source upload verification/reuse and project maintenance callers
are outside S7. No historical error is claimed fixed without its caller/status.

### S7 request ledger and smoke coverage

The CI inbox guard counts actual fixture HTTP requests. For twelve shards with the
same 886-file report set, the older batched path uses 38 Class A / 25 Class B requests;
packed results use 14 / 90. Logical log hashes, original shard result digests and
provider attestation are unchanged. This is a deterministic fixture observation,
not a live or invoice saving. The ledger has an absolute 14-Class-A CI ceiling and
an 80-Class-A smoke-shaped landing ceiling; exceeding either fails independently
of the normal percentage tolerance. The fixture shape includes a 4,096-file source
main race, both twelve-shard check runs and 31-day exhaust maintenance. It starts
after fixture Lane/check setup: client upload/materialization, reuse, mirror and
external recurring backup/sweep are unmeasured. Its caller
counts are printed as `S7 smoke R2` in the landing check (31 Class A / 193 Class B:
source 3/13, CI results 28/180, exhaust maintenance 0/0). Those zeros describe the
executed expiry fixture, not all recurring maintenance.

New smoke captures retain `r2Signatures` in `result.json`: totals and per-landing
Class A/B signatures, PUT lengths and free deletes, grouped by the actual provider
function identifier. The signer emits only project identity, sequence and counters;
no key, signed URL, source body or secret. Streamed Progress/Completion replays are
deduplicated. Maintenance functions in the captured window are included in the same
table. Old captures with no such lines return unknown, never zero. These counters
are capabilities signed by Convex, not executed bucket requests: unused grants,
client reuse/retries, missing lines and external backup/maintenance remain separate
coverage gaps. Source-step copies of the counters must not be added again.

The retained `n3-r1-dry-a2` report above predates these lines. It is not backfilled
with fixture counts. The lead's executed bucket reconciliation above supplies that
historical window only; complete caller and recurring-maintenance allocation stays
open on S0. The S7 builder made no account-dashboard read.

### Indexed patch calibration

**Measured dev execution I/O**, 11 November 10:23:32.601–10:26:11.984 UTC.
The [numeric calibration fixture](../../tests/fixtures/indexed-patch-usage.json)
retains every execution's usage and timing conditions. The observable internal
writer reached dev through the normal Lane and
[CI deployment](https://github.com/NanthAI/nanthai-forge/actions/runs/43002233317),
at source State `37b2f69c`, mirrored commit `0c27e652`. It ran only on dev.
The three temporary table definitions and writer were removed from source after
measurement; the schema-wide duplicate-index deployment guard remains.

Each table had identical document columns, nominal JSON document sizes of
1,024 / 8,192 / 27,648 bytes, and 1 / 9 / 24 distinct custom indexes (built-ins
excluded). Each index selected the operation key plus a different small numeric
column. Ten rounds ran sizes 1 / 8 / 27 KiB, then indexes 1 / 9 / 24 for each
size. Each patch advanced an **unindexed counter**; indexed values stayed fixed.
Read/write bytes below come from each successful `Completion.usageStats` in the
same `convex logs --jsonl --success` stream as the benchmark meter. No raw log
text was retained. All ten executions in each cell had identical byte counts.

| Nominal JSON B | Custom indexes | Patches | Billed read B / patch | Billed write B / patch |
| ---: | ---: | ---: | ---: | ---: |
| 1,024 | 1 | 10 | 2,505 | 1,333 |
| 1,024 | 9 | 10 | 2,505 | 2,357 |
| 1,024 | 24 | 10 | 2,505 | 4,277 |
| 8,192 | 1 | 10 | 16,841 | 8,501 |
| 8,192 | 9 | 10 | 16,841 | 9,525 |
| 8,192 | 24 | 10 | 16,841 | 11,445 |
| 27,648 | 1 | 10 | 55,754 | 27,958 |
| 27,648 | 9 | 10 | 55,754 | 28,990 |
| 27,648 | 24 | 10 | 55,754 | 30,925 |

| Phase | Executions | Billed read B | Billed write B |
| --- | ---: | ---: | ---: |
| Create nine synthetic rows | 1 | 0 | 125,311 |
| Counter patches | 90 | 2,253,000 | 1,253,110 |
| Delete nine synthetic rows | 1 | 225,300 | 0 |
| Repeat cleanup, verify absence | 1 | 0 | 0 |
| **Total** | **93** | **2,478,300** | **1,378,421** |

Total observed fixture I/O is **3,856,721 B**, below the 5 MB envelope, including
setup and cleanup. Counters report 198 document reads and 108 document writes
(including nine deletions whose billed write bytes were zero). Each patch
reports two document reads and one write. Reported execution network egress is
zero; that is not a measurement of the caller's HTTP traffic. The second cleanup
found no rows for the operation; separate bounded reads verified all three
tables empty. No landing, source job, retention change or new smoke was triggered.

**Observation, N = 10 pairs per size:** reducing custom indexes from 24 to 1
changed billed writes by -2,944 B at 1 and 8 KiB, and -2,967 B at 27 KiB.
The median-difference 95% bootstrap intervals are respectively
[-2,944, -2,944], [-2,944, -2,944] and [-2,967, -2,967] B, with seed 1 and
10,000 resamples. These are small samples below the 11-pair reference bar;
the intervals cover resampling these observations, not other key shapes,
provider changes or production landings.

For these rows, write bytes fit `D + 181 + N * E`, where `D` is nominal JSON
bytes, `N` is custom-index count, and `E` is 128 B for the shorter operation key
or 129 B for the one-character-longer 27 KiB key. This is an empirical fit,
**not a vendor formula**. Increasing the payload by 7,168 B changed billed writes
by 7,168 B at every index count. Thus a full payload copy per index is not the
observed patch-I/O multiplier. A smaller frequently rewritten payload supplies
about a one-for-one write-byte reduction in this fixture; changing indexed keys,
physical index storage, actual landing key widths and the ticket/body write
partition still need their own evidence. The matrix does not prove an S3
production saving or the $2 target.

The 159.383 s window excludes the heavy queue and log-stream startup. Per-patch
server execution was 0.0785–0.2950 s; caller wall time was 0.989–3.107 s including
`npx`, authentication and local load. One-minute load was 12.19–27.31 and swap
used was 6,218.5–6,450.5 MiB; all three load averages and swap are recorded per
sample. Maximum driver RSS was about 53.5 MiB; child CLI and remote function
memory were not measured. No latency or memory improvement is claimed.

Node remained 24.22.1 and Convex CLI 1.46.0. During the window, dev also deployed
commit `47e0cdb1` (State `1f4ad21d`); its only changed files were `src/host-cli.ts`
and `tests/host-directory.test.mjs`, outside the fixture/server dependency
closure. The fixture functions, schema and dependency versions were unchanged.
Administrative metadata preflight/empty-table reads and CI deployment are
separate from the 93 measured fixture executions. No account-dashboard read,
local deployment or production operation was performed by this calibration.

### Advisory rows, growth and window proposals

On dev, bounded creation-time pages (128 rows, 262,144-byte target) returned only
aggregate sizes/day counts. A fixed upper creation time per table prevents new
writes from extending its scan. Forty-four coordination pages plus one empty
agent page and one client-error page read 5,564 retained rows, 1,877,912 serialized
JSON bytes. These are logical retained bytes, not physical/index storage or billed
I/O. Peak application memory is O(one page plus day aggregates), with no payload
returned to the client and no per-row external call.

| Table | Observation UTC, 11 Nov | Rows | Logical B | Oldest / newest UTC | Last complete day: rows / B | Last seven complete UTC days: rows/day / B/day |
| --- | --- | ---: | ---: | --- | ---: | ---: |
| `projectCoordinationEvents` | 08:17:12.974 | 5,562 | 1,870,569 | 30 Oct 05:06 / 11 Nov 08:16 | 610 / 204,710 | 636.3 / 213,258.7 |
| `agentEvents` | 08:17:37.374 | 0 | 0 | None | 0 / 0 | 0 / 0 |
| `clientErrors` | 08:17:37.705 | 2 | 7,343 | 30 Oct 20:22 / 4 Nov 21:14 | 0 / 0 | 0.143 / 617.9 |

Seven complete days means 4–10 November. Coordination totalled 4,454 rows /
1,492,811 B then; client errors one row / 4,325 B. The partial 11 November
coordination day has 118 rows / 39,512 B and is not extrapolated to a daily rate.
These are creation rates of **currently retained** rows, not measured net table
growth or proof that no earlier deletion occurred. A later retained-byte snapshot
and insert/delete counters would establish net growth.

The following table records the measurement-time proposals. The owner has since
[selected advisory windows](../decisions.md#advisory-windows): client errors expire
after 30 days through existing scheduled check maintenance; coordination detail
gets 14 days hot then R2 archival in S2, with no deletion. Lifecycle audit, messages,
handoffs and acknowledgements stay indefinitely; access diagnostics have no window. R2 archive/pointer costs and readers must be designed before any archive
option is admitted. The rate projections assume the measured seven-day mix
continues; they do not predict provider indexed storage.

| Scope | Window choices / proposed behavior | Size basis and tradeoff |
| --- | --- | --- |
| Coordination activity/change/claim/release detail | Consider 7 or 14 days hot in Convex. Preserve message, handoff and acknowledgement history; any move of that history needs exact durable archive/read recovery first. | All-kind upper envelope at the observed rate: 7 days ~4,454 rows / 1.493 MB; 14 days ~8,908 / 2.986 MB. Eligible subset is not separately sized. Shorter detail history reduces debugging reach. |
| Agent lifecycle audit (`create`, `revoke`, `expire`, `cascade-revoke`) | Preserve indefinitely; no deletion window proposed. | Zero retained rows today is not permission to drop future grant audit. |
| Agent access diagnostics (`describe`, `read`) | Consider 30 days only if future volume warrants it; leave current behavior until the owner decides. | Zero rows/observed growth; no measured storage benefit today. |
| Client errors | Consider 30 days of error/stack detail, or keep current behavior. | Both retained rows fit 30 days; no immediate measured saving. Recent creation rate projects ~4.3 rows / 18.5 KB per 30 days, based on one event and therefore weak. |

### S0 follow-up evidence

The remaining counters belong to S0, not to another smoke run: retain the bounded
`forge-source-step.putBytes` category totals with execution/job/kind and failed
attempts in the existing meter; record an all-I/O union and exclusive busy-state
intervals (plus Node CPU if CPU is claimed), rather than subtracting overlapping
clocks; and count executed R2 methods/status/retries by caller at the actual
request seam, including uses of already signed URLs. Reconcile once with the
owner-approved bucket read. The indexed patch matrix above is complete. Advisory net growth needs a second retained snapshot or insertion /
deletion counters. No missing field is zero and no new run is authorized by this
follow-up list.

Evidence and open lines are tracked on
[S0](https://nanthai-forge-dev.netlify.app/?project=mh7aafndrxmj8c2q0931zbjk2n8h4ffs&projectTab=planning&planningItem=886a4694-b2eb-4e58-881f-787376038698)
and the existing [cost Issue](https://nanthai-forge-dev.netlify.app/?project=mh7aafndrxmj8c2q0931zbjk2n8h4ffs&projectTab=planning&planningItem=298f9675-b8ad-49d6-96c3-07d94e5f9ebd).
This documentation replaces unlabelled placement estimates with scoped
observations and explicit gaps. The temporary patch writer and three schema
definitions are removed after row cleanup. The retained numeric evidence and
deployment guard add no product runtime calls, memory, byte placement, idle work
or retention changes.
