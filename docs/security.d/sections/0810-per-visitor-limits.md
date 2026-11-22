## Per-visitor limits

Signed-out source reads and device sign-in have a limit per visitor, so one noisy client cannot spend the budget every
other visitor shares (Item b6588425, owner numbers 2026-11-22). A visitor is a keyed hash of its network address.

| What | Per visitor | Outer limit (unchanged) |
| --- | --- | --- |
| Signed-out code reads that miss the site cache (folder, file page, changes, touched) | 60 an hour | 120 a minute per public project |
| Device sign-in starts and renewals, together | 10 a minute and 30 an hour | 120 a minute per deployment |

**Which paths go through the site.** Convex never sees a client address, so these requests pass the site's edge, which
reads the address from the platform's own request context:

- Signed-out code and history already go through the cached public read (`netlify/functions/public-read.mts`, then
  `/public/v1/code/…`). On a cache miss the function, and the Cloudflare Worker behind file pages, forward the hash.
  The members' source actions (`projectCodeBrowse:read`, the rendered `projectSourceReview:read`) now refuse signed-out
  callers with `PROJECT_UNAVAILABLE`, so a client cannot skip the limit by calling Convex directly. No signed-out page
  used them. Signed-in reads are unchanged.
- `nforge login` and sign-in renewal post to `/auth/device/start-v2` and `/auth/device/renew` on the site
  (`netlify/functions/device-auth.mts`), which forwards the request unchanged with the hash. The CLI still signs for the
  backend origin and tries it first; a backend that requires the site answers `421 use_site` with the site's origin, and
  the CLI sends the same signed request there once. An environment without the setting answers directly, as before.

**How the hash is keyed.** The edge computes HMAC-SHA256 over `forge-client-v1`, a zero byte and the address under
`FORGE_CLIENT_HASH_KEY`, which only the site holds; Convex stores only the 64-character hash. IPv6 is keyed by its /64,
an IPv4-mapped address as IPv4. The address is never stored, logged, forwarded or put in an error. Without the key,
stored hashes cannot be matched to addresses by trying them. A /64 is one subscriber's usual allocation; a holder of a
whole /48 still gets one budget per /64, which the outer limits then bound. Rotating the key resets every visitor's
window.

**Trust.** Convex accepts the hash only from the site: on `/public/v1/…` with the existing `FORGE_PUBLIC_READ_SECRET`,
on the device routes with `FORGE_SITE_DEVICE_KEY` (both compared as fixed-length digests). Once
`FORGE_SITE_DEVICE_KEY` is set on Convex, a direct start or renewal, or one with a wrong key, gets `421 use_site` and
runs nothing; a visitor key in the request JSON is ignored. A site that sends no hash (an older edge) is not charged
per visitor; the project and deployment budgets still apply. Addresses behind one NAT share a budget, as on GitHub.

**Refusals.** An over-limit read answers `429 RATE_LIMITED`, uncached, with "Signed-out reads from your network are at
their limit of 60 an hour. Sign in (nforge login) or retry in N min." An over-limit sign-in answers `429 slow_down` with
the wait in `interval` and a sentence the CLI shows. A refusal writes nothing: an over-limit visitor spends none of the
outer budget, and a call the outer budget refuses is not charged to the visitor.

**Cost.** Cache hits run no function and no Convex call, as before; idle costs nothing. On a miss or a sign-in start the
charge runs inside the mutation that already serves it: one point read and one write on `deviceAttempts`, and a refusal
only the read. A new visitor's first row also deletes up to two expired rows (`by_expiresAt`), so rotating addresses
cannot grow the table; there is no job. No Convex call, table or CLI dependency is added. Code history, project, profile,
explore and sitemap reads are queries with no mutation to charge, so they carry no per-visitor count: they stay bounded
by the 30-second cache per address and the site's platform rate rule of 60 a minute per IP.

**Added latency (measured from one client on 2026-11-22).** Hashing costs about 18 µs per request. A cache hit adds
nothing. A sign-in start or renewal adds one site round trip: the dev site's function answered in a median of 151 ms
server time (281 ms with a new TLS connection) against 33 ms for a static file, so about 0.12 s of function start plus
the in-region hop to Convex. Once the backend requires the site, the CLI's first direct call is the refusal round trip
(dev Convex median 294 ms server, 335 ms total). Sign-ins run once per login and renewals once per 30 days.

**Settings.** Site: `FORGE_CLIENT_HASH_KEY` and `FORGE_SITE_DEVICE_KEY` (with the existing `FORGE_CONVEX_SITE_URL` and
`FORGE_PUBLIC_READ_SECRET`). Convex: `FORGE_SITE_DEVICE_KEY`, the same value. The public code Worker forwards the hash
once redeployed. Roll out in this order: release the CLI, set both site settings and deploy the site, then set the
Convex setting; it switches device sign-in to the site, and unsetting it switches back. A CLI older than this release
gets the `421` sentence and must update (`nforge update`), so set the Convex setting only after the release has been
out. Rotating `FORGE_SITE_DEVICE_KEY` means changing it on both sides together; sign-ins fail with `use_site` in the gap.
A self-hosted site must point `FORGE_CONVEX_SITE_URL` at the same backend origin its CLIs use (`FORGE_HTTP_URL`),
because the signed proof names that origin. Not covered: signed-out CI output reads over the Convex client remain
charged only to the project budget.
