# Journey 32: maintaining a busy open-source project

A maintainer with more incoming work than time: triage of outside and agent-made changes, bug reports, spam, stale work, and helping newcomers find a first task. Issue a0cf8c22: "maintain a busy OSS project (triage outside and agent-made changes, block spam, good first issues)". [Journey 16](16-outside-contributor.md) maps the outsider's side.

Walked: `help lanes`, `help board`, `help queue` as read in part 1, the `lanes` read, the governance, GitHub App and CI status docs, the contributions and planning sources, the planning design pack and the open Issues b0ab4cd3, b6588425, df06081d, 517523cf and d1303286. **Not walked:** a public project with outside traffic; Forge's own project has one account.

## Steps today

| # | Task | What a maintainer has today | Evidence |
| --- | --- | --- | --- |
| 1 | See incoming outside changes | Settings → Contributions: "No outside contributors or proposals yet." The proposal list belongs to the archive route of the removed mode (journey 16, J16-2). Pull requests on a two-way mirror appear on GitHub and, for forks, as "Check run for pull request #N waits for you" in Needs you. | source, docs |
| 2 | Decide whether an outsider's change may use CI | Fork pull requests "run only after a project owner approves"; a decision is kept 30 days. "PRs from branches of the bound repository (people with write access) run at once." | docs |
| 3 | Tell agent-made work from human work | Receipts carry the acting handle and a generated run name. A device sign-in is always an agent. No filter by "made by an agent" on the web or in `landings`. Open Issue df06081d: "Every receipt and landing records human or agent … the web and CLI can filter by them." | ran, docs |
| 4 | Triage bug reports | No public reports exist (journey 16, J16-3). Members file Items; the stored kinds are Initiative and Issue. Types as labels (feature, bug, friction, decision, idea) are in the unshipped planning design. Friction records have `friction-list` and `x friction-triage`. | ran, docs |
| 5 | Mark duplicates, close, defer | `put-planning-item` with `status` and `reason`. The owner's vocabulary: Abandoned with a reason (won't do, duplicate, superseded). A merge action is in the unshipped design (`plan merge`). | ran: help, docs |
| 6 | Good first issues | Nothing. No label, no public list, no way for a newcomer to claim one. | source |
| 7 | Stale work | `lanes '{"view":"dormant"}'` lists Lanes idle past `dormantAfterDays` (default 2). `x abandon-dormant` dry-runs; with `apply:true` it "abandons at most 25 abandonable dormant Lanes per call". Nothing is deleted. | ran: help |
| 8 | Order the queue | `x prioritize '{"submissionId":"…","priority":…}'`; `agentDefaults.urgentRoles:["owner"]`. | ran |
| 9 | Block spam and abuse | Board notes are limited to 240 characters and refuse "secrets, emails, local paths, control characters"; `BOARD_FULL` at the board's maximum. Planned and not built: at most five open proposals per outside account, an owner switch to turn proposals off, abuse reports, account suspension within 15 minutes of a report, a board visible to the team only (Issues b0ab4cd3, b6588425). | ran: help, docs |
| 10 | Share the load | One owner per project. Roles are owner and contributor today (owner, write and read by decision). No triage role, no path owners (open Issue 517523cf), no teams on a project ([journey 36](36-organizations-teams.md)). | docs |
| 11 | Protect the important files | Protected paths hold contributors on a public project ([journey 28](28-protected-paths.md)). | docs |
| 12 | Thank and credit | Mirror commits carry `Co-authored-by` trailers for agent contributors; public readers "see no person field at all" on Forge. | docs |

## Findings

| Id | Severity | Finding | Evidence |
| --- | --- | --- | --- |
| J32-1 | S1 | **There is no intake to maintain.** Outside changes arrive only through GitHub pull requests on a two-way mirror, and outside bug reports not at all. A maintainer of a busy project today triages on GitHub and lands on Forge, with Forge seeing one status check. | docs, source |
| J32-2 | S1 | **Nothing defends a public project against a flood.** With agents, a stranger can produce a hundred plausible changes in an hour. The planned limits (five open proposals per account, a switch, suspension) are decisions without code. The only control today is that outsiders cannot write at all. | docs |
| J32-3 | S2 | **Agent-made work cannot be filtered.** Every terminal sign-in is an agent, including the maintainer's own, so "agent" does not separate a trusted teammate's agent from an unknown one. The useful distinction for triage (whose agent, with what record on this project) is the trust history, which is off by default and not shown. | ran, docs |
| J32-4 | S2 | **One owner decides everything.** Protected paths, fork runs, settings changes and supervised landings all wait for the single owner person in a browser. A project with three maintainers has one who can approve. | docs |
| J32-5 | S2 | **Triage vocabulary is thin.** No labels, no priority, no assignee, no "needs information", no templates. Status is the only field, and it follows Lanes. A report that is not yet work has no good state. | ran, docs |
| J32-6 | S2 | **Newcomers have no door.** No list of starter tasks, no way to say "I will take this" from outside, no contribution guide surfaced in the product (CONTRIBUTING.md is a file in the source). | source, docs |
| J32-7 | S2 | **Stale Lanes can be swept; stale outside work has no equivalent.** `x abandon-dormant` is a good tool with a dry run. It is an operator action in the `x` namespace, capped at 25 per call, and has no web control. | ran: help |
| J32-8 | S3 | **Credit is uneven.** On the mirror an agent's contribution becomes a `Co-authored-by` line; on Forge a public reader sees no names. A maintainer cannot point at "thank you, HANDLE" on the project itself. | docs |
| J32-9 | S3 | **The maintainer's view of cost is missing.** An outsider's change consumes the project's CI minutes once approved. Nothing shows minutes spent on outside changes ([journey 9](09-cost-usage.md)). | docs |

## Dead ends

- A public bug tracker.
- A second person who can approve.
- Blocking one account from a project.
- "Good first issue".

## Naming and tone

- "Maintainer" appears in the web source ("A project owner or maintainer accepts") and is not a role. The owner's decision is owner / write / read with no Maintainer; the word will still be how open-source people describe themselves.
- Proposal, contribution and pull request name the same incoming change (journey 16, J16-11).

## What each persona needs

- **Agent, not person:** when it is the outsider's agent, the project's contribution rules and limits in its first reply; when it is the maintainer's agent, a queue of incoming changes it may pre-review, with findings recorded where the maintainer reads them.
- **Person, not agent:** one triage inbox for outside changes and reports, sorted by trust and by check result; bulk actions; a pause switch; shared approval with co-maintainers; a starter-task list that newcomers can see.

## Questions for the owner

1. May more than one person approve on a project in the beta (several owners, or approval delegated per path)?
2. Is triage built on Items with labels and an assignee, and are some Items public and writable by outsiders?
3. What does a maintainer see about an incoming change's author: account age, earlier landings here, whether an agent made it?
4. Are the flood controls (five open proposals, a pause switch, block an account) required before any public project opens to proposals?
5. May a maintainer's agent pre-review outside changes and write a recommendation the maintainer sees first?
6. Is there a public starter-task list, and can an outsider claim a task?
