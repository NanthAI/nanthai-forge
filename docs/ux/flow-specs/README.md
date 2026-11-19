# Flow specs for the Phase 7 journeys

One spec per journey of Item a0cf8c22. Each walks one goal step by step: **What they want**, **What they see**, **What they do**, **What happens**. Specs describe behaviour and content intent; the prototype decides the look and the final copy. They describe the redesign to build, not today's product: the [journey maps](../journeys/README.md) describe today, and [REQUIREMENTS.md](../REQUIREMENTS.md) holds the requirements, the emotional core and the build phase of each group. [SCREENS.md](SCREENS.md) lists every screen and the specs that touch it.

Open owner questions are marked in each spec as *(Pending Decision — …)* with the journey or Item 581bd373 question that holds them. A spec never settles one silently.

The owner approved the journey list on 2026-11-19, with first run built in Phase 7. The AI walkthrough and the agent scorecard run at the Phase 7 close.

## Flow Spec Index

| # | Flow Spec | File | Status |
|---|---|---|---|
| 01 | Know what needs me now | [01-what-needs-me-now.md](01-what-needs-me-now.md) | Draft |
| 02 | Hand a planned Item to an agent | [02-hand-an-item-to-an-agent.md](02-hand-an-item-to-an-agent.md) | Draft |
| 03 | Watch agents land work | [03-watch-agents-land-work.md](03-watch-agents-land-work.md) | Draft |
| 04 | Review an agent's change | [04-review-a-change.md](04-review-a-change.md) | Draft |
| 05 | Approve something Forge holds for me | [05-approve-something-held.md](05-approve-something-held.md) | Draft |
| 06 | Understand why a landing failed | [06-understand-a-failed-landing.md](06-understand-a-failed-landing.md) | Draft |
| 07 | Answer or unblock an agent | [07-answer-or-unblock-an-agent.md](07-answer-or-unblock-an-agent.md) | Draft |
| 08 | Undo a landing or a Lane's save | [08-undo-a-landing-or-a-save.md](08-undo-a-landing-or-a-save.md) | Draft |
| 09 | Add an Item to the backlog | [09-add-items-to-the-backlog.md](09-add-items-to-the-backlog.md) | Draft |
| 10 | Edit, move or delete an Item | [10-edit-move-and-delete-items.md](10-edit-move-and-delete-items.md) | Draft |
| 11 | Organise and plan the backlog | [11-organise-and-plan-the-backlog.md](11-organise-and-plan-the-backlog.md) | Draft |
| 12 | Understand where a project is at | [12-understand-where-a-project-is-at.md](12-understand-where-a-project-is-at.md) | Draft |
| 13 | Find and understand code | [13-browse-code.md](13-browse-code.md) | Draft |
| 14 | See cost and savings | [14-see-cost-and-savings.md](14-see-cost-and-savings.md) | Draft |
| 15 | Understand Forge on a first visit | [15-first-visit-walkthrough.md](15-first-visit-walkthrough.md) | Draft |
| 16 | Sign up and connect my agents | [16-sign-up-and-connect-agents.md](16-sign-up-and-connect-agents.md) | Draft |
| 17 | Bring a GitHub repository to Forge | [17-import-a-github-repository.md](17-import-a-github-repository.md) | Draft |
| 18 | Set up checks with my own CI | [18-set-up-checks-with-your-ci.md](18-set-up-checks-with-your-ci.md) | Draft |
| 19 | Invite a teammate | [19-invite-a-teammate.md](19-invite-a-teammate.md) | Draft |
| 20 | Control what acts for me | [20-control-what-acts-for-me.md](20-control-what-acts-for-me.md) | Draft |
| 21 | Give checks the secrets they need | [21-give-checks-their-secrets.md](21-give-checks-their-secrets.md) | Draft |
| 22 | Protect paths an agent may not change alone | [22-protect-paths-from-agents.md](22-protect-paths-from-agents.md) | Draft |
| 23 | Export everything and leave | [23-export-everything-and-leave.md](23-export-everything-and-leave.md) | Draft |
| 24 | Know what is happening during an outage | [24-honest-status-during-an-outage.md](24-honest-status-during-an-outage.md) | Draft |
| 25 | Discover a public project worth following | [25-discover-projects.md](25-discover-projects.md) | Draft |
| 26 | Star a project | [26-star-a-project.md](26-star-a-project.md) | Draft |
| 27 | Contribute to a project I am not in | [27-contribute-as-an-outsider.md](27-contribute-as-an-outsider.md) | Draft |
| 28 | Keep up with a busy open-source project | [28-maintain-a-busy-open-source-project.md](28-maintain-a-busy-open-source-project.md) | Draft |
| 29 | Cut a release with notes from the landings | [29-cut-a-release.md](29-cut-a-release.md) | Draft |
| 30 | An agent learns Forge from the docs alone | [30-agent-learns-forge.md](30-agent-learns-forge.md) | Draft |
| 31 | An agent picks the next Item | [31-agent-picks-the-next-item.md](31-agent-picks-the-next-item.md) | Draft |
| 32 | An agent reports progress and evidence | [32-agent-reports-progress-and-evidence.md](32-agent-reports-progress-and-evidence.md) | Draft |
| 33 | An agent recovers from a failed check or a stale Lane | [33-agent-recovers-from-a-failure.md](33-agent-recovers-from-a-failure.md) | Draft |
| 34 | An agent asks or hands back when stuck | [34-agent-hands-back-when-stuck.md](34-agent-hands-back-when-stuck.md) | Draft |
| 35 | An agent coordinates a change across repositories | [35-agent-coordinates-across-repositories.md](35-agent-coordinates-across-repositories.md) | Draft |

## Why this order

Specs are written and read in order: later specs reuse the screens and words of earlier ones.

| # | Why here |
|---|---|
| 01 | The project's front page; it sets the decision grammar (a question with answers, Later, Undo) every other flow reuses. |
| 02 | The core loop starts when a person gives work to an agent. |
| 03 | Follows the handed work through the four stops to main. |
| 04 | Reading a change sits between watching and deciding. |
| 05 | Approval reuses review's Candidate and Needs me's decision. |
| 06 | A failed landing is the most common reason work stops. |
| 07 | Answering an agent reuses the decision grammar and adds the thread and delivery line. |
| 08 | Undo closes the loop: nothing is lost even after a mistake. |
| 09–11 | The backlog flows in create, edit, organise order, so the Item's anatomy is set before it is moved. |
| 12 | Project status reads the plan of 09–11 and the landings of 03. |
| 13 | Code browsing reuses review's diff and History. |
| 14 | Cost and savings read the landings and checks of 03 and 06. |
| 15–18 | First run delivers people into the core loop, so it follows it. |
| 19–20 | People and devices come before what they may touch. |
| 21–22 | Secrets and protected paths are rules on checks and landings. |
| 23–24 | Leaving and outages: trust when things end or go wrong. |
| 25–26 | Discovery comes before contribution. |
| 27–29 | Outsider, maintainer and release flows build on review and approval. |
| 30–35 | The agent's side of the same loop, in the order a fresh agent meets it; scored at the Phase 7 close. |

## Checking the specs

Run the flow-spec linter of the user-flow-specs method on this folder after every edit: `node validate-flow-specs.js docs/ux/flow-specs` (the script ships with that method, not with this repository). Its goal-actor warning (W3) knows only a few role words; every Goal here names its actor as a person, an owner, a developer, a maintainer or an agent. Status changes here only, after the owner's review.
