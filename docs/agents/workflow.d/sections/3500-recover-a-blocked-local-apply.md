### Recover a blocked local apply

`save --sync` and `sync` keep unsaved edits in files the sync does not change; only an
edit on a path main changed stops the local apply, and the error names the one
`recover-apply` command that finishes it. That command moves only the edits that clash
with the incoming change; the rest stay in place. `status:"superseded"` from `recover-apply`
means the Lane moved before anything was applied, and nothing was moved: run its `next` (`open`). A
`displacedRecovery` folder in a result holds bytes found in the old checkout; copy back
what you need, then delete it. See [recovery details](../../../architecture.md#hosted-agent-transport).
