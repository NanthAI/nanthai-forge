# User journeys as they are

Current-state maps of eleven journeys through Forge, for two personas: a **person** (the project owner or a teammate, mostly on the web app) and a **coding agent** (mostly on the CLI and MCP). Each file lists the steps as they work now, with the exact command or screen and the reply, then the findings and the questions only the owner can answer.

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

The remaining owner questions (groups B–H of the mapping handoff) are tracked in Item 581bd373. Naming and status implementation is tracked on d3357f40; the person-decision and landing-event wording is tracked on a4c5394c.

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

## Pattern references

Findings were checked against the onboarding, settings, sharing and error-recovery flow patterns (activation moment and value before asks; findable settings with one persistence model and visible current values; the recipient side of an invite; every error names the cause, the next step and where the work is). Where a finding cites one of these rules it says so.
