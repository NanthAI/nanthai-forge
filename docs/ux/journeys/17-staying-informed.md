# Journey 17: staying informed

How a person and an agent learn what happened and what needs them: Now, the away summary, Needs you, activity, alerts, notifications and digests, and the agent's view of the same events. PRODUCT.md sets the three questions: who is working, what is changing, what needs me.

Walked: the Now, Needs you, away strip, activity and sessions sources, `policy`, `capabilities`, `board`, `help wait`, the `start` and `status` replies of this mapping's Lane, the workflows doc (Now), the parallel-work defaults and the open Issues e88f503d, 11ba7bb9, f65d8024, 8c53a7f5 and 9e748e41. **Not walked:** a rendered Now page, an alert delivery and an approval request.

## Steps today

### A person

| # | Question | Where | What they see |
| --- | --- | --- | --- |
| 1 | What needs me? | Now → **Needs you**. "Needs you holds decisions, direct messages, questions and handoffs addressed to the viewer." Kinds: "Ready to accept", "Approval request", "Handoff to you", "Check failed", "Reverted from main", "Fix needed". | "Reading what needs you…", then rows, or "Nothing needs you." **Not now** hides one item for the browser session. A badge in the shell counts them. Home: "N need you across your projects"; that number "covers conflicts and can be lower than the panel's, never higher". (source, docs) |
| 2 | What changed while I was away? | Now → away strip: "While you were away (9 h)", "at most three facts, then dismiss". Shown after two hours away. The last visit is "stored only in this browser". Policy `notify:{"awaySummary":true}`. | Three facts and a link to what landed. (source, ran) |
| 3 | What is changing now? | Now → **What's changing**: Lanes in motion with the journey rail (edited, saved, checked, accepted), overlap rows "with nothing to answer", "Accepted today". | Above 20 rows, groups by Initiative. (docs) |
| 4 | Who is working? | Now → **Who's working**: sessions by agent session name, "otherwise its recorded name or Agent". "No one yet." Sessions are "working through 15 minutes, quiet through 90, then folded". | **Message** and **Hand off** per session. (source, docs) |
| 5 | What happened earlier? | Now › Activity: "saves, checks and acceptances". Ledger: "What landed on main", "Who accepted", "Full history". | (source) |
| 6 | Tell me when I am not looking | Stall alerts only: `agentDefaults.stallAlerts` = `{"enabled":true,"notifyAfterMinutes":15,"repeatAfterMinutes":30,"email":[],"webhook":"ntfy"}`. A landing with no progress for 15 minutes sends one alert to a push topic the owner configured. Email is an empty list; email delivery is open Issue 8c53a7f5. | Nothing for an approval request, a failed check, a question from an agent or a finished landing. (ran, docs) |
| 7 | A digest | Not built. | |
| 8 | Notification settings | No page. `notify.awaySummary` and `stallAlerts` are policy fields, set through `set-policy`. | The status doc: "notification delivery [is] designed separately". (ran, docs) |

### An agent

| # | Event | How it reaches the agent |
| --- | --- | --- |
| 1 | Another agent is on the same Item or files | On `start`: `presence.notices` ("Another agent on your account (HANDLE/fiery-ibis) is working on this Issue: Lane bac2799a … active 2m ago; files: … +21."). On a file write: a hook line. On `save`: `conflictNotice` when a trial merge conflicts. (ran) |
| 2 | Main moved under its Lane | `behindMain` on start, save and status replies ("shows ten paths; coverage and more report omissions"). (docs) |
| 3 | A note for it | `board.notices` on the next reply; the hook line "1+ more: board '{}'" on every file write; "A note to your Lane ends wait early (reason message, exit 3)". (ran) |
| 4 | Its landing finished | `wait` returns; or one background `wake.command` that exits when the landing settles. (docs) |
| 5 | Its check failed, was cancelled or stalled | The `wait` result. `LANDING_STALLED` after 15 minutes. (ran: help) |
| 6 | A person asked for changes or answered | The Lane conversation, read on its next command. Nothing reaches an agent that is thinking or has stopped. Open Issues 11ba7bb9 (push into running sessions) and f65d8024 (an event feed for orchestrators). (docs) |
| 7 | Old failures on the project | `needsFix` on `status` and `capabilities`: three "Fix needed" notices dated four days earlier, each with a receipt id, a 64-character head and an `undo` command. (ran) |

## Findings

