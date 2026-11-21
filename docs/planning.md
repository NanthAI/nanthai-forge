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

## Item Work

Open an Item from the Plan, including its Done and Dropped lists. Work lists open Lanes
first with their Intent titles and recorded saves. A landing links to Code at the
accepted State, with its recorded check and changed-file count when available. Related
links use the current titles of Initiatives, dependencies and split Items. The Item
discussion and Lane rows use the same identity mark as the rest of Forge.

Work opens with one call to the same bounded reader as the agent CLI. Each request for
more work reads one cursor page. The web details are optional and Work makes no idle
calls. The Landings fold pages retained receipt notes by recorded time, then older
Lane stamps. Check or file evidence unavailable in the retained records stays unknown.
Related resolves both directions from the current Plan records, including Done and
Dropped Items. Reverse links use bounded pages of planning rows, so a later page may
contain a link from an older Item.

The Initiative Progress region rolls up open Lanes, distinct landing receipts and
distinct files touched by its Items, including Done and Dropped Items. It uses the
Item's Intent chain and exact Candidate file evidence, using the member Candidate when
a cohort lands several members together. Partial counts are lower bounds while more
pages remain or older file evidence is unavailable. Each Work page is read once on
request.

Accountable shows the public handle behind the Initiative's creation record.
Working now links to Lanes › Who is touching what and counts distinct agents on
the Initiative's Items from the Plan's existing recent Lane read. That snapshot
uses open Lanes active within 48 hours. When it does not cover all open Lanes
reported by Work, the panel shows a lower bound if some agents are known.
The panel makes no idle calls.

## Status

Stored status words never change. Screens and agent replies show the visible word:

| Stored | Shown |
| --- | --- |
| `proposed` | Proposed |
| `open` | Planned |
| `in-progress` | In progress |
| `closed` | Done |
| `abandoned` | Abandoned (one-press reasons: won't do, duplicate, superseded) |
| `archived` | Archived |
| `deleted` | Deleted |

Status follows real work: starting a Lane from an Item moves it to In progress, and landing with its Done-when lines
met closes it. Done-when lines are the body's Markdown task lines (`- [ ]` and `- [x]`); planning rows carry their
count as `doneWhen: [ticked, total]`.
Put `@due YYYY-MM-DD` before the text of an unchecked line to date it. The agent Loose ends read lists the earliest
pending date on each open Issue, with the exact line number in its body. Dates are calendar dates in UTC and the Issue
body retains every annotation, including dates that have been checked off.

### Archive and Deleted

Archive and Delete are two different places an Item can be sent and brought back from. Both hide the Item from every
plan view, count, agent list and public read; its links, Lanes, landings and comments stay, and so does its Intent's
state. Archive has no time limit. The project owner archives, deletes and brings Items back (planning writes are
owner-only).

Each move is an ordinary put (`put-planning-item` with `"status":"archived"` or `"deleted"`), retry-safe by its
operation id. That version stores `was`, the status the Item left; moving between the two keeps it. Unarchive and
Restore put `was` back, which adds a version and keeps the history. The web sends each move through the batch call,
so every one has the 10-second Undo.

Reads list them only when asked: `planning {"status":"archived"}` or `{"status":"deleted"}`, or `"all"`. A read with no
status, or `"active"`, leaves them out; the Everything view's copyable command is that read with no status (a search
with no status returns open work only, so with Find it says `"all"` and notes that this adds both shelves). The Plan
screen has Archive and Deleted views, one bounded page of 50 at a time from the search roots
(`projectPlanSettled:page`), read only while the view is open. An archived or deleted Item's own page (opened by its
full id or unique short id) reads its current version for the owner. A short id adds one bounded
prefix lookup. The page offers Unarchive or Restore on the matching shelf.
Bringing back a closed Item does not add to today's closed count. An Issue whose Initiative is archived or deleted
stays in members' views under No Initiative, marked "Initiative archived or deleted"; public reads hide it.

A move adds one version row and rewrites one search root. `was` adds about 15 bytes to a shelved version
and its root. A move into or out of Deleted also updates its deadline record in the same transaction.

### Permanent deletion

