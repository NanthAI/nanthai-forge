# Journey 8: planning

Initiatives, Issues, comments and ordering. A rename from Issue to Item is planned.

Walked: `planning` (list by Initiative, read one, short id), `help planning`, `start` from an Issue, the planning and Intent sources (`WorkPlanning`, `PlanningIntents`, `InitiativePage`, `StatusMenu`), concepts and AGENTS.md. **Not walked:** creating, editing, commenting or closing an item, and friction records (each writes to the project).

## Steps today

| # | Step | Agent (CLI) | Person (web) |
| --- | --- | --- | --- |
| 1 | See the backlog | `planning '{"status":"open","limit":50}'`; `initiativeId` narrows to one Initiative; follow `nextCursor`. One page of 50 items was about 47 KB, with bodies cut to 400 characters. The 111 open items of the Phase 7 Initiative took three pages. (ran) | Work → Planning: "Intents and Initiatives", grouped by Initiative, filters Proposed, Planned, In motion, Done, All, and "Find an Intent or Initiative". Work → Intents has List and Board (Planned, Working, Checking, Ready, Done). (source) |
| 2 | Read one | `planning '{"planningItemId":"ID"}'` (changes nothing) returns the item (title, body, status, version, initiativeId, intentIds) and every comment (text, time, `authorLabel`). (ran) | The Intent or Initiative page; Initiative pages have "Add to the conversation…" and "Child Initiatives". |
| 3 | Search | `planning '{"search":"words","limit":10}'`. Every search is billed at the full index size. | The find field. |
| 4 | Create or edit | `put-planning-item` with `kind`, `title`, `body`, `status`, `reason`, `initiativeId`, `expectedVersion`. | **New Intent**, **New Initiative** (inline forms; "Parent Initiative" or "No Initiative"); row menu: Edit, Add Intent, Mark done. "Starts as Planned · In motion begins with its first Lane". |
| 5 | Move through states | Status follows real events: `start` set this map's own Issue to `in-progress` (`planning:{"updated":true,"status":"in-progress","version":2}`). (ran) | Status menu: **Plan it** (Proposed to Planned), In motion "starts with the first Lane", **Mark done**. |
| 6 | Comment | `comment-planning-item '{"planningItemId":"…","text":"…"}'`. | "Add discussion entry". |
| 7 | Hand over | `start '{"planningItemId":"…"}'`. | **Hand to an agent** on the row. |
| 8 | Close | The Issue closes when its Intent completes and every Done-when line has evidence; a held one names the open lines. | Mark done. |
| 9 | Record friction or a decision | `friction` / `save --friction`, `friction-list`, `x friction-triage`; `save --decision`, `decisions`. | Work → Decisions lists owner decisions (read-only). |
| 10 | Export | n/a | "Export planning history" in the Planning menu; "Export" on an Initiative. |

## Findings

| Id | Severity | Finding | Evidence |
| --- | --- | --- | --- |
| J8-1 | S1 | **One thing has four names, and one of them means something else too.** The web says **Intent** (New Intent, Add Intent, "Find an Intent or Initiative"). The CLI help, concepts and AGENTS.md say **Issue**. The actions and fields say **planning item** (`put-planning-item`, `planningItemId`, with `id` and `itemId` as aliases). The owner plans **Item**. Meanwhile "Intent" is also "the execution record behind an Issue". A person who makes an Intent on the web and tells an agent to work on it sends the agent to docs that speak only of Issues. | source, ran, docs |
| J8-2 | S2 | **Nothing orders the backlog.** No order or priority field appears in the list reply or on the web. The Phase 7 Initiative keeps its order as prose in its body: lists of ids under "Run first" and "in this order". An agent asked to "pick the next item" has no rule to follow. | ran |
| J8-3 | S2 | **Three status vocabularies.** Stored: proposed, open, in-progress, closed, abandoned. Web filters: Proposed, Planned, In motion, Done. Board columns: Planned, Working, Checking, Ready, Done. The CLI filters with `status:"open"` and reports `status:"in-progress"`. | ran, source, docs |
| J8-4 | S2 | **The list costs an agent a lot of context.** About 47 KB for 50 items and about 100 KB for the 111 open items of one Initiative, although bodies are already cut to 400 characters. Each row also carries a request hash, an operation id, provenance and version fields. No titles-only list was found in the action's parameters besides `counts`. | ran |
| J8-5 | S2 | **Two instructions about search paging.** `help planning`: "planning '{"search":"words","limit":50}' searches; follow nextCursor". AGENTS.md: one search with `limit:10` is enough, and "Do not page nextCursor for a duplicate check: every search is billed at the full search-index size". | ran, docs |
| J8-6 | S2 | **A comment's author came back empty.** On the Issue read for a0cf8c22 the one comment had `authorLabel` with no value. An agent reading the thread cannot tell who said it. | ran |
| J8-7 | S2 | **Done-when lines are Markdown in the body.** Ticking one means rewriting the body through `put-planning-item` with the right `expectedVersion`. No action ticks a line. | ran (action list) |
| J8-8 | S2 | **Operator wording on the planning page.** "User-declared planning record. Discussion names are supplied labels." "An exported observation does not authenticate offline authorship." "Reconcile discussion entry". | source |
| J8-9 | S3 | **Dependencies and order live as ids in prose.** Initiative and Issue bodies refer to other items by 8-character id with no link or title, so an agent needs one more read per id. | ran |
| J8-10 | S3 | **Old process notes sit in Issue bodies.** Lines such as "Stage as of …; recheck at triage" and "Route to 6.3" are in several open Issues. This is content, not product, but every agent that reads the item pays for it. | ran |
| J8-11 | S3 | **A person cannot record a decision on the web.** Decisions are read-only there ("Recording from the site awaits the … hosted write path"). | docs |

## Dead ends

- "Pick the next item" (J8-2).
- An Intent created on the web with no Lane: "no Lane yet". The next step is Hand to an agent, which is on the row but not on the empty state.

## Naming and tone

- See J8-1 and J8-3. The planned rename to Item is the chance to settle both: one noun for the planned unit, one set of status words on the web, in the CLI and in replies.
- The web status menu ("Plan it", "In motion: starts with the first Lane", "Mark done") is the clearest wording of the lifecycle and could be the source for the CLI's words.

## What each persona needs

- **Agent, not person:** a compact list (id, title, status, order); the next item by rule; whole context of one item in one read with dependency titles; a way to tick a Done-when line; who wrote each comment.
- **Person, not agent:** to add an item in seconds, drag items into order, see what is in motion and what is stuck, and see an Initiative's progress (open Issue b7a0dff1). The owner's vision in `docs/design/planning/` describes this; the web today has creation and grouping, not ordering.

## Questions for the owner

1. After the rename, is the noun Item everywhere, including where the web says Intent today? What then is an Intent to a person: nothing they see, or the name for an Item in motion?
2. Does an Item keep the name Issue anywhere (for people coming from GitHub)?
3. How is order expressed: a manual rank within an Initiative, a priority field, or both? Who may reorder: people only, or agents too?
4. Which status words are the one set: Proposed, Planned, In motion, Done?
5. Should the wire names (`planningItemId`, `put-planning-item`) change with the rename, or stay as aliases?
