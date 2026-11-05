# P6 planning: information architecture (design pass, 2026-10-31)

Status: unshipped design input; see [README](README.md) for caveats and the synthetic-data note.

Scope: Work › Planning for agents and humans. Jira-lite, GitHub Issues parity, built for many agents plus people. Status is read from Forge's own records, never typed by hand. Nothing in the user UI shows money.

## 1. Item model

One record kind, `Item`, with a light hierarchy and labels instead of a type tree.

| Field | Required | Notes |
|---|---|---|
| `id`, `version`, `operationId` | yes | As today (`planningItemSchema`). Every write is CAS on `expectedVersion`; same `operationId` replays. |
| `kind` | yes | `initiative` or `item` (wire name stays `issue` for compatibility). |
| `title` | yes | The only required field for capture. Outcome-first, ≤ 90 chars recommended, never truncated in UI. |
| `body` | no | Plain text with light Markdown (paragraphs, lists, links, code). Convention, not schema: *why*, *done when*, *scope*, *links*. |
| `type` | no | One label from the project's type list (defaults: feature, bug, friction, decision, idea, chore, docs). Free to add; max 12 per project. |
| `initiativeId` | no | Parent Initiative. An Item with none sits under "No Initiative". |
| `parentId` | no | Parent Item → this is a **sub-item**. Depth is exactly Initiative › Item › sub-item; a sub-item cannot have children (server refuses). |
| `order` | yes | Fractional rank string (LexoRank-style) among siblings (same `initiativeId` and `parentId`). Server assigns "end of list" on create. |
| `notBefore` | no | ISO date. Until that day the Item is **Dated**: alive but out of "to tackle". Replaces calendar waits tracked by hand. |
| `fields` | no | `Record<string, string>`; keys from the project's field list (max 6 fields, e.g. `area`, `stage`). Values are short text; no typed schema in v1. |
| `status` (declared) | yes | `open`, `closed`, `abandoned` (+ legacy `proposed`, `in-progress` read as `open`). Declared status is the floor; the **derived** status (below) is what the UI shows. |
| `reason` | on close/abandon | Free text. "Closed by hand" needs one; landing-closed Items carry evidence instead. |
| `intentIds` | no | Links to Intents. Many-to-many: one Lane can serve two Items (two frictions fixed by one slice). |
| `closedBy` | server | `{ kind: 'landing', viewId, channelMoveId, at } | { kind: 'hand', actor, at } | { kind: 'merge', intoId }`. |
| `createdBy`, `at` | server | Actor from the hosted event, as today. |

Initiatives are Items with `kind: initiative` and no `parentId`; they take `title`, `body`, `order`, `status`, `reason`, `fields`. Nested Initiatives are not created in v1 (existing nested records flatten under their first visible parent, as `childInitiatives` does today).

Comments stay as today (`planningComments`) plus one boolean, `decision`. Decision comments are the record of choices; they are never written by auto-tracking.

### Grouping by any field
Group-by options are built from a fixed list plus the project's custom fields: **Initiative** (default), Type, Status (derived), Actor (last actor on a linked Lane), each custom field, None. Group order: Initiatives by their own `order`; field values alphabetically with an empty bucket last. Within a group, Items by `order`.

### Shared, editable order
`order` is one shared list per sibling set. People reorder by drag or keyboard; agents reorder through `plan move`. Policy `planning.reorder`: `people` (default: people only), `people+own` (agents may move Items they created or are working on), `all`. Same shape as queue reordering (owner decision 2026-10-26: off by default for agents, own entries only).

## 2. Status from real events

Derived status is computed server-side from linked records and stored in a projection row per Item (`planningStatus`: `{ itemId, derived, flag?, laneCount, saveCount, lastSaveAt, checkState?, queuePosition?, landedAt?, updatedAt }`), updated by the same hooks that write Lane, check, queue and landing records. No polling, no model prose.

Precedence (first match wins):

| Derived | Rule | Pill |
|---|---|---|
| Abandoned | declared `abandoned` | — Abandoned (grey) |
| Done | declared `closed`, or `closedBy.kind = landing` | ✓ Done (green) |
| Conflict | a linked Lane's latest sync or compose reports conflict | ⧉ Conflict (violet) |
| Check failed | latest check on a linked Lane's newest Candidate failed | ✕ Check failed (red) |
| Waiting | a linked Lane or Intent has an unanswered question, overlap ack, or review for a person; or a decision comment addressed to a person is open | ◷ Waiting (amber) |
| Ready | a linked Candidate passed and is queued to land or awaits acceptance | ✓ Ready (green) |
| Checking | a check is queued or running on a linked Candidate | ◐ Checking (blue) |
| Working | any linked Lane is active with at least one save or edit | ● Working (blue) |
| Dated | `notBefore` is in the future and nothing above applies | ○ Dated (grey) |
| Proposed | declared `proposed` (from outside, not yet planned) | ○ Proposed (grey) |
| Planned | everything else | Planned (plain) |

