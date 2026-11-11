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
| R2 compose requests | $0.0251 | $0.0256 | Model from signed requests; incomplete provider coverage |
| Weekly backup I/O allocation | $0.415 | $0.399 | Model below; recurring expiry is unmeasured |
| Covered serving + R2 + maintenance subtotal | $9.376 | $6.677 | Partial model, not the complete invoice total |
| Covered subtotal / ~$2 target | 468.8% | 333.9% | Unmeasured components are not zero |
| Complete serving + R2 + maintenance total | Unknown | Unknown | Net retained bytes, full operation counts and recurring expiry missing |

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
| Real twelve-shard CI batch ingest, excluding compute | 6 calls; 370,145 DB B; 36,440 reply B; R2 A/B 38/25 | 0.270 | 0.279 |
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
This is a fixture measurement, not billed physical storage: indexes, Convex
system-job retention and R2 objects are excluded. Source bytes remain in R2.
The fixtures do not model every save, large source fan-out or a whole user month.

| Fixture (one landing) | Immediate JSON bytes | After expiry, including page receipts |
| --- | ---: | ---: |
| Fresh project, two test shards | 53,279 | 50,417 |
| Dogfood-shaped, main race / two large checks | 931,822 | 360,486 |

The retained totals include 1,368 / 3,176 bytes of maintenance audit receipts in
`legacyStorageCleanupPages`; these remain durable. The dominant reclaimed table
is `projectHostedCheckRuns` (dogfood 573,484 → 7,440 bytes). Callback rows retain 822 / 1,656 bytes of digest receipts after raw-payload compaction; shards fall from
720 / 1,448 to zero. The larger
retained dogfood footprint includes its changed-path index, canonical Work and
operation records; expiry does not cut that source/audit history. Every other table's
budget, including zero-growth tables, is recorded in the JSON guard. These are
before/after **expiry** measurements of the same synthetic landing, not a claim
about a measured dashboard reduction or a live pre-change deployment.

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

## Backup export cadence

`hosted-backup.yml` stays weekly (Monday 03:00 UTC). Manual dispatches require
the lead's OK: each snapshot export reads the whole database. Three manual
exports on 10 November consumed **3.94 GB of database I/O**, according to the
owner's Usage evidence on Issue `8c4f126b`. Cleanup/measurement must not dispatch
another export as an inventory shortcut. This changes no workflow or backup
contents; the existing weekly recovery path remains in place.
