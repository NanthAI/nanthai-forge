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
characters. In CLI and MCP writes, set the Initiative via `initiativeId` and a sub-item's parent and type
via `fields.parentId` and `fields.type` on `put-planning-item`.

A `planning` list or search can group the returned page without another read. For example,
`nforge agent ROOT planning '{"status":"active","groupBy":"owner","reconcile":false}'` (MCP: `forge_planning`
with command `action: "planning"` and the same fields). Group by `initiative`, `parent`, `owner`, `type`,
`status`, `kind`, or `none`. The reply keeps `items` and adds `groups: [{key,itemIds}]` for that page; a
null key is the last group and includes Items without the field. The cursor is unchanged; the same
key on successive pages is the same group. Grouping doesn't fetch unseen parents or Initiatives.

## Link work to Items

Hosted projects with a prepared Plan capture a title-only Item when an agent starts a new Lane from an
outcome instead of an existing Item or Intent. The Item is already In progress, shares its ID with the
Intent, and is visible to project members, not visitors. Forge copies only the outcome, not the
constraints, and uses no model. Retrying the start returns the same Lane and does not add another Item.

**Link work to Items** is on by default. Owners can turn it off in Settings → Project → Plan, or with
`nforge agent ROOT set-policy '{"autoCreatePlanningItem":false}'`. Pass `true` to re-enable it. This changes
future starts only. Archive a captured Item to remove it from the Plan without stopping its Lane.

## Title-only capture and optional agent refinement

Use **New Item** on the Plan, or `nforge agent ROOT put-planning-item '{"kind":"item","title":"…"}'`.
A title is enough. The Item can be edited later without starting a Lane.

**Agents write Item text** starts off for each project. The owner can opt in under Settings → Project →
Plan or with `nforge agent ROOT set-policy '{"agentsWriteItemText":true}'`. An agent's policy edit may be
held for owner-person approval; check the result before refining. Use `false` to turn it off. Turning off
Link work to Items also pauses agent refinement without erasing the preference.

When asked to refine an Item, an agent first runs `nforge agent ROOT planning '{"id":"ITEM","refine":true}'`
(or the same `planning` command in `forge_planning`). If `refinement.enabled` is false, do not run a
model for refinement. If true, use the returned title, body and version to suggest changes with the model
in your own tool. Forge does not call a model, edit the Item, or start a Lane. To apply agreed changes, use
`put-planning-item` with `itemId` set to `item.id` and `expectedVersion` set to `item.version`.

## Item Work

Open an Item from the Plan, including its Done and Dropped lists. **Text** renders the Item's Markdown and folds long prose in place. **Done when** lists the task lines in their stored order: open (`[ ]`), done (`[x]`) or moved (`[~]`, not counted). Text and Done when use one selected Item read, refreshed only when the Item's live version changes. When a retained body doesn't fit in the first record, **Show all text** loads it on request. Task examples inside Markdown fences are prose, not checklist lines. The Item page and wide Plan rows show the exact ticked count beside the same bar: one block per line up to 12, then 12 grouped blocks. Partial blocks fill from the bottom in thirds, so even one tick is visible. Narrow Plan rows keep the space for the title; open the Item to see its bar.

The owner and current project writers can edit the text, add or edit a checklist line, mark it moved, reopen it, or remove it with Undo. **Tick and post** saves the tick and its decision comment together. A stale line edit retries only if it can still identify the unchanged line; a stale prose edit keeps the draft, offers the versions to compare and then lets you resume the draft against the newer version. New Item capture takes an optional Markdown description above the checklist. Readers cannot change Items. Managing the rest of the Plan, including shelving and deleting Items, remains owner-only.

Work lists open Lanes
first with their Intent titles and recorded saves. A landing links to Code at the
accepted State, with its recorded check and changed-file count when available. Related
links use the current titles of Initiatives, dependencies and split Items. The Item
discussion and Lane rows use the same identity mark as the rest of Forge.

Work opens with one call to the same bounded reader as the agent CLI. Each request for
more work reads one cursor page. The web details are optional and Work makes no idle
calls. Lanes, Landings and Related start open with three rows each; **Show more** reveals rows already held, without another read. History starts open with one page of 25 events, shows its first three, and reads another page only when asked. Folds remember the reader's choice. Landings pages retained receipt notes by recorded time, then older Lane stamps. Check or file evidence unavailable in the retained records stays unknown.
Related resolves both directions from the current Plan records, including Done and
Dropped Items. Reverse links use bounded pages of planning rows, so a later page may
contain a link from an older Item.

The Initiative Progress region rolls up open Lanes, distinct landing receipts and
distinct files touched by its Items, including Done and Dropped Items. It reads the
totals in one query when opened. Landings use a project-owned rollup maintained after
acceptance completion. Files use retained Candidate paths, including the member Candidate
when a cohort lands several members together. A `+` marks a lower bound when file
evidence is incomplete or the active Lane read reaches its bound. Landing and
file totals show a dash until existing history has been backfilled or a rebuild finishes.