Delete starts a 30-day recovery window. Deleted shows the date from which each Item is eligible for the
daily purge. Restore or Undo cancels that deadline. Deleting the Item again starts a new window.
Items already in Deleted before deadlines were recorded remain available for Restore and Delete forever.

The project owner can choose **Delete forever** on a Deleted Item's page or in the Deleted list and type
`DELETE` to confirm. The same purge executor handles early and scheduled removal. A daily sweep reads one
bounded index range of due entries across projects and dispatches up to ten in a run. It reads no projects
that have nothing due. An unfinished attempt backs off between sweeps, leaving room for newly eligible
Items. The Deleted view reads deadlines in one indexed range per page, independently of retry updates.
The purge append checks the selected Deleted version atomically, so a restore that lands first keeps
the Item whole. A completed request retains its original completion time for retries.

Forge permanently removes the Item's text, versions and comments from search, history and rebuilds. Landing receipts, Lane records and accepted source remain. Earlier backups and exports, and copies in commit messages or landing notes, stay as they were.

A `purge-planning-item` Work command turns the current Deleted version into an id-only tombstone titled
"Deleted Item". The tombstone carries the purge operation, the Deleted version's time and who purged it.
The executor appends it with its projection in one mutation. Clients call the owner action for early
removal. Every later put, comment or restore on the tombstone is refused with `PLANNING_ITEM_PURGED`.

