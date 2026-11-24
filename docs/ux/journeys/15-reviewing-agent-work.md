# Journey 15: a person reviewing agent work

Reading a Candidate and its diff, commenting, asking for changes and deciding. This is the equivalent of a pull request review. [Journey 7](07-people-access.md) covers who may decide and the approval pages for held landings; this file covers the reading and the conversation.

Walked: the review, Lane, diff and conversation sources, `help review`, the `diff` summary of this mapping's parent Lane, the workflows doc (browser review, reviewing a Candidate, feedback, check output). **Not walked:** a rendered review page, a line comment, **Ask for changes**, **Approve** and **Revert** (each writes).

## Steps today

| # | Step | Person (web) | Agent (CLI or MCP) |
| --- | --- | --- | --- |
| 1 | Learn there is something to review | Needs you: "Ready to accept" on a supervised project, or "Approval request" for a held landing. On a project that lands automatically, nothing asks: the change is already on main. (source; journey 7) | `REVIEW_REQUIRED` on its own landing; `wait '{"approval":"LANE_ID"}'`. |
| 2 | Open the Candidate | Review page. Top: **Your decision**. Then "What this does and why" (the outcome and its notes), then "Changes, in the order they were built": "Each group is a recorded Lane save. The diff shows this Candidate's final changes to that save's files." Groups are titled "Save 1", "Save 2". | `diff '{"laneId":"…","summary":true}'` returns each path with `status` and `main:"equal" or "absent" or "different"`. (ran) |
| 3 | Read the diff | "Changed files" with a filter ("Change type", "All files", "Modified", "Deleted"), a **Files / Map** toggle, and a diff in Unified, Split or Inline mode with "viewed files and cached syntax highlighting". "The file text is unchanged. File mode changes are shown above." | `diff '{"laneId":"…","paths":[…],"byteBudget":N}'` pages hunks with `nextCursor`; `show '{"laneId":"…","path":"FILE"}'` returns exact saved bytes. "show and diff never substitute another revision." (ran: help) |
| 4 | Check the evidence | "Check passed on exactly this Candidate" (or failed), a log reader with stdout and stderr, **First failure** and line links. "No check recorded for this Candidate." "Exact record: Candidate, pins, receipts" is folded. | `status`, `log '{"runId":"…"}'`. |
| 5 | Comment on a line | Item discussion draws structured reviewer findings and keeps their exact record. | `comment-planning-item` stores a versioned finding batch with exact reported saved-head/file evidence; later replies retain outcomes without rewriting the original. [Format](../../guides/review.md#structured-review-findings). |
| 6 | Ask for changes | **Ask for changes** "opens inline, keeps a draft per Candidate during the browser session" ("Draft kept"), then "Send to AGENT". Result: "Review feedback recorded · sent to Lane conversation." The message starts "Changes requested for Candidate:" with a link to it. "It is advisory and adds no acceptance gate." | The Lane conversation shows the message; "Lane and Review conversations show sent messages and explicit acknowledgements; a heartbeat alone is not evidence that a message was seen." How a running agent receives it depends on its next command (open Issues 11ba7bb9, f65d8024). |
| 7 | Decide | **Accept into main** "submits the exact reviewed Candidate to the hosted landing queue as a person". The page then shows Queued, Checking, Landing, Landed "or the retained failure". "People retain their existing ability to accept an unchecked Candidate." **Cancel landing** is separate. | `LANDED`, or `REVIEW_DECLINED` with the reason. |
| 8 | A conflict in the Candidate | "Unresolved composition" and "Open the Lane to resolve conflicts." | [Journey 3](03-conflict.md). |
| 9 | After it landed | The same review page, with the disposition in place of the decision. **Revert…**: "Creates a new Candidate: the reverse of this change on current main", "Checked (verify) and landed through the queue, like any Candidate". | `x revert`. [Journey 10](10-mistakes-recovery.md). |
| 10 | Hand the review to an agent | **Hand to an agent** "opens the review briefing sheet". | Reads the briefing. |

Speed, measured on the dogfood project: the Lane changes view made "13 serialized Convex round trips and whole-State transfer before a tiny diff (3.5 s, 85% waiting on RPCs)" (open Issue 4bc460aa).

## Findings

| Id | Severity | Finding | Evidence |
| --- | --- | --- | --- |
| J15-1 | S1 | **Review after landing starts in FYI.** Open Review from a landed row, then dismiss it when read. These rows are not approval requests. | Item 48049998 |
| J15-2 | S2 | **"Ask for changes" changes nothing a person can see.** It records feedback and sends a message. The Candidate can still be approved, by the same person or another. Nothing shows "changes asked, not yet answered" on the Candidate, in Needs you or on the Lane (journey 7, J7-6). | docs, source |
| J15-3 | S2 | **A person cannot tell whether the agent got the message.** Delivery depends on the agent's next command; acknowledgement is explicit and optional. An agent that has already stopped never answers, and the page shows a sent message with no reply. | docs |
| J15-4 | S2 | **Line comments belong to one Candidate.** A comment is anchored to a Candidate snapshot. When the agent saves again and a new Candidate is composed, the earlier comments stay on the old one. Moving anchors across later saves is deferred until after beta. A reviewer cannot see "my three comments, two addressed". | docs |
| J15-5 | S2 | **The story is organised by save, with titles "Save 1", "Save 2".** Agents save often and for their own reasons (every 30 minutes, before a preflight). The grouping is honest and rarely matches how a person would read the change. Save messages, when present, are not shown as the group title. | source |
| J15-6 | S2 | **An unchecked Candidate can be approved from the same button.** "People retain their existing ability to accept an unchecked Candidate." The button label does not change when no check has run; the only signal was the line "No check recorded for this Candidate." further down. Item e6f1290b added an explanatory line where check evidence is available. The later decision supersedes the copy-only requirement: ask once for confirmation (Item c008cb43). | docs, source; `tests/ui-owner-acceptance.test.mjs`, `tests/landing-decision-browser.test.mjs` |
| J15-7 | S2 | **The diff is slow.** 3.5 seconds for a small change is measured (4bc460aa). A reviewer moving through ten agent changes waits more than they read. | docs |
| J15-8 | S2 | **Agent findings share the Item discussion.** Versioned structured batches carry Lane/base/head and file-blob/line evidence, finding ids, severity, origin and reasoned outcomes. The web draws them as findings; CLI and exports retain the complete JSON. They remain reported, advisory snapshots; cross-save anchoring is deferred until after beta, and the findings add no approval requirement. | [delivered scope](../../guides/review.md#structured-review-findings); persistence/render/browser regression |
| J15-9 | S2 | **Three words for the reviewed thing on one page.** Candidate (titles), View (routes and source names such as `reviewView`), "Accepted versions" (the list). The owner's decision is Candidate. | source |
| J15-10 | S3 | **The decision words are in flux.** The button says **Accept into main**; the owner's decision is that a person approves and the system accepts (tracked on a4c5394c). "A project owner or maintainer accepts" still names a role that does not exist. | source |
| J15-11 | S3 | **Who wrote what is partly unknown.** "Groups come from retained provenance; missing save authors remain unknown." With several agents under one handle, the author shown is the person, and the run name is the only hint. | docs |
| J15-12 | S3 | **A review cannot be split or shared.** There are no requested reviewers, no "reviewed by", no approval count. One owner decides. Open Issue 517523cf covers approvals bound to what lands and path owners. | docs |

## Dead ends

- A comment thread across two Candidates of the same Lane.
- Automatic cross-save anchoring is outside the beta. Using findings as an acceptance gate is a separate, unapproved change.

## Naming and tone

- "Your decision" above everything is the right order.
- "Exact record: Candidate, pins, receipts" keeps hashes out of the way, as PRODUCT.md asks.
- "Unresolved composition" is an internal phrase for "these changes conflict".

## What each persona needs

- **Agent, not person:** review feedback delivered into its session with the file and line; a structured way to answer ("addressed in save N") and to post findings when it is the reviewer.
- **Person, not agent:** a queue of what to read, including work that already landed; a diff that opens at once; comments that follow the change; a visible state for "I asked for changes".

## Approved direction (group I)

These owner decisions guide the P7 spec; the steps and findings above describe the implementation observed.

- **I41:** Needs you holds approvals, questions, handoffs and reviews; failures appear only when no agent is on them. Order the longest-blocked agent first.
- **I42:** Read state is kept per account so web, phone and CLI agree.

## Decisions

- FYI is the landed, not yet read list. Its Review buttons open landing evidence; a person can dismiss some rows or all. Read state is per account ([inbox decisions](README.md#approved-asking-answering-and-inbox-decisions); Item 48049998).
- **Ask for changes** holds a landing only where the project requires approval (Item 3607c6d6). **Approve** asks once for confirmation if no check has run (Item c008cb43).
- Agent review findings are first-class, attached to an exact saved source version in Item discussion. They do not add an acceptance gate. Keeping findings pinned to lines across later saves is after beta (Item 5dda91bc for exact-save findings; disposition on Item 581bd373).

## Questions for the owner

- Is the change story grouped by save, by file, or by the agent's own summary of what it did?
