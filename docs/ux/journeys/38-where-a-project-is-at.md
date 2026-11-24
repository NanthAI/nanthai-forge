# Journey 38: understanding where a project is at

A person, or an agent acting as lead, asks: how far along is this phase, what is in progress, what needs a decision, is main healthy? Issue a0cf8c22 lists "understand where a project is at" in the core loop. The planning design began with this question ("The owner kept asking what is the status of this phase, and the answer lived in a lead agent's private log"). [Journey 8](08-planning.md) maps planning; [journey 17](17-staying-informed.md) maps news; this file maps the summary.

Walked: `planning` with `counts:true`, `queue`, `lanes`, `nforge status`, `check-settings` (main audit), `landings`, `nforge metrics --report` as read in journey 9, the Now and planning sources, the planning design pack and the open Issues b7a0dff1 and d3357f40. **Not walked:** a rendered planning page.

## Steps today

| # | Question | Agent or terminal | Person on the web |
| --- | --- | --- | --- |
| 1 | How far along is this Initiative? | `planning '{"initiativeId":"…","counts":true}'` returns five status counts, their total and coverage. The maintained path uses one read. | Plan's Initiative headers and detail show the same [progress counts](../../planning.md#progress). A `+` marks a lower bound when the bounded read cannot prove completeness. |
| 2 | What is in motion right now? | `lanes '{"limit":N}'` (actor, Item title, last save, latest landing, state); `queue '{}'` → `total`, each entry with `position`, `landingState:{"state":"checking","label":"Checking","nextStep":"The check is running on this Candidate; wait for its result."}` and `intentTitle`. (ran) | Now → What's changing, with the journey rail per Lane; Who's working. |
| 3 | What needs attention? | No single read. Dormant Lanes: `lanes '{"view":"dormant"}'`. Held landings sit in `queue` "without a position". Stalls raise an alert. | Needs you ([journey 27](27-what-needs-me.md)). "Quiet Lanes expand from one summary line." |
| 4 | Is main healthy? | `check-settings` → `mainAudit`: `result:"passed"`, `redMinutes:0`, `lastGreen`, `landing.label:"Fast landing"`, `window:{"audits":50,"red":0}`. (ran) | Not found as a line on Now ([journey 30](30-provider-outage.md), J30-6). |
| 5 | What landed lately? | `landings '{"from":"…","to":"…"}'` (no titles; [journey 18](18-browsing-code.md), J18-6). | Now → "Accepted today"; the ledger "What landed on main". |
| 6 | Is my copy current? | `nforge status .` → "Forge clone: current with main." One line, for people. (ran) | n/a |
| 7 | How fast and how costly is it going? | `nforge metrics --report` ([journey 9](09-cost-usage.md)). | No page. |
| 8 | One sentence for the whole project | None. The planning design proposes a one-liner per Initiative "assembled from events and never written by a model: Phase: 14 of 19 landed, 3 in flight, 2 waiting on owner", and an agent action `plan status` (unshipped). | None. |
| 9 | Burn-up, flow, swimlanes | None. Listed as ideas in the planning design ("burn-up per Initiative … cumulative flow … progress swimlanes"). | None. |
| 10 | Across projects | None ([journey 22](22-many-projects.md)). | Home: a count of what needs you and "N working" per project. |

## Findings

| Id | Severity | Finding | Evidence |
| --- | --- | --- | --- |
| J38-1 | S1 | **Plan now shows where an Initiative stands.** The five counts agree with the CLI and MCP for covered Initiatives, including Items outside the displayed rows (b7a0dff1). | fixture, docs |
| J38-2 | S2 | **The counts use the stored status words, not the ones people will see.** `open`, `in-progress`, `closed`, `proposed`, `abandoned` against the decided Proposed, Planned, In progress, Done, Abandoned (journey 8, J8-3). "122 open" hides how many are planned and how many nobody has looked at. | ran |
| J38-3 | S2 | **Progress, motion, health and blockage live in five reads.** `planning`, `lanes`, `queue`, `check-settings` and Needs you each hold one part. A lead agent asked "where are we?" runs all five and writes the sentence itself, which costs tokens and differs every time. | ran |
| J38-4 | S2 | **Waiting and inactivity are different.** A landing held for a person has no queue position; a check that never reports can stall. Neither implies that an Item should leave In progress for inactivity. | ran, docs |
| J38-5 | S2 | **Counts say how many, not whether it is going well.** 20 closed of 160 could be healthy or late. Forge records landings per day, first-try rate and time to main (journey 9, J9-9); none is joined to an Initiative. | ran |
| J38-6 | S2 | **An Initiative's own summary is prose kept by hand.** The Phase 7 Initiative body lists what to run first, the dated re-checks and triage notes, typed by a lead. It is the real status page of the project and is edited by `put-planning-item` with no structure. | ran |
| J38-7 | S3 | **`nforge status` is the one command that answers a person in a sentence**, and it answers the smallest question (is my folder current). The same form would suit the larger ones. | ran |
| J38-8 | S3 | **`coverage` on the counts is easy to miss.** The schedule read returned `coverage:"partial"`; a reader who ignores the field takes a partial count as the whole. | ran |

## Dead ends

- "Will this Initiative finish, at this rate?"

## Naming and tone

- Status means a project's progress, an Item's state, a Lane's state, a landing's state, a clone's freshness, service health and a document (`docs/status.md`).
- The design pack's one-liner is in the right voice: counts, no adjectives.

## What each persona needs

- **Agent, not person:** one read that returns the sentence and the numbers for an Initiative or the project, cheaply, so it never composes status prose from five reads.
- **Person, not agent:** per Initiative, its status and how many Items are done. Needs you explains what is waiting for a decision; main health is a separate fact.

## Decision

- Show one line per Initiative: its status and **x of y Items done**. There is no “stuck” state or label. Time away or exhausted model credits do not move anything out of **In progress**. Only an explicit action or the work roll-up rules change status. An agent asks before moving someone else's work out of In progress, even when the owner changes direction (Item 052ca3c8).

## Questions for the owner

- Does the project summary also include main health and the queue?
- Is a trend wanted, or are counts enough for the first version?
- Is the Initiative's hand-written summary kept beside the generated line?
