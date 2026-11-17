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

## Batches

One action on many Items (move, re-parent, assign, change status or type, close many, split, merge) is one batch:
a list of at most 100 ordinary puts and comments sent in one call, `projectPlanningBatch:apply`
([`src/planning-batch.ts`](../src/planning-batch.ts) builds the lists). Each write is checked and journaled exactly like
a single one, so readers and replay do not change. Each write's operation id derives from the batch's, so a retry
applies nothing twice. The reply gives every write's outcome: applied, replayed, or refused with its reason. An Item
that changed after it was read is refused with its current version and is never overwritten; the rest still apply.

- Undo is one more batch that writes back each field the batch named (`batchUndo`). A new Item made by the batch is
  abandoned with the reason "Undone"; copied comments stay, since comments are never deleted.
- Close many sets each Item to Done with one note as its reason. An Item with open Done-when lines closes with that
  note, or with the one-press close-anyway reason; the reply names those Items so a follow-up can be offered.
- Split gives each Done-when line to one part. The Item keeps its prose and the lines it keeps; each new part is a
  Planned Item in the same Initiative and parent, related both ways to the Item.
- Merge carries each duplicate's Lane links (its planned Intent and linked Intents) and a copy of each comment to the
  surviving Item, and abandons the duplicate as a duplicate with a `duplicate-of` link. Items have no watchers yet,
  so there are none to carry.

Agents send the same batch as `put-planning-item {"batch":[…]}` ([workflow](agents/workflow.md)).

## Filters

Reads filter by type, owner and relation with one rule ([`src/planning-filter.ts`](../src/planning-filter.ts)), as
well as by kind, status and Initiative. `owner: "none"` matches Items with no owner, and a person's handle also
matches the agents working for them (`handle/agent`). `relation` is a relation kind (`depends-on`, `duplicate-of`,
`related`) or `"none"`. `status: "active"` is open work (Proposed, Planned and In progress), the Plan screen's
default scope; `"all"` adds done and dropped Items. The web Plan screen keeps the same fields in its address, and a
saved view is a personal shortcut to them.

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
record key), optional `createdAt`, `closedAt` and `originalHandle` (a public handle), and `batchId` (the import UUID). Original dates retain a date-only value when that is all the source records, and stay absent when unknown; source handle case is preserved.
Original timestamps use ISO 8601 with an offset. The normal `at` remains the time Forge recorded that version; it is
never replaced with an original date. Search and compact agent rows retain the attribution. It makes no claim
that original identities were authenticated or that imported work landed in Forge.

The backlog writer is staged default off; web review, import Undo and a full project archive remain open.
The existing internal planning export contains all retained Item and Initiative versions, comments, relations
and linked Intent metadata. It is narrower than a full source and Work archive.

## Backlog import

Agents translate the source into one `planning` transfer. Forge does not have a parser per tracker or ongoing
tracker synchronization. Preparation reads the proposed rows and matching source keys without writing planning.
Preparation uses normal planning read access. Apply uses the same planning reducer and authority as ordinary
puts, including an authorised owner device.
With existing authorization, an agent can send `apply:true` directly.
Imports create planning history, never Lanes, checks or landing receipts.

The writer is staged behind the deployment setting `FORGE_PLANNING_IMPORTS=1`, default off. Readers landed first.
Preparation, completed-operation replay and ordinary edits of retained imported work stay available before
enablement; new imports on a deployment that has not enabled the writer report
`HOSTED_ACTION_UNSUPPORTED`. Undo, look-alike merging and the web review are still open on the backlog import
Item. The writer has synthetic coverage; live import and billed usage are not yet qualified.

A transfer has `mode: "import"`, `rows`, optional `batchId`, and `apply` (false for preparation). Each row has:

| Field | Meaning |
| --- | --- |
| `key` | Stable source key, unique within the project; include a source namespace |
| `source` | Original source note, such as a repository-relative document path or Issue URL |
| `kind`, `title`, `body` | `issue` or `initiative`, title, optional body |
| `status`, `reason` | Original final status and optional reason; status defaults to `closed` |
| `createdAt`, `closedAt` | Optional original ISO calendar date or timestamp with an offset; missing stays not reported |
| `originalHandle` | Optional public Forge or GitHub handle; never invent a handle from a person's name |
| `initiativeKey`, `parentKey` | Source keys for the Initiative and optional parent Item |
| `fields` | Existing planning fields, including hand order and type |
| `selected` | Whether to apply this row; true by default |

Source keys derive stable Item ids, independently of the import operation. The same key is skipped on later
imports, including after someone edits the Item. No existing Item is overwritten. Source-key matches appear in
the review, with attention rows first. Each apply page has an immutable request and receipt. A server-side page failure rolls back its additions. A lost reply may already have committed; replaying its
original operation reconciles the result. A partial reply lists confirmed created and skipped ids, retained rows,
the unconfirmed page and unfinished keys. `applyRequested` names the request, not an unconfirmed outcome.
Replay the same input and operation id to retry unfinished pages. Changing rows or selections needs a new
operation id; keep the `batchId` to group the changed request with the same import.

