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
It is a local file compare: no call, works offline (ad80e037).
[Refresh and cost reference](../../../operations/source-exchange.md#hosted-main-client-checkout).
