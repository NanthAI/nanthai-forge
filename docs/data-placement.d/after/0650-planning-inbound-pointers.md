## Related work pointers

`_workStorePlanningInbound:<epoch>` rows in `projectWorkDataRecords` index the
source Item's position by target Item in one physical Work partition. They
store IDs, position and a shelf visibility class, not copied titles or relation
kinds. A changed source reconciles its pairs in one bounded range; unchanged
pairs need no pointer reads. Readers range only over non-shelved sources;
owners merge both ranges. The Item page still rechecks each selected source
root for visibility and relation labels. One page considers up to 50 pointers
plus lookahead and retains the existing 128 KiB source-row budget plus a
crossing row. Links may surface earlier than on the scan, in the same source
order.

New partitions maintain exact coverage from their first root. Older partitions
keep the bounded scan until an owner prepares their current partition with
`projectPlanningInboundPrepare:page`. This is an operator pass, not a watcher or
an idle job. Start with `after: null`, a fresh `operationId`, and the current
physical `partition`, `projectId`, and `owner`. Save the operation UUID and
resume with the returned `after` and the same UUID. The first call only fences
preparation. Each subsequent root page considers up to 20 roots with a 512 KiB
provider page budget, one crossing root and up to 400 pointers. For dogfood,
reserve 3.5 MB billed per root page (including crossing row, pointer I/O and
index overhead) against the 5 MB approved read/write budget. Check actual
billed bytes after each call and stop before another reserved page can exceed
the budget. The scan stays active until the entire root pass publishes coverage.
Source-return snapshots do not carry these derived rows as source facts.

Before deploying a writer that does not maintain pointers, start the same pass
with `rebuild` set to the current coverage epoch and a fresh UUID, but **do not
continue** past its first receipt. That puts readers back on the scan and leaves
a clean, paused epoch.
After the maintaining writer is restored, continue with the saved cursor and
same operation. The new epoch becomes readable only after the full root pass;
then explicit continuation calls remove up to 100 retired-epoch rows per page,
including rows for sources that no longer exist. `complete: true` means no
retired rows remain in the pass's scope. Do not downgrade during the active
root pass.
