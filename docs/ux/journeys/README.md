# User journeys as they are

Current-state maps of forty journeys through Forge. Journeys 1 to 11 were mapped first; 12 to 40 add the rest of the list in Issue a0cf8c22 and the journeys found on the planning board and in the docs. Two personas run through all of them: a **person** (the project owner or a teammate, mostly on the web app) and a **coding agent** (mostly on the CLI and MCP). Four more appear where named: an outside contributor, a maintainer, a lead agent and an operator who hosts Forge. Each file lists the steps as they work now, with the exact command or screen and the reply, then the findings and the questions only the owner can answer.

These maps describe behaviour. They contain no visual design. The flow specs, screens and the agent scorecard of Issue a0cf8c22 build on them.

| # | Journey | File |
| --- | --- | --- |
| 1 | Discovery to first value | [01-first-value.md](01-first-value.md) |
| 2 | An agent's first task | [02-first-task.md](02-first-task.md) |
| 3 | A conflict while landing | [03-conflict.md](03-conflict.md) |
| 4 | A failed check, a flaky check and recovery | [04-failed-check.md](04-failed-check.md) |
| 5 | Several agents at once | [05-many-agents.md](05-many-agents.md) |
| 6 | Settings | [06-settings.md](06-settings.md) |
| 7 | People and access | [07-people-access.md](07-people-access.md) |
| 8 | Planning | [08-planning.md](08-planning.md) |
| 9 | Cost and usage visibility | [09-cost-usage.md](09-cost-usage.md) |
| 10 | Mistakes and recovery | [10-mistakes-recovery.md](10-mistakes-recovery.md) |
| 11 | Leaving or exporting | [11-leaving.md](11-leaving.md) |
| 12 | Importing a GitHub repository and migrating | [12-import-migrate.md](12-import-migrate.md) |
| 13 | Connecting CI | [13-connecting-ci.md](13-connecting-ci.md) |
| 14 | Setting up agents | [14-setting-up-agents.md](14-setting-up-agents.md) |
| 15 | A person reviewing agent work | [15-reviewing-agent-work.md](15-reviewing-agent-work.md) |
| 16 | An outside contributor to a public project | [16-outside-contributor.md](16-outside-contributor.md) |
| 17 | Staying informed | [17-staying-informed.md](17-staying-informed.md) |
| 18 | Browsing code and history | [18-browsing-code.md](18-browsing-code.md) |
| 19 | Releases, tags, versions and deploys | [19-releases.md](19-releases.md) |
| 20 | The account | [20-account.md](20-account.md) |
| 21 | Plans, billing and limits | [21-plans-billing-limits.md](21-plans-billing-limits.md) |
| 22 | Several projects at once and cross-repo coordination | [22-many-projects.md](22-many-projects.md) |
| 23 | Stats and "what Forge saved you" | [23-stats-and-savings.md](23-stats-and-savings.md) |
| 24 | Discovery by LLMs and agents | [24-llm-discovery.md](24-llm-discovery.md) |
| 25 | Handing an Item to an agent | [25-handing-work-to-an-agent.md](25-handing-work-to-an-agent.md) |
| 26 | Answering or unblocking an agent | [26-answering-an-agent.md](26-answering-an-agent.md) |
| 27 | "What needs me now" | [27-what-needs-me.md](27-what-needs-me.md) |
| 28 | Protected paths | [28-protected-paths.md](28-protected-paths.md) |
| 29 | Secrets and private files | [29-secrets-private-files.md](29-secrets-private-files.md) |
| 30 | Honest status during a provider outage | [30-provider-outage.md](30-provider-outage.md) |
| 31 | Discovering and starring projects | [31-discover-and-star.md](31-discover-and-star.md) |
| 32 | Maintaining a busy open-source project | [32-maintaining-open-source.md](32-maintaining-open-source.md) |
| 33 | The agent-side scorecard journeys | [33-agent-scorecard-journeys.md](33-agent-scorecard-journeys.md) |
| 34 | The short product walkthrough on a first visit | [34-product-walkthrough.md](34-product-walkthrough.md) |
| 35 | Undo, for a person | [35-undo-for-a-person.md](35-undo-for-a-person.md) |
| 36 | Organizations, teams and transferring a project | [36-organizations-teams.md](36-organizations-teams.md) |
| 37 | Running Forge yourself | [37-running-forge-yourself.md](37-running-forge-yourself.md) |
| 38 | Understanding where a project is at | [38-where-a-project-is-at.md](38-where-a-project-is-at.md) |
| 39 | A lead agent running several builders | [39-leading-a-fleet.md](39-leading-a-fleet.md) |
| 40 | A person changes code themselves | [40-a-person-changes-code.md](40-a-person-changes-code.md) |

