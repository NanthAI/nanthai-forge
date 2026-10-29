# Hosted byte accounting

Source-return responses contain a retained operation receipt or progress, not source
files. A native push negotiates missing content hashes; unchanged physical chunks
are reused. Hosted computation can still read retained metadata internally, and a
small action response does not imply a small storage bill.

`exchangeObjectReader` can reuse the existing 16 MiB process byte memo for verified
raw storage bindings, including recipe nodes and leaves. Publication descendants,
metadata loading and source-return continuation opt into it. A fresh publication always
rereads and hashes its receipt root from storage; original-operation receipt
reconciliation still returns before storage validation. Every use still resolves
current project access before and after reading, checks current storage metadata,
and revalidates recipe closures. No authorization, mutable Work snapshot or whole
recipe result is cached. Cold processes and eviction fall back to verified reads;
this is not a durable cross-worker cache or an egress guarantee.

A CLI exchange instance retains up to 16 MiB of verified downloaded objects by
content hash and size, with individual entries at most 2 MiB. Larger downloads
continue through ranged reads, including draining active requests on failure.
Mixed batches fetch only missing objects; hits obtain current authorized project bindings before bytes are returned. Returned buffers
are independent copies. Logical Work metadata retains checkpoint-specific checks.
The cache lasts for that exchange instance; it does not replace the native owner's
existing persisted missing-object/baseline reuse or ranged/streamed paths.
Private source responses are not given public
immutable HTTP caching, which would bypass current read authorization.

## Local measurement

After `npm run build:core`, run:

```sh
node --import ./tests/check-runtime.mjs --test tests/egress-budgets.test.mjs tests/exchange-download-cache.test.mjs
```

The synthetic fixture retains 1,000 notes (roughly 925 KB of Work), changes one
note, returns that push, then lands a one-file change while retaining the exact
returned hosted event. It opens indexed Now/Work collections and the selected Code
file twice, then dispatches twenty local CLI status reads. Upload preparation is
ingress and excluded. Publication and source-return calls are included.

`EGRESS_BYTES` reports public function JSON response-body estimates (including
base64 expansion for byte fields), internal function response estimates separately,
and full storage bodies read with `storage.get`. The fixture's `getUrl` counter
charges full object size; any future ranged URL flow needs actual response-body
instrumentation instead. These counters are not Convex billing telemetry: they
exclude WebSocket framing, request bytes, retries outside the scenario and provider
internal accounting. Internal function bytes are not added again to public response
bytes. The fixture does not reproduce an entire browser session or provider
subscription invalidations. Byte assertions are regression budgets, not user limits.

The local status loop uses local Forge records and transfers zero hosted bytes.
Now/Work use indexed queries; a warm Code file uses the current-authorized source
byte memo. A cache hit is still a read requiring current permission.

## Remaining cost paths

- `hosted.read` serves GitHub-import graph/source endpoints. A cold read builds
  a persisted graph/document index and a concatenated source object in R2. Later
  endpoints read the index; source requests fetch only their file range and check
  its digest against the graph manifest. The original gzip is decoded once per
  index build. Endpoint caches retain current GitHub authority, source-state and
  latest-head checks. Status retains its small persisted summary.
- `/auth/jwks` invokes `deviceActions.jwks` for each request to the route, deriving
  the public JWK from the configured private key. There is no external JWKS fetch in
  that action and no cache-control or TTL in the route. Validator request frequency
  cannot be inferred from this code. Public-key TTL/HTTP caching remains separate work.
- Diffstat projection/progress already caches by `(base, head)` in hosted derived
  records and per-cursor memory. A miss invokes `projectDiffstats.compare` on
  changed-file batches; that action still reads before/after content and reports
  its storage reads to the caller's per-push accounting.
- Source-return cursors and snapshots are gzip JSON, reused by warm workers, and
  reread once per cold 30-second invocation. Every completed push returns its
  storage reads/bytes, steps and invocations (`accounting`), so per-push egress is
  visible without billing attribution.
- Legacy archive metadata and archive range reads keep streamed or ranged
  `fetch` of action-private storage URLs: a Node action's `ctx.storage.get`
  buffers the whole Blob. Function attribution suggests Node `storage.get` bytes
  are also reported as fetch egress (source return used only `storage.get` yet
  carried most fetch egress), so replacing those URLs would not remove the double
  count. Imported and derived artifacts also consume storage bodies.

To reconcile a production invoice, collect interval-matched function invocation
counts, storage response bytes by object class and cold/warm cache observations.
The supplied historic 218.86 GB total minus 65.09 GB function attribution leaves
153.77 GB unresolved. Code inspection cannot uniquely assign that residual, nor
establish that today's small receipts generated the historical 61.2 GB attributed
to source return. No production traffic or billing sample is collected by these tests.

## Archive and finish transfers

New resumed backup/proposal archive uploads use checksum-bound, create-only R2
PUTs. Completion HEAD-checks the exact reserved size/checksum before the owning
transaction records it. A retry uses the same operation, key and pins; HTTP 412
cannot overwrite accepted bytes. Archive registration remains retired in favour
of object exchange; this also applies to uploads which resume an old registration.

Backup, proposal, import and Zone archive downloads return one signed R2 GET
with exact size/digest metadata. Browser snapshot downloads hash incrementally;
native recovery and check-log maintenance stream to private staging and verify
before publishing the file. Archive size does not increase Convex calls or carry
archive bodies through actions. Existing Convex `_storage` rows keep their
legacy, authorized range-action reads until explicit backfill/purge. Exchange
`downloadPart` already returns `direct:true` for R2/recipe rows, whose clients use
bounded `signDownloads` batches; only legacy raw storage uses its action body.

A 500 MiB archive needs three client operations (prepare, complete, sign), versus
250 two-MiB download actions alone on the legacy path. The `backupTransfer` API uses a prepare mutation, a HEAD-verifying completion
action and a sign mutation. Completion also makes two internal calls for current
authority/pins and the final atomic commit: five Convex invocations in total. The
32,000-object scale fixture measures 15 document reads, five writes and no
archive-body bytes in Convex. Signing a stored R2 backup is one mutation; import
and Zone signing retain their external current-GitHub authority checks. The scale fixture signs a synthetic 500 MiB binding without
allocating/transferring its body; the round-trip fixture transfers real smaller
bytes. Neither is a production billing measurement. R2 egress is free; request,
storage and Convex metadata costs still apply.

The finish driver reserves its plan as a project object, then create-only PUTs
and HEAD-verifies its JSON in R2 before the atomic resume. A plan contains pinned
selection descriptors, not source file bodies. Plan size is measured in the
10-file finish test; existing selection pages remain bounded at 128 KiB. This
reuses project-object durability/cleanup, with no additional idle scheduling.

New binary derivatives also use R2 for legacy originals. New R2 reservations do
not scan `_storage` or schedule orphan sweeps. The retained
`derivedArtifacts:sweep` is one manual legacy metadata page (100 files), returning
`{isDone,cursor}` without scheduling another page or a delayed pass. Old upload
bindings remain attributable. `projectBackups:findUpload` and duplicate cleanup
are legacy reconciliation only; R2 uploads reconcile by their immutable key.