Accountable shows the public handle behind the Initiative's creation record.
Working now links to Lanes › Who is touching what and counts distinct agents on
the Initiative's Items from the Plan's existing recent Lane read. That snapshot
uses open Lanes active within 48 hours. When it does not cover all open Lanes
reported by Work, the panel shows a lower bound if some agents are known.
The panel makes no idle calls.

## Read budget

Opening the default Plan uses one bounded Plan view, one count read, and at most one batched workers read.
The route shares the project's line and Needs me reads; a cold link also resolves the project and viewer.
Opening an Item already in that Plan keeps those reads. It adds one Work page and bounded discussion reads;
owner writers also read the comment reactions. A short link or a row outside the loaded Plan can need one
point lookup. History, further pages and shelf reads are on request, not background work.

For a call-count check, start with a signed-in tab on the board's real project. Count new Convex subscriptions
and one-shot requests from the cold Plan open, then count the extra calls when clicking one loaded Item in
that tab. Record the role, visible root count, any capped windows, and the scope of the count. Leave the tabs
untouched and count new requests separately from server updates: a peer's write can update existing
subscriptions, but time passing alone does not start a query. Reply bytes are not billed database bytes.

## Open work and closed history

Plan opens in **Open work**: Proposed, Planned and In progress. Done and dropped Items do not appear there.
Switch to **Closed** and use Find to narrow the loaded history by title or Item id. Find cannot see
older rows until **Load more** reads them. For an indexed search across closed history (including bodies),
use `nforge agent ROOT planning '{"search":"words","status":["closed","abandoned"],"kind":"issue"}'`,
or send the same fields with `action: "planning"` to `forge_planning` in MCP. Search without a status
only finds active work. A `nextCursor` means the search is incomplete, even if the current page has
no matches. Continue with the same filters and `cursor: nextCursor` until you find the Item or the cursor is null.

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

Status follows real work. Starting a Lane from a Planned Item moves it to In progress. The Item keeps its
Intent link, and Work follows that Intent to the Lane and its check and acceptance evidence. A landing posts
its receipt to the Item even if the agent is no longer running. A landing that completes the Intent lets the
next reconciling planning read close the Item, without a manual status edit. If any Done-when lines remain
open, the Item stays open and the read names the remaining lines. These are the body's Markdown task lines
(`- [ ]` and `- [x]`); planning rows carry their count as `doneWhen: [ticked, total]`.
Put `@due YYYY-MM-DD` before the text of an unchecked line to date it. The agent Loose ends read lists the earliest
pending date on each open Issue, with the exact line number in its body. Dates are calendar dates in UTC and the Issue
body retains every annotation, including dates that have been checked off.

### Status roll-up (design; not yet active)

- **Start.** A Lane start moves its unpinned Item to In progress. An In progress descendant moves every unpinned
  Planned ancestor Item and the applicable Planned Initiatives to In progress. Completed work is also evidence
  of starting when there is still open work in the scope. Proposed Items still require planning; a Proposed or
  pinned ancestor does not stop the start signal from reaching the next level.
- **Done.** An Item closes when its own Done-when lines are met and its children are settled (Done or Abandoned).
  An Item with linked work still needs that work to finish. A parent without its own Lane can close after its
  last child settles. An unstarted leaf without a checklist does not close merely because it has nothing to tick.
  After the last child settles, a parent with unchecked lines stays open and the Item shows the remaining lines.
  An Initiative closes when it has at least one Item, every Item in it is settled and its own Done-when lines are
  met. It becomes Abandoned if all its Items were Abandoned, or Done if any Item was Done. The reason names the
  rule that moved it. Archived and Deleted rows are outside the live Plan, so they neither block closure nor count
  as completed work. Initiative membership is the Item's stored `initiativeId`, counted once even when that Item
  is nested.
- **Reopen.** New or reopened work under a settled parent or Initiative reopens it. It becomes In progress if
  work in its scope has started, or Planned if none has. A Lane start or recorded completed work is evidence of
  starting; abandoning an unstarted Item is not. A reopen does not reopen any settled children or recreate Lanes.
- **Override.** An explicit manual status change pins that Item or Initiative. Its status shows who pinned it
  and when, from the retained version. Editing the title or checklist does not pin it. Automation, including
  start and completion, leaves the pinned status alone, but still forwards facts about the children and updates
  the rest of the tree. A pinned Done Item counts as Done in its Initiative; a pin does not settle its descendants.
  Close and bulk status changes pin each changed row. On the web choose **Follow work** in the status menu;
  in CLI or MCP use `put-planning-item` with the current `expectedVersion` and `fields: {"statusPin": null}`.
  The member Item or Initiative reply shows `statusPin` with who and when; clearing starts the same evaluation
  as a new work change, so an open child can reopen the row or a settled scope can close it. If no rule applies,
  the status stays where it is. To undo an automatic change, set the previous status, which pins it. Batch Undo
  restores the previous pin with the previous status; Archive and Restore from the shelf keep the pin state.