## Where each journey of Issue a0cf8c22 is mapped

| Group | Journey in the Issue | Mapped in |
| --- | --- | --- |
| Core loop | Add items to the backlog; edit, delete and move items; organise and plan the backlog | [08](08-planning.md) |
| Core loop | Hand a backlog item to an agent | [25](25-handing-work-to-an-agent.md), [02](02-first-task.md) |
| Core loop | Watch agents land work | [05](05-many-agents.md), [17](17-staying-informed.md) |
| Core loop | Review a change | [15](15-reviewing-agent-work.md) |
| Core loop | Approve something | [07](07-people-access.md), [28](28-protected-paths.md) |
| Core loop | Understand why a landing failed | [04](04-failed-check.md), [03](03-conflict.md) |
| Core loop | Undo (revert a landing, restore a snapshot) | [35](35-undo-for-a-person.md), [10](10-mistakes-recovery.md) |
| Core loop | Understand where a project is at | [38](38-where-a-project-is-at.md) |
| Core loop | "What needs me now" | [27](27-what-needs-me.md), [17](17-staying-informed.md) |
| Core loop | Answer or unblock an agent, including an overlap | [26](26-answering-an-agent.md), [05](05-many-agents.md) |
| Core loop | Browse code | [18](18-browsing-code.md) |
| Core loop | See cost and savings | [09](09-cost-usage.md), [23](23-stats-and-savings.md) |
| First run | A short product walkthrough | [34](34-product-walkthrough.md), [01](01-first-value.md) |
| First run | Sign up and connect your agents | [20](20-account.md), [14](14-setting-up-agents.md), [01](01-first-value.md) |
| First run | Connect or import a GitHub repository | [12](12-import-migrate.md), [11](11-leaving.md) |
| First run | Set up checks with your own CI | [13](13-connecting-ci.md), [06](06-settings.md) |
| Team and trust | Invite a teammate | [07](07-people-access.md) |
| Team and trust | Roles and permissions for people and agent identities | [07](07-people-access.md), [14](14-setting-up-agents.md), [36](36-organizations-teams.md) |
| Team and trust | Secrets for checks | [13](13-connecting-ci.md), [29](29-secrets-private-files.md) |
| Team and trust | Protected paths | [28](28-protected-paths.md) |
| Team and trust | Export everything and leave | [11](11-leaving.md) |
| Team and trust | Honest status during a provider outage | [30](30-provider-outage.md) |
| Community | Discover projects; star or like a project | [31](31-discover-and-star.md) |
| Community | Fork or contribute as an outsider | [16](16-outside-contributor.md) |
| Community | Maintain a busy open-source project | [32](32-maintaining-open-source.md) |
| Community | Cut a release with a changelog from landings | [19](19-releases.md) |
| Agent side | Learn Forge from the docs and `llms.txt` only | [24](24-llm-discovery.md), [33](33-agent-scorecard-journeys.md) |
| Agent side | Pick the next backlog item; report progress and evidence | [33](33-agent-scorecard-journeys.md), [08](08-planning.md) |
| Agent side | Recover from a failed check or a stale Lane | [33](33-agent-scorecard-journeys.md), [04](04-failed-check.md), [10](10-mistakes-recovery.md) |
| Agent side | Hand back to a person when stuck | [26](26-answering-an-agent.md), [33](33-agent-scorecard-journeys.md) |
| Agent side | Coordinate across repositories | [22](22-many-projects.md), [33](33-agent-scorecard-journeys.md) |

