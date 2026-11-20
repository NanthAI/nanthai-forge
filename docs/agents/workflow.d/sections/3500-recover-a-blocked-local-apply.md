### Recover a blocked local apply

`save --sync` and `sync` save unsaved edits first (`saved` in the reply), then sync, as Git
commits before a pull: the merge carries them, a clash with main is a conflict to resolve against
the saved head, and the folder equals the result, so preflight needs no second save. Only an
edit written while a sync runs on a path main changed stops the local apply, and the error names
the one `recover-apply` command that finishes it. That command moves only the edits that clash
with the incoming change; the rest stay in place. Moved edits are not in the Lane head, so
`recover-apply` then fails `UNSAVED_LANE_EDITS` (`recovery.status:"needs-action"`, the kept paths
and folder, and the finished apply under `recovery.completed`): copy back what you need, then
run its `next` (`save`, or the resolve, sync or finish it belongs to, which takes the other unsaved
files). Bytes kept from `.forge/` are Forge metadata, not Lane edits. Every reply that names a save makes the same final check: files that differ from the
head it reports fail `UNSAVED_LANE_EDITS` with their names and the `save` to run. `status:"superseded"` from `recover-apply`
means the Lane moved before anything was applied, and nothing was moved: run its `next` (`open`). A
`displacedRecovery` folder in a result holds bytes found in the old checkout; copy back
what you need, then delete it. See [recovery details](../../../architecture.md#hosted-agent-transport).
