# User journeys

These forty maps pair observed steps with approved decisions. The steps and findings describe what was observed when mapped unless they name a later delivery. Decision sections specify the intended behavior and name the work that carries it; they do not announce that a feature is live. Only unresolved choices belong under Questions for the owner.

The main perspectives are a **person** (usually on the web) and a **coding agent** (usually on the CLI or MCP). Other journeys cover outside contributors, people maintaining or hosting a project, and people or agents coordinating work. Leading work does not grant a separate role or interface.

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
- Statuses are **Proposed, Planned, In progress, Done, Abandoned**. Abandoned has a reason: **won't do**, **duplicate** or **superseded**. Inactivity does not move work out of In progress; there is no “stuck” status ([journey 38](38-where-a-project-is-at.md#decision)).
- Settings has **People & access** (who decides) and **Landing & checks** (how landings are checked). **Automatic** means only that Forge picks from the project's own data.
- Roles are **owner / write / read**; no Maintainer role is added. Invited people are **members**; **contributor** means an outsider (Item 203fd4f8).
- The link to the external Git host is the **mirror**.
- People see **version**, the CLI keeps **State**, and **Channel** is hidden while there is only one (Item c008cb43).

Accepted answers from Item 581bd373 are recorded under Decisions in the relevant journeys, with the Items that carry the work. They describe approved behavior, not a rollout. Remaining questions stay explicit. Naming and status implementation is tracked on d3357f40; the person-decision and landing-event wording is tracked on a4c5394c.

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

Items b54a14c0 and 77d2e8bc cover the message and inbox foundations; Item e88f503d tracks notification work. Those deliveries do not establish that every requirement above is live. The FYI list shows landed work not yet read, with Review links and individual or bulk dismissal (Item 48049998).

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
6. **Recovery needs one exact command.** Follow the stalled-landing receipt's repair command rather than starting another bare `land`. See [04](04-failed-check.md).
7. **Project savings need a stated baseline.** Stats shows estimated dollars saved; see [09](09-cost-usage.md) and [23](23-stats-and-savings.md).
8. **The recipient half of sharing is missing.** An invitation sends nothing to the person invited. See [07](07-people-access.md).
9. **Forge speaks only when spoken to.** Nothing reaches a person outside the app, and an agent hears news on the reply to its next command. See [17](17-staying-informed.md), [26](26-answering-an-agent.md), [27](27-what-needs-me.md), [30](30-provider-outage.md).
10. **Discovery and outside intake are separate.** Explore and public project pages let people find projects; outside proposals and bug reports have separate rollout requirements. See [16](16-outside-contributor.md), [31](31-discover-and-star.md), [32](32-maintaining-open-source.md).
11. **One owner and one identity.** One account approves everything on a project, and every terminal sign-in is an agent under its person's handle with all of that person's reach. See [14](14-setting-up-agents.md), [20](20-account.md), [28](28-protected-paths.md), [36](36-organizations-teams.md), [39](39-leading-a-fleet.md).
12. **An agent cannot ask or hand back with the commands it is taught.** Two message systems exist and do not meet. See [26](26-answering-an-agent.md), [33](33-agent-scorecard-journeys.md).
13. **Source, work and releases follow different paths.** Import brings source and history, not tracker work. Read history and blame in Forge; edit in a Lane. Tags are to go to the mirror, with Forge releases deferred. See [12](12-import-migrate.md), [18](18-browsing-code.md), [19](19-releases.md), [40](40-a-person-changes-code.md).
14. **Setup happens in a terminal and the docs, with no screen.** Connecting CI, connecting an agent and self-hosting. See [13](13-connecting-ci.md), [14](14-setting-up-agents.md), [37](37-running-forge-yourself.md).
15. **Texts written for agents by hand drift from the CLI.** `llms.txt` and the skill teach retired verbs; the help omits a working action. See [24](24-llm-discovery.md), [18](18-browsing-code.md), [33](33-agent-scorecard-journeys.md).
16. **Put each figure where it informs a decision.** Show savings on Stats, space warnings on Usage and progress on the Initiative. See [21](21-plans-billing-limits.md), [23](23-stats-and-savings.md), [30](30-provider-outage.md), [38](38-where-a-project-is-at.md).
17. **A revert is a new landing.** “Take it out of main” reverts the exact change without rewinding main. See [35](35-undo-for-a-person.md).

## Pattern references

Findings were checked against the onboarding, settings, sharing and error-recovery flow patterns (activation moment and value before asks; findable settings with one persistence model and visible current values; the recipient side of an invite; every error names the cause, the next step and where the work is). Where a finding cites one of these rules it says so.