A purge lists every journal row of its Item (`rows`: operation id and the digest of the row's redacted facts),
recorded while the rows are still whole. That covers the Item's puts and comments, writes made through an alias or
its Intent id, and an Intent-born Item's `intent` row and Lane `note` rows. A purged journal row keeps its envelope
(operation id, revision, actor, time, request hash) and, as its facts, its own command reduced to a keep-list of
structural fields (`redactPlanningWrite` in `src/work-intent-types.ts`: kind, status, versions, links, Initiative,
parent, thread, base), with the words replaced (title and outcome "Deleted Item", empty body and constraints,
comment text "Deleted comment", note text "Deleted note") and free text or attribution dropped (reason, type
label, owner, import facts, note anchor). A field a schema gains is dropped until it is classified, and a test fails
until it is. New planning, Intent, note and purge command rows stay in Convex. The executor also selects older archived
commands. A purged Issue, comment or Intent version keeps its header and digest. Readers accept a
journal row under one rule: it hashes to its request, or it names a purge command that exists, is itself whole,
comes later and lists the row with the digest of its facts, parsed strictly (no unknown key) and holding no words.
Anything else is `INVALID_WORK_JOURNAL`, so a row cannot vouch for its own structure. Replay runs a purged row as its
redacted command and the purge as the tombstone, with the same checks as the first run, so a rebuild keeps every
Item that names the purged one and cannot bring the text back; in a full replay (load, export, recovery) the purge also replaces
the words of every earlier version and comment of the Item, including those from the base checkpoint; the hosted
index keeps them until the purge executor redacts its records. The executor (`projectPlanningPurge.run`, internal) runs a read-only preflight, selects every journal row of the Item under any of its ids (notes
included, at most 1,000 rows, else refused with nothing written), appends the purge and the tombstone in one mutation
(refused if a row of the Item was appended after the selection read), then redacts in bounded pages: journal rows,
the Work index of every record partition, kept or retired ones included (events, versions, comments, notes,
lifecycle, the Intent with its handoff summaries, the Item's root, Initiative record and search row, and stale payload
chunks), the work store's issue, comment and lifecycle versions, bodies and heads, its Intent versions (the Item's
Intent and every successor Intent a later start continued it on: the head becomes a new 'Deleted Item' version that
keeps status and Lane pin, and every older version is purged; the chain ends at a successor id that names an Issue of
its own), the outcome copy on each of their Lanes' overlap rows, lifecycle plan reasons and their copies in
lifecycle events, and the store fingerprints.
The purge uses the work store's retained record pointers and a sparse index of older archived Item
commands and records. On a project whose archive has yet to be indexed, it uses a full archive scan.
The operator can run `projectPlanningArchiveBackfillRun:run` with the project id, repeating until
`done: true`. Each call resumes one bounded page. The backfill reads legacy archive bytes and compares
the number of verified segments with a second pass over archive metadata. Modern record
segments already have their pointers in Convex. The backfill stores its progress and verified
coverage in the journal receipt table. There is no idle job.
Current archive publication keeps the same writes for ordinary records and commands. If a captured legacy
Item command is published, its index entry is written in the same transaction.
The purge checkpoints selection and sweep pages. Before the tombstone, it accounts for newly
published Item commands. Rewriting earlier event bytes invalidates that selection. Long scans continue
from their saved position. The purge replaces only segments
that contain affected rows, keeps their logical positions, and deletes their superseded R2 objects and fragments
before reporting completion. The completion revision invalidates Work exports and recovery selections that carried
older bytes. A stopped purge resumes selection or retirement using the original operation id. Superseded Intent
versions can enter journal segments again. An in-flight Intent archive keeps its upload pins until publication or
cleanup, so a purge can account for bytes from an interrupted upload. Aliases have no index by Intent, so a purge reads all of the project's
aliases and refuses a project with more than 8,000 (nothing written). The preflight also refuses a project that keeps hosted
display snapshots (they copy record bodies under no index by Item), an Item whose Intent has an id of its own, an Item
in a stored base (no creation row after the
backup's revision or a record-detail catalog's: the archive keeps its words and a load or rebuild reads it again, so a
base scrub must come first; a detail migration is refused while a purge is open). The last step also refuses while a Work index build runs or the set of
record partitions differs from the one the check walked. The same pages
run read-only as the completeness check; the purge's `purgedAt` (project `itemPurges`) is set only when the check
finds nothing left on the generation still selected. A stopped purge resumes by running again with the same
operation id, also after an index rebuild. New Issue and comment versions stay in Convex.
A purged Intent or lifecycle version, read by version, answers `PLANNING_ITEM_PURGED` naming the Item. A note or
status change on the Item's Intent is still accepted after the first step (refusing it would cost every note write a
read); the last step refuses to finish while such a note exists, so the purge never reports done over it. A purged decision
comment's own body version replays under a request derived from the comment's (`purgedDecisionRequest`), since the
body it hashed is gone. A put that newly names a tombstone as its Initiative, parent, linked Intent or relation is
refused with `PLANNING_ITEM_PURGED`; links an Item already has stay, so it can still be edited. A retry of a purged
operation answers `PLANNING_ITEM_PURGED`; the same operation id with other inputs stays `WORK_OPERATION_CHANGED`. A
purged record version answers `PLANNING_ITEM_PURGED` instead of a digest failure. `exportJournal` refuses a journal
with a purge to a CLI without the `planning-purge-v2` contract feature (`CLI_UPGRADE_REQUIRED`, also for v1 CLIs); a
legacy source-return whose pinned Work digest a purged row makes unreproducible is checked by envelope continuity
only, and the export's coverage says so. Healthy rows cost nothing extra; a page with purged rows looks each distinct
purge up once (up to two indexed reads). A put that newly names a link, parent, relation or Initiative
reads those Items' latest versions (and their alias and Intent) after its other rows, so the live write refuses a
tombstone exactly as a full replay does; a put that names no new link reads nothing more. That check asks for each key
once (a key that came back empty is not asked again), and every large Intent's payload is read in the same batched
lookups (100 keys per call), so linking k Items costs about three lookup calls, not one per Intent. Schema 16+ only: older
reducers do not check links.

### Versions

The Item page compares any two versions by line, marking the changed words inside a rewritten line, and restores one
as a new version (`reason: "Restored version N"`), with Undo. A restore at a stale version is refused with
`ITEM_CHANGED` and overwrites nothing. When a body edit clashes with someone else's save, the editor keeps your
text: Keep both saves it as the next version over theirs (theirs stays in Versions), Take theirs drops it.

## Hand order

