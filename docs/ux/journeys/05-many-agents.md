# Journey 5: several agents at once

The queue, overlap notices, waiting and status when many agents work on one project.

Walked: `queue`, `lanes`, `board`, `peers` help, `help overlap`, `help queue`, `help board`, `nforge queue list`, `policy`, the first-write hook as it fired while this map was written, and the Now, Sessions and queue-model sources. **Not walked:** a live queue (it was empty) and a live overlap.

## Steps today

| # | Moment | Agent sees | Person sees |
| --- | --- | --- | --- |
| 1 | Before the first write | An advisory hook in Claude Code and Codex. It never denies an edit. While this map was written it added the line "1+ more: board '{}'" to the first three file writes. (ran) | n/a |
| 2 | Who else is working | `lanes '{"limit":5}'`: actor, 64-character head, Intent title and id, latest landing, Lane id, last save time, state. (ran) | Now: three columns, Needs you · What's changing · Who's working. Sessions show "not seen since …"; agents carry an `agent` tag and "started by NAME". (source) |
| 3 | Overlap at save | `conflictNotice`; `peers '{"laneId":"…","path":"…"}'` lists open Lanes that saved the same files. "Coverage excludes unsaved peer edits and never proves independence." Receipts carry `behindMain`. (ran: help) | "Where work overlaps", with "claimed by both, not yet edited. Both said they'd change it. Usually fine." and "changed on main since this Lane started". (source) |
| 4 | Shared decision or hand-back | Use `ask` for a fixed-choice question and `hand-back` for a saved Lane that needs a person’s decision. `board {"all":true}` reads retained notes and system notices. |
| 5 | Waiting for a peer | `wait '{"peer":"LANE_ID"}'` blocks until that Lane lands, fails, is cancelled or closes, or a note arrives. (ran: help) | n/a |
| 6 | Building on a peer | With `stacking: offer`, the reply prints the exact `sync {stackOn}` command. (docs) | Lane: "Waiting for parent Lane «NAME» to land. Lands right after its parent; no action needed." |
| 7 | The queue | `queue '{}'`: entries in dispatch order with Lane, Intent title, phase, suspect, last failing test files and recompose count; `yourLane` gives the position; held entries follow with position null and `hold {kind,reason,paths,next}`. Empty: `{"total":0,"listed":0,"more":false,"train":0,"entries":[]}`. (ran) | Lane: "In the landing queue. Waits for its turn on main. Nothing to do; it lands or stops by itself." |
| 8 | Waiting in the queue | `CHECK PASSED; not landed yet: waiting for older submission ID to take main first`, or "…reserved files this change touches; it lands first or its reservation ends". (source) | The channel strip: main, last acceptance, check state. |
| 9 | Local machine limits | `nforge heavy CMD` runs a heavy command under the machine-wide slot limit (`localHeavySlots`, auto). (ran) | n/a |

## Findings

| Id | Severity | Finding | Evidence |
| --- | --- | --- | --- |
| J5-1 | S2 | **The board hint leads to an empty read, and repeats.** The hook and the start receipt say "1+ more: board '{}'". Running `board '{}'` returned `"notices":[]` with `"more":1`. Only `board '{"all":true}'` showed the notes. The hook attached the same hint to each of the first three file writes in the Lane. | ran |
| J5-2 | S2 | **Board notes are cut mid-word in the list.** Each note shows about 90 of its 240 characters and needs a second call (`board {"id":"…"}`) to read. Reading seven listed notes in full takes eight calls. | ran |
| J5-3 | S2 | **Two commands are called queue.** `nforge queue list` printed `[]`: it lists local operations from the removed native mode. The hosted landing queue is `nforge agent ROOT queue`. The top-level help lists the first with no hint that it is not the queue an agent is waiting in. Cancelling is `nforge queue cancel` there, and `x cancel` or `land --withdraw` here. | ran |
| J5-4 | S2 | **Seven kinds of waiting, each worded differently.** A queue turn, an older submission, a file reservation, a review hold, a stack parent, a check machine and a measurement hold. The CLI's "(waiting for acceptance)" is the queue turn, not a person. No single field says "you are waiting for X; nothing to do" or "you are waiting for X; do Y". | source |
| J5-5 | S2 | **Agents learn of peer events only on their next command.** A note, a peer's landing or a conflict notice reaches an agent that is mid-edit when it next calls Forge. Open Issues 11ba7bb9 (push events into sessions) and f65d8024 (event feed) cover this. | docs |
| J5-6 | S2 | **Retired overlap settings still appear.** The policy read returns `overlapGate:"off"`; the defaults doc has a section "Overlap notices (retired)" while `help overlap` describes live conflict notices. An agent reading both cannot tell which overlap mechanism exists. | ran, docs |
| J5-7 | S2 | **Web copy for a state that no longer exists.** The queue model still holds "owner not seen since …" and "Queued work is kept and lands when the owner is back. This is not a failure." The hosted queue lands without an owner machine. Whether a hosted project can still reach these lines was not verified. | source |
| J5-8 | S3 | **`"train":0`** in the queue reply is unexplained ("train" is not in the help topic). | ran |
| J5-9 | S3 | **Agent run names have no home.** `as:"HANDLE/fiery-ibis"`, `agentRun:"green-koala"` and board senders use generated names. Nothing found says which terminal or session a name belongs to, so a person reading a board note cannot find its author. | ran |
| J5-10 | S3 | **Overlap has five names.** Overlap (web, help), conflict notice (receipts), claim (web: "claimed by both"), "touching PATH" (board), peers (the read). | ran, source |

## Dead ends

- `board '{}'` after the hint (J5-1).
- `nforge queue list` for an agent looking for the landing queue (J5-3).

## Naming and tone

- The web's waiting copy is the best in the product: it says what is happening, that it is not a failure, and that nothing needs doing. The CLI has no equivalent sentence.
- "predecessor", "older submission", "parent Lane" and "the change ahead" all describe something that must land first.

## What each persona needs

- **Agent, not person:** to be interrupted when something changes; one waiting field with the reason and the action; whole notes in one read.
- **Person, not agent:** who is working and what needs a decision. Lane rows show the recorded reason work is waiting; there is no separate “stuck” status.

## Approved direction (group I)

These owner decisions guide the P7 spec; the steps and findings above describe the implementation observed.

- **I44:** Owner and write roles may order two overlapping Lanes from Now. Record the order and show it with Undo.

## Decision

- Show the public run name on Lanes and receipts, with the reported app and model. The name links to the run; missing declarations stay explicit (Items 41514fee and 6a251b23).

## Questions for the owner

- Should an agent's reply carry whole board notes (they are at most 240 characters) instead of a hint and a truncated list?
- Is `nforge queue` to be removed, or pointed at the hosted queue?