Not in the Issue, found on the planning board and in the docs: [21](21-plans-billing-limits.md) (plans and limits), [36](36-organizations-teams.md) (organizations), [37](37-running-forge-yourself.md) (self-hosting), [39](39-leading-a-fleet.md) (a lead agent) and [40](40-a-person-changes-code.md) (a person changing code by hand).

## Approved vocabulary for the P7 specs

The owner decided the vocabulary below. Findings and command transcripts in these current-state maps retain the words observed; the P7 specs and implementation Items use these decisions. PRODUCT.md is the product reference. Code, UI and command renames remain P7 work.

- **Item** is planned work everywhere people look. **Intent** is internal only. **Issue** is only a search alias in help ("Items, like GitHub issues"), not a product name.
- **Approve** is a person's decision on something held. **Accept** is the system's result when a change passes. "Grant" and "apply" retire as names for the owner's yes.
- **Land** is the visible event in CLI, web and tagline. **Accepted** appears only as a state inside a receipt.
- **Candidate**, not View, is the exact combination of Lane saves.
- Statuses are **Proposed, Planned, In motion, Done, Abandoned**. Abandoned has a reason: **won't do**, **duplicate** or **superseded**, matching the existing Lane abandon verb.
- Settings has **People & access** (who decides) and **Landing & checks** (how landings are checked). **Automatic** means only that Forge picks from the project's own data.
- Roles are **owner / write / read**, matching GitHub; no Maintainer role is added.
- The GitHub link is the **mirror**.

The remaining owner questions (groups B–H and J–Q of the mapping handoffs) are tracked in Item 581bd373. Group I (37–44) is answered below. Naming and status implementation is tracked on d3357f40; the person-decision and landing-event wording is tracked on a4c5394c.

## Approved asking, answering and inbox decisions

Group I (37–44) is answered. These are requirements for the P7 specs, not claims that the current implementation supports them. Current-state findings below remain evidence of the gaps.

37. At beta, batched email reaches a person for approvals, agent questions and handoffs; phone push comes later.
38. `ask` (with choices) and `hand back` become agent actions beside start, save and land.
39. Use one message system: one thread per Lane or Item, with choices on a message. Board notes and session messages merge into it.
40. When the agent has stopped, the answer waits on the Lane and Forge offers a ready resume prompt. Forge never starts an agent by itself.
41. Needs you holds approvals, questions, handoffs and reviews; failures appear only when no agent is on them. Order the longest-blocked agent first.
42. Read state is kept per account so web, phone and CLI agree.
43. Home holds one inbox across projects, filterable by project.
44. Owner and write roles may order two overlapping Lanes from Now. Record the order and show it with Undo.

## How to read a finding

**Evidence** says how a fact was established:

- **ran**: a read-only command was run against the Forge project itself and the reply was read.
- **source**: the text was read in `web/src`, `src` or `convex`. The screen or reply was not rendered.
- **docs**: the behaviour is stated in `docs/`, `README.md`, `PRODUCT.md` or the CLI help.

Steps that could not be walked without changing a project (a first sign-in, an import, a real conflict, an invitation) are marked **not walked** and rest on source and docs only.

**Severity:**

- **S1** stops the journey, or tells the person or agent something false about what happened.
- **S2** costs real time: a wrong turn, a wait with no explanation, or a trip to the docs.
- **S3** is friction or an inconsistency that stops nobody.

## Patterns that recur across journeys

