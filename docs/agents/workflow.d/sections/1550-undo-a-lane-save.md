## Undo a Lane save

From a Lane folder, run `nforge x ROOT undo '{}'` to restore the State the last
recorded save started from. To restore the result of an earlier save, list the
Lane's `records {"collection":"saves","parentId":"LANE_ID"}` and pass its
`saveId` to undo. Pass `laneId` from outside the Lane folder. In MCP, use
`forge_task` with `{"command":{"action":"undo","saveId":"SAVE_ID"}}`.

Undo records a new version of the open Lane pointing at the exact retained
State, with that version's source base and stack or resolution pins. This
keeps later saves, including the one you undid, available. The receipt names
the original operation, the previous head and version under `from`, the
restore target under `restored`, and the resulting head under `lane.head`.
To go back to the pre-undo State, run undo with `version` set to the receipt's
`from.version`. Retry an unknown result with the same operation ID and inputs.

If the Lane is open here, undo also applies to its checkout. Local edits to
unrelated paths stay in place. A local obstruction reports the path and
provides `recover-apply` for the exact undo that already completed on the
server. Use `apply:false` to restore just the hosted Lane.

Other Lanes and main keep their source and history. A later landing composes the
restored State onto current main, merging concurrent work or reporting a
conflict. To take a landed change out of main, use
`nforge agent ROOT revert '{"target":{"kind":"receipt","receiptId":"RECEIPT_ID"}}'`
and run `land --save` in the resulting Lane for a checked compensating landing. The original
landing and the new landing both remain in history.

After a sync, you can select a saved State from before it. The sync receipt
stays in history. For unsaved edits, use the [snapshot workflow](0200-refresh-the-clone-root.md).