- **Project setting.** **Roll up planning status** defaults to on; the owner can turn it off in Settings → Project →
  Plan. Off stops ancestor and Initiative changes, not an unpinned Item's own start and finish behavior. The signal
  is the Item's work and checklist state, its direct children's maintained facts, and the Initiative's membership
  tally. The formula is the rules above: on applies them; off leaves aggregate statuses alone. There is no tuned
  range beyond off and on. In manual mode the hint is “Automatic would turn this on because status follows work.”
  The top metric is flow (landings that stay landed); check minutes, wall time and cost per 1,000 landings guard it.
  This setting does not change Lane creation, completion, acceptance or autonomy policy. Direct counter facts
  are still maintained while off. Switching back on starts one bounded catch-up using the existing recompute
  path; it does not wait for another Lane or schedule recurring work.

Automatic changes append ordinary retained planning versions, not a separate history. Versions and History say
what changed and why, with a Forge actor and a rule such as “Done: last child closed”. CLI, MCP and the web use
those same stored statuses. Explanations in public replies must not identify hidden work or disclose private
checklist content or attribution; audit reads keep their existing member access rules.

#### How roll-up is bounded

Reuse the planning counter writer and its record partition. Keep exact status tallies keyed by parent and by
Initiative; do not use the capped public visibility groups as a source of truth. Track open work and evidence of
starting through an overridden ancestor separately from that ancestor's displayed status. On a status or link
change, subtract the old contribution and add the new one, including moves out of an old parent or Initiative.
A body-only edit whose checklist facts did not change touches neither tally. One write evaluates one level; it
can process a bounded page of targets at that level. It does not enumerate siblings or descendants.

Schedule the next affected level after commit, coalescing the same target within a page. Each step checks the
current setting, generation, links, counters and Item version; it never overwrites a newer override or applies a
stale delta. The causing operation and target version identify the derived write. The contribution, version and
successor checkpoint commit together, so a retry neither changes the counters twice nor loses its next step.
Stop when facts no longer change, at a missing or shelved parent, or when a target repeats. The depth budget is
16 ancestor levels per continuation segment; deeper valid trees continue in another segment, not a new nesting
limit. For a pinned topology of `N` live-Plan Items, the absolute bound is `N − 1` Item ancestors per starting
Item. Initiative evaluations are terminal. If a target repeats, stop that path without treating the cycle as
settled. If topology moves, evaluate the old and new affected links from their current facts. There is no polling,
idle call or extra client round trip.

| Planning status work for one linked Item landing | Before | Design budget after |
| --- | --- | --- |
| Acceptance and required completion | No planning status read or write in the acceptance transaction. Completion already schedules the Work fold. | No added read, write or call on acceptance or required completion. Start evaluation in the existing background Work fold. |
| Item closure | No status change without a reconciling read or last tick. Reconciliation reads the Intent state (one point read, in the page query), reads the selected Item, then appends one ordinary status version; an unticked checklist can instead append one hold version and one comment. | Reuse the fold's project and Item root, read at most one child tally plus one Intent head for the Item, and append zero or one ordinary status version. Replace the closing read and hold writes; clients no longer drive status. |
| Propagation | Zero reads and writes for parents and Initiatives. | Per affected target: at most one root and one tally read for the decision, one counter update per changed contribution, and zero or one ordinary status version. Pages share scope reads and the scheduler continuation; stable facts and disabled roll-up add no ancestor step. |

For one landing that closes one Item, the old status path selects two records (Intent state and the Item, not
counting their lookup and payload overhead) and appends one version. The new bound, excluding the fold's
existing reads, is `2 + 2(H + I)` point reads for decisions and at most `1 + H + I` version appends, where `H`
is the number of affected ancestors and `I` the number of distinct affected Initiatives (at most `H + 1`). There
are at most two maintained counter updates per changed Item and one wake per nonempty page needing a successor.
For one parent and one Initiative this means at most six decision reads, four counter updates and three version
appends, instead of two record selections and one version append. A landing with no due status work adds no
ancestor reads or writes. A cohort batches by page and deduplicates shared targets before these counts apply.

Version appends include their existing audit, index and projection work; they are not single database document
writes. Measure whole-document and billed I/O separately from scheduling on a small fixture and a Plan with
about 1,300 roots. The per-level I/O is independent of sibling count, and peak memory is one bounded page plus
the ordinary version writer's working set. Last-child propagation time depends on depth and scheduler latency,
not width. Measure it off the acceptance critical path rather than assuming a scheduler deadline.

#### Existing Plans

Before making decisions from the new counters, a one-time recompute builds complete coverage in a selected
partition, then evaluates statuses from the leaves up. Use indexed pages of at most 50 roots and a 256 KiB compact
working page, with a saved cursor and a revision fence. Interleaved writes must be accounted for before publishing
coverage. An incomplete pass supplies no zero counts and cannot produce an automatic close. No source bytes move.

For an initial, lead-approved **dev-only** run on a Plan of about 1,300 roots, budget two root passes (about 2,600
root reads before point reads and status appends), at most one status append per changed root, and a cumulative
stop of **0.10 GB billed Convex database I/O ($0.02 at $0.20/GB)**, including index I/O, retries and a reserve for
the final page. Pilot one page within **0.01 GB** of that total. Run a read-only preview first and record the would-be
changes by kind and from/to status. Do not apply if even one pinned or Proposed row would move. Compare provider
usage before allowing the next batch, and stop if the next batch plus the reserve will not fit. Function reply byte
estimates are not billing ceilings. Verify the resulting Initiative statuses with the owner on dev; this does not
authorize a production run.

