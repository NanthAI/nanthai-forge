# Hosted action compute and idle subscriptions

Imported Code subscribes to `importStatus.watch`, a reactive, source-free
invalidation token derived from the import row, persisted status derivative,
worker task and selected Zone. The query checks current local importer/sharing
or Zone authority. Status and source bytes remain behind the existing actions,
which check current GitHub authority; endpoint actions also check the latest
upstream head. The subscription never grants GitHub access or serves source.

An initial observation, changed import/derivative, GitHub webhook observation,
window focus or network recovery triggers an authorized read. Read observations
exclude their own timestamp and revision from the invalidation token, avoiding a
feedback loop. Webhook reconciliations have a separate event revision so an access
change at the same source head still triggers revalidation. Import progress and
re-index completion use the same subscription rather than a polling loop.
Unchanged background tabs make no periodic status action calls. Without a
received webhook, upstream changes are observed on the next focus, network
recovery or explicit read; this is not a guarantee of instantaneous revocation
or freshness for already rendered data. Every new source read still checks
current GitHub authority and head.

Non-status hosted endpoints reuse the existing persisted derivative machinery.
Their keys bind original storage metadata, import, indexed head, endpoint and
observed upstream head. Current access is checked before cache retrieval and
again before returning. Large results use storage-backed derivatives. New keys,
missing or corrupt derivatives still decode and validate the original artifact.

Device signing keys and serialized public JWKS use a single-entry process memo,
replaced when the configured private key changes. `/auth/jwks` advertises
`public, max-age=300, must-revalidate`: clients may retain the old public key for
five minutes after rotation; there is no additional stale-on-error window.
Cold Node workers still derive once. The HTTP route retains the internal Node
action hop because key derivation uses `node:crypto`, unavailable in the Convex
HTTP runtime. It exposes only public JWK fields.

Other action timers:

- Live run output formerly read every 2.5 seconds (24 calls/minute). Unchanged
  pages now back off through 5, 10, 20 and 30 seconds (2 calls/minute at steady
  idle); changed output restores 2.5 seconds. Completed runs do not poll.
- In-progress account operations formerly advanced every second (60 calls/minute,
  plus continuation pages). Unchanged stages now back off to 30 seconds
  (2 calls/minute, plus continuation pages); stage changes restore one second.
  These actions advance an explicitly requested operation rather than idle work.
- CLI device login formerly polled every five seconds (12 calls/minute).
  Pending authorization and network failures now back off to 30 seconds
  (2 calls/minute). Existing server slow-down responses remain respected.
  The device-code deadline and retry operation identity are unchanged.

Owner acceptance listeners poll a mutation, coordination/presence/check heartbeats
write mutations, cockpit/status clocks update local presentation, and coordination
feeds already subscribe. They are not periodic action calls and retain their
existing behavior. Download continuation loops are explicit user requests.

`tests/compute-calls.test.mjs` compares the former five-second timer with the
subscription helper under the same fake clock: 720 versus zero periodic calls
per idle tab-hour, asserting every idle minute. It separately counts startup,
state changes and focus/recovery. This is a synthetic invocation budget, not
production traffic, billing or a browser end-to-end measurement.
