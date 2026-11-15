# Journey 25: handing an Item to an agent

A person takes a planned Item and gives it to a coding agent. Issue a0cf8c22 puts this in the core loop: "hand a backlog item to an agent (first version: a prepared prompt to copy)". [Journey 2](02-first-task.md) starts where this one ends, with the agent's first command; [journey 8](08-planning.md) covers the Item itself.

Walked: the delegate sheet, copy-prompt, briefing model and message composer sources, the agents doc, the briefings doc headings and the `start` reply of this mapping's own Lane. **Not walked:** a rendered sheet, a copied prompt and a prompt pasted into an agent.

## Steps today

| # | Step | What the person sees | Evidence |
| --- | --- | --- | --- |
| 1 | Find the action | **Hand to an agent** on a planning row, on a Lane, on a Candidate review, on a Needs you item and in Now's first-run guide ("Copy the prompt into Claude Code, Codex or any agent. It works in the Lane."). Shortcut ⌘⇧C. On a new Item: "Create & hand to an agent". | source |
| 2 | The sheet | "Hand this to an agent". A list titled "What the agent will know": "The outcome"; for a conflict "The conflicting file, both versions"; for a failed check "What failed"; "What this Lane changed"; "What changed on main since it started"; "Who else touches these files"; "The handoff note" or "The message"; "This repo's rules first"; "Your guidance"; and one row marked off: "Not: source outside the Lane, secrets, other projects". A fold "How the briefing is built". | source |
| 3 | Copy | **Copy prompt** → "Copied." If the browser refuses: "Copy was blocked by the browser. Open the prompt below and copy it by hand." If a linked message fails: "Copied, but the inbox message failed: …". | source |
| 4 | Paste | The person switches to their agent's window and pastes. Forge takes no part. | source |
| 5 | Or send to a running session | Who's working → **Message** or **Hand off** on a session. For a session Forge cannot reach: "Copy message copies the draft and then names the session to paste it into" ("Paste it into NAME's session."). Otherwise "Sent to NAME". | source, docs |
| 6 | The agent starts | It reads the prompt, runs `start '{"planningItemId":"…"}'` and gets a Lane ([journey 2](02-first-task.md)). The Item moves to in-progress when the Lane starts. | ran |
| 7 | See that it was picked up | The Item shows a Lane; Now shows the Lane under What's changing and a session under Who's working. Nothing says "the prompt you copied was used". | source |

The agent's own route needs no person: `planning '{"status":"open"}'`, then `start '{"planningItemId":"…"}'`.

## Findings

| Id | Severity | Finding | Evidence |
| --- | --- | --- | --- |
| J25-1 | S2 | **Handing over is copy and paste, and Forge cannot tell whether it happened.** Between "Copied." and the agent's first command there is no state. An Item handed over and never pasted looks exactly like an Item nobody touched. A person who hands five Items to five agents has no list of "handed over, not started". | source |
| J25-2 | S2 | **The sheet does not say which agent, or where.** The prompt works for any agent, which is the strength. But the person must already have an agent open in the right folder, signed in, with the CLI installed. The sheet has no line for "no agent connected yet" that leads to setup ([journey 14](14-setting-up-agents.md)). | source |
| J25-3 | S2 | **Two ways to reach an agent, with different guarantees.** The prompt (nothing delivered) and a session message (delivered when the agent next reads, acknowledged only if it chooses). The words **Hand to an agent** and **Hand off** are one letter apart and mean different things: the first starts work, the second transfers work in progress. | source, docs |
| J25-4 | S2 | **The person cannot see or edit the prompt before copying, except through a fold.** "What the agent will know" lists sources, which builds trust. The text itself sits under "How the briefing is built" or appears only when copy is blocked. A person who wants to add one sentence has to paste and edit elsewhere. | source |
| J25-5 | S2 | **An Item with no done-when lines hands over an outcome only.** The briefing takes "The outcome". Whether the Item says how to tell it is done depends on what was typed; the sheet does not warn that the Item is thin. | source |
| J25-6 | S3 | **"Your guidance" and "This repo's rules first" appear as rows, with no way to open them from the sheet.** The person cannot check what their own standing guidance says at the moment it is used. | source |
| J25-7 | S3 | **The same Item can be handed to two agents.** Nothing stops a second copy. The second agent learns of the first from the presence notice on `start` ("Another agent on your account … is working on this Issue"), which is advisory. | ran |
| J25-8 | S3 | **"Prompts are not available here."** appears with no reason or next step. | source |

## Dead ends

- Handing an Item to an agent from a phone: the prompt has nowhere to go.
- Assigning an Item to a named agent that is not running.

## Naming and tone

- "Hand to", "hand off", "handoff", "delegate" (source names), "briefing", "prompt". PRODUCT.md fixes **hand to**.
- The row "Not: source outside the Lane, secrets, other projects" is a good idea: it says what the agent will not get.

## What each persona needs

- **Agent, not person:** a prompt short enough to keep, with the Item id, the one command to start and the done-when lines; everything else fetched when needed.
- **Person, not agent:** to hand over in one action and then see "waiting to be picked up", "picked up by NAME", "stuck"; to hand over to an agent that is already connected without leaving the page.

## Approved direction (group I)

These owner decisions guide the P7 spec; the steps and findings above describe the implementation observed.

- **I40:** When the agent has stopped, the answer waits on the Lane and Forge offers a ready resume prompt. Forge never starts an agent by itself.

## Questions for the owner

1. **Answered in group I:** When the agent has stopped, the answer waits on the Lane and Forge offers a ready resume prompt. Forge never starts an agent by itself.
2. Should an Item show "handed over, not started" for a time after the prompt is copied?
3. May a person assign an Item to a person or a named agent before any Lane exists?
4. Should the sheet show the prompt text and allow one added note that is kept on the Item?
5. Are **Hand to an agent** (start work) and **Hand off** (transfer work in progress) two names to keep, or one action with two cases?