### Archive and Deleted

Archive and Delete are two different places an Item can be sent and brought back from. Both hide the Item from every
plan view, count, agent list and public read; its links, Lanes, landings and comments stay, and so does its Intent's
state. Archive has no time limit. Only the project owner archives, deletes and brings Items back.

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
display snapshots (they copy record bodies under no index by Item), and an Item whose Intent has an id of its own. An
Item in a stored base (no creation row after the backup's revision) is purged there too
([whole Item in the base checkpoint](#whole-item-in-the-base-checkpoint)); one a record-detail catalog holds is
refused (a second stored base), and a detail migration is refused while a purge is open. The last step also refuses while a Work index build runs or the set of
record partitions differs from the one the check walked. The same pages
run read-only as the completeness check; the purge's `purgedAt` (project `itemPurges`) is set only when the check
finds nothing left on the generation still selected. A stopped purge resumes by running again with the same
operation id, also after an index rebuild. New Issue and comment versions stay in Convex.
The durable Item tombstone ends discussion downloads as soon as the purge begins.
The executor also walks the Item's discussion namespace in indexed pages and marks every
artifact binding removed, including unfinished reservations. Each new artifact tombstone
starts its tracked R2 delete ([removed artifact bytes](r2-storage-plan.md#removed-artifact-bytes)): retried until
it succeeds, and not done before any upload signed for the binding has run out, while a late commit deletes its own
bytes. Completion checks the bindings; R2 deletion runs through those cleanup actions.
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

### Removing one comment

The Forge operator can remove one reported comment for good (the abuse review's `purge`,
[abuse reports](security.d/sections/2160-abuse-reports.md#operator-review); `convex/projectCommentPurge.ts`). The Item,
its other comments, replies to the comment and the thread stay. One mutation appends a `purge-planning-comment` Work
command that lists the comment's row with the digest of its redacted facts, then rewrites the comment's copies in
their purged form: its journal row (comment text "Deleted comment", no author label, as above), its `events` and
`planningComments` index records and payload chunks on every record partition and their store fingerprints, its
work-store versions (purged marker, body emptied) and head (an older head without an inline value gets the tombstone
inline), the staged pages of a failed index build (which cannot resume), and its discussion attachments (removed, with
the tracked R2 delete started, as for an Item purge). The purge row itself goes to the event table even where planning is a primary store
writer: it projects no record of its own. A staged index page can no longer be written once its build has stopped.
Work-store copy and compare count a purged version as matching, since its index row is now the tombstone. Readers accept the purged row by the same one rule, so a rebuild, full load or export keeps
"Deleted comment" in its place and never brings the text back. A retry of the comment's own operation, or a read of a
purged version, answers `PLANNING_COMMENT_PURGED` naming the comment and its Item. A retry of the purge with the same
operation id changes nothing; a comment an earlier purge already removed reports 0. `exportJournal` refuses a journal
with a comment purge unless the caller sends `purgedRows: 3` (`CLI_UPGRADE_REQUIRED`); the CLI asks for 3, then 2,
then nothing, as the server allows. Hosted display snapshots lose the comment's rows (one indexed read per snapshot,
at most 64 snapshots).

A decision comment's words are also a line in the Item's Decisions. Before the purge row, an audited put as the
project owner replaces that line in the current body with its emptied form (`- date @actor: Deleted comment (comment
id)`), with `reason: "Removed the words of a purged decision comment"` in Versions. The line is found by its
`(comment id)` marker, so an edit of its words since still finds it; two lines with the same short id are refused.
The purge then rewrites the Item version the decision derived (its index records, its work-store body, inline or not,
and its display rows), which a replay of the purged comment derives the same way. A decision whose derived version
keeps its body only in the journal archive is refused; purge the Item instead. Body versions saved between the
decision and the purge, and the Intent's copies of those bodies, keep the line as history; purge the Item to remove
them too.

Comment rows no longer enter journal segments, but a row archived before that keeps its command in an R2 segment. The
abuse review then writes its audit row as running (`done: false`) and schedules `projectCommentPurgeArchive:run`.
The action reads the command from the one events segment that holds the row's revision and runs the same purge with
it, checked against the row's request hash. It then rewrites that segment through the Item purge's segment sweep,
narrowed to this comment, which deletes the old objects before it is over. The last step runs the live copies'
redaction again, for an index build that read the whole archived row meanwhile, and raises the purge revision, so a
load or export that read it refuses to finish. It waits while an index build runs, then marks the purge entry
finished (no sweep state kept; the last 20 finished entries stay) and the audit row done. A Work load that both
starts and ends during the rewrite can still return the archived words, as during an Item purge's sweep; the audit
row says the purge is done only after the rewrite. Each step is a fixed point, so a stopped run resumes. A refusal
before anything was written (a base the scrub cannot rewrite, say) sets `failed` on the audit row, returns the report to
the open queue and drops that review's receipt. Any other failure retries with backoff (from a minute, doubling, six
runs), then is kept as `failed`. A retry of the same review starts a run that failed, or one that made no progress
for two hours. The Item purge executor never takes a comment purge's entry as its own.

A comment in the base checkpoint (written before the stored base was cut, or imported with it) has its words in the
base backup's exchange root: its `planningComments` record, the `hostedEvents` record that wrote it and, for a
decision, the derived body version, as content-addressed objects and the record packs over them. The abuse review
schedules the same action for it. Its first step is the purge above, with the comment's command taken from its
`events` index record (or, for a comment that has no event, rebuilt from its comment record). The action then scrubs
the base (`src/work-base-scrub.ts`, `convex/projectCommentPurgeBase.ts`). It writes a new exchange root with those
records in their purged form and the packs over them rebuilt. One pass over every record measures the whole-Work
digest again, and the manifest's `work.json` pin moves to it. One mutation then publishes it: the backup selects
the new root (`projectBackups.scrubbed`, as `work.recordDetails` selects a migrated catalog), and every replaced
object still stored is tombstoned with the save purge's primitive, the seed's whole `work.json` among them (above
1 MiB with its recipe, pages and chunks). Every base reader reads the backup's root through
`backupRootPin` (index build, full and detail load, checkpoint and describe, source review, recovery, the journal
export), so a read of an old object refuses `PURGED`. Their R2 bytes are deleted next (a pack member is zeroed), and
only then is the purge finished. Owner pages and returned-source checks keep naming the original whole-Work digest
(`scrubbed.originalWork`). The publication is refused when the backup's root changed since the build, and the retry
builds again. One base scrub runs per project at a time; another base comment's purge waits, with nothing written,
until it is done, and a record-detail migration does not start meanwhile. It refuses before anything is written: a legacy archive base, a project with another stored
backup (checked again when the scrub is published), a base with no record catalog, and a project read through a migrated record-detail catalog. Cost per purge:
one read of the base's root, catalog and manifest trees, every record once (one GET per record pack, one object
resolve query per 100 pins, packs read up to 100 or 8 MiB at a time), a few new objects (the two records, the packs over them, the changed tree chunks, the
root), one tombstone per replaced object, and three small mutations. In `tests/comment-purge-base.test.mjs` the
whole purge is 151 document reads (about 102 KB) and 36 writes (about 20 KB). Nothing runs while idle.

### Whole Item in the base checkpoint

An Item written before the stored base was cut (Item b6588425 line 2e) has its words in the same base records: its
`planningItems` versions, `planningComments`, `hostedEvents`, its Intent (with notes and lifecycle) and Initiative.
When the purge's first step finds the Item in the base, the executor checks that the scrub can rewrite this base
(the refusals above, nothing written) and lists the Item's base rows from the Work index
(`projectPlanningPurgeSelect.basePage`: its versions, comments and notes, and its Intent; rows the journal still holds
are listed by the normal selection). Each is listed in the purge command like a journal row, so the reader rule
covers it, and the index redaction purges its records. After the journal sweep the walk runs the base scrub once
(`projectCommentPurgeBase.scrubItem`), and `purgedAt` waits for it. The scrub replaces every record of the Item with
its purged form and, while it measures the whole-Work digest, checks every record in the base: a record of the Item
that is not in its purged form (a copy the index list missed) refuses the publication with nothing removed from the
base. A base converted to Intents also keeps the pre-conversion planning records inline in its catalog
(`legacyIntentMerge`): the Item's Issue versions, comments and Intents there take their purged form too, and the old
catalog's tree chunks are tombstoned (its extension `fields` stay opaque). One unfinished base scrub runs per
project. A base read through a record-detail catalog is refused, and so is an Item with more than 2,000 comments in
the Work index (imported ones included), both before the first step writes anything.

The reference check: the scrub chunks the scrubbed whole Work as a seed's recipe would (content-defined chunks,
digests only). A chunk or page of the old whole Work that the scrubbed Work repeats holds none of the Item's words
and is never tombstoned, so another object stored in chunks that names it (a large source file, another seed) still
reads. The chunks the scrubbed Work does not repeat hold or border the changed records; only those, and the old
recipe, are tombstoned. The old whole Work, its recipe parts and its catalog also stay while another backup's
exchange root names the same whole Work or catalog. An object that names one of the tombstoned chunks holds a copy
of the Item's words itself, and loses it with them.

A detail migration stages its new catalog before writing it (`projectWorkDetailMigrations.staged`, and the project's
`stagedDetailMigration` marker: one staged copy per project). No purge starts while the marker is set, and staging
refuses during an open purge. The step invocation that stages a copy holds its token: only it publishes the copy.
When its publication is refused, it deletes its own copy; a stopped run's copy is deleted by the next run once it is
15 minutes old (longer than an action runs), so no running step loses its copy. Deleting removes every plain object
row created after the copy was staged, with its bytes (R2 keys deleted after the row, in batches of 200). It deletes
instead of tombstoning, so a later migration stores the same records again. Older rows stay: they were there before
the copy and may be named elsewhere; with one staged copy per project, no other migration writes in that window.

Client caches after a scrub: a presigned object URL handed out before it fails once its R2 key is deleted, and
expires after 5 minutes in any case. A CLI keeps a disposable exchange cache keyed by the root's digest; the scrubbed root has a new digest, so the
next read fetches it, but an entry from before the scrub stays on that machine until the machine's owner removes it.

Cost per whole-Item base purge: the base purge's cost above, plus one index page per 64 of the Item’s versions,
comments and notes, one bounded comment count (at most 2,001 index rows) before the first step, one check and one
chunking pass per byte during the measure pass (CPU only, no extra reads; memory one 1 MiB chunk buffer and one digest
per chunk), one root read per other backup, and one mutation per R2 batch. In `tests/planning-purge-base.test.mjs`
(an Item with three comments and a kept Item) the whole purge is about 504 document reads (about 412 KB) and 78
writes (about 42 KB). Nothing runs while idle.

Rebuilding a hosted display snapshot page skips a purged comment's versions. A page that pins the rewritten
decision version still refuses to rebuild (its digest changed).

It refuses, with nothing written: a project whose Work index is being built or whose record-table migration still keeps an old copy (retry after it finishes), and
a comment too large to rewrite on every partition in one step (about 8 MiB of reads; retire old partitions, or purge
the Item). Cost per purge with one record partition, measured in `tests/comment-purge.test.mjs`: 28 document reads
(about 22 KB) and 9 writes (about 6 KB), the same whatever other comments the Item has. A decision comment takes 52
reads and 20 writes. An archived row takes 68 reads and 21 writes, plus 6 R2 requests: a GET to find the command,
then the sweep's GET, absence check, PUT, read-back and the old object's DELETE. Each further record partition adds
a few point reads. Without a complete archive index, the sweep pages every segment of the project, resumably, as an
Item purge's does. Nothing runs while idle.

### Versions

The Item page compares any two versions by line, marking the changed words inside a rewritten line, and restores one
as a new version (`reason: "Restored version N"`), with Undo. A restore at a stale version is refused with
`ITEM_CHANGED` and overwrites nothing. When a body edit clashes with someone else's save, the editor keeps your
text: Keep both saves it as the next version over theirs (theirs stays in Versions), Take theirs drops it.

### Audit trail

Every planning version, comment, Lane and landing stays in the existing hosted journal (no extra table or index).
Planning puts, ticks, start moves and comments from device credentials record the writing agent session slug (`agent`)
and declared launcher/model (`agentClient`: `FORGE_AGENT_MODEL`, the client's own `ANTHROPIC_MODEL` or `GEMINI_MODEL`,
or the model the session declared at `start`) in the same write mutation (0 extra Convex calls; browser sign-ins and
scheduled server jobs carry neither).

- **Item timeline**: `planning {"planningItemId":"ISSUE_ID","history":true,"limit":50}` (CLI or MCP `forge_planning`)
  returns one bounded, newest-first page (at most 100 events) of who (public Forge handle or `handle/agent` + declared
  model, or `"not declared"` when an agent declared none; never raw account IDs, display names or emails), when and what changed: status and close/abandon reasons,
  archive/delete/restore, title and bounded body diff summaries, Done-when checkbox ticks/unticks/edits, `waitingOn`
  set/changed/cleared, Initiative/parent/order moves, owner, type, visibility, relations, Intent links, comments
  (including replies and decisions), Lanes and landings/reverts. The reply reports `historyStartsAt`, `firstVersion`,
  `completeFromCreation`, `coverage` and `nextCursor`.
- **Backlog window**: `planning {"initiativeId":"INITIATIVE_ID","history":{"from":"YYYY-MM-DD","to":"YYYY-MM-DD","change":"all|closed|reopened|changed"}}`
  (omitting `initiativeId` scans the project; omitting `to` reads through now) lists Items closed, reopened, created or
  changed in the UTC window in one bounded indexed read over `projectHostedRecords` (`by_project_and_kind_and_parent`
  or `by_project_and_kind`, the same Initiative/time range as the 14-day close history). A version counts at its
  record's creation time. Each page scans at most 4,096 version headers / 8 MiB between `from` and `to` (never past
  now) and returns at most 100 Items; bodies are read only for the returned Items. A busy window continues on later
  scan pages: each Item is listed once, on the page with its newest version in the window, and `countsScope` is
  `scan-page` when the counts cover one page rather than the whole window. Restoring a shelved `closed` Item does
  not count as a new close. `kind` is refused here, since version headers do not record it. Versions imported from
  an earlier store were recorded after they happened: when the store's first record is one, `recordsFrom` names
  where its records begin, and a window starting earlier is `partial` (read those changes on each Item's timeline,
  which keeps their real dates). A listed Item whose newest version was imported carries `recordedAt` (the time the
  window placed it by), is counted in `recordedLater`, and also makes the page `partial`.
  A row whose body has `## Decisions` lines dated inside the window (a `decision:true` comment writes one) carries them
  as `decisions` (`date`, `label`, `text`, `comment` id prefix; oldest first by date, newest 10, `decisionsOmitted` counts older
  ones) from the body already read for the row: no extra read. A line keeps only its UTC day, so rows stay ordered by
  the Item's newest change and the line dates give the decision order.
- **Access and identity**: Audit reads require project membership (`readProjectRole`). Writers and the owner see public
  handles; read-only members see agent slugs and models without person handles; signed-out viewers and non-members are
  refused. Both reads make zero idle calls and run no polling.

## Hand order

The list has one hand order. An Item that was never moved has no stored `order` and sorts by its creation position.
A move stores `order`, a rank strictly between the two neighbours' ranks (`rankBetween`); nobody else is rewritten.
An Item moved to the end (`rankAtEnd`) still sorts before Items created later. The plan order is: Initiatives by
their own rank, then No Initiative; within each group, Items by rank, each followed by its sub-items (`planOrder`).
Initiatives move the same way: a moved Initiative stores one `order` between its neighbours among the Initiatives
shown (the web Plan's group headers and the Initiatives overview).

## Groups and the board

The web Plan groups its rows by Initiative (the default), owner, type or nothing. The choice is one Group chip, kept in
the address as `group=` beside the layout, and List and Board use the same bands. An owner band holds the owner as
set (with or without `@`). Items with no owner come last under "No one yet", and Items with no type under "No type".
Grouping by owner, type or nothing does not drag in List, because hand order is kept within Initiatives. A band
folds, and the fold is kept on this browser (the same record as the Initiative folds).

Board puts each Item as one row in its status column: Proposed, Planned and In progress, plus Done and Won't do when
the scope reads settled Items. Columns meet at seams, and each band runs across them. A sub-item whose parent is a row
is shown in the parent's roll instead of as its own row. Each column's total counts the rows it draws, with `+` when
the read is partial. A cell shows 20 rows, then 20 more at a time. Board reorders nothing; order inside a cell is the
plan order or the chosen sort. Grouping, totals and paging work on rows already read, so they make no call.

An In progress row says its Lane's state in the words Lanes and Needs me use: "Needs you" with the reason when it waits
on the reader, the hold's own word (Conflict, Check failed) when it waits on someone else, otherwise the Lane's stop
(Editing, Checking, Ready to land). The words come from reads the page already holds: the shell's Needs me read and
line feed, joined to the Item through the Plan's who-works-on-it read, which returns each Lane's id. A Lane none of
them names still says "in Lane". Owners show as their whole public identity (`handle/run` or `@handle`). The page
sentence reads "N Items are left; next is X. M in progress, K of them wait on you.", with N and M from the standing
line, whose hints are landings today, Lanes open and how many need you, and the next Item. The board's toolbar ends
with its row count, and the agent's command (`planning {"status":"open"}`) sits beside New Item.

## Next

The web Plan derives "Next" from the loaded Plan rows. It selects the first Planned Item in plan order with no owner,
Lane, live `depends-on` dependency or live direct sub-item. A Proposed, Planned or In progress sub-item keeps its
parent out of Next. A Planned sub-item can itself be Next if it meets the same criteria.
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
| `waitingOn` | `{kind, reason}` records a wait for an owner decision (`owner`), design or placement verdict (`design`), live evidence or a date (`evidence`), or another Item (`item`). Give a short reason of up to 200 characters. Use `null` to clear it |
| `relations` | Up to 20 of `{kind, id}`, kind `depends-on`, `duplicate-of` or `related`; the other side is derived (`depends-on` shows as Blocks on its target) |
| `hidden` | Hidden from public reads of the plan |

Agents name these fields in one `fields` object, for example
`put-planning-item {"itemId":"…","expectedVersion":3,"fields":{"order":"L00000AV","owner":"@mara"}}`. The CLI
flattens it, so the stored operation has one flat shape. Comment threads and decisions belong to
discussions (Item `9a3d6f5f`).

A server advertises the `planning-model` contract feature once it stores these fields. The CLI refuses to send them
to a server that does not, since that server would drop them.
The wait field uses the `planning-waiting-on` feature and the same Item version check as other fields.
It describes the wait and leaves status, dispatch and access to their existing rules.

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
- When you confirm a close in Plan, direct sub-items that are still Proposed, Planned or In progress become
  top-level Items in their own stored Initiatives. A sub-item you close in the same selection stays under its
  parent, as do settled sub-items. Plan promotes the children together when the parent closes, including children
  outside the visible window. Larger closes keep applying the stored links in the background. One Undo restores
  matching child links before it reopens the parent, so Plan shows the restored hierarchy together. Undo skips
  children edited after detachment and reports those edits. An ordinary reopen leaves detached Items in their
  Initiatives. Every edit adds a retained version.
- Split gives each Done-when line to one part. The Item keeps its prose and the lines it keeps; each new part is a
  Planned Item in the same Initiative and parent, related both ways to the Item.
- Merge carries each duplicate's Lane links (its planned Intent and linked Intents) and a copy of each comment to the
  surviving Item, and abandons the duplicate as a duplicate with a `duplicate-of` link. Items have no watchers yet,
  so there are none to carry.

Agents send ordinary batches as `put-planning-item {"batch":[…]}` ([workflow](agents/workflow.md)).

## Filters

Reads filter by type, owner and relation with one rule ([`src/planning-filter.ts`](../src/planning-filter.ts)), as
well as by kind, status and Initiative. `owner: "none"` matches Items with no owner, and a person's handle also
matches the agents working for them (`handle/agent`). `relation` is a relation kind (`depends-on`, `duplicate-of`,
`related`) or `"none"`. `status: "active"` is open work (Proposed, Planned and In progress), the Plan screen's
default scope. `"all"` adds done, dropped, archived and deleted Items. For a list or a search, pass an array
of stored statuses to match any of them. The Closed view copies `"status":["closed","abandoned"]` with `"kind":"issue"`.
An indexed search with multiple statuses filters each bounded search page, so continue with its cursor
even when that page has no matching Items. The web Plan screen keeps the same fields in its address, and a
saved view is a personal shortcut to them. Open Plan's views in the sidebar or from the page title on a phone.
The Plan toolbar saves and removes views kept in the current browser.

CLI and MCP list and count reads accept `waitingOn` with a kind from the table above or `"none"`.
Older Items without a wait and Items whose wait was cleared both match `"none"`. For example:

```sh
nforge agent ROOT put-planning-item '{"planningItemId":"ISSUE_ID","expectedVersion":3,"fields":{"waitingOn":{"kind":"evidence","reason":"Read live volume on Monday"}}}'
nforge agent ROOT planning '{"kind":"issue","status":"active","waitingOn":"none","reconcile":false}'
```

Use the same command fields with MCP `forge_planning`. Continue with `nextCursor` and the same filters,
including after an empty page. A waiting list uses bounded existing index pages without text search.
Projects with an older projection use the existing bounded Item pages until the projection is prepared.
An explicit `search` also accepts the filter and keeps the usual text-search cost.

## Progress

Needs me and Plan show the same project-wide Item counts, including when Plan is filtered. Done counts all
closed Items, In progress counts Items in progress, and Left counts planned Items and lists proposed Items
separately. A `+` marks a lower bound.

An Initiative's progress counts each Item under its stored Initiative, with one tick for done, in progress, open,
proposed or removed. In the tree, a sub-item still sits under its displayed parent. When the maintained counter
covers the Initiative, members see the same counts as CLI and MCP even beyond the display window. Archived and
deleted Items stay out. The existing Plan subscription carries the counts for List, Tree, Board and Initiative
detail. If the counter cannot prove membership, the bounded reads show a `+` wherever their counts may be incomplete.
Visitors see lower bounds from the visible work in the bounded read. A narrow Plan group header shows each
status as a coloured swatch and count so the Initiative title stays readable. Hover or focus a count to
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
public and members-only (`publicDiscovery:setSettings`, next to the Lane-title opt-in). Settings > Project has the
same switch for the owner and shows the setting read-only to everyone else. Each change is one row in the policy
history (`projectPolicyChanges`, with `planChange` holding the old and new value, who and when); the policy itself
is unchanged. Needs me › FYI lists it as a settings change.
`tests/public-plan-access-matrix.test.mjs` checks every viewer against every setting on these reads.

When Plan resolves an Item page, Work opens with one page of 10 Lanes from `projectItemWork:read`, the same
reader agents use. Work shows the Lane count and links the receipts on those Lanes to Code at the landed State.
Show more work advances the Lane, landing and Related cursors that still have pages. Work stays idle between requests.

Who wrote a comment comes from the sign-in, never from typed text: a browser sign-in is the person, a device
credential is an agent run (its session slug, and the model declared in `FORGE_AGENT_MODEL`, the client's own
`ANTHROPIC_MODEL`/`GEMINI_MODEL`, or the session's `start` declaration, stored as `agentClient` beside the slug;
declared, not verified). Members see `@handle` and "person", or `handle/run`, "agent"
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

The web Item page opens the newest 20 member comments plus the existing bounded Forge notes. **Show 20 earlier** requests the next page. The loaded count does not claim a total while earlier pages remain. Decisions, review findings and author filters match only the loaded comments and make no requests. The page matches tick evidence to its line using the recorded position and wording; older or unmatched ticks say the landing was not reported and link to Decisions.

Completion skips this comment for Intents created independently. Linking one to an Item later leaves the
receipt available under Work. Older Intents without a recorded origin continue to produce notes.
Later ticks and input pages add Lanes to the same note
within the existing five-Lane display limit. The Item discussion shows up to 50 system notes per page from its
own and linked Intent chains. The comment cursor continues through older notes and large sets of links.
A merged Item shows the duplicate's receipt-backed notes alongside copied member comments.
Notes stay in the live table until their landing reaches the existing seven-day capsule window.
Verified capsules then hold the original note bytes. Item discussion and planning export read both
locations under the same project access checks. Capsules written before notes were included leave
their live note copies available. Project backups continue to derive from the recorded Work history.

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
