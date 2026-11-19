## Terminal landing capsules

S1 (`bea7868d`) packs every landing that settles once the writer is deployed;
earlier terminal landings are not backfilled. After the approved seven-day
terminal grace, one complete private gzip object
holds canonical observations, attempts, landing-owned finish projections,
acceptance events/pages/plans/snapshots, compose pages and expired callback digest
receipts. Relocated per-landing expiry receipts travel in that object too. A
verified pointer precedes bounded removal of duplicate Convex copies. Reuse
aliases, canonical acceptance receipts/compose selections, exact transaction
ledgers and shared metric/control projections remain in Convex. A fixed bootstrap
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