Normal puts that omit retained import attribution keep it.

### Recipe: recreate past milestones, then plan the next one

Ask your agent: “Read the milestone documents, recreate the completed milestones and their Items as closed
planning, preserving dates and source references; then create the next milestone as Planned.” The agent reads
those documents and prepares a request file like this synthetic example:

```json
{
  "transfer": {
    "mode": "import",
    "rows": [
      {"key":"docs:m3", "source":"docs/milestones/m3.md", "kind":"initiative", "title":"Milestone 3", "status":"closed", "closedAt":"2024-03-05"},
      {"key":"docs:m3/task-1", "source":"docs/milestones/m3.md", "kind":"issue", "title":"Previous task", "initiativeKey":"docs:m3", "status":"closed", "createdAt":"2024-01-02", "closedAt":"2024-03-05"}
    ]
  }
}
```

Run `nforge agent ROOT planning --command-file import.json`. Review every returned row, then add
`"apply":true` inside `transfer` and replay with the returned operation id. On an enabled deployment this applies
the prepared request. Create the next Initiative with `put-planning-item` using `expectedVersion:0`,
`kind:"initiative"`, `title` and `status:"open"`; put its new Items in that Initiative with `initiativeId`.

The same recipe works for GitHub Issues: the agent reads an authorised Issue/milestone export or API, gives each
row a stable key such as `github:owner/project:issue:123`, maps completed work to `closed` and won't-do work to
`abandoned` with its original reason, and keeps the Issue URL in `source`. It uses only known public handles and
original dates. Pull requests, tags, CI configuration and accounts do not become imported planning or Lanes.

The client sends at most 100 rows per page, targeting 128 KiB of row JSON; a larger individual row gets its own
page. There is no total row ceiling in the transfer client. A 1,000-row request takes ten prepare queries and ten
apply mutations, plus the existing capability read for each command. At 2,000 rows those are twenty and twenty.
Completed pages are local retry receipts; retrying known completed pages writes nothing. Idle adds no calls.
Source text and attribution use existing planning records and their existing history archival path. No new table,
archive store, worker or idle scheduler is added.

## Planning export and full archives

The existing internal planning export reducer contains retained Item and Initiative versions, comments, relations,
import attribution and linked Intent metadata. A hosted planning download/action and full project archive are not
yet available. Full archive work must preserve source/history, planning, comments, receipts and Lane metadata,
apply current visibility, and distinguish imported historical receipts from acceptance authority in a fresh
project. Existing same-project recovery is not that fresh-project round trip.

## Plan list projection

The Plan query accepts compact `_workStorePlan` pages in the existing data partition. A page holds at most 512
creation positions, grouped by kind and status (settled Items also by Initiative); each page uses portable DEFLATE compression, and settled pages hold positions only. It contains only the list fields and Done-when counts. Item bodies, comments, exact agent reads and
search remain in their existing records. `planRowsVersion: 1` on the generation means every root is covered. Older
generations keep the existing indexed search-root reader until preparation completes; reads never start a backfill.
The Work writer updates these pages in the same transaction as every search-root change, including batched
planning writes, imports and rebuilds. Each touched page is read and flushed once per transaction. Fresh partitions
carry the marker from creation and become readable only after publication; aliases use their partition's current coverage.
The query's row limits, permissions, order and counts stay the same. No screen open writes or prepares data.

Plan also reads transactional authority/Work-pointer and generation headers from the existing `projectFinishReadRows` table. Generation headers retain the selected schema, status and coverage rather than the full index metadata. The finite landing observer keeps its separate authority header without a Work-revision dependency. Project controller history and journal revisions neither look up nor invalidate Plan headers. Empty projects and removal tombstones retain no Plan project header. Missing or unusually large headers use the exact source records; ordinary relevant writes and explicit preparation install the small headers without query-triggered backfills.

For an existing complete search generation, the owner can call `projectHostedPlanningPrepare:page` with
`planRowsOnly:true`, the project/owner/generation pins, a fresh operation UUID and `cursor:null`; continue with the
returned cursor until `isDone`. Each call handles at most 100 roots/1 MB, retains an exact retry receipt and changes
only the disposable projection. Full search preparation also fills Plan pages. Partial preparation keeps the legacy
reader, and planning changes between pages are included by ordinary transactional upkeep. `compactReady:false` reports a completed pass that retained exact legacy reads because unusually large list metadata outgrew the compact page envelope. Such Item writes still succeed without truncation; a fresh pass can compact the partition after that metadata changes.

“Public” means every viewer without a project role, including a signed-in account. Public query registration
and journal re-entry apply this rule to Item bodies, versions, comments, reactions, list rows and counts. Members
retain the exact plan. Role-less planning reads through compact authority headers load the current canonical
project policy once inside the same query; old headers omit that policy. Members keep the compact path, with
no new function call or header write. Cached discovery pages can retain the last public response for up to 30 seconds after an
in-flight pre-change read finishes; browser responses revalidate and no stale copy is served after expiry.
