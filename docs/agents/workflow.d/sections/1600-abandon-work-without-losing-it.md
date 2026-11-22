### Abandon work without losing it

`nforge agent ROOT abandon '{"laneId":"UUID","reason":"Superseded by …"}'` closes a Lane as `abandoned`. To abandon an Intent, pass `target:{"kind":"intent","intentId":"UUID","version":N,"cascade":true}` (use the observed Intent version); omit `cascade` when its Lanes are already closed. Hosted abandonment pins the observed Lane versions itself; `expectedHead` is not an argument. Unsaved source edits return `LANE_DIRTY`; `saveFirst:true` explicitly saves them before closing (including staging all Git Lane changes). On a hosted checkout, `keepPatch:true` instead keeps them in a patch file next to the checkout and abandons; re-apply it in a fresh Lane with `patch -p1`. A concurrent edit after saving leaves the Lane open. Saving for abandon retains unresolved conflict markers and merge context; reopening lets you resolve them later. No source, saves, history or workspace files are deleted. Ignored/excluded files remain on disk and follow the existing capture and clean rules.

The receipt records reason, actor, time and operation id. Retry with the original operation id and identical input (including returned `resolved` fields); a retry after `reopen` returns the original abandonment without closing the work again. `reopen` restores an abandoned Lane or Intent as active; reopen child Lanes separately after an Intent cascade. `clean` can reclaim abandoned Lane workspaces under its existing capture checks. Abandoned Lanes leave Now and open lists, and appear as grey **Abandoned** under Done/Closed.

MCP uses `forge_task` with `command.action:"abandon"`. Hosted abandonment goes through the hosted Lane APIs; `nforge exchange ROOT push` is retired. Native abandonment records use Work format 13; upgrade readers/writers before sharing an owner with them.

Start the Loose ends Intent group with
`nforge agent ROOT lanes '{"view":"loose-ends","intents":true}'`. An Intent without an Item
appears for review with its last recorded Intent, Lane or save activity. When the
bounded child-Lane read cannot establish activity, the timestamp is null and the
batch reports that the children need review. Follow
`groups.intents.continueCursor` as `cursor` with the same view until it is null. Continue
even through an empty page when the cursor is present.

The project owner can explicitly set aside reviewed Intents in batches of up to 25.
Pass the top-level `setAside.authorityEpoch` and the chosen rows' `selection` objects to
`nforge agent ROOT abandon '{"operationId":"UUID","authorityEpoch":N,"reason":"…","intents":[…]}'`.
A row that gained a save or Item link, or whose Intent or Lane changed since the read,
returns its own skip reason. If the original reply is lost, replay exactly the same
request, including its UUID, to recover the receipt. For a skipped row you still want
to set aside, review a fresh selection and submit that row with a new UUID. Each
successful row carries its lifecycle receipt and the version to use with
`nforge agent ROOT start --reopen '{"target":{"kind":"intent","intentId":"UUID","version":N}}'`.

Run `nforge agent ROOT lanes '{"view":"loose-ends"}'` or the same command through MCP `forge_work_overview`
for dormant Lanes, stopped Lanes, checked work, inactive projects and dated Issue checks in one read.
A group reports why its evidence is unavailable. Pass its `continueCursor` as `cursor` to read
its next page. The inactive-project search follows the account's accessible project list in bounded
pages, so a page can be empty before the end. It looks for 30 days since the last landing receipt, or
since creation when a project has no receipt. A project-scoped device sees only its selected project. Each of the reader's own projects carries
`trash.expectedRevision` and `trash.expectedLastLanding` for `projectLifecycle:trash`. A project that landed
since is refused as `WORK_STALE`, and with that pin the reply's `applied` says whether this operation moved
the project. The first page lists the account's open permanent-delete requests as `deleteRequests`. The web
page's Undo for a set-aside Lane sends `reopen:[{laneId,version}]` to the dormant sweep with the version it
returned (`versions:true`); a Lane changed since is skipped as `changed`. The sweep skips a Lane in the landing
queue as `in-queue`.

Each Lane row says what its own writes stored: `saves` (moved heads since the count began), `landedBefore:true`
when its work landed and it was saved again, and `paths`. The `checked` group lists Lanes an unrequested check
passed on and nobody saved or landed since, oldest pass first, with `passedAt`; its first page holds 8 rows and the
continuation 25. A Lane written before these fields existed omits `saves`: that means not recorded, not zero, until
its next save. A listed project carries `openLanes` and `bytes` from its project row, kept by Lane starts and ends
(size is read at most every 10 minutes); both are omitted until the one-time backfill
(`internal.projectLooseEndBackfill.backfill`, 10 projects or 50 Lanes per run) or the project's next Lane start.

Add a date to an unchecked Done-when line with `- [ ] @due 2026-12-01 Review the changes`.
Loose ends reports the earliest pending date per Issue, the line number in its body and the viewed
version, plus the Item's `owner` and `proposed:true` while the Item is proposed. Date results follow open Issues in bounded pages and a page can be empty before the end. A date added before date support appears when its Issue's search record is next written or rebuilt.
Set Issues aside with `status:"archived"` or hand them to an agent with `owner:"@handle/agent"`. Send
the selected rows' `selection` fields with the chosen change in a `put-planning-item` batch. The
existing batch returns a version-pinned Undo for changed rows and a result for each stale row. For a
held Lane, use the existing `open` handoff with the saved pins and recipient session.