The list has one hand order. An Item that was never moved has no stored `order` and sorts by its creation position.
A move stores `order`, a rank strictly between the two neighbours' ranks (`rankBetween`); nobody else is rewritten.
An Item moved to the end (`rankAtEnd`) still sorts before Items created later. The plan order is: Initiatives by
their own rank, then No Initiative; within each group, Items by rank, each followed by its sub-items (`planOrder`).
Initiatives move the same way: a moved Initiative stores one `order` between its neighbours among the Initiatives
shown (the web Plan's group headers and the Initiatives overview).

## Next

The web Plan derives "Next" from the current view. It selects the first Planned Item in plan order with no owner,
no Lane and no open `depends-on` dependency.
To choose the next Item with the CLI, [read the ordered active Plan](guides/plan.md#find-the-work) and
check eligibility before starting.

## Fields

All are optional and absent on older records. A put that omits a field keeps it; `null` clears it (`relations: []`,
`hidden: false`).

| Field | Meaning |
| --- | --- |
| `order` | Hand-order rank, 1 to 64 letters and digits, never ending in `0` |
| `type` | Type label |
| `parentId` | Parent Item (Items only) |
| `owner` | Who has the Item: a Forge handle or `handle/agent`. A start from an Item with no owner sets it to the starter's public identity; a set owner is kept |
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
default scope. `"all"` adds done, dropped, archived and deleted Items. For a list or a search, pass an array
of stored statuses to match any of them. The Closed view copies `"status":["closed","abandoned"]` with `"kind":"issue"`.
An indexed search with multiple statuses filters each bounded search page, so continue with its cursor
even when that page has no matching Items. The web Plan screen keeps the same fields in its address, and a
saved view is a personal shortcut to them.

## Progress

Needs me and Plan show the same project-wide Item counts, including when Plan is filtered. Done counts all
closed Items, In progress counts Items in progress, and Left counts planned Items and lists proposed Items
separately. A `+` marks a lower bound.

An Initiative's progress counts its Items and their sub-items, one tick each for done, in progress, open,
proposed or removed. Plan and the Initiative page use the same breakdown. A narrow Plan group header shows
each status as a coloured swatch and count so the Initiative title stays readable. Hover or focus a count to
see its status word. There is no typed percentage (`progress`).

## Public plan

On a public project the plan (Items, Initiatives and comments) is readable by anyone. The project setting
`planVisibility: "members"` keeps all of it to members. An owner can hide one Item (with its sub-items) or an
Initiative together with every Item in it; hiding is reversible. Every public read and every public count uses the
one rule `publicPlanVisible`: a hidden Item never appears or counts anywhere public, and a read that has not looked
up an Item's Initiative or parent treats it as hidden.

"Public" means every viewer without a project role, signed in or not; readers, writers and the owner see the whole
plan. The rule covers the public project page, the Plan screen (its open rows, its Done and dropped pages and its
counts, which for a viewer without a role count only the Items they may see, from the stored counter's visibility
groups: one row plus the Initiatives and parents it names, never the Items), CLI and MCP planning reads (lists, one
Item with its comments and landing receipts, search, counts and short ids; a search's read statistics are zero), the
Lanes list, queue, conflict notices and History (each names a hidden Item nowhere: a Lane row of a hidden Item carries
a stand-in Intent id) and People: on a members-only plan a viewer without a role sees no Items-closed or comment
counts. A members-only plan's pages are empty and finished for such a viewer. Agent briefings are for members: they
render Lane names and the project's recent messages. With the Lane-title opt-in on, a viewer without a role sees a Lane's title only
when the read ties its Intent to a visible Item: the Intent is that Item, or a follow-up Intent of an Item the read
loaded (the public project page loads the open ones). A Lane on a hidden Item, one the read cannot tie to a visible
Item (including Lanes started without an Item) and every Lane of a members-only plan shows no title. An Intent's
constraints (the Item body a planned start copies) never reach a viewer without a role. A read that selects plan work
by Item, Initiative or Intent (an Item and its comments, its work as `planning {id}` and the Item page read it,
`lanes {planningItemId|intentId}`, History by Item, a Plan page by Initiative, Work records of an Intent or of its
Lanes, each Intent of a list such as the related coordination feed), live or from journal history, runs for a viewer
without a role as for an id no record has, cursors, totals and errors included, unless the id is a visible Item (an
Item's first Intent shares its id). A Lane row names a hidden Item by no field: a stand-in id takes its place. A follow-up Intent
cannot be tied to its Item without reading the plan, so a filter by one answers as absent: filter by the Item instead.

On a public plan, a hidden Item still leaves a visitor's settled, list or search page shorter than asked, and a
search cursor can show that a term matched more than one page, and its Lanes stay listed without title, under a
stand-in Intent id, so they can be counted; no Item, title or id of it reaches the reply, and a page left empty is
finished. A request such a viewer sends that is not a JSON object is refused; so is a journal history request that
is not one, for every viewer (`BAD_ARGUMENT`). Archived and Deleted Items are never public, under any setting. Only the project owner switches the plan between
public and members-only (`publicDiscovery:setSettings`, next to the Lane-title opt-in); there is no web control for
it yet.
`tests/public-plan-access-matrix.test.mjs` checks every viewer against every setting on these reads.

When Plan resolves an Item page, Work opens with one page of 10 Lanes from `projectItemWork:read`, the same
reader agents use. Work shows the Lane count and links the receipts on those Lanes to Code at the landed State.
Show more work advances the Lane, landing and Related cursors that still have pages. Work stays idle between requests.

Who wrote a comment comes from the sign-in, never from typed text: a browser sign-in is the person, a device
credential is an agent run (its session slug, and the model its launcher declared in `FORGE_AGENT_MODEL`, stored as
`agentClient` beside the slug; declared, not verified). Members see `@handle` and "person", or `handle/run`, "agent"
and the model ("model not declared" when none). Readers and public viewers see no person: "a person", or the run
name with its model.

Landing receipts on Items (Issue 3a733ee8): each Intent started from an Item gets one system comment per
landing, whether accepted by its agent, a person or the queue after the agent stopped
(incident 2bf85ddf). An explicit accept of a cohort credits the caller on the claimed member and the queue on
its peers. A resolution Lane also notes the origin's Item, including on `keepOpen` and `closes:false` landings.
A revert posts a matching "Reverted" comment.

The comment appears as `Forge`, with `system: true` and a `landing` object containing the Lanes, receipt,
commit, main sequence, `landedBy` (`queue`, `agent` or `person`), `accepted` (`person` or `policy`) and the
submitter's handle where the viewer can see it. Person acceptance includes carried owner approval.
System comments take no reply or reaction. Agents see the `systemComments` advisory beside them.

Completion skips this comment for Intents created independently. Linking one to an Item later leaves the
receipt available under Work. Older Intents without a recorded origin continue to produce notes.
Later ticks and input pages add Lanes to the same note
within the existing five-Lane display limit. The Item discussion shows up to 50 system notes per page from its
own and linked Intent chains. The comment cursor continues large sets of links. A merged Item shows the
duplicate's receipt-backed notes alongside copied member comments. Planning exports include these notes as
evidence. Project backups continue to derive from the recorded Work history.

An Item read (`planning {planningItemId}`) returns its newest 50 comments, oldest first. When more exist it adds
`commentsMore: true` and `commentsCursor`; `planning {planningItemId, cursor: commentsCursor}` returns the next 50
older comments (one bounded page read, no Item, work or reconcile read) and its own `commentsCursor` until none are
left. The cursor names its Item and Work generation, so another Item's id or a list cursor is refused.

## Imported history attribution

Retained planning readers accept optional `imported` attribution: `source` (a source note), `key` (the original
record key), optional `createdAt`, `closedAt` and `originalHandle` (a public handle), and `batchId` (the import UUID). Original dates retain a date-only value when that is all the source records, and stay absent when unknown; source handle case is preserved.
Original timestamps use ISO 8601 with an offset. The normal `at` remains the time Forge recorded that version; it is
never replaced with an original date. Search and compact agent rows retain the attribution. It makes no claim
that original identities were authenticated or that imported work landed in Forge.

The backlog writer is staged default off; web review, import Undo and a full project archive remain open.
The [planning history download](#planning-export-and-full-archives) retains import attribution alongside each
exported version.

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

Project owners can download `forge-planning.json` from their project’s `/planning` page.
Choose **More planning actions** → **Export planning history**. This exports retained planning history across the project. Forge checks current
ownership before loading the history and again before returning it.

The downloaded UTF-8 JSON has `schema: 1` and `kind: "forge-hosted-planning"`.

| Field | Contents |
| --- | --- |
| `projectKey`, `name`, `workRevision` | The project and revision selected for the export |
| `items` | Retained Item and Initiative versions, with IDs, relations and original import attribution where recorded |
| `comments` | Retained planning comments with their own IDs and parent Item IDs |
| `landingNotes` | Retained system landing and revert notes keyed by Intent, with submitter handles where available |
| `linkedIntents` | Retained Intent metadata for links in any exported version, including a surviving planned Intent |
| `events` | Retained hosted Item and comment operations |
| `coverage` | What the export represents, including the scope of server-recorded actor observations |

The file contains planning data. Source and history, check and acceptance receipts, and Lane metadata
have separate [source and recovery paths](guides/export.md). The [backlog importer](#backlog-import)
takes source-keyed rows. It does not read this file as an archive or replay comments or receipts.

A portable project archive and fresh-project import are planned. Existing hosted recovery
restores the original project from retained checkpoints and history.

## Plan list projection

The Plan query reads compact `_workStorePlan` pages in the existing data partition. Each leaf holds at most
128 rows, grouped by kind/status (settled Items also by Initiative), and splits sooner above 11 KB of encoded
payload. Leaves cover creation-position ranges rather than fixed position windows, so gaps do not create mostly
empty pages. The existing parent/position index selects one predecessor leaf; a new interval can also read its
successor. Portable DEFLATE and the row payload remain compatible with earlier readers. Settled pages contain
positions only. Live pages contain only the PlanRow allow-list and Done-when counts; bodies, comments, authors,
times and source bookkeeping stay in their existing records.

A completed search preparation stamps both a selected alias and its record partition. Historical aliases whose
partition marker is older can still prove complete coverage for their exact shared partition; exceptional repair
uses at most two extra authority/generation reads for this legacy proof, never per Item.

`planRowsVersion: 1` still means complete coverage, independent of leaf layout. New leaf keys identify the
128-row layout; an ordinary write encountering old keys clears coverage and requests one bounded replacement
repair. Untouched covered generations remain readable. The writer maintains prepared leaves in the source
transaction, caching each touched leaf and already-observed root. Non-root planning rows retain only their
classification in that cache, so payload retirement and header repair do not read their bodies twice. Row limits,
permissions, ordering, counts and exact Item/agent reads are unchanged. Reads never start a backfill.

Plan also reads transactional authority/Work-pointer and generation headers from `projectFinishReadRows`.
Controller history and journal-only patches neither look up nor invalidate Plan headers. Missing or unusually
large headers retain exact source reads; ordinary relevant writes restore them. The finite landing observer
keeps its separate authority header without a Work-pointer dependency.

The existing owner-only `projectHostedPlanningPrepare:page` accepts `planRowsOnly:true`, project/owner/generation
pins, an operation UUID and `cursor:null`. It first deletes only this partition's Plan pages in batches of at most
32 documents/1 MB, then re-applies at most 100 search roots/1 MB per call. No roots are re-applied before clearing
finishes. Retry receipts preserve exact responses; concurrent rebuilds continue the current shared progress.
Canonical root bytes, versions and unrelated collections stay untouched. Coverage stays off until completion,
and ordinary writes between pages are included. Full search preparation requests the same finite Plan repair.

Layout upgrades and oversized-leaf fallback schedule the internal `repair` continuation automatically, one
fenced mutation per bounded step, coalesced per partition. A stale callback is a no-op. Metadata beyond the
internal envelope still succeeds as source data and uses exact legacy reads; one repair pass stops as blocked
if it still cannot fit. A relevant edit, move or deletion starts repair again automatically. An edit during a
blocked pass can request one additional replacement pass. There is no polling, idle timer, title limit,
truncation or mandatory operator preparation. When finite work ends, idle costs zero calls and writes.

“Public” means every viewer without a project role, including a signed-in account. Public query registration
and journal re-entry apply this rule to Item bodies, versions, comments, reactions, list rows and counts. Members
retain the exact plan. Role-less planning reads through compact authority headers load the current canonical
project policy once inside the same query; old headers omit that policy. Members keep the compact path, with
no new function call or header write. Cached discovery pages can retain the last public response for up to 30 seconds after an
in-flight pre-change read finishes; browser responses revalidate and no stale copy is served after expiry.
