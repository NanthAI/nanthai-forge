# Planning for agents and humans: design pack

Status: **design input, not shipped.** This pack is the accepted design input for Phase 7.1 ("planning for agents and humans") and for Phase 6 design preparation. It records an approved extraction; it does not approve building the design, and nothing here is a new limit, price, policy or user step. Mockups show intended layout and wording only. In particular, the "Ready → Landing" rename, the derived-status pills, the Board, the charts and the `plan` verbs do not ship today; [status](../../status.md) lists what does.

| File | What |
|---|---|
| [IA.md](IA.md) | Item model, grouping, order, derived status rules, one-liner template, alive/history, capture, auto-tracking, navigation |
| [SPEC.md](SPEC.md) | Builder spec: components, exact strings, states, keyboard, density, budget rules, do-not-build |
| [AGENT-SURFACE.md](AGENT-SURFACE.md) | Proposed `plan` CLI verbs, two MCP tools, skill text |
| [BUILD-PLAN.md](BUILD-PLAN.md) | 4 slices (+1 optional) with acceptance and Convex budget |
| [OWNER-VISION.md](OWNER-VISION.md) | The owner's original problem statement and must-haves (2026-10-30) |
| `design/planning/` (repo root) | Seven HTML mockups plus `p6.css` and `p6.js`: [List](../../../design/planning/01-backlog.html), [Item](../../../design/planning/02-item.html), [Board](../../../design/planning/03-board.html), [Initiative](../../../design/planning/04-initiative.html), [History](../../../design/planning/05-history.html), [Settings](../../../design/planning/06-settings.html), [States](../../../design/planning/07-states.html) |

The mockups live outside `docs/` because the packaged-documents inventory accepts only listed Markdown files there. Open them in a browser; `?theme=dark` or the toggle switches theme. Relative links between the files are intact inside `design/planning/`.

## Data in this extract

The original design used the live project backlog and live actor names. Every Item, Initiative, person, agent, Lane name and number in the mockups and in the examples here is now a **synthetic example** (project `demo-project`, Initiatives such as "Release 1 close"). The chart series on the Initiative mockup are illustrative: a new project has no history, so real charts would start on its first day. Raw evidence stays private.

## Decisions recorded on 2026-10-31

The owner accepted the lead recommendation for all nine questions. They are historical decisions with their status, not newly authorized caps:

1. Rename the derived status **Ready** to **Landing**. *Proposed in the design; not implemented.*
2. Done stays in Alive for 24 hours.
3. Old imported and abandoned-looking Initiatives are removed from the live backlog (abandoned in planning with history kept), so no quiet-line is needed for them.
4. Infer a type from the first word of a captured title, with Undo.
5. `notBefore` is the only date field.
6. For the dogfood project, reorder permission is people plus agents' own Items.
7. The Board is read-only in v1; drag-to-start comes later.
8. One sub-item level, about 7 per Item. This is a design guideline, not an authorized hard cap.
9. Keep the old Planning list behind a flag for the first dogfood week.

## How the pieces relate

[OWNER-VISION.md](OWNER-VISION.md) states the problem. [IA.md](IA.md) turns it into a model and derived statuses. [SPEC.md](SPEC.md) fixes strings, states and budgets for the mockups. [AGENT-SURFACE.md](AGENT-SURFACE.md) and [BUILD-PLAN.md](BUILD-PLAN.md) describe how agents drive it and how to slice the build. Any slice must still meet [AGENTS.md](../../../AGENTS.md): idle costs zero Convex calls, reads are O(pages), and Forge itself never calls a model.
