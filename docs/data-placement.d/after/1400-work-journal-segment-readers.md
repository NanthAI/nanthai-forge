## Work journal segment readers

Journal history uses S1's digest/size/table verification and server transport.
Its segments stay on the Node zlib gzip codec (`encodeArchiveBytes`) in Node
actions; landing capsules moved to the portable V8 codec (Item b149b16b), and both
are standard gzip. `projectJournalSegments` holds one compact
range index per segment, separate from hot finish projections so its range indexes
do not multiply every landing row's storage. Current heads and versions remain
transaction-readable. `projectJournalReceipts` keeps compact deduplication facts
for archived coordination detail; full commands stay in R2. Immutable version
hashes, Lane source pins and metric facts
let transactional retries and metrics reconcile without an R2 read. Full history
bytes remain server-only and use current access checks after each GET.

Version pages use stable revision positions; coordination uses creation-time/id
positions with scoped indexes. Browser and CLI clients hydrate cold pages and
retain live subscriptions; changing viewer permissions hides old hydrated data
before reauthorization. Recovery merges original rows with live rows and capsules
under a relocation fence. Existing rows larger than a page use ordered, hash-verified transport fragments;
every physical segment still uses S1’s codec. Original row bytes reassemble before
projection or export, preserving the record capability and bounded page transport.
The separate writer is installed behind the default-off server setting
`FORGE_JOURNAL_SEGMENTS=1`; the setting is not enabled by a deployment. Existing
readers continue to resolve retained objects when the setting is off.

Terminal source operations and primary Work commands schedule finite archive
continuations after seven days; closed Lanes schedule their save-page drain and
coordination detail schedules its fourteen-day drain. No cron or periodic poll is
added. One internal operator invocation of `projectJournalRun:pack` with
`{projectId, operationId, existing:true}` also walks settled existing rows. Its
per-project cursors and page receipts resume interrupted work; another invocation
with the same operation id reconciles published pages. A failed in-flight capture
can be resumed after its ten-minute internal claim lease. This is an operator
maintenance entry point, not a new user action or confirmation.

Each Node page uses one capture and one publication mutation, at most 100 original
rows, and at most 500 KiB of capture transport. Capture budgets include related
head/body reads; an individual existing provider row can exceed the transport
page and is re-read and framed without truncation. Publication revalidates source
hashes, head identity and body sharing after the verified PUT/GET. Original rows
stay until the final verified fragment. One R2 PUT writes each physical segment;
no separate packer or object store is introduced. Compact version/header facts,
complete ninety-day terminal retry results and Work command replay facts remain
in Convex. Shared current bodies, current heads, prepared lifecycle versions,
messages, handoffs and acknowledgements stay live. The archive removes relocated
Convex copies, not logical history; recovery export and restore provide the
original rows. Turning the setting off stops new relocation.

Eight fixed record/operation/existing-history cursor kinds are accounted as
project metadata, separately from coordination and expired-operation ownership
receipts. Lane-scoped save controls are removed after their finite drain. The
fixture ratchets charge segment indexes and all remaining receipt result bytes;
small-row metadata overhead is charged whole. Known eligibility points use one
deduplicated scheduling fact per scope/date; expired facts left by a paused job
clear in bounded metadata-only pages. Late archived operation-ledger updates
advance the recovery fence, including while new relocation is disabled.

Terminal operation transport and its mutable recovery ledger have separate
ownership during export. A live compact receipt supplies the current recovery
ledger; after receipt expiry a compact ownership digest selects the last archived
physical row. Older immutable objects remain retained, while export emits each
physical operation once. Restored operation histories can contain an operation
UUID reused after its original receipt expired; the transactional loader selects
the newest physical receipt for that project/actor/UUID.

Cold journal queries use the existing structured `CLI_UPGRADE_REQUIRED` envelope
with an opaque viewer/source commitment. Updated clients recognize that
continuation and hydrate through the private history action automatically; older
clients get an explicit upgrade instead of an incomplete successful page. The
existing contract-feature negotiation advertises `journal-segments-v1`. Live
reads retain their original query count and no extra capability call is added.

Record journals also accept compact original version receipts: immutable identity,
content hash and transaction pins remain query-readable, while the full original
header and body live in a range segment. Lane receipts carry only source and
metric facts. This keeps metric paging exact even when an old Lane version becomes
superseded long after other projects' history was archived; metrics do not depend
on a bounded guess about overlapping segment time ranges. These are receipt
bytes in the storage ledger, separate from the one index per physical segment. A
compact header can point to its exact private segment index by content pin, so
one segment can contain versions of several resources. Header indexes still
provide exact point and history paging; no per-resource duplicate archive index
is required.

Work projection replay uses the same verified compact command facts as ordinary
retries and remains query-readable when the full original provenance is archived.

Journal page actions retain the original page identity and pending claim across
write-conflict retries. At most four scheduled resumptions use exponential
250–2,000 ms backoff plus less than 250 ms jitter; an exhausted conflict remains
visible as a failed job, and the original cursor stays resumable. Other failures
remain explicit. A successful page resets the retry count for its successor.

One small project pointer in the existing receipt table names the pending claim
across every phase and Lane scope. Captures read its existing point index before
writing eligibility markers or control state, so concurrent wakes defer until the
current claim expires. Publication checks the same ownership before applying rows.
The deferred request has one finite scheduled continuation; there is no polling,
periodic job or idle wake. Older controls remain readable and republish the project
pointer when their own frontier is captured again. Claims use the existing ten-minute
expiry. The shared control writer clears the pointer on stale selection, fragment
handoff and completion; no second cleanup path, table or index is added.

Empty journal selections commit their cursor, replay result, eligibility wakes and
phase continuation in the capture mutation itself. They acquire no capture lease,
create no pending-project pointer and call neither publication nor R2. A replay of
the control's last page returns before loading the project or selecting source rows.
This also applies to already scheduled wakes with the original arguments. Empty
metadata-cleanup pages still advance, and an empty Lane frontier removes its control.
There is no scheduling-format change, coalescing lookup on supersession, new timer,
periodic wake or change to the seven/fourteen-day eligibility rules.

Healthy nonempty pages keep one action and at most two mutations. Point reads of the claim
replace redundant control-row lookups; its capture/publication adds two small
metadata writes per page. The project pointer exists only while a page is pending,
so retained JSON and stored-index ceilings stay unchanged. No segment payload or
source bytes move into Convex. A single injected capture conflict adds one action
and one mutation; an injected publication conflict adds one action, two mutations
and one reconciliatory R2 GET, with the same segments and no duplicate PUT. Tests
retain the original storage ceilings and verify a finite drain after concurrent
wakes in distinct phases, including an actual indexed OCC race. Retention and
logical history are unchanged. Provider billing and live byte-placement deltas
remain separate rollout evidence.
