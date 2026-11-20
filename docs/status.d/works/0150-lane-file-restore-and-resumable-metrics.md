- A Lane folder has `git status` and `git checkout -- FILE`: `status {"files":true}` lists the
  files that differ from the saved head, and `x snapshots {"restore":"saved","paths":[...]}` puts
  named files back to it, undoable with `{"undo":1}`
  ([agent workflow](../../agents/workflow.d/sections/0200-refresh-the-clone-root.md)).
  A `metrics` read too large for one call's 100 s continues when the same command is asked again
  within the hour, from the calls it already answered, so no page is read twice ([operations](../../operations.md)).
