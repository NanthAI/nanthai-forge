# Why Forge for agentic development?

Forge gives people and agents isolated Lanes, combines their changes, checks the result and moves accepted source to main. Agents keep their normal editors and tools. Our [principles](principles.md) guide continuous improvement.

## What changes from GitHub?

Start a Lane for an Intent, edit its returned path, run affected tests and land. With a configured hosted runner, concurrent changes share a landing check on their combined Candidate. See the [agent workflow](agents/workflow.md) and [landing batches](operations/landing-batches.md).

Forge updates from main and schedules composition/checks. Failed batches are isolated by checking prefixes: the longest passing prefix lands and remaining Lanes are requeued. Conflicts stay explicit; failed Candidates are never accepted. Supervised review and protected-path policies apply; Git and docs-only changes retain their ordinary landing path.

Peers and presence let agents see announced work, exchange messages and hand work off. These observations can be incomplete. Alert delivery has been measured below; whether alerts improve agents' work has not.

## Current agent benchmark evidence

<!-- agent-measurements:start -->
Phase 7 close (27–28 Nov 2026). Ten agents reached main 35% sooner, on 59% fewer CI minutes. Median Forge savings across paired runs were 35% wall time (30–42%, 5 runs), 28% median task time (20–37%, 6 runs), 59% CI minutes (56–64%, 5 runs) and 38% cached input tokens (29–43%, 5 runs). GitHub ran faster overnight and those runs are included. The Phase 7 results record every run, void and exclusion with its reason.

B1.5d (2026-11-04), ten real-agent tasks: the published summary reports time to main per task of 324 / 496 s at N=1, 386 / 597 s at N=3, 352 / 512 s at N=5, and 350 / 460 s at N=10 (Forge / Git + GitHub). The leads were 35%, 35%, 31% and 24%. CI billed minutes were 331 / 910. Wall-to-all-landed favored GitHub at N=3 and N=10; the N=5 unpaired time ranges overlap. Strict correctness totals matched. This is not a universal speed or token-saving promise.

Historical Phase 6 exit results (measured 13–15 Nov 2026) retain three reps per arm and agent count. N=1/3/5 use the tuned series, and N=10 uses a separately registered rerun. The report retains task flags, strict correctness and recovery turns alongside the timing and cost figures.
<!-- agent-measurements:end -->

Sources and limitations are in the [Phase 7 results](research/p7-close-bench-results.md), [B1.5d report](research/b15d-report.md), [P6 descriptive results](research/p6-exit-bench-results.md), [baseline and partial P6 evidence](research/p6-baseline.md) and [registered P6 exit plan](research/p6-exit-bench-plan.md).

## Measured landing throughput

**These numbers are historical.** This section covers 20–25 October 2026, before Forge moved its own landings to the hosted path on 28 October. The first table ran on GitHub-hosted runners. The P2 repeat and E3 used the runner setup Forge retired on 25 October. The E3 rerun (G8) remains unpublished.

Measured on **2026-10-20**, P1c attempt 9 (01:40–07:50 UTC), using the same seed
(one squashed Forge main tree, `9db0122d`) on both sides. Both Forge's check runner
and GitHub's merge queue ran on GitHub-hosted `ubuntu-latest`, with four test
shards. Timing starts when all changes in a burst are already finished and ends
when all are on main. Values are medians in seconds; speed-up is the GitHub
median divided by the Forge median. Sources: the benchmark's generated public
`scores.md` (2026-10-20 07:54 UTC) and its P1c method note, `P1c-NOTE.md`.

| Already-finished burst | Forge | GitHub merge queue | Speed-up | Valid runs (Forge / GitHub) |
| --- | ---: | ---: | ---: | ---: |
| 4 agents | 296.9 s | 701.6 s | 2.36× | 3 / 3 |
| 8 agents | 372.9 s | 1192.9 s | 3.20× | 2 / 3 |

The four-agent result is measured; the eight-agent result is an **early sample**.
The eight-agent Forge run omitted from that comparison lost one of eight
landings when a check-ref push was rejected and the controller did not retry
(fixed since: transiently rejected check-ref pushes now retry).
Earlier attempts were voided for harness/API-budget problems, an Actions incident
and Linux test races. The method note records zero retries and **zero red-main
observations on both sides** in the reported runs; this is an observation of
those runs, not a guarantee that arbitrary checks catch every bug.

