# Journey 23: stats and "what Forge saved you"

Project Stats estimates what a project saved by using Forge. Product usage statistics answer a different question: where people and agents drop off in each journey (Item 8edd3157). [Journey 9](09-cost-usage.md) maps the raw cost reads; this file maps the comparison and the statistics.

Walked: `landings`, the `nforge metrics --report` findings of journey 9, the why-forge doc, the marketing scenarios doc, the agent workflow doc (context cost), a search of the web source for savings or statistics, and the open Issues 8edd3157, 38e85188, 2cf30e0a, 9e748e41 and 9589476a. **Not walked:** the rendered Stats page; the findings below are from the initial mapping unless updated.

## Steps today

### What Forge saved a project

| # | Question | Where the answer is today | Evidence |
| --- | --- | --- | --- |
| 1 | How many CI minutes did I use? | `nforge metrics --report` (journey 9): per landing "134.494 runner, 17.095 check-minutes". Each `landings` row: `costs.runnerAccepted` and `runnerDiscarded`. | ran |
| 2 | How many minutes would the same work have used elsewhere? | Project Stats replays recorded work as a comparison (Item 3678767e). The estimate is not a bill. | source |
| 3 | How much faster did changes reach main? | Per project: finish-to-main times in the metrics report. Against GitHub: benchmark only ("time to main per task was 24 to 35% lower on Forge at every N tested"; wall time "mixed"). | ran, docs |
| 4 | How much did checks reuse or skip? | The report's reuse figure ("reuse 0.1 (missed 0 runs)"); `checkSkipped` on a landing row; "0 discarded by a moved main". | ran |
| 5 | How many conflicts never reached me? | Not counted for a person. Overlap notices and early resolutions are records; no total is shown. | ran |
| 6 | How many tokens did my agents spend on Forge? | Not measured per project. The docs measure Forge's own context cost in characters ("the hosted agent MCP lists eight tools in about 5.9k characters (about 1.5k tokens)"). Agents' token use is not recorded on hosted projects. | docs |
| 7 | Any of this on the web? | Project Stats shows estimated dollars saved. Now is for work and decisions, not an operator cost ledger. | source, Item 3678767e |

### Forge's own usage statistics

| # | Question | Today | Evidence |
| --- | --- | --- | --- |
| 1 | Where do people drop off? | Not measured. Issue 8edd3157: "journey funnels and drop-off for people and agents", with "no third-party ad or tracking scripts, no cross-site identifiers, no fingerprinting; aggregate by default … opt-out honoured". | docs |
| 2 | Where do agents fail? | Partly: the metrics report has "Lifecycle errors per 100 finishes" (8 errors in 24 finishes on 2026-11-13, `BAD_ARGUMENT` the largest class) and "Interventions per landing" (1.688). Friction records are filed by agents by hand. | ran |
| 3 | What does Forge collect from a browser today? | Client error reports: "the reporting account's auth subject, kind, scrubbed message and stack, route path, build hash … Rows never hold source contents, URL query strings or recognized tokens." Reports expire after 30 days (Item 71db311e). They are not yet part of Your Forge data. | docs |
| 4 | Can a person see or switch off what is collected? | No page. | docs |

## Findings

| Id | Severity | Finding | Evidence |
| --- | --- | --- | --- |
| J23-1 | S1 | **A published benchmark is not a project's saving.** Stats shows an estimate based on that project's own landings instead of applying a benchmark ratio to it. | Item 3678767e |
| J23-2 | S2 | **State the baseline beside the estimate.** The accepted comparison and remaining methodology work are in [Decisions](#decisions). | Item 8edd3157 |
| J23-3 | S2 | **Dollars saved belong on Stats.** This supersedes the old blanket rule against showing money. Operator costs remain internal. | Items 581bd373 and 3678767e |
| J23-4 | S2 | **Tokens are in the promise and not in the data.** The journeys Issue names "CI minutes, tokens, against GitHub". Forge does not see an agent's token use; it can count what its own replies cost. A "tokens saved" figure has no source today. | docs |
| J23-5 | S2 | **Product statistics do not exist, and the first evidence is already in hand.** The agent-side counts (errors per finish, interventions per landing, error classes) are recorded for the Forge project. They are the agent funnel of 8edd3157 in raw form, visible only in an operator report. | ran |
| J23-6 | S2 | **What is collected today is not disclosed in the product.** Browser error reports expire after 30 days and are outside the account data export. The policy and product statistics work (Items 85720296 and 8edd3157) still needs to explain what is collected. | docs |
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
- **Person, not agent:** estimated dollars saved, with the baseline and method within reach; then time to main, first-try rate and CI minutes per landing. A plain page says what Forge counts about them.

## Decisions

- Project Stats leads with estimated dollars saved, then time to main, first-try rate and CI minutes per landing. Compare the same work on the comparison host at its published per-minute CI rate. Include the CI runs Forge avoided, but do not count a run again if it is already in the minute difference. The methodology must say which runs count (Items 3678767e and 8edd3157).
- Agent token reporting is opt-in. Keep reported agent tokens separate from the estimate for Forge's own replies; public claims cover only what was measured (Item 40ad7abd).
- The first product statistics are the agent funnel, using counts Forge already records (Item 8edd3157).

## Questions for the owner

- How are browser error reports disclosed and included in account data export? The 30-day expiry has landed (Item 71db311e).
