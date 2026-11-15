# Journey 9: cost and usage visibility

CI minutes, what the owner pays, and statistics.

Walked: `nforge metrics` (JSON and `--report`), the agent `metrics` action, `landings`, `check-settings`, a search of the web source for cost surfaces, the README and the operations cost docs' headings. **Not walked:** `metrics record-bill` (it writes).

## Steps today

| # | Question | Where the answer is | What it looks like |
| --- | --- | --- | --- |
| 1 | How many CI minutes did landings use? | `nforge metrics ROOT --from DATE --to DATE --report FILE.md` | A table. Row "5.6 Check minutes per landing and reuse": "134.494 runner, 17.095 check-minutes (1.688 runs/landing, 0 discarded by a moved main); reuse 0.1 (missed 0 runs); total 2151.906 runner / 273.528 check min". (ran) |
| 2 | Same, without `--report` | `nforge metrics ROOT --from … --to …` | JSON. Two days came to about 350 KB. (ran) |
| 3 | What was wasted? | The report's waste table | Rows by cause (main-race, flake, conflict, cancel, supersede, stall, check-failed) with attempts, lost elapsed minutes, runner minutes and discarded passed runner minutes. (ran) |
| 4 | What did it cost in money? | Row "5.8 Dollars per landing" | "$unknown billed / $unknown list; estimator error unknown", until the owner enters each provider bill with `nforge metrics record-bill ROOT --provider P --from DATE --to DATE --billed-usd N`. (ran) |
| 5 | What did one landing cost? | `landings` rows | `costs:{"attempts":2,"writes":8,"r2ClassA":4,"r2ClassB":7,"r2BytesPut":49188,"runnerAccepted":95.65,"runnerDiscarded":0}`. (ran) |
| 6 | Whose CI runs the checks? | `check-settings` | Provider, runner repository, `runsOn`, `concurrencyBudget`, and the public-logs notice. (ran) |
| 7 | What did an import cost? | The `nforge import` reply | The GitHub API requests the import made, "by who paid for them". (docs) |
| 8 | Any of this on the web? | Settings → Checks | Runs and last run per check. No minutes, no cost, no totals. A search of the web source for CI minutes, runner minutes and cost found nothing. (ran) |
| 9 | Usage statistics | n/a | Not built. Open Issue 8edd3157. |

Other rows in the report: "5.1 Landings by path" (first try, retry, recompose, fixer), "5.2 Lifecycle errors per 100 finishes", "5.3 Dropped landings", "5.5 Interventions per landing", "5.7 Authority lag and contradictions", "R Red-main minutes", "B Proved-reuse back-stop".

## Findings

| Id | Severity | Finding | Evidence |
| --- | --- | --- | --- |
| J9-1 | S1 | **The person who pays cannot see what they pay.** The web has no CI-minute or cost figure anywhere. The only route is a CLI command whose default output is hundreds of kilobytes of JSON. | ran |
| J9-2 | S2 | **The report is written for Forge's own team.** Its rows are numbered 5.1 to 5.8 (the stages of an internal plan), R and B. Terms such as "fixer", "compensating", "authority lag", "proved-reuse back-stop" and "estimator error" are not explained. Coverage notes are longer than the values. | ran |
| J9-3 | S2 | **Two kinds of minutes with no definition on the page.** "134.494 runner" and "17.095 check-minutes" per landing differ by about eight times. The report defines neither and does not say which one is billed. `runnerAccepted: 95.65` in a landing row has no unit. | ran |
| J9-4 | S2 | **Money is "unknown" unless typed in by hand.** Dollars per landing needs each provider's bill entered through a command. No estimate from list prices is shown in its place. | ran |
| J9-5 | S2 | **Nothing states who pays for what.** With your own CI, check minutes are on the owner's CI account; storage and backend calls are on the Forge operator. No surface says this, and pricing is not decided. | docs |
| J9-6 | S2 | **The saving against GitHub has no number.** The journeys Issue asks for "cost and savings (CI minutes, tokens, against GitHub)". Today there is waste (minutes discarded) and reuse (0.1), and the README states that no advantage for single agents has been shown. Token use is self-reported by agents and optional. | ran, docs |
| J9-7 | S2 | **Two open Issues disagree about money on the web.** 9e748e41 (Now view) says "No ledger or money for users". a0cf8c22 lists "see cost and savings" in the core loop. | ran |
| J9-8 | S3 | **Agents get no warning before a limit.** A refusal names the limit and `retryAt`; nothing shows the remaining budget beforehand. Open Issue 93907d28. | ran |
| J9-9 | S3 | **The numbers that would persuade are already measured.** One day: 16 landings, 6 on the first try, first-attempt land rate 0.571, 1.688 interventions per landing, finish-to-main p50 about 11 minutes. They are visible only in the report. | ran |

## Dead ends

- A person on the web looking for usage: there is no page.
- "Dollars per landing: $unknown" with no hint in the row about how to fill it (the command is in the help, not the report).

## Naming and tone

- "runner minutes", "check-minutes", "CI minutes" (owner's word), "check time" and "shard seconds" (docs) are used for overlapping things.
- The report states what it does not know, which fits the product ("absent facts are omitted, never shown as zero"). It needs that honesty in fewer words.

## What each persona needs

- **Agent, not person:** its remaining budget and the cost of the action it is about to repeat (a failed check costs N runner minutes); nothing about money.
- **Person, not agent:** three or four numbers at a glance with a trend: minutes per landing, share landed first try, waiting time, and what was wasted and why. Then, when pricing exists, what they owe.

## Questions for the owner

1. Is money shown to users at all? 9e748e41 says no ledger; a0cf8c22 says cost and savings. If yes: as CI minutes only, or dollars?
2. Which numbers come first for an owner: minutes per landing, first-try rate, time to main, wasted minutes?
3. Is `nforge metrics` a tool for every owner or for the Forge team? That decides whether its report gets plain row names.
4. Should Forge estimate cost from list prices when no bill is entered, marked as an estimate?
5. Is a comparison with GitHub shown inside the product, or only in published benchmarks?