A smaller repeat on **2026-10-20** (P2) ran both sides on the same
4-vCPU runner profile with four shards and GitHub's merge queue. A single docs change
landed in a median 57 s on Forge versus 172 s on GitHub (3.0×, 3 / 3 runs), and a
four-change burst in 310 s versus 678 s (2.2×, 3 / 2 runs; one GitHub run was cut
short by the operator's job time limit). Main stayed green with zero retries on
both sides; Forge ran 4 checks per burst, the merge queue 12.

### When one change in the burst fails

Measured on **2026-10-24** (E3), on the same runner profile, with one of four
burst changes deliberately failing a test. GitHub's merge queue was tuned
(batching and `max_entries_to_build`), not left at its defaults. **GitHub was
faster:** it put the three good changes on main in a median 189 s; Forge took
989 s (3 / 3 valid runs each side). That is about 5.2×; even if every Forge check
had been as fast as a GitHub PR check, GitHub would still be about 2.4× faster.
Neither side landed the bad change or turned main red, and Forge used fewer check
jobs (20–25 against 48–54). Forge isolates a failure by checking prefixes one
after another, and that serial recovery is what lost. The Phase 5 plan covers the
fix ([landing without an operator](phase5-plan.md#landing-without-an-operator-q)); the E3 re-run (G8) is not published.

### Overlap alerts between live agents

Measured on **2026-10-24 and 2026-10-25** (E1): four Codex agents edited the same
paragraphs of three documents while eight Lanes finished at once, five replays per
run. No finish was dropped (0 / 40) and no agent saw `WORK_STALE` or `WORK_BUSY`.
On the current build every overlapping agent pair and file raised an alert at save
time (90 / 90), and 84 / 90 reached both agents' transcripts. Alerts arrive with an
agent's next Forge call, so a fast second save can come first: only 2 / 5 replays
delivered the first alert to both agents before the second save. Delivery at first
write has since landed (B3.1); it has not been re-measured. On-main E1/E3 summaries
(raw evidence private); methods: [E1](research/e1-overlap.md), [E3](research/e3-failing-burst.md).

**Coordination (R3, measured in B1.5d on 2026-11-04).** Across the scored Forge cells at N ≥ 3,
Forge raised 45 blocking overlap notices; 13 matched a real conflict and agents acknowledged 42.
All 21 advisory notices were noise, and 22 real conflicts in test files had no notice. On the
overlapping tasks, Forge landed without a conflict, failed check or extra attempt more often than
GitHub (preview cluster 0.88-1.00 against 0.50-0.67). The samples are small. Notice precision is
Phase 6 work. Details: [B1.5d report](research/b15d-report.md#coordination-r3).

This measures landing throughput of completed changes. It does not measure agent
coding time, total development time, token use or coordination quality. Those are
measured with real agents in [B1.5d](research/b15d-report.md), which also carries R3,
the coordination evaluation. Do not infer them from burst landing.

## What stays familiar and portable?

Use normal tools and tests inside a Lane. Git repositories work with Forge; accepted source exports to GitHub. Native source also works without Git. See [workflows](workflows.md) and [GitHub sync](workflows.md#github-sync-mvp).

## Documentation for agents and LLMs

The web build generates `/llms.txt` with agent rules, dated measurements (including the failed E3 bar) and links to every packaged document. `/llms-full.txt` concatenates the README and guides selected in `scripts/llm-documents.mjs`, in order, within 400 KB. A missing source fails the build. The build prints the file size and warns above 400 KB; size never fails a build, because combined documentation changes would fail landings that pass alone. Plans, research, status and other references remain linked. The installed agent skill is linked on GitHub.

`robots.txt` permits the public landing and static documentation for all crawlers,
including AI crawlers. App and project URLs, including legacy query routes, are
excluded so crawler traffic does not trigger project reads. No sitemap is
advertised because the site has none.

Check logs follow bring-your-own-CI: providers retain full output under their own retention. Forge keeps results, failure summaries, compact test evidence and provider links. Local logs stay local unless explicitly opted in with finite retention; see [operations](operations.md#check-logs-and-retention).