| Id | Severity | Finding | Evidence |
| --- | --- | --- | --- |
| J17-1 | S1 | **Forge tells a person nothing unless they open it.** An approval request, a question from an agent, a failed landing and a finished landing all wait in Needs you. The one outbound signal is a stall alert to a push topic that someone configured by hand. An agent that needs its owner has to say so in its own chat (journey 7, J7-5). Open Issue e88f503d covers quiet notifications; it is the centre of this journey, not an extra. | ran, docs |
| J17-2 | S2 | **Whether a stall alert reaches anyone depends on setup nobody is asked to do.** On the Forge project the policy reads `"email":[]` and a webhook preset whose topic the operator configured by hand. The setting says `enabled:true` either way. No page shows where alerts go or offers a test alert, and what a new project's owner receives by default was not established in this pass. | ran |
| J17-3 | S2 | **"Away" is per browser.** The last visit and **Not now** live in local storage. A person who reads Now on a laptop sees the same away summary again on a phone, and a dismissed item returns in another tab. Read state is not shared with the CLI either. | source |
| J17-4 | S2 | **Three counts of "needs you" can differ.** The panel, the shell badge and Home's "N need you across your projects". The docs say Home "can be lower than the panel's, never higher". A person who sees 0 on Home may have work waiting. | docs |
| J17-5 | S2 | **There is no cross-project inbox.** Needs you is per project. A person with five projects opens five pages; Home shows a number, not the items (see [journey 22](22-many-projects.md)). | docs |
| J17-6 | S2 | **An agent hears news only when it speaks.** Every event rides on the reply to the agent's next command. This is by design (idle costs nothing) and it means a waiting or thinking agent learns late. Open Issue 11ba7bb9 states the goal: agents hear of overlap, a landing result and main moving "while they work, not only at their next Forge call". | docs |
| J17-7 | S2 | **The agent's replies carry stale project news.** Three "Fix needed" notices from four days earlier lead `status` and `capabilities` for every agent in the project, whatever its task (journey 4, J4-10). They cost tokens on each read and teach agents to skip the field. | ran |
| J17-8 | S2 | **The board hint repeats on every file write** ("1+ more: board '{}'") and the read it names showed project notes unrelated to the Lane (journey 5, J5-1; open Issue 70b38346). | ran |
| J17-9 | S2 | **A person cannot choose what to hear.** No notification settings page, no per-project mute, no "only what waits on me". The two existing switches are policy fields behind `set-policy`, which an agent sign-in cannot change without the owner's approval on the web. | ran, docs |
| J17-10 | S3 | **"Briefing" means the agent's prompt, not a summary for a person.** PRODUCT.md and the status doc use briefing for "copy prompts and full briefings for nine situations". A person asking for "a briefing on this project" finds none. | docs |
| J17-11 | S3 | **Session names help little.** "Agent", a harness name or a generated run name. Who's working cannot say which task a quiet session belongs to once its Lane is closed. | source |
| J17-12 | S3 | **Activity and the ledger are complete and unfiltered.** No filter by person, agent, path or Item was found; "ownership areas, labels, maintainer queues and batch actions are not available". | docs |

## Dead ends

- "Email me when something needs me": no setting.
- Reading Needs you from the terminal: no command returns the person's inbox (`status` is per Lane or per project).
- A weekly summary.

## Naming and tone

- Needs you, Now, away, activity, ledger, feed, board, notices, alerts, inbox and notifications are eleven words for overlapping lists.
- The empty states are honest: "Can't read what needs you." differs from "Nothing needs you.", and "only a complete read says Nothing needs you". That distinction is worth keeping.

## What each persona needs

- **Agent, not person:** events about its own Lane delivered when they happen, in one line with one next command; nothing about other people's old failures; a note only once.
- **Person, not agent:** to be told, on the channel they choose, when something waits on them and only then; one inbox across projects; a summary on return that is the same on every device; a way to say "not now" that sticks.

## Approved direction (group I)

These owner decisions guide the P7 spec; the steps and findings above describe the implementation observed.

- **I37:** At beta, batched email reaches a person for approvals, agent questions and handoffs; phone push comes later.
- **I41:** Needs you holds approvals, questions, handoffs and reviews; failures appear only when no agent is on them. Order the longest-blocked agent first.
- **I42:** Read state is kept per account so web, phone and CLI agree.
- **I43:** Home holds one inbox across projects, filterable by project.

## Questions for the owner

- Should the project-wide “Fix needed” notices leave every agent's replies and go only to the Lane that caused them and to the owner?
- Is a digest wanted (daily or weekly, per project or per account), or does the away summary replace it?
- May a person read and answer Needs you from the terminal?
