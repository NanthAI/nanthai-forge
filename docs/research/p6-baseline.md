# Baseline to beat

B1.5d is the current real-agent reference and the Phase 6 no-regression bar.
Later smoke, fixture and cross-repository results cover different workloads;
they do not replace it. Measurement dates below belong to the data. The
[exit-bench plan](p6-exit-bench-plan.md) and its owner decisions govern scoring.

## Best real-agent result: B1.5d (Phase 5, 2026-11-04)

The [B1.5d report](b15d-report.md) compares Forge with Git + GitHub on t3code:
ten tasks, GPT `gpt-6.1-sol` agents through Codex at high reasoning effort, and
11 scored cells per arm. The table uses the registered count, excluding the
separately disclosed owner-requested extra N=3 attempt. Time to main is each
cell's median over landed, non-void tasks, then the median over cells.
Percentage leads are also recorded on [exit-bench Issue 8c9b84fc][exit].

| N | Time to main/task, Forge / GitHub s | Forge faster | Wall to all landed, Forge / GitHub s | Lower wall median |
| --- | --- | --- | --- | --- |
| 1 | 324 / 496 | 35% | 4100 / 5575 | Forge (26% faster) |
| 3 | 386 / 597 | 35% | 3054 / 2322 | GitHub |
| 5 | 352 / 512 | 31% | 1202 / 1871 | Forge |
| 10 | 350 / 460 | 24% | 1198 / 1045 | GitHub |

The registered time-to-main range test holds at N=1, 3 and 10. At N=5,
Forge won every paired rep on both time to main and wall, but the unpaired
ranges overlap. Wall ranges overlap at N=3, 5 and 10; only N=1 is a clear
wall win under that test. Conflict and overtake loops caused the wall losses.
Strict correctness medians matched at every N and strict totals matched;
lenient medians differed slightly at N=3 and 5, with no overall correctness
difference reported.

| Measure over the 11 scored cells, unless noted | Forge | GitHub | Comparison |
| --- | --- | --- | --- |
| CI billed minutes | 331 | 910 | About 36% of GitHub's minutes |
| CI jobs | 116 | 336 | Fewer jobs |
| Cached input tokens | 257M | 386M | 33% fewer |
| Output tokens | 0.97M | 1.23M | 21% fewer |
| Agent turns | 3,982 | 5,912 | 33% fewer |
| Uncached input tokens | 8.5M | 8.2M | About equal |
| Workspace prep/task, median s | 15.3 | 4.5 | Forge slower |
| Workspace prep/task, p90 s | 33.8 | 17.3 | Forge slower |

