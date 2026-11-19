# Requirements for the Phase 7 journeys

These requirements drive the [flow specs](flow-specs/README.md) of Item a0cf8c22. They describe the product the redesign builds, not the product as it is today; the [journey maps](journeys/README.md) describe today. PRODUCT.md is the product reference and DESIGN.md the design reference. Where an owner question is still open, the spec that depends on it marks it as a pending decision.

## Problem and goal

People who run several coding agents against one codebase cannot tell, at a glance, who is working, what is changing and what needs them. Agents cannot ask, hand back or learn the rules without reading long references. Forge's goal: a person delegates more to agents because the work feels in good hands, and comes back because Forge tells them, in seconds, the one or two things that need them. An agent learns Forge from a short start page and finishes its task with few turns, few tokens and no wrong turns.

## Users

- **The project owner or a teammate (a person):** an expert developer, mostly on the web app, between other work. Knows GitHub. Has no time to be taught twice.
- **A coding agent:** Claude Code, Codex, Cursor, OpenCode, Pi or another app, mostly on the CLI and MCP. Reads replies literally and cannot see the web app.
- **Named where they appear:** an outside contributor, a maintainer of a busy public project, a lead agent running builders.

**Standing accessibility requirements:** WCAG AA contrast in both themes; status is never shown by colour alone; every action works by keyboard with a visible focus; reduced motion makes motion instant; every screen works at phone width (390 wide) with no sideways scroll; replies to agents are plain text that a screen reader can also read.

## Emotional core

Calm control. A person feels that among many agents and much work they understand the project: what was done, what is in progress, what is left, and the one thing that needs them now. Nothing surprises them and nothing is lost. An agent feels it always knows the next command.

## Functional requirements

| # | Requirement |
|---|---|
| **R1** | A person or agent adds an Item to the backlog in seconds. A person's Item starts Planned; an agent's starts Proposed unless its person said otherwise. |
| **R2** | A person edits, moves, deletes and restores Items. Delete keeps an Item 30 days in Deleted; every move is recorded and can be undone. |
| **R3** | A person orders and groups the backlog (Initiatives, a "next" marker, List, Tree and Board views) and sees each group's progress. People and agents may both reorder. |
| **R4** | A person hands an Item to an agent in one action (first version: a prepared prompt to copy) and sees whether it was picked up. |
| **R5** | A person watches agents' work move through four stops (edited, saved, checked, landed) and sees what landed without reading every change. |
| **R6** | A person reviews a change: the parts that need their eyes first, line notes that follow the change, and "Ask for a change" that holds the landing. |
| **R7** | A person approves or declines anything Forge holds for them (a held landing, a fork run, a settings change, an access request) from one place. |
| **R8** | A person and an agent understand why a landing failed: the cause where Forge can observe it, the suspects (the change, main, the machine, a flaky test), and the next step. |
| **R9** | A person takes a landing out of main, returns a Lane to an earlier save, or restores a deleted Item, in one press, with nothing lost. |
| **R10** | A person sees where a project is at: per Initiative, what is done, in progress and left; whether main is healthy; what is stuck. |
| **R11** | Needs me shows only what waits on the reader, longest held first, each answerable in place. Everything else is FYI. One inbox across projects lives on Home. |
| **R12** | An agent asks with fixed answers or hands work back; the person answers in one thread per Lane or Item; a stopped agent's answer waits with a ready resume prompt. Forge never starts an agent. |
| **R13** | A person with write access orders two overlapping Lanes that wait for each other; the order is recorded and can be undone. |
| **R14** | A person browses code: files at main or any landing, the landings that touched a file, who changed these lines, a compare between two versions, and search. |
| **R15** | A person sees landings used against the plan's limit, CI minutes, first-try rate and time to main, with the baseline stated. |
| **R16** | A newcomer understands Forge in under a minute before any ask, signs in with a passkey or GitHub, approves a device once, and connects each agent app with one command that previews, backs up and can be undone. |
| **R17** | A person imports a GitHub repository with its history, chooses visibility, and keeps a mirror to GitHub while they move. |
| **R18** | A person connects their own CI as the project's check, tries it before the first landing depends on it, and their first landing is checked by it. |
| **R19** | A person invites a teammate with a link and an email, sets a role (owner, write, read), and sees every device, sign-in and agent session acting for them. |
| **R20** | A person keeps secrets out of the source, gives checks the secrets they need, and marks paths that an agent may not change alone. |
| **R21** | A person exports everything and leaves: a Git repository with full history and one archive of the rest. |
| **R22** | During an outage of CI, GitHub or Forge, people and agents see what is degraded, since when, what keeps working, and that nothing is lost. |
| **R23** | Anyone finds public projects, judges whether one is alive, stars it, and contributes a change as an outsider, checked without the outsider paying. |
| **R24** | A maintainer triages outside and agent-made changes, blocks spam, pauses intake, and offers starter tasks. |
| **R25** | A person marks a landing as a release and gets notes written from the landings since the last one. |
| **R26** | A fresh agent learns Forge from `llms.txt` and the docs alone, picks the next Item, reports progress and evidence, recovers from a failed check or a stale Lane, hands back when stuck, and coordinates work across repositories. |
| **R27** | Every automatic action says what it did and offers Undo. Idle screens and clients cost nothing. Nothing accepted is ever lost or overwritten. |

## Constraints

- **Vocabulary:** Item (Intent is internal), Lane, save, Candidate, check, land, main, Needs you, Approve (a person's yes), Accepted (a receipt state only). Item statuses: Proposed, Planned, In progress, Done, Abandoned (won't do, duplicate, superseded). Roles: owner, write, read. The GitHub link is the mirror. Settings: People & access, Landing & checks. Banned words in product UI are listed in PRODUCT.md.
- **Places in the app:** Home; per project Needs me, Lanes, Plan, Code, Stats, Settings; the account (Projects, Billing, People, Devices, Your data); public Explore and profile pages. Six project places; no seventh.
- **Design system:** DESIGN.md and `web/src/ds/`. Three weights (act now, watch, reference); one first stop per screen.
- **Cost:** no polling; idle costs zero Convex calls; reads by bounded page; bytes in R2. Signed-out public pages never reach Convex.
- **Agents:** the CLI and MCP stay light; one source generates the agent text in `llms.txt`, the skill, the CLI help and the MCP descriptions.

## Build phases

| Group | Specs | Build |
|---|---|---|
| Core loop | 01–14 | Phase 7 |
| First run | 15–18 | Phase 7 (owner decision 2026-11-19); publishing, the default login address and live charging stay in Phase 8 |
| Team and trust | 19–24 | Phase 8 |
| Community and open source | 25–29 | Phase 8 and 9 |
| Agent side | 30–35 | Scored by the agent scorecard at the Phase 7 close |

## Out of scope

- Settling a conflict in the browser (after the first build).
- A money ledger for users beyond the account's plan and billing.
- Yearly billing, phone push, a native mobile app.
- Forge starting or running an agent by itself.
