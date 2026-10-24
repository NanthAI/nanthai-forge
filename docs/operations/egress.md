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

- `hosted.read` serves GitHub-import graph/source endpoints. `App` requests status
  every five seconds while mounted. Status already uses a persisted derived row;
  other endpoints decode and validate the complete artifact per request. Current
  GitHub authority and latest-head checks still require actions. Caching arbitrary
  endpoint results must preserve those current checks and freshness.
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