Prep is inside wall time and outside time to main. The
[cost-to-serve comparison](../operations/cost-to-serve.md#pre-bench-smoke-and-subsequent-fixes-2026-11-10)
records B1.5d Convex usage at about **$9.40 per 1,000 landings** at capture
list rates; B1.5d reports **$0.86 for scored cells**. These are rate-card
estimates, not invoices. In [coordination R3](b15d-report.md#coordination-r3),
13 of 45 blocking notices matched real conflicts; 22 real test-file conflicts
had no notice. These weaknesses are part of the baseline, alongside the wins.

## Older bests (2026-10-20 to 2026-10-25)

These [Why Forge measurements](../why-forge.md#measured-landing-throughput)
predate the hosted cutover and have **never been re-measured on today's path**.
Already-finished bursts exclude agent coding time, tokens and coordination
quality. The 8-agent result is an early sample.

| Historical workload | Forge | GitHub | Result |
| --- | --- | --- | --- |
| Already-finished 4-agent burst, 2026-10-20 | 296.9 s | 701.6 s | 2.36× speed-up |
| Already-finished 8-agent burst, 2026-10-20 | 372.9 s | 1192.9 s | 3.20× speed-up; early sample |
| Single docs change on earlier paid runners, 2026-10-20 | 57 s | 172 s | 3.0× speed-up |
| Four-change burst on those runners, 2026-10-20 | 310 s | 678 s | 2.2× speed-up |
| E3: three good changes land with one failing change in the burst, 2026-10-24 | 989 s | 189 s | GitHub wins |

E3 lost to serial prefix isolation. Its G8 rerun is not published or completed
in the cited evidence; do not treat the later recovery implementation as that
rerun. The [Phase 5 close](../phase5-close.md#delivered), dated 2026-11-04,
also records no-Mac import of a 28,902-file repository in **2 min 31 s and
2 min 37 s**, versus an earlier **9 min 29 s**. Those import measurements are
separate from both the older burst experiment and the later zoo.

## Phase 6 re-measurements (partial)

The **2026-11-10 pre-bench smoke** was a dry N=3 run with scripted agents,
not model agents; it supplies no model-token or agent-turn comparison.
[CI Issue 685774ea][ci] and [prep Issue c83c4451][prep] retain the CI/prep
figures. Other timings supplied by the lead are explicitly labelled below.
The smoke used the old bench CLI (**lead-reported, not in a public source**).

| Smoke measure | Forge | GitHub | Evidence / comparison |
| --- | --- | --- | --- |
| Wall to all landed, s | 1451 | 1703 | 15% faster; lead-reported, not in a public source |
| Time to main/task, median s | 234 | 430 | 46% faster; lead-reported, not in a public source |
| Time to main/task, range s | 183–793 | 250–792 | Lead-reported, not in a public source |
| CI billed minutes | 67 | 83 | [685774ea][ci]: 19% fewer, versus about 64% fewer in B1.5d |
| CI jobs | 21 | 34 | [685774ea][ci] |
| Queue, s | 39 | 60 | Lead-reported, not in a public source |
| Workspace prep/task, median s | 19.7 | 12.8 | [c83c4451][prep]: Forge slower; worse than B1.5d's 15.3 s |

The [live smoke meter](../operations/cost-to-serve.md#pre-bench-smoke-and-subsequent-fixes-2026-11-10)
priced captured Convex usage at **$8.94 per 1,000 landings** in the driver,
or **$8.69** in the lead journal, against the roughly **$2** target. The
driver result is **4.47×** target, with maintenance, storage and R2 allocation
still needed. [Main-race Issue 1018d0f8][race] records **5.02452 discarded
runner-minutes** across ten smoke landings. Its fix landed, but the same smoke
has not been re-measured after it.

The **2026-11-09 N=10 real-agent attempt was void**: a deploy changed the
landing path mid-cell ([8c9b84fc][exit], comments `cf376b87` and `acdbee8b`).
It supplies no scored result. The claim that no Forge-arm data was retained is
**lead-reported, not in a public source**; no missing arm is treated as zero.

The following post-smoke evidence does not establish a new billed serving
cost. The storage and source fixtures overlap and must not be summed.

| Evidence measured or modelled on 2026-11-10/11 | Before | After | Scope / source |
| --- | --- | --- | --- |
| Generated State upload, PUT B/save | 3,306,429 | 737,549 | −77.7%; ten sequential 29k-file synthetic saves, [cost-to-serve](../operations/cost-to-serve.md#landed-fixes-and-fixture-evidence), [298f9675][source] |
| CI source-resolver calls/job | 16 | 3 | Complete 6k-file fixture; same 6,002 storage GETs, [cost-to-serve](../operations/cost-to-serve.md#landed-fixes-and-fixture-evidence) |
| Retained B/landing after approved expiry | 931,822 (932 KB) | 360,486 (360 KB) | Dogfood-shaped fixture; not provider/index bytes, [cost-to-serve](../operations/cost-to-serve.md#landed-fixes-and-fixture-evidence) |
| Cold CI descriptor DB bytes | 10,226,466 | 2,105,060 | −79.4%; 29k imported/migrated catalog fixture, unchanged calls, [cost-to-serve](../operations/cost-to-serve.md#landed-fixes-and-fixture-evidence) |
| Planning/data index split, storage sensitivity GB | 7.94 | 3.97 | Model from measured native-document bytes; not reclaimed provider storage, [data placement](../data-placement.md#work-projection-index-domains) |

The ci-status comparison on **2026-11-10** is measured scratch evidence,
**not a fixture or a causal speed-up proof**: cohorts were blocked, CLI pins
moved, and provider matrices differed ([4e4204b6][provider], comment `3657b8a4`;
[cost-to-serve](../operations/cost-to-serve.md#maintenance-cost-and-unmeasured-work)).

| Mean over three samples/path | ci-status s | Normal s | Observed difference |
| --- | --- | --- | --- |
| Client land-to-return | 246.566868 | 249.066496 | −1.0036% |
| Submit-to-GitHub-created | 7.601 | 2.384 | About +5.217 s overhead |

[Recovery Issue 438e9ace][recovery] likewise records live scratch
single reversals in **1.41–1.91 min** on 2026-11-10. Those trials did not prove
pair compensation. A later trial **did**: checked green in **1.515317 min**,
both interacting landings reversed, unrelated accepted source and author Lanes
preserved (comment `788100d4`); cleanup was confirmed before closure. This
supersedes the earlier “pair proof unmet” status, without claiming an E3 rerun.

The [full zoo report](zoo-mini-report.md), measured across 2026-11-10/11 and
completed on **2026-11-11**, passes **26/26 required rows**, including named
expected hazard refusals. These are medians over repositories that ran both
operations, compared with **plain git**, rather than GitHub's checked merge
queue or the t3code agent workload.

| Zoo operation | Forge s | Plain git s |
| --- | --- | --- |
| Clone | 0.8 | 1 |
| Import | 21.8 | 1 |
| Sync | 4.9 | 0.6 |
| Land | 82.1 | 1.8 |
| landReuse (Lane C; not necessarily reused) | 117.6 | 2.2 |

Median check-result-to-main-commit gap was **3.2 s**. Five matched Rust C
overtakes had median **169.420 s**, **2.056×** the unchanged baseline: the
strict timing gate remains unmet ([70a9bd2f][zoo]). The baseline's different
landing order prevents a causal code-regression claim. History selected lookup
reads rose **9.13%** (1,549,066 → 1,690,543 B/repository scenario), with
attribution still open on [8c4f126b][storage]. Many import walls included
**500–6,000 s** of GitHub rate-reset waits ([ed088358][imports]); functional
passes do not erase those waits.

The prep regression ([c83c4451][prep]) and reduced CI-minute saving
([685774ea][ci]) remain open explanations for the next smoke/bench. Scripted
agents omit failing model iterations that inflated GitHub's B1.5d minutes;
that is a workload difference to quantify, not proof that the saving survived.

## Not re-measured since B1.5d (no current P6 number)

The [exit-bench Issue][exit] and [registered plan](p6-exit-bench-plan.md)
still own comparable real-agent evidence for:

- Tokens, turns and rework with real agents.
- Correctness on the ten-task oracle.
- Per-N scaling at N=1, 5 and 10.
- Coordination and overlap-notice precision.
- The failing-burst case (E3/G8).
- The N=16 convoy (no B1.5d convoy baseline).

These are exit-bench measurements, run only on the owner's explicit go under
the [P6 close order](../phase6-plan.md#p6-close-order-owner-2026-11-10).
A scripted smoke, passing functional zoo or fixture saving does not supply a
missing real-agent result.

[exit]: https://nanthai-forge-dev.netlify.app/?project=mh7aafndrxmj8c2q0931zbjk2n8h4ffs&projectTab=planning&planningItem=8c9b84fc-737e-4d1e-8bca-0d0f847566e6
[ci]: https://nanthai-forge-dev.netlify.app/?project=mh7aafndrxmj8c2q0931zbjk2n8h4ffs&projectTab=planning&planningItem=685774ea-bea7-4bab-b469-f49798938c97
[prep]: https://nanthai-forge-dev.netlify.app/?project=mh7aafndrxmj8c2q0931zbjk2n8h4ffs&projectTab=planning&planningItem=c83c4451-a30a-4f0e-8b45-1ff35300a001
[race]: https://nanthai-forge-dev.netlify.app/?project=mh7aafndrxmj8c2q0931zbjk2n8h4ffs&projectTab=planning&planningItem=1018d0f8-7745-447b-8e83-b2b502bc25fc
[source]: https://nanthai-forge-dev.netlify.app/?project=mh7aafndrxmj8c2q0931zbjk2n8h4ffs&projectTab=planning&planningItem=298f9675-b8ad-49d6-96c3-07d94e5f9ebd
[provider]: https://nanthai-forge-dev.netlify.app/?project=mh7aafndrxmj8c2q0931zbjk2n8h4ffs&projectTab=planning&planningItem=4e4204b6-9373-49b3-a8fd-3eb06208a310
[recovery]: https://nanthai-forge-dev.netlify.app/?project=mh7aafndrxmj8c2q0931zbjk2n8h4ffs&projectTab=planning&planningItem=438e9ace-bb4f-4e0c-b374-c6dfaacc50d8
[zoo]: https://nanthai-forge-dev.netlify.app/?project=mh7aafndrxmj8c2q0931zbjk2n8h4ffs&projectTab=planning&planningItem=70a9bd2f-f741-4d26-8ae5-7bb11148a17c
[storage]: https://nanthai-forge-dev.netlify.app/?project=mh7aafndrxmj8c2q0931zbjk2n8h4ffs&projectTab=planning&planningItem=8c4f126b-0c04-492e-a66a-aabc6acd4981
[imports]: https://nanthai-forge-dev.netlify.app/?project=mh7aafndrxmj8c2q0931zbjk2n8h4ffs&projectTab=planning&planningItem=ed088358-d32e-4821-b951-1ecf21e1ff76
