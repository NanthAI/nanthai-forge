# Journey 40: a person changes code themselves

A person makes a change with their own editor, with no agent: a one-line fix, a config tweak, a rename. This journey is not on the list of Issue a0cf8c22. It comes from PRODUCT.md ("Each person or agent works in an isolated Lane"), the real-user scenario matrix ("humans and agents mixed in one repo", Issue 431c0c9e) and the agent-first CLI decision in [journey 2](02-first-task.md).

Walked: `nforge --help`, `nforge status .`, `nforge settings`, the `start`, `save` and `status` replies of this mapping's own Lane (made by hand in a terminal), `help lanes`, the agents doc (session kinds), the governance doc and the Phase 5 plan's freeze list. **Not walked:** `land` (this task saves only) and an edit in the clone root.

## Steps today

| # | Step | What the person does | What they see | Evidence |
| --- | --- | --- | --- | --- |
| 1 | Edit in the browser | The browser does not edit source or resolve conflicts. For conflicts it directs the person to an agent (Item a0cf8c22). | The Code view is read-only. | docs |
| 2 | Edit in the clone | Opens the project folder and edits. | `nforge pull` "refuses tracked edits and names a Lane as the next step" (journey 10). The clone is for reading. | docs |
| 3 | Start a Lane | `nforge agent ROOT start '{"outcome":"…"}'` or `'{"planningItemId":"…"}'`. | The `started` line prints the full Lane id and folder path. A new default folder under `ROOT.forge-client/lanes/` uses the Issue title or outcome as a slug, followed by the first eight characters of the Lane id, for example `fix-tax-rounding-1a2b3c4d`. | source, fixture |
| 4 | Open it in an editor | Changes folder by hand to the printed path. `start` has an `open` parameter; hooks are installed for Claude Code and Codex, not for editors. | Nothing confirms which folder is "the Lane" inside the editor. | ran: help, docs |
| 5 | Save | `nforge agent . save '{"message":"…"}'` from the Lane folder. | `{"status":"settling", … "note":"Saved: the server is finishing this save now. Your next command here reports its outcome, including any failure."}` and timing in milliseconds. | ran |
| 6 | Land | `nforge agent . land --save '{"message":"…"}'`; waits for the check. | Lines such as "CHECK PASSED; queued to land, not landed yet", then `LANDED` ([journey 2](02-first-task.md)). | docs |
| 7 | Who they are to Forge | "Any device sign-in (nforge login) is an agent, the owner's included." A session can announce `kind: person`. | The owner's own hand-made change to a protected path is held for the owner's approval in the browser ([journey 28](28-protected-paths.md), J28-4). Receipts name the handle and a generated run name. | docs, ran |
| 8 | Check where things are | `nforge status ROOT`. | "Forge clone: current with main." in the clone. In a Lane, `nforge agent . status` returns JSON. | ran |
| 9 | Review their own change | The web Lane page shows the diff and the check. | As for an agent's Lane. | source |
| 10 | With Git | `git clone` is read-only; "`git push` is refused with a message that changes go through Lanes". On a two-way project a person can push to the GitHub mirror and it comes back as a landing ([journey 12](12-import-migrate.md)). | | docs |

## Findings

| Id | Severity | Finding | Evidence |
| --- | --- | --- | --- |
| J40-1 | S2 | **A person's small change takes the agent's road.** Three JSON commands under `nforge agent` and replies made of JSON, hashes and epoch times (pattern 5 of the index). For a one-line fix the overhead is larger than the change. People will ask an agent to do it, or push to the GitHub mirror. | ran |
| J40-2 | S2 | **Forge treats the person at a terminal as an agent.** This is deliberate and safe. Its effects surprise: the owner's own change waits for the owner's approval, the run name in the receipt is a generated animal, and Who's working shows the person as an agent session unless their tool announces otherwise. | docs, ran |
| J40-3 | S2 | **The natural first move is refused.** Editing in the clone, where the project was checked out, is not how work is done; the person learns this at `pull`. The refusal is helpful. Nothing in the clone folder says "read-only; start a Lane to change something" before the edit. | docs |
| J40-4 | S2 | **Existing Lane folders still have their original names.** New default folders use the title and short id. Reopening a local checkout uses its recorded path, and a start retry uses the path pinned to that operation. | source, fixture |
| J40-5 | S2 | **Small source edits use the same workflow.** To fix a typo, hand it to an agent or edit in an IDE in a Lane. A README is source too. | docs |
| J40-6 | S3 | **Editors are not a target.** Hooks cover two agent harnesses. An editor extension that shows the Lane, the save state and overlaps does not exist, and no Issue was found for one. | docs |
| J40-7 | S3 | **The message at save and at land are both called "message".** One describes a step, the other becomes the mirror's commit message (16 KiB). A person used to commit messages expects one. | ran: help |

## Dead ends

- Fixing a typo from the browser.
- Pushing with Git to Forge.

## Naming and tone

- `nforge agent …` for a person. The namespace name tells people the command is not for them.
- "Forge clone: current with main." shows the CLI can speak to a person in one line.

## What each persona needs

- **Agent, not person:** nothing here.
- **Person, not agent:** a clear Lane path to open in the editor, with plain status and next steps in the CLI.

## Decisions

- Agents do the work by design. People who change source edit in their own IDE in a Lane. No editing source or resolving conflicts in the browser (Item a0cf8c22).
- The CLI is mainly for agents; people can use the same verbs. Reads may lead with one human line; JSON remains the contract (Item 235878aa). Plain `land` saves first (Item 6b7d5a79).
- Approval is browser-only at beta, including on a person's own protected change (Item 0a99ab23).

The folder naming decision is recorded on Item 23726545.