An Item with sub-items derives from them: Done when all sub-items are Done (or it is closed itself); otherwise the most urgent sub-item state by the same precedence; its progress reads "2 of 5".

Closing by landing: when a linked Lane's Candidate is accepted on main and `lifecycle.completeOnAccept` completes the Intent, the Item is closed with `closedBy.kind = landing`. If the Item has other linked Intents still open, it stays open and the fact line says "1 of 2 Intents landed". Reopening the Intent reopens the Item.

The **Initiative one-liner** is assembled from counts of its top-level Items, zero buckets omitted, in this fixed order:

`<landed> of <total> landed · <working+checking> working · <ready> ready · <waiting> waiting on you · <failed+conflict> blocked · <dated> dated · <planned> planned`

Examples: "0 of 9 landed · 2 working · 1 waiting on you · 3 dated · 3 planned". Closed Initiative: "14 of 14 landed · closed 25 Oct". Empty: "nothing planned yet". "waiting on you" is used when the viewer is the person; otherwise "waiting on <name>".

The project-level situation sentence on Planning uses the same template across Initiatives that are not quiet.

Per-Initiative daily buckets (`planningDaily`: `{ initiativeId, day, scope, landed, inFlight, waiting, blocked }`) are appended once per day per Initiative on the first status change of that day and overwritten on later changes that day. They feed burn-up and flow with reads of O(days).

## 3. Default view and history

**Alive** (default) = Proposed, Planned, Dated, Working, Checking, Ready, Waiting, Check failed, Conflict, plus Items landed in the last 24 h (shown dimmed at the end of their group, then gone). Filters inside Alive: Waiting on you · Blocked · Dated. The search box on Alive filters alive Items only.

**History** = Done and Abandoned, newest close first, with search across titles, bodies, comments and close reasons; a scope toggle "Everything" includes alive Items. Export stays here.

**Quiet Initiatives**: an open Initiative with nothing in flight, nothing waiting on anyone and no event for 14 days (project setting) collapses into one line at the bottom of Alive: "14 quiet Initiatives · 46 planned · no activity since 16 Oct". Expand to see them. They still count in History search. This hides imported or abandoned-looking history without deleting it.

## 4. Quick capture, refine later

One input at the top of Planning and of every Initiative page: title only, Enter adds a Planned Item at the end of the current group (the Initiative in scope, or the one chosen in the small "in …" selector; remembered per project). ⌘Enter adds and opens. If the first word matches a type ("bug: …"), the type is set and shown as `auto` with Undo. Toast: "Added '…' to Release 2 · Undo · Open".

Refine is a set of ordinary actions on the Item page and the row menu: Edit, Split into sub-items, Merge into… (closes this Item with `closedBy.merge`, moves comments as quotes, links Intents to the target), Move to… (Initiative or parent), Set not before, Hand to an agent (copies a prompt with the Item id; the agent uses the CLI or MCP). Forge itself never calls a model.

## 5. Everything tied together

Item ↔ Intent ↔ Lanes ↔ checks ↔ landing. The Item page's **Work** panel shows the chain as records: Intent, each Lane with save count and state, the newest check with the journey rail, and the landing (commit, channel move, time). Start a Lane from the Item (`start {itemId}`) creates and links the first Intent and Lane; an agent that starts an Intent and names an Item links the same way; auto-tracking (below) covers the rest.

## 6. Auto-tracking setting

Settings › Project › Planning › **Track work in planning**:
- **Link work to Items** (on by default). A Lane started without an Item gets one, titled from the Intent outcome, under the Initiative the agent passed (`initiative` on `start`) or none; the Item closes when the Lane lands, with evidence. Deterministic, server-side, no tokens. Off means Items are only created explicitly.
- **Agents write Item text** (off by default). A policy flag read by the skill: when on, agents fill why / done-when on start and a two-line summary on close. Costs the agent's tokens.
- **Who can reorder**: people · people and agents on their own Items · everyone.
- Types, Fields (≤ 6), Quiet after N days.

## 7. Navigation

Work sub-nav: Intents · Lanes · Planning (unchanged). Planning has one view switcher: **List · Board · History**. Group header → Initiative page. Row → Item page. URL records view, filter, group-by and search; the browser remembers the view per project.

Views kept (design choice): List (default), Board (same five columns as Intents Board: Planned · Working · Checking · Ready · Done 7 days; Dated, Waiting, Failed and Conflict are flags on cards, not columns), Initiative page with Progress swimlanes + burn-up + flow, History. Not built: timeline/Gantt with dates, per-person boards, velocity, estimates, sprints, cost.
