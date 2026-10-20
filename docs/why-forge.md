# Why Forge for agentic development?

Forge is a source host and workspace for people and coding agents changing one
codebase at the same time. Agents keep their editors and tools. Forge records
what each agent intends to do, gives it an isolated Lane, composes concurrent
changes, checks the combined code and moves accepted source to main.

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
These observations are advisory and can be incomplete. Coordination quality has
not yet been measured.

## Measured landing throughput

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

The web build generates `/llms.txt` as a linked guide and `/llms-full.txt` as the
complete text of every document in `scripts/package-documents.mjs`, in that
inventory's stable order. It also serves those Markdown files under `/docs/`.
The inventory includes this page, the documentation index, agent guidance,
concepts, architecture, workflows, operations, security, development, decisions,
license disclosures and the already-public status, backlog and roadmap.
Unlisted documents, vendor notice trees, root files and agent skills are excluded
from these generated files; the installed agent skill ships separately.

`robots.txt` permits the public landing and static documentation for all crawlers,
including AI crawlers. App and project URLs, including legacy query routes, are
excluded so crawler traffic does not trigger project reads. No sitemap is
advertised because the site has none.
