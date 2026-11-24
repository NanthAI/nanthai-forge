# Journey 39: a lead agent running several builders

Leading a fleet is a workflow, not a separate Forge persona. An agent or person plans work, hands Items to builders, follows progress and acts on holds. This journey is not on the list of Issue a0cf8c22. It comes from the lead playbook in this repository, Items f65d8024 (the project event feed) and 98084923 (shared usage), and the 2026-11-09 design review ("a full-time lead agent doing three jobs by hand: sequencing work so builders do not collide, checking that landed is true, and re-driving stuck things"). [Journey 5](05-many-agents.md) maps several agents from a builder's seat.

Walked: the lead playbook and brief template, `planning` (lists, counts and `schedule`), `lanes`, `queue`, `board`, `decisions`, `friction-list`, `help wait`, `help board`, and this mapping's own coordination with a builder working in the parent Lane. **Not walked:** launching builders (this task forbade child agents).

## Steps today

| # | Step | What the lead does | Evidence |
| --- | --- | --- | --- |
| 1 | Decide what to run | Reads `planning` page by page. `planning '{"kind":"issue","schedule":true}'` adds advice: `parallel`, `stacks`, `unknown`, with "Nothing is started or blocked." For one Initiative it returned 4 parallel and 26 unknown ([journey 33](33-agent-scorecard-journeys.md)). | ran |
| 2 | Prepare the Item | "Create the Issue before assigning a slice. A behavior change needs a measurable Done when checklist. Before dispatch, read the Issue body and every comment and rewrite Done-when from them." | docs |
| 3 | Write the brief | A 36-line template in the repository. The brief lives outside Forge, in the lead's harness. | docs |
| 4 | Launch | In the lead's own harness. "Forge never hosts or spawns agents." "Before launch, check shared model usage, memory pressure, swap and disk; all projects share these resources." | docs |
| 5 | See who is running | `lanes` (actor, Item, last save, latest landing, state); `queue`. "Before calling a builder running or stopped, inspect its actual thread/session, Lane activity and latest handoff. Silence is unknown." | ran, docs |
| 6 | Keep builders apart | Board notes of 240 characters to a Lane, an Item or the project. In this mapping one note was posted to the parent Lane: `status:"posted"`, `recipients:1`. No reply was seen. | ran |
| 7 | Wait | `wait '{"peer":"LANE_ID"}'` for one Lane; `wait '{"operationIds":[…]}'` for landings; one background wake command per landing. Open Issue f65d8024: an event feed and `nforge watch ROOT --on-landing CMD`. | ran: help, docs |
| 8 | Check that "landed" is true | `landings`, `lane-history`, the receipt. "Do not ferry scratch patches or land a builder's unverified work for them." | ran, docs |
| 9 | Re-drive | `x prioritize`, `x cancel`, `land --withdraw` (author or owner), `x abandon-dormant`. "Before relaunching, verify there is no live original builder or command; duplicate ownership is an incident." | ran: help, docs |
| 10 | Record decisions and friction | `save --decision` and `decisions` (each row has `decidedBy`, `what`, `why`); `friction`, `friction-list`, `x friction-triage`. | ran |
| 11 | Report to the owner | In the lead's chat. Nothing in Forge is the lead's report. | docs |

## Findings

| Id | Severity | Finding | Evidence |
| --- | --- | --- | --- |
| J39-1 | S1 | **The lead's working state lives outside Forge.** Briefs, which builder has which Item, whether a builder is alive, and the report to the owner are in the lead's harness and private notes. Forge sees Lanes and landings. The playbook's own rules ("silence is unknown", "inspect its actual thread") describe a lead compensating for what Forge cannot tell it. | docs |
| J39-2 | S2 | **Forge cannot say whether a builder is alive.** Sessions are "working through 15 minutes, quiet through 90". A builder that crashed and one that is thinking look the same until the lead checks its harness. | docs |
| J39-3 | S2 | **Scheduling advice needs file names in Item text.** The schedule marked most Items unknown. The design review proposed predicting files from history and declared scope; today a lead writes "launch when both land" into briefs by hand. | ran, docs |
| J39-4 | S2 | **A lead follows many builders through one-at-a-time waits.** `wait` takes one of runId, operationIds, peer or approval. Following eight builders means eight waits or a polling loop over `lanes`, which the rules forbid. The event feed (f65d8024) is the answer and is not built. | ran: help, docs |
| J39-5 | S2 | **A note to another agent is a message in a bottle.** The post returned `recipients:1`. Whether the other agent read it, and when, is not shown to the sender; board notes "arrive once per Lane" on the receiver's next command. | ran |
| J39-6 | S2 | **The lead and its builders are one identity.** All act under one handle with generated run names. "Assigned to" does not exist; `lanes` shows the same actor for every row. The lead cannot be given rights its builders lack (for example, only the lead may reprioritise). | ran, docs |
| J39-7 | S2 | **Shared resources are checked by hand.** Model allowance, memory and disk are outside Forge; CI concurrency is inside. Nothing warns a lead that launching four more builders will exceed any of them ([journey 22](22-many-projects.md), J22-5). | docs |
| J39-8 | S3 | **Decisions are recorded and hard to use.** `decisions` returns full records with 128-character cursors. There is no "decisions that apply to this Item" read for a builder's brief. | ran |
| J39-9 | S3 | **The playbook is specific to building Forge.** It is the best description of the lead's journey and lives under `docs/agents/` as working rules for this project. Other teams' leads have no equivalent guide. | docs |

## Dead ends

- "Which of my builders are alive?"
- "Wake me when any of these eight Lanes changes state."
- Assigning an Item to a builder before it starts.

## Naming and tone

- Lead, orchestrator, supervisor, owner agent, builder, worker, subagent, session, run. "Worker" also means a check machine (`nforge worker`).
- The playbook's sentence "Silence is unknown." is the right principle and belongs in the product's replies about sessions.

## What each persona needs

- **Agent, not person (lead):** a plan read that returns runnable groups; assignment that Forge records; one wait over many Lanes; liveness per builder; a status sentence it does not have to compose ([journey 38](38-where-a-project-is-at.md)).
- **Person, not agent:** use the same Plan, Now and decision records to see who has what and what needs a decision. No lead-only view is required.

## Approved direction (group I)

These owner decisions guide the P7 spec; the steps and findings above describe the implementation observed.

- **I38:** `ask` (with choices) and `hand back` become agent actions beside start, save and land.
- **I39:** Use one message system: one thread per Lane or Item, with choices on a message. Board notes and session messages merge into it.
- **I40:** When the agent has stopped, the answer waits on the Lane and Forge offers a ready resume prompt. Forge never starts an agent by itself.
- **I44:** Owner and write roles may order two overlapping Lanes from Now. Record the order and show it with Undo.

## Decisions

- “Lead” is not a product persona or role. Leads use the project event feed and `nforge watch` (Item f65d8024). Existing permissions apply; there is no extra power to move someone else's work.
- Record assignment at handover and show **Handed over, not started** until the agent starts (Item 95b7ab51).

## Questions for the owner

- Is a general “leading agents on Forge” guide part of the docs site, separate from this repository's playbook?
