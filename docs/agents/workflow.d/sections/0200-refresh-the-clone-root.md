## Refresh the clone root

`nforge pull [ROOT]` (ROOT defaults to the clone holding the cwd) / `nforge status ROOT` are the `git pull` / `git status`
equivalents. Agent: `pull {}` / `status {}`; MCP: existing `forge_task` /
`forge_work_overview`. Pull refuses tracked edits, preserves ignored artifacts
and resumes interruption. When the pull changed the lockfile and the folder's own
`node_modules` no longer matches it, `nforge pull` prints one line with the
install command for the declared manager (a local file compare: no call, no
install). Current: 1 query, 0 GETs; idle: 0 calls.
In a Lane folder, `status {"files":true}` is the `git status` of your edits: the
files that differ from the Lane's saved head (`added`, `modified` or `deleted`,
`conflictMarkers` when a file still holds them; at most 50 paths, then `more`).
It is a local file compare: no call, works offline (ad80e037). While a save of this
folder is still settling, `settling` names it (`operationId`, `captured` file count) and
lists the files it holds; only files that differ from what it captured are `unsaved`. The `git checkout --
FILE` of a Lane is `x snapshots {"restore":"saved","paths":["FILE"]}`: those files
(or every file under a named folder; `"."` is all) go back to the saved head.
The current files are snapshotted first and the result is recorded in the
snapshot log, so `{"undo":1}` brings the edits back
([snapshots](1500-unsaved-edits-after-a-crash.md)). A path a snapshot cannot hold
(secret-flagged, over the new-file cap, or an untracked credential) is refused,
and nothing changes.
[Refresh and cost reference](../../../operations/source-exchange.md#hosted-main-client-checkout).
