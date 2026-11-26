## Terminal landing capsules

S1 (`bea7868d`) packs every landing that settles once the writer is deployed.
Landings that settled earlier have no wake; a one-time backfill (`b149b16b`,
`convex/projectLandingCapsuleBackfill.ts`) packs them on an explicit operator call
per project. `dryRun` reads only (resumable with its `cursor`) and reports landings,
rows, bytes, calls and whether the project index is built. `run` builds an unbuilt
capsule index before it schedules any pack, then pages 64 requests without reading
cold bodies, classifies them with the packer's shared rules and schedules the same
verified packer 2 s apart (`staggerMs` 0.5–60 s). One control row holds the cursor,
a generation and the one pending chained call (`pages`): an overlapping call is
refused, `restart` cancels the pending call. There is no cron or idle work, and the
module is deleted once dev and bench are done. After the approved seven-day
terminal grace, one complete private gzip object
holds canonical observations, attempts, landing-owned finish projections,
acceptance events/pages/plans/snapshots, compose pages, Item landing notes and expired
callback digest receipts. Relocated per-landing expiry receipts travel in that object too. A
verified pointer precedes bounded removal of duplicate Convex copies. Reuse
aliases, canonical acceptance receipts/compose selections, exact transaction
ledgers and shared metric/control projections remain in Convex. Compact per-note
references retain the original creation order and point to verified capsule bytes.
New note rows and their archive references carry the Item ID from the Intent head.
Convex indexes that field with the project and landing time. The capsule body
keeps the original shape, so filling an Item ID can run between capsule capture
and removal without rewriting the object.
A fixed bootstrap
cursor/revision is charged per project, separately from landing history.

Capsule objects use the private project `landing-capsules` namespace, outside the
client-readable object namespace. Server actions alone open them, verify complete
raw bytes/table hashes and return currently authorized, identity-mapped logical
history. Recovery uses that path and retains the full raw server object; its
fixture drill also restores hosted source. Logical history is preserved
indefinitely. Live dev packing, cold reads and retained bytes are recorded on
Item b149b16b; billed storage savings are not yet a dashboard reading.

Landing request phase state lives in the indexed `projectHostedLandingRequests` ticket. Resolution-message inheritance follows existing compose, operation and submission indexes when a child attempt conflicted; older ordinary recomposes also read their landing attempt. New finish recomposes reserve the owning submission UUID in the existing operation-ID map, so cached precompose adoption preserves exact note choices. Their source job reuses the already unique Candidate UUID, replacing the redundant job-operation reservation (two fewer serialized bytes per operation). Healthy landing calls, writes and indexes stay unchanged; source bytes stay in R2.
Its immutable request and larger batch selection live in separate rows of the unindexed
`projectHostedLandingBodies` table, reached only by the ticket's private pointers. Existing
index readers receive the same logical row. The finite observer hydrates only the request,
so it never reads a batch selection merely to display status. Phase changes reuse both
bodies; ordinary parent deletion and permanent project purge remove them atomically.
Legacy inline tickets remain readable and separate their cold fields on their next state write.

Resubmissions carry scalar CI usage on the existing ticket. Its optional server-only
`supersededCheck` checkpoint (one run ID and usage scalars, about 60–90 serialized bytes) also rides
the desired row until admission, when its existing write clears that copy. The request keeps it
until the existing check-binding write consumes it. If no run ever binds, it remains with that
request until the request is removed by existing cleanup or project deletion; there is no new
expiry or retention rule. It prevents exact-run reuse from being counted twice, adds no lookup or
new table, and changes no source-byte or history placement.

### Landing-note Item ID backfill

Wait for the optional-field schema and Item index to deploy to Forge dev. For
every dev project, call `projectIntentLandingNoteFill:count` with its `projectId`
and `cursor: null`. Follow `next` until null. Sum the rows for the deployment and
record the estimate of 1,500 billed DB I/O bytes per note before applying any page.

For each project, call `projectIntentLandingNoteFill:remaining` and pass its first
note ID as `first` to `projectIntentLandingNoteFill:fill` with the same project ID.
Each mutation patches up to 64 rows, leaving their other fields intact. If a
reply is lost, reconcile its execution in the spend ledger before continuing. A
retry with the same first row cannot patch the following page. A note whose
Intent head has no Item stops the transaction and goes to the lead for review
before retry or cutover.

Use the dev [spend ledger](../../operations/convex-spend.md) to account for the
fill's actual billed I/O, including confirmation and any retries. Record the
read-only count separately. Run one page at a time and reserve room for the page
and its verification using the known billed page costs. Use `maxRows` to shorten
the next page if needed. Proceed only when the page fits within the lower of
twice the counted estimate and 100,000,000 bytes per deployment. Stop if
completion usage is missing or the next call's cost cannot be bounded. Record the
actual calls, bytes and wall time. Verify each project with a null result from
`remaining`, which reads at most one row. Finish and verify the dev Plan
Lane-mark pass on each remaining project within its own 1 MB budget before the
reader cutover removes the legacy roll-up.
