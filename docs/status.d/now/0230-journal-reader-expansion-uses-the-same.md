Journal reader expansion uses the same private capsule codec and transport for
exact old versions, Lane provenance and contiguous Work event pages. Recovery
merges verified segments after live rows and landing capsules, with a separate
physical relocation fence, and includes coordination and snapshot tables.
Planning-version and Lane history pages, coordination feed/recent/related reads and
Lane metric facts also accept archived rows. Reactive clients hydrate cold pages
through currently authorized server actions; live pages and idle tabs add no calls.
Compact immutable version receipts retain transaction pins and Lane metrics.
The separately landed writer is default-off (`FORGE_JOURNAL_SEGMENTS`): finite
terminal-event continuations and one operator-started existing-history run move
verified superseded payloads, terminal transports, closed-save pages and coordination
detail older than fourteen days. Messages, handoffs and acknowledgements remain live.
Retry readers accept complete terminal results, Work command facts and closed-save
digest ledgers. Journal pages resume write conflicts through at most four scheduled
backoffs with the same page/claim; one existing-table claim defers concurrent
project phases before capture writes. Healthy page calls and idle behavior stay
unchanged, with no periodic retry job. Fixture relocation, fault recovery and exact original-row export
are covered; live enablement, billed usage and two dev exports remain open. Recovery also preserves a terminal operation’s
mutable recovery ledger and selects its latest archived physical row; restored
expired operation UUIDs reconcile against their newest retained receipt.
