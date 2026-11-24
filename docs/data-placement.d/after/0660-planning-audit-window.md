## Item History summaries

`projectPlanningAudit` keeps a disposable window of up to 32 summaries per
Item in the record store. A live write that has its exact predecessor puts the
same inputs the History renderer would derive from the two snapshots, capped
at 4 KiB per document. The row has the operation ID, predecessor version and
operation ID, time, attribution inputs and diff; it has no full body or command
envelope. Past the window the writer prunes a bounded trailing range. This
adds no calls between services and does no work on idle tabs or writes that
publish no planning version. The fresh and dogfood-shaped landing fixtures
ratchet this table at zero bytes per landing. Old versions, historical imports,
legacy layouts, copies and staged lifecycle rows are not backfilled. Later live
edits to imported Items can build a new window.

The History reader proves a page from the current authoritative head through
matching version and operation IDs. The cursor picks only a version, never the
operation that proves it. A gap, oversized diff, expired cursor or large page
uses the existing exact reader. The current head, first-version metadata,
comments, Lanes and landings still use their original readers. There is no
change to access, cursor format or client requests. Summaries keep the diff
format used at write time. On very wide Items, covered pages can fit more
events than the exact reader's byte budget allows, in the same event order.

The window is excluded from source copies and journal exports. Permanent Item
purge deletes it with the tombstone. Decision-comment purge drops the whole
window when redacting the old version in place: a later summary can quote its
predecessor. Project purge also deletes the rows through the project prefix of
the same index. Exact snapshots remain canonical and cannot be removed: they
serve older pages and replay where summaries are absent.
