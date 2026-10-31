# Why Forge for agentic development?

Forge is a source host and workspace for people and coding agents changing one
codebase at the same time. Agents keep their editors and tools. Forge records
what each agent intends to do, gives it an isolated Lane, composes concurrent
changes, checks the combined code and moves accepted source to main.

Our [principles](principles.md) put continuous study and improvement at the heart of Forge.

## What changes from GitHub?

On GitHub, agents commonly work in branches and pull requests, then wait for CI
and a merge queue. In Forge, start a Lane for an Intent, edit its returned path,
run affected tests and finish. With a configured native runner, concurrent code
changes share a landing check on their combined Candidate instead of each agent
running the full suite on almost the same tree. See the
[agent workflow](agents/workflow.md) and [landing batches](operations/landing-batches.md).

Forge handles updating from main, composition and check scheduling. If a batch
fails, it checks prefixes, lands the longest passing prefix, attributes the next
Lane's failure and requeues the remaining Lanes. Conflicts remain explicit;
failed Candidates are never accepted. Agents do not need to rebase or babysit a
merge queue. Supervised review and protected-path policies still apply; Git and
docs-only changes retain the ordinary finish path.

Peers and presence show other agents' announced or observed files and work.
Agents can spot overlap, exchange messages and hand work off before a conflict.
These observations are advisory and can be incomplete. Alert delivery has been
measured (below); whether alerts make agents' work better has not.

## Measured landing throughput

**These numbers are historical.** Every figure on this page was measured between 2026-10-20 and 2026-10-25, before Forge landed its own work on the hosted path (cutover on 2026-10-28). The first table ran on GitHub-hosted runners; the P2 repeat and E3 below ran on Blacksmith runners, which Forge stopped using on 2026-10-25. None of it has been re-measured on today's path. The benchmark on a real repository (B1.5d) and the re-run of E3 (G8) are not yet published.

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

A smaller repeat on **2026-10-20** (P2) ran both sides on the same Blacksmith
4-vCPU runners with four shards and GitHub's merge queue: a single docs change
landed in a median 57 s on Forge versus 172 s on GitHub (3.0×, 3 / 3 runs), and a
four-change burst in 310 s versus 678 s (2.2×, 3 / 2 runs; one GitHub run was cut
short by the operator's job time limit). Main stayed green with zero retries on
both sides; Forge ran 4 checks per burst, the merge queue 12.

### When one change in the burst fails

Measured on **2026-10-24** (E3), on the same Blacksmith runners, with one of four
burst changes deliberately failing a test. GitHub's merge queue was tuned
(batching and `max_entries_to_build`), not left at its defaults. **GitHub was
faster:** it put the three good changes on main in a median 189 s; Forge took
989 s (3 / 3 valid runs each side). That is about 5.2×; even if every Forge check
had been as fast as a GitHub PR check, GitHub would still be about 2.4× faster.
Neither side landed the bad change or turned main red, and Forge used fewer check
jobs (20–25 against 48–54). Forge isolates a failure by checking prefixes one
after another, and that serial recovery is what lost. The Phase 5 plan covers the
fix ([landing without an operator](phase5-plan.md#landing-without-an-operator-q)); the E3 re-run (G8) is not started.

### Overlap alerts between live agents

Measured on **2026-10-24 and 2026-10-25** (E1): four Codex agents edited the same
paragraphs of three documents while eight Lanes finished at once, five replays per
run. No finish was dropped (0 / 40) and no agent saw `WORK_STALE` or `WORK_BUSY`.
On the current build every overlapping agent pair and file raised an alert at save
time (90 / 90), and 84 / 90 reached both agents' transcripts. Alerts arrive with an
agent's next Forge call, so a fast second save can come first: only 2 / 5 replays
delivered the first alert to both agents before the second save. Delivery at first
write has since landed (B3.1); it has not been re-measured. Sources: the forge-bench results `E1-2026-10-24.md`,
`E1-2026-10-25.md` and `E3-2026-10-24.md`.

This measures landing throughput of completed changes. It does not measure agent
coding time, total development time, token use or coordination quality. R3, the
coordination evaluation, is pending. No single-agent token or time advantage over
plain Git has been established. Do not infer those benefits from burst landing.

## What stays familiar and portable?

Use normal files, editors, agents and test commands inside a Lane. Git repositories
work with Forge, and Forge can export accepted source to GitHub. Your repository
stays portable; adopting Forge does not require giving up GitHub distribution.
Native source also works without Git. See [workflows](workflows.md) and
[GitHub sync](workflows.md#github-sync-mvp).

## Documentation for agents and LLMs

The web build generates `/llms.txt` as a linked guide: a summary, the rules agents
should follow, the dated measurements on this page (including the E3 bar Forge
failed) and links to every document in `scripts/package-documents.mjs`, served
under `/docs/`. It generates `/llms-full.txt` from a fixed list in
`scripts/llm-documents.mjs`: the README and the user and agent guides, in that
list's order and within a 400 KB budget. A missing listed source or an oversize
file fails the build. Plans, status, backlog, roadmap, research, license
disclosures and the architecture reference stay linked from `/llms.txt`, not
concatenated. The installed agent skill ships separately and is linked on GitHub.

`robots.txt` permits the public landing and static documentation for all crawlers,
including AI crawlers. App and project URLs, including legacy query routes, are
excluded so crawler traffic does not trigger project reads. No sitemap is
advertised because the site has none.

Check logs follow bring-your-own-CI: providers retain full output under their own retention. Forge keeps results, failure summaries, compact test evidence and provider links. Local logs stay local unless explicitly opted in with finite retention; see [operations](operations.md#check-logs-and-retention).
