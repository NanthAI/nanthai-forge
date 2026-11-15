# Journey 23: stats and "what Forge saved you"

Two things under one word. First, what a project saved by using Forge: CI minutes, time to main, tokens, set against GitHub (the core-loop line "see cost and savings" of Issue a0cf8c22). Second, the product's own usage statistics: where people and agents drop off in each journey (Issue 8edd3157). [Journey 9](09-cost-usage.md) maps the raw cost reads; this file maps the comparison and the statistics.

Walked: `landings`, the `nforge metrics --report` findings of journey 9, the why-forge doc, the marketing scenarios doc, the agent workflow doc (context cost), a search of the web source for savings or statistics, and the open Issues 8edd3157, 38e85188, 2cf30e0a, 9e748e41 and 9589476a. **Not walked:** nothing here writes; the web has no page to render.

## Steps today

### What Forge saved a project

| # | Question | Where the answer is today | Evidence |
| --- | --- | --- | --- |
| 1 | How many CI minutes did I use? | `nforge metrics --report` (journey 9): per landing "134.494 runner, 17.095 check-minutes". Each `landings` row: `costs.runnerAccepted` and `runnerDiscarded`. | ran |
| 2 | How many would GitHub have used for the same work? | Not computed for a project. The only comparison is a published benchmark: "Forge used 331 billed CI minutes and 116 jobs over 11 scored cells, against 910 minutes and 336 jobs for the Git and GitHub arm". | docs |
| 3 | How much faster did changes reach main? | Per project: finish-to-main times in the metrics report. Against GitHub: benchmark only ("time to main per task was 24 to 35% lower on Forge at every N tested"; wall time "mixed"). | ran, docs |
| 4 | How much did checks reuse or skip? | The report's reuse figure ("reuse 0.1 (missed 0 runs)"); `checkSkipped` on a landing row; "0 discarded by a moved main". | ran |
| 5 | How many conflicts never reached me? | Not counted for a person. Overlap notices and early resolutions are records; no total is shown. | ran |
| 6 | How many tokens did my agents spend on Forge? | Not measured per project. The docs measure Forge's own context cost in characters ("the hosted agent MCP lists eight tools in about 5.9k characters (about 1.5k tokens)"). Agents' token use is not recorded on hosted projects. | docs |
| 7 | Any of this on the web? | No. Issue 9e748e41 (Now view) says "No ledger or money for users". Hearth 5 (38e85188, proposed, parked by the 2026-11-09 review) plans local counters (landings, a clean streak) that "never show a count". | docs, source |

### Forge's own usage statistics

| # | Question | Today | Evidence |
| --- | --- | --- | --- |
| 1 | Where do people drop off? | Not measured. Issue 8edd3157: "journey funnels and drop-off for people and agents", with "no third-party ad or tracking scripts, no cross-site identifiers, no fingerprinting; aggregate by default … opt-out honoured". | docs |
| 2 | Where do agents fail? | Partly: the metrics report has "Lifecycle errors per 100 finishes" (8 errors in 24 finishes on 2026-11-13, `BAD_ARGUMENT` the largest class) and "Interventions per landing" (1.688). Friction records are filed by agents by hand. | ran |
| 3 | What does Forge collect from a browser today? | Client error reports: "the reporting account's auth subject, kind, scrubbed message and stack, route path, build hash … Rows never hold source contents, URL query strings or recognized tokens." "Reports are kept until removed by hand" and "are not yet part of Your Forge data". | docs |
| 4 | Can a person see or switch off what is collected? | No page. | docs |

## Findings

| Id | Severity | Finding | Evidence |
| --- | --- | --- | --- |
| J23-1 | S1 | **Forge's central claim cannot be seen by the person it is made to.** "Fewer CI minutes, faster to main with many agents" is measured in a benchmark on someone else's repository. In a person's own project no number says what Forge saved them. The inputs exist per landing (minutes used, minutes discarded, checks skipped, landings grouped). | ran, docs |
| J23-2 | S2 | **A saving needs a baseline, and none is defined.** "Against GitHub" could mean one full CI run per landing (what a pull request would cost), a merge queue with rebases, or the project's own history before Forge. Each gives a different number. Without a stated baseline any figure shown would be a claim, not a measurement, which the product's rules forbid. | docs |
| J23-3 | S2 | **Two open Issues disagree** (journey 9, J9-7): the Now view says no money for users; the journeys Issue lists cost and savings in the core loop; 2cf30e0a holds the usage page until the owner answers. Savings in minutes and time are not money and may not be covered by the "no ledger" decision. | docs |
| J23-4 | S2 | **Tokens are in the promise and not in the data.** The journeys Issue names "CI minutes, tokens, against GitHub". Forge does not see an agent's token use; it can count what its own replies cost. A "tokens saved" figure has no source today. | docs |
| J23-5 | S2 | **Product statistics do not exist, and the first evidence is already in hand.** The agent-side counts (errors per finish, interventions per landing, error classes) are recorded for the Forge project. They are the agent funnel of 8edd3157 in raw form, visible only in an operator report. | ran |
| J23-6 | S2 | **What is collected today is not disclosed in the product.** Browser error reports carry an account identifier, are kept without a time limit and are outside the account's data export. The planned policy page (85720296) and 8edd3157 both need this stated before the beta. | docs |
| J23-7 | S3 | **"Stats" means three things in planning.** Usage statistics about people (8edd3157), usage for owners (2cf30e0a) and delight counters (38e85188). They share events and need one name each. | docs |
| J23-8 | S3 | **The benchmark's losses are part of the honest number.** Wall time at N = 10 was worse than GitHub's median. A per-project savings figure will sometimes be negative. The product needs a way to say so. | docs |

## Dead ends

- "Show me what Forge saved this month."
- "What do you collect about me?"

## Naming and tone

- "Saved" is a claim word. The docs already separate "measured", "early sample" and "not measured"; a savings figure has to carry the same labels.
- Minutes: "runner minutes", "check-minutes", "CI minutes", "billed CI minutes" (journey 9, J9-3).

## What each persona needs

- **Agent, not person:** nothing about savings. For statistics: its errors and wrong turns counted without its prompts or code leaving the machine.
- **Person, not agent:** two or three numbers with a stated baseline (minutes used against one full run per landing; share landed first try; median time to main), shown where they already look, with the method one click away. And a plain page that says what Forge counts about them.

## Questions for the owner

1. Does "no ledger or money for users" also rule out savings shown as CI minutes and time, or only dollars?
2. Which baseline defines a saving: one full CI run per landing, the project's own pre-Forge numbers when it imports history, or the published benchmark ratio?
3. Is "what Forge saved you" a number on Now, a monthly summary, a page, or marketing only?
4. Tokens: does Forge ask agents to report token use (opt-in), estimate only its own replies, or drop tokens from the claim until it can measure them?
5. For product statistics (8edd3157): is the first version the agent funnel from counts Forge already records, with the people funnel later?
6. Are browser error reports added to the account data export and given a retention period before the beta?
