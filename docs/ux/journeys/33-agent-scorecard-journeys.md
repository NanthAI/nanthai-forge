# Journey 33: the agent-side scorecard journeys

Issue a0cf8c22 fixes six journeys that a fresh agent will run with only the docs, measured in turns, tokens, errors and wrong turns: learn Forge from the docs and `llms.txt`; pick the next backlog Item; report progress and evidence; recover from a failed check or a stale Lane; hand back to a person when stuck; coordinate across repositories. Use the current guides below to run the scorecard. The original mapping pass follows as a record of what its agent observed.

| Journey | Start with the built guide |
| --- | --- |
| Learn Forge | [Docs home](../../README.md) and [entry point for agents](/llms.txt) |
| Pick an Item | [Plan](../../guides/plan.md#find-the-work) |
| Report evidence | [Save and land](../../guides/agents.md#land-it) and [Done-when evidence](../../guides/plan.md#record-done-when-evidence) |
| Recover | [Review and land](../../guides/review.md#when-a-check-fails) and the receipt's recovery |
| Ask or hand back | [When you need someone else](../../guides/agents.md#when-you-need-someone-else) |
| Work across repositories | [Order two separate landings](../../guides/agents.md#work-across-two-repositories) |

The generated [CLI](../../reference/cli.md) and [MCP](../../reference/mcp.md) references have the current commands. The current entry point teaches `start`, `save` and `land`. Action help puts an example before its schema. For earlier Lanes, pass an Item ID to `lanes {planningItemId}` or a full Intent UUID to `lanes {intentId}`. Use `status {laneId}` for one Lane. The CLI schema for planning Item IDs accepts an unambiguous prefix of at least eight characters. Follow the project's current rules if it asks for a full UUID.

Walked: every command below marked ran, against the Forge project, during this mapping's own Lane (a Lane stacked on the part 1 Lane). **Not walked:** a failed check, a stale Lane and a second repository.

## 1. Learn Forge from the docs and `llms.txt` only

Detail: [journey 24](24-llm-discovery.md) and [journey 14](14-setting-up-agents.md).

| Step | Observed in the mapping pass | Evidence |
| --- | --- | --- |
| Find the start | `nforge --help` opens with "Start here: nforge docs quickstart (offline Git adoption)". `nforge docs` lists 108 documents. `nforge docs agent` prints the skill. | ran |
| Learn the loop | The skill: "Three verbs: start, save and land". AGENTS.md gives five commands. `llms.txt` still says `finish` and `tests`. | ran, source |
| Learn one action | `nforge agent . ACTION --help` prints a JSON schema; for `lanes` the three id fields carry a 180-character pattern each and one sentence of meaning. | ran |
| First mistake | `lanes '{"laneId":"…"}'` → `BAD_ARGUMENT: Unrecognized key: "laneId". Run nforge agent ROOT lanes --help, correct the named fields and retry.` with `next` and `learn`. A short id → "expected the full 36-character UUID". Both cost one turn each in this pass. | ran |

## 2. Pick the next backlog Item

Detail: [journey 8](08-planning.md).

| Step | Observed in the mapping pass | Evidence |
| --- | --- | --- |
| List what is open | `planning '{"status":"open","limit":50}'`; one Initiative of 155 Items took two pages; each row has a body cut to 400 characters. | ran |
| Know the order | No order field. An Initiative's body lists ids in prose ("Run first (owner, early P7): 11ba7bb9 …"). | ran |
| Know what can run in parallel | `planning '{"kind":"issue","schedule":true}'` adds `schedule`. For the 30 open Items of one Initiative it returned 4 as `parallel`, 0 `stacks` and 26 `unknown`, with `coverage:"partial"` and the rule "an Issue that names none is unknown, not independent. Nothing is started or blocked." | ran |
| Know whether someone has it | `lanes '{"planningItemId":"FULL-UUID"}'` lists open Lanes for the Item with actor, last save and state. `start` also warns: "Another agent on your account (HANDLE/fiery-ibis) is working on this Issue: Lane bac2799a …, active 2m ago". | ran |
| Take it | `start '{"planningItemId":"…"}'`. The Item moves to in-progress. | ran |

## 3. Report progress and evidence

| Step | Observed in the mapping pass | Evidence |
| --- | --- | --- |
| Progress while working | `save '{"message":"…"}'`. Reply: `status:"settling"` and "Saved: the server is finishing this save now. Your next command here reports its outcome, including any failure." | ran |
| Tell peers | `board --post '{"to":"lane:ID","text":"…"}'` (240 characters) → `status:"posted"`, `recipients:1`. | ran |
| Record evidence on the Item | `comment-planning-item '{"planningItemId":"…","text":"…"}'`. "An Issue closes when its Intent completes and every Done-when line has evidence; a held one names the open lines." A closing comment on another Item read: "Intent completed; 1 Done-when line(s) still open, so this Issue stays open … Comment the evidence for each line, then close with: nforge agent . put-planning-item …". | ran: help, ran |
| Evidence of the change | The landing receipt: check run ids, heads, costs. Optional proof that changed tests fail on the base and pass on the head (`proofOnLanding`, off by default). | docs |
| Report to the person | Nothing structured. AGENTS.md asks for a handoff in prose: "what changed, why, what you ran (with results), what you did not verify, and the next step". | docs |

## 4. Recover from a failed check or a stale Lane

Detail: [journey 4](04-failed-check.md), [journey 3](03-conflict.md) and [journey 10](10-mistakes-recovery.md).

| Situation | Observed in the mapping pass | Evidence |
| --- | --- | --- |
| The check failed | "Fix it in the same Lane, save, then land --save again. Do not abandon or re-create the Lane, and never skip or weaken a test to pass." `log '{"runId":"…","tail":8192}'` reads the output. | ran: help |
| The Lane is behind main | `behindMain` on start, save and status. `save --sync` (also spelled `sync`) updates it; conflicts go to the resolve flow. | ran: help, docs |
| Something moved during a command | "WORK_STALE, *_CHANGED, *_STALE: something moved while you ran (main, the Lane, a policy). Run the same command again; it reads fresh state." | ran: help |
| The Lane is no longer active | "LANE_NOT_ACTIVE: the Lane landed or was abandoned; keep your edits and start a new Lane." `start --reopen` restores an abandoned one. | ran: help |
| The Lane went dormant | Idle past `dormantAfterDays` (default 2) it is listed as dormant and may be abandoned in a sweep; nothing is deleted. | ran: help |
| The local folder is gone | `start --open '{"laneId":"…"}'` brings it back at its last save. | ran: help |
| A read right after a save | In part 1, `diff` seconds after `save` returned the old head (J2-14). In this pass, saving returned `settling` and the next command was the report of the outcome. | ran |

## 5. Hand back to a person when stuck

Detail: [journey 26](26-answering-an-agent.md).

| Step | Observed in the mapping pass | Evidence |
| --- | --- | --- |
| Ask for a go | `request-approval`, then `wait '{"approval":"LANE_ID"}'`. | docs |
| Ask a question | No action among those the help lists. | ran |
| Hand the work back | `handoff` → `HOSTED_ACTION_UNSUPPORTED: handoff was removed with native mode. Use board --post {to,text} leaves a note for the next agent.` | ran |
| Stop cleanly | `x abandon '{"laneId":"…","reason":"…"}'` keeps everything; or leave the Lane saved and report in the agent's own chat. | ran: help |

## 6. Coordinate across repositories

Detail: [journey 22](22-many-projects.md).

| Step | Observed in the mapping pass | Evidence |
| --- | --- | --- |
| Find the other project | No list read. | ran: help |
| Link two changes | Nothing. Stacking (`stackOn`) works inside one project. | ran |
| Wait for the other landing | `wait '{"peer":"LANE_ID"}'` works inside one project. | ran: help |

## Findings

| Id | Severity | Finding | Evidence |
| --- | --- | --- | --- |
| J33-1 | S1 | **Two of the six scorecard journeys cannot be completed with the taught commands.** Handing back when stuck has no action (journey 26, J26-1 and J26-2). Coordinating across repositories has no first step (journey 22, J22-2). A scorecard run today scores them as failures by construction. | ran |
| J33-2 | S2 | **Picking the next Item is a reading task, not a query.** No order, no "next for me", no filter by what is unclaimed. The schedule advice marked 26 of 30 Items `unknown` because their text names no file. An agent given "take the next one" reads two pages of 400-character bodies and an Initiative's prose. | ran |
| J33-3 | S2 | **The first wrong turn is the id shape.** Actions take `laneId`, `planningItemId` (with aliases `id` and `itemId`), `intentId`, `operationId`, `submissionId`, `runId`, `receiptId` and `candidateId`. `lanes` takes no `laneId`; `status` does. Eight-character ids are printed everywhere and refused as input. In this pass that cost two failed calls in the first ten. The refusals were exact and named the fix. | ran |
| J33-4 | S2 | **Evidence has no shape.** Progress is a save message, a board note, an Item comment and a prose handoff, in four places. The Item closes on done-when lines, and the way to attach evidence to a line is to write a comment and hope the match is clear. The reply that an Item stays open names the open line, which is good. | ran, docs |
| J33-5 | S2 | **`--help` on an action is a schema, not help.** Each UUID field prints a 180-character pattern. The one-line summary at the top ("lanes: planningItemId?, id?, itemId?, intentId?, cursor?, limit?, view?") is the useful part and is followed by a hundred lines an agent pays to read. | ran |
| J33-6 | S2 | **A save answers "settling".** The agent is told the next command will report the outcome. An agent that saves and then ends its turn never learns of a failed save. Part 1 found the same from the read side (J2-14; Issue 12 of the first handoff). | ran |
| J33-7 | S3 | **Stale has four meanings.** A Lane behind main, a Lane idle too long (dormant), a Lane already landed or abandoned (not active), and a command that raced a change (`WORK_STALE`). Each has its own word and remedy; the scorecard says "a stale Lane". | ran: help |
| J33-8 | S3 | **Stacking worked first time and its reply was long.** `start` with `stackOn` returned the path, a presence notice naming 24 files, a board hint and the install-scripts line (journey 14, J14-8). | ran |

## What the scorecard should measure first

From this pass, as inputs to the scorecard design and not as results: failed calls from id shape and key names; tokens spent on `--help` output; turns from "take the next Item" to `start`; whether a save's outcome was read; whether a stuck agent left anything in Forge.

## Approved direction (group I)

These owner decisions guide the P7 spec; the steps and findings above describe the implementation observed.

- **I38:** `ask` (with choices) and `hand back` become agent actions beside start, save and land.
- **I39:** Use one message system: one thread per Lane or Item, with choices on a message. Board notes and session messages merge into it.
- **I40:** When the agent has stopped, the answer waits on the Lane and Forge offers a ready resume prompt. Forge never starts an agent by itself.

## Questions for the owner

1. Is "next Item for me" a read Forge answers (order, unclaimed, not blocked), or does the lead always assign?
2. Should actions accept the eight-character ids Forge prints, when unique?
3. Does evidence attach to a done-when line by an explicit action (tick with a receipt or a note)?
4. Should `--help` on an action print the one-line form and examples first, with the schema behind a flag?
5. **Answered in group I:** `ask` (with choices) and `hand back` become agent actions beside start, save and land. The scorecard should cover both actions.
6. Is journey 6 scored at all before cross-repository coordination exists?
