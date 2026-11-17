# Planning model

Planning is one list of Items grouped by Initiatives, shared by people and agents. This page is the contract every
planning screen, public read and agent reply builds on. The rules live in one pure module,
[`src/planning-model.ts`](../src/planning-model.ts), used by the web app, Convex and the CLI. The stored schema keeps its own copy of the rank pattern and relation
kinds so the CLI loads no extra module; a test ties the copies together.

## Items and Initiatives

An Item is one piece of work a person or an agent can take. Initiatives group Items. An Item may have one parent
Item (a sub-item); deeper nesting is shown flattened under the first parent. Items outside every Initiative are
listed last, under No Initiative.

The stored kind of an Item is `issue`, so every older operation replays exactly. The CLI also accepts
`"kind":"item"` and stores it as `issue`. "Issue" stays only as a search alias in help.

Each Item has one type label. The defaults are Idea, Task and Bug; a project may use its own labels of up to 32
characters.

## Status

Stored status words never change. Screens and agent replies show the visible word:

| Stored | Shown |
| --- | --- |
| `proposed` | Proposed |
| `open` | Planned |
| `in-progress` | In progress |
| `closed` | Done |
| `abandoned` | Abandoned (one-press reasons: won't do, duplicate, superseded) |

Status follows real work: starting a Lane from an Item moves it to In progress, and landing with its Done-when lines
met closes it. Done-when lines are the body's Markdown task lines (`- [ ]` and `- [x]`); planning rows carry their
count as `doneWhen: [ticked, total]`.

## Hand order

The list has one hand order. An Item that was never moved has no stored `order` and sorts by its creation position.
A move stores `order`, a rank strictly between the two neighbours' ranks (`rankBetween`); nobody else is rewritten.
An Item moved to the end (`rankAtEnd`) still sorts before Items created later. The plan order is: Initiatives by
their own rank, then No Initiative; within each group, Items by rank, each followed by its sub-items (`planOrder`).

## Next

"Next" is derived from state and never stored: the first Planned Item in plan order with no owner, no Lane and no
open `depends-on` dependency (`nextItem`). The Items skipped on the way come back with their reason: owned, in a
Lane, or blocked by a named Item.

## Fields

All are optional and absent on older records. A put that omits a field keeps it; `null` clears it (`relations: []`,
`hidden: false`).

| Field | Meaning |
| --- | --- |
| `order` | Hand-order rank, 1 to 64 letters and digits, never ending in `0` |
| `type` | Type label |
| `parentId` | Parent Item (Items only) |
| `owner` | Who has the Item before a Lane: a Forge handle or `handle/agent` |
| `relations` | Up to 20 of `{kind, id}`, kind `depends-on`, `duplicate-of` or `related`; the other side is derived (`depends-on` shows as Blocks on its target) |
| `hidden` | Hidden from public reads of the plan |

Agents name these fields in one `fields` object, for example
`put-planning-item {"itemId":"…","expectedVersion":3,"fields":{"order":"L00000AV","owner":"@mara"}}`. The CLI
flattens it, so the stored operation has one flat shape. Comment threads and decisions belong to
discussions (Item `9a3d6f5f`).

A server advertises the `planning-model` contract feature once it stores these fields. The CLI refuses to send them
to a server that does not, since that server would drop them.

## Progress

An Initiative's progress counts its Items and their sub-items, one tick each: done, in progress, not started
(proposed and planned) and dropped (abandoned). There is no typed percentage (`progress`).

## Public plan

On a public project the plan (Items, Initiatives and comments) is readable by anyone. The project setting
`planVisibility: "members"` keeps all of it to members. An owner can hide one Item (with its sub-items) or an
Initiative together with every Item in it; hiding is reversible. Every public read and every public count uses the
one rule `publicPlanVisible`: a hidden Item never appears or counts anywhere public, and a read that has not looked
up an Item's Initiative or parent treats it as hidden.

## Imported history attribution

Retained planning readers accept optional `imported` attribution: `source` (a source note), `key` (the original
record key), `createdAt`, optional `closedAt` and `originalHandle` (a public handle), and `batchId` (the import UUID).
Original dates use ISO 8601 with an offset. The normal `at` remains the time Forge recorded that version; it is
never replaced with an original date. Search and compact agent rows retain the attribution. It makes no claim
that original identities were authenticated or that imported work landed in Forge.

This is the reader contract. A backlog batch writer, review, Undo and full project archive are not yet available.
The existing internal planning export contains all retained Item and Initiative versions, comments, relations
and linked Intent metadata. It is narrower than a full source and Work archive.
