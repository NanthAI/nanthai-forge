# Journey 26: answering or unblocking an agent

An agent needs something from a person: an answer, a go, a decision between two agents that touch the same files, or it is stuck and hands the work back. Issue a0cf8c22 lists "answer or unblock an agent, including an overlap between two agents" in the core loop and "hands back to a person when stuck" on the agent scorecard.

Walked: the Needs you, answers, reply box, overlaps, conversation and message composer sources, `help overlap`, `help board`, `help wait`, the `handoff` action's refusal, the agent workflow doc (coordination, approval requests) and the open Issues 11ba7bb9 and e88f503d. **Not walked:** a question from an agent, an answer, a handoff and an overlap between two live Lanes.

## Steps today

### The agent's side

| # | Need | Route | What comes back |
| --- | --- | --- | --- |
| 1 | A go before landing | `request-approval '{"laneId":"…","reason":"…"}'` "records one request on a saved Lane and posts one project board note; the reply carries the owner's link". `wait '{"approval":"LANE_ID"}'` blocks until the decision. | Granted, or `REVIEW_DECLINED` with the reason. (docs; [journey 7](07-people-access.md)) |
| 2 | An answer to a question | No agent action asks a person a question. The board takes a note of at most 240 characters to a Lane, an Item or the project. A second channel, `nforge coordination DEPLOYMENT PROJECT_ID JSON` (or the `mcp-coordination` server), has `message` with two or three choices ("answers must match a label and cannot be replaced, while free text remains available"), `unacked` and `ack`. | A note that "ends wait early (reason message, exit 3)". (ran: help, docs) |
| 3 | Hand the work back | `handoff` → `HOSTED_ACTION_UNSUPPORTED`: "handoff was removed with native mode. Use board --post {to,text} leaves a note for the next agent." The coordination channel still has `{"action":"handoff","to":"…","summary":"…","head":"HEAD"}`. `x abandon` with a reason closes the Lane and keeps everything. | (ran, docs) |
| 4 | Two agents on the same file | "A real conflict shows as conflictNotice on save, status and land, on both Lanes: file, lines and the other Lane's goal. Nothing needs an answer: sync or coordinate, save again". `peers` lists who saved the same files. `wait '{"peer":"LANE_ID"}'` waits for the other Lane to land. | (ran: help) |
| 5 | Stuck with no route | It tells its person in its own chat. Forge records nothing. | |

### The person's side

| # | Item in Needs you | What the person can do there | Evidence |
| --- | --- | --- | --- |
| 1 | "Approval request": "Approval for Lane 1a2b3c4d waits for you" | **Review request** opens the approval page. | source |
| 2 | A question with choices | Two or three buttons, or a reply box. "Could not send this reply." on failure. | source, docs |
| 3 | "Handoff to you" | "Taking this handoff.", **Hand to OWNER** or **Hand to an agent**. | source |
| 4 | An overlap between two Lanes | Now lists overlaps "as plain rows with nothing to answer (overlap answers were removed, Issue 853fcde3)", with **Compare** and "About overlap in PATH": "Both said they'd change it. Usually fine.", "Whichever is accepted second will need to update from main.", and an action "Ask NAME to wait". | source, docs |
| 5 | "Check failed", "Fix needed", "Reverted from main" | **Open failing run**, **Start a fix** ("Opens a sibling Lane from the reverted head with the failing tests, the diff and the undo command in its brief."), **Close** ("Close without a fix? The Intent is marked abandoned; its Lane and saved head stay."). | source |
| 6 | Writing to an agent directly | Lane or Review conversation; Who's working → **Message**. "Sent to NAME", or for a session Forge cannot reach, "Paste it into NAME's session." | source |

## Findings