1. **One thing, several names.** The planned unit of work is an Intent on the web, an Issue in the CLI help and concepts, a planning item on the wire, and is due to become an Item. The owner's yes is accept, approve, grant or apply depending on the page. The same policy read has four command spellings. See [08](08-planning.md), [07](07-people-access.md), [06](06-settings.md).
2. **Three generations of verbs are visible at once.** The help lists `save --sync` and `land --save`; replies, rules and help topics say `sync`, `resolve` and `finish`; the top-level help still lists commands from the removed native mode. See [02](02-first-task.md), [05](05-many-agents.md).
3. **The web app shows controls and commands that no longer do anything.** A switch with no effect on hosted projects, and export commands the CLI refuses. See [06](06-settings.md), [11](11-leaving.md).
4. **Settings that decide how a landing is checked have no web control.** A person changes them through a CLI command that is then held for the same person's approval on the web. See [06](06-settings.md).
5. **Replies are built for agents; nothing is built for a person at a terminal.** Reads return full hashes, UUIDs and epoch times with no one-line summary. `nforge status` is the one exception. See [02](02-first-task.md), [09](09-cost-usage.md), [10](10-mistakes-recovery.md).
6. **Replies contradict each other in a few places an agent will read.** `check-settings` reports that agent landings wait for review on a project where they land automatically; the stalled-landing rule and help topic give opposite instructions. See [02](02-first-task.md), [04](04-failed-check.md).
7. **Cost is invisible to the person who pays.** No web surface shows CI minutes or cost; the CLI report uses internal row codes. See [09](09-cost-usage.md).
8. **The recipient half of sharing is missing.** An invitation sends nothing to the person invited. See [07](07-people-access.md).
9. **Forge speaks only when spoken to.** Nothing reaches a person outside the app, and an agent hears news on the reply to its next command. See [17](17-staying-informed.md), [26](26-answering-an-agent.md), [27](27-what-needs-me.md), [30](30-provider-outage.md).
10. **The outsider has no door.** No proposal without an invitation, no bug report, no directory, and crawlers are kept out of project pages. See [16](16-outside-contributor.md), [31](31-discover-and-star.md), [32](32-maintaining-open-source.md).
11. **One owner and one identity.** One account approves everything on a project, and every terminal sign-in is an agent under its person's handle with all of that person's reach. See [14](14-setting-up-agents.md), [20](20-account.md), [28](28-protected-paths.md), [36](36-organizations-teams.md), [39](39-leading-a-fleet.md).
12. **An agent cannot ask or hand back with the commands it is taught.** Two message systems exist and do not meet. See [26](26-answering-an-agent.md), [33](33-agent-scorecard-journeys.md).
13. **What people from GitHub look for first is absent.** A history tab, blame, tags and releases, an issue import, a small edit on the web. See [12](12-import-migrate.md), [18](18-browsing-code.md), [19](19-releases.md), [40](40-a-person-changes-code.md).
14. **Setup happens in a terminal and the docs, with no screen.** Connecting CI, connecting an agent and self-hosting. See [13](13-connecting-ci.md), [14](14-setting-up-agents.md), [37](37-running-forge-yourself.md).
15. **Texts written for agents by hand drift from the CLI.** `llms.txt` and the skill teach retired verbs; the help omits a working action. See [24](24-llm-discovery.md), [18](18-browsing-code.md), [33](33-agent-scorecard-journeys.md).
16. **Measured facts are not shown where a person decides.** Main's health, counts per Initiative, usage against limits and savings exist in reads and reports only. See [21](21-plans-billing-limits.md), [23](23-stats-and-savings.md), [30](30-provider-outage.md), [38](38-where-a-project-is-at.md).
17. **Some controls describe an action without performing it.** Undo beside an automatic landing is a tooltip; the proposal upload needs an archive the CLI no longer makes. See [35](35-undo-for-a-person.md), [16](16-outside-contributor.md).

## Pattern references

Findings were checked against the onboarding, settings, sharing and error-recovery flow patterns (activation moment and value before asks; findable settings with one persistence model and visible current values; the recipient side of an invite; every error names the cause, the next step and where the work is). Where a finding cites one of these rules it says so.
