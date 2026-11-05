# Planning for agents and humans: owner vision (2026-10-30)

This is an extract of the owner's problem statement that started the design. It is background for the [design pack](README.md), not a plan to build. Names and private logs are omitted.

## Problem

The owner kept asking "what is the status of this phase?", and the answer lived in a lead agent's private log. Forge should answer it itself. The goal is a simple Jira-lite that covers GitHub Issues parity and is built for many agents plus humans. Do not reinvent the wheel and do not overcomplicate it.

## Must have

1. **Light hierarchy, not deep trees.** Initiative (a phase or theme) → Item → optional sub-items. Types are a label (feature, bug, friction, decision, idea), not a rigid epic/feature/story/task tree.
2. **Organise by any field.** One project groups by phase; others use their own fields (area, milestone, owner). Custom fields stay small.
3. **Order is shared and editable.** People and agents can add and reorder Items; policy can limit agents to their own Items, as with queue reordering.
4. **Default view is what is alive.** New and to-tackle, in flight (linked Lanes working, checking, landing), and blocked. History of closed and abandoned Items is one click away and searchable across the project.
5. **Quick capture, refine later.** "Jot it down for the next phase" is one call or one line with no required fields. Later, agents and humans refine together: break down, edit, merge duplicates, move between Initiatives. Comments record decisions.
6. **Everything tied together.** Item ↔ Intent ↔ Lanes ↔ checks ↔ landing evidence. An Item shows live progress from real work, not from someone updating a status by hand.

## Auto-tracking setting (opt-in)

- A project setting (name to be decided; for example "Track work in planning"). When on, an agent that starts work without an Item gets one created and linked; landing closes it with evidence (commit, check, cost-free facts).
- **Token cost split.** Linking Lane → Intent → Item and moving status from real events is deterministic and server-side, so it costs no model tokens and can be on by default. Writing ticket prose (titles, acceptance text, summaries) costs agent tokens, so that part is opt-in. The setting is off by default for projects that do not manage work in Forge.

## Visualisation ideas (the design pass chose a few)

- Progress swimlanes per Initiative: Gantt-shaped but progress-based, no dates; Items as bars filling from planned to working to checking to landed.
- Burn-up per Initiative (scope line against done line, so scope creep is visible); burn-down as a variant.
- Cumulative flow (planned / in flight / landed over time) to show bottlenecks such as a stuck queue.
- Board by status, and a grouped list by any field.
- A "where are we" one-liner per Initiative, assembled from events and never written by a model: "Phase: 14 of 19 landed, 3 in flight, 2 waiting on owner".
- Idle is zero Convex calls; views read cheap aggregates.

## Agents

- MCP and CLI: capture, read (filtered and paged), update, reorder, comment, start from an Item.
- A skill that says how to write a good Item (outcome-first title, why, acceptance, scope, links; short), when to split, and when to comment instead of editing.
- Lead workflow: the owner says "note it for the next phase" and the Item appears under that Initiative in the same turn.

## Order

First the planning-for-agents slice (search, filters, seeding the backlog), then the design pass for views and information architecture, then build slices: fields and grouping, reorder, the auto-tracking setting, views, skill text, search and history. See [BUILD-PLAN.md](BUILD-PLAN.md).