| Id | Severity | Finding | Evidence |
| --- | --- | --- | --- |
| J26-1 | S1 | **An agent cannot ask its person a question through the commands it is taught.** The three verbs and the reads have no "ask". The choices-and-answers channel exists behind a different command (`nforge coordination` with a deployment address and project id) and a different MCP server, which the skill and the help do not teach. In practice a stuck agent stops and writes in its own chat, where Forge and the rest of the team see nothing. | ran, docs |
| J26-2 | S1 | **"Hand back" was removed and its replacement is a 240-character note.** The refusal for `handoff` says to post a board note. A handoff needs what was tried, what is left and where the work is; the Needs you kind "Handoff to you" still exists on the web, fed by the other channel. The scorecard journey "hands back to a person when stuck" has no agent command. | ran, source |
| J26-3 | S2 | **Two message systems that do not meet.** The board (agent actions, 240 characters, notes to a Lane, an Item or the project) and coordination messages (sessions, choices, acknowledgements, handoffs, claims). The web shows the second in Needs you and conversations; agents are taught the first. A person's answer and an agent's question can sit in different places. | ran, docs, source |
| J26-4 | S2 | **The answer reaches the agent only at its next command** (journey 17, J17-6). A person answers in Needs you and sees nothing change; the agent may have ended its turn. Nothing tells the person "delivered" or "the agent is no longer running; start it again with this prompt". | docs |
| J26-5 | S2 | **A person cannot decide an overlap; they can only watch it.** Overlap answers were removed on purpose (notices were noisy). What is left for a person is "Usually fine." and "Ask NAME to wait", which sends a message with no effect on the queue. When two agents really collide, the decision "this one first" has no control; queue priority exists as an operator action (`x prioritize`). | source, ran |
| J26-6 | S2 | **The agent's request names a Lane by eight hex characters.** "Approval for Lane 1a2b3c4d waits for you". The person needs the Item title and the agent's reason first. | source |
| J26-7 | S2 | **A person is told nothing outside the app** (journey 17, J17-1). The agent holds an approval link and must pass it on by other means. | docs |
| J26-8 | S3 | **"Start a fix" explains itself in one long sentence** that names a sibling Lane, a reverted head, a brief and the full check. It is accurate and written for someone who knows the internals. | source |
| J26-9 | S3 | **Choices are limited to three labels of 120 characters.** Good for a quick decision. A question that needs a file or a number falls back to free text, which the agent must parse. | docs |

## Dead ends

- An agent asking "A or B?" with only the taught commands.
- A person choosing which of two overlapping Lanes lands first.
- A person answering an agent that has stopped.

## Naming and tone

- Question, message, note, notice, request, handoff, reply and answer are eight words across two systems.
- "Nothing needs an answer" is a clear and unusual sentence for a conflict notice. It tells the agent what not to do.

## What each persona needs

- **Agent, not person:** one command to ask with choices, one to hand back with a structured note (tried, left, where), and a wait that ends when the person answers; a clear statement of when to ask and when to decide.
- **Person, not agent:** every question from every agent in one list, answerable in place, with the Item and the reason first; to know whether the agent got the answer; a way to restart a stopped agent with the answer included.

## Approved direction (group I)

These owner decisions guide the P7 spec; the steps and findings above describe the implementation observed.

- **I37:** At beta, batched email reaches a person for approvals, agent questions and handoffs; phone push comes later.
- **I38:** `ask` (with choices) and `hand back` become agent actions beside start, save and land.
- **I39:** Use one message system: one thread per Lane or Item, with choices on a message. Board notes and session messages merge into it.
- **I40:** When the agent has stopped, the answer waits on the Lane and Forge offers a ready resume prompt. Forge never starts an agent by itself.
- **I41:** Needs you holds approvals, questions, handoffs and reviews; failures appear only when no agent is on them. Order the longest-blocked agent first.
- **I44:** Owner and write roles may order two overlapping Lanes from Now. Record the order and show it with Undo.

## Questions for the owner

1. **Answered in group I:** `ask` (with choices) and `hand back` become agent actions beside start, save and land.
2. **Answered in group I:** Use one message system: one thread per Lane or Item, with choices on a message. Board notes and session messages merge into it.
3. **Answered in group I:** When the agent has stopped, the answer waits on the Lane and Forge offers a ready resume prompt. Forge never starts an agent by itself.
4. **Answered in group I:** Owner and write roles may order two overlapping Lanes from Now. Record the order and show it with Undo.
5. When should an agent ask and not decide? Is that a project setting (the "You decide ↔ Agents decide" scale) that agents can read?
