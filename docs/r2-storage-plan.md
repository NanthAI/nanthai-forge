# R2 storage plan

Plan to move every file blob from the application database's file storage to Cloudflare R2, so that file bytes never pass through database functions. Status: design and spike done; slices R0 and R1 are landed and slice R2 (dual read) is in review; with R2 the opt-in works end to end. R3 owner-derived publication and the R6 lead-run backfill command are implemented; deployment qualification and the actual backfill remain. Date: 2026-10-19. Related: [roadmap](roadmap.md), [egress](operations/egress.md), [compute and egress](operations/compute-egress.md), [source exchange](operations/source-exchange.md).

## Why

The first month of hosted use taught a general lesson: when file bytes are read by server functions, every read is billed as egress, and some reads are billed twice (once as a fetch, once as file serving). Hosted pushes re-read stored bytes once per durable step, and thousands of steps add up to hundreds of gigabytes. Other sources were open browser tabs (calls and database I/O, not egress) and a key-set endpoint fetched on every request. Fixes landed for all of these, but while bytes live in function-readable storage, any new code path can reintroduce the cost.

R2 has zero egress fees. If clients move bytes directly to and from R2 with short-lived signed URLs, the database only handles metadata, authority and realtime state.

## Target design

Principle: R2 holds every blob. No database function receives or returns file bytes. Functions only sign URLs, record digests and check membership.

- **Keys and dedupe.** Key `v1/p/<projectId>/o/<sha256>`; the key is the content address. Large files keep their 1 MiB recipe leaves, so chunk dedupe across versions carries over. A per-project namespace gives prefix purge, prefix-scoped credentials and no cross-project existence oracle. Forks duplicate storage, which costs about $0.015 per GB-month.
- **Integrity, three layers.** (1) The signed PUT is create-only (`If-None-Match: *`) and carries a sha256 checksum that R2 enforces. (2) A commit step checks each new object with a HEAD request. (3) Every reader verifies the sha256 of what it downloads, as Git does, so a corrupt upload can only damage a project the uploader could already write to.
- **Upload.** The client asks which objects are missing, asks for signed PUT URLs for up to 100 at a time, uploads directly, then commits the batch. About 3 database calls per 100 objects instead of 2 to 3 per object.
- **Download.** One call returns signed GET URLs for up to 100 keys after a membership check. Ranged reads use HTTP `Range` on the same URL.
- **Browser.** The bucket gets a CORS rule for the web origin. The code view and diff fetch blobs directly, verify sha256 with `crypto.subtle` and compute hunks client-side.
- **Access control.** Private projects: the bucket is private, and the only way to obtain bytes is a URL signed after a current access check. Revocation applies immediately to new URLs; issued URLs live at most 5 minutes (GET) or 15 minutes (PUT). Public projects may be signed without sign-in, limited to 100 keys per call plus a per-project anonymous budget. The signing secret is a bucket-scoped token held only as a server environment variable.
- **Retention.** Objects are never overwritten. Project purge lists and deletes a prefix (deletes are free). Prepared-but-uncommitted uploads are swept after 24 hours. Optional later: a weekly copy to a second bucket and a bucket lock.
- **Moving byte processing.** Diffstats, views and tree derivation move to the CLI (it already holds the bytes and sends derived data); publication validation becomes database lookups over a bounded manifest the CLI supplies; source-return cursors become database rows; the web code view runs in the browser; GitHub-import artifacts are built by a runner or the CLI. The trust shift: derived display data is client-supplied, so a malicious pusher can mislabel only their own project's display data. Authority (who may land, main heads) stays server-side. Current pushes require owner display protocol 3; R2 opt-in controls storage placement, independently of display derivation.
- **Public reads at scale (later).** A small Worker with an R2 binding and edge cache on a project subdomain, so anonymous reads need no database call. Presigned URLs do not work on custom domains, so this is a separate path.

## Slices

| Slice | Content | Status |
| --- | --- | --- |
| R0 | A single blob-store seam in the backend and CLI (no behaviour change), `location` and key fields on object rows, and a presigner using `crypto.subtle` with the AWS reference test vector | Landed |
| R1 | Signed PUT write path behind a flag and per-project opt-in; commit step with HEAD checks; CLI direct upload with PUT concurrency of 8 or more | Landed |
| R2 | Signed GET read path; readers dispatch on each row's location; browser sha256 helper; mixed-location tests, revoked members, expired URLs | In review (tested against a local fake; real-bucket smoke pending) |
| R3 | Owner display data, metadata publication and durable source return | Implemented; protocol 3 removes push-time display derivation, local qualification only |
| R4 | Browser bytes: code view, review and archive download through signed URLs; CORS | Not started |
| R5 | Imports, zones, agents and proposals build artifacts into R2 | Not started |
| R6 | Backfill: export, upload each file after checking its digest, flip rows in pages; keep old storage 14 days as fallback | Lead-run command implemented; deployment qualification and actual run remain |
| R7 | Prefix purge, abandoned-upload sweep, scheduled database-only export, optional bucket lock | Not started |
| R8 | Optional public Worker with edge cache on a custom subdomain | Later |

Order: R0, R1, R2, then R3a and R4 in parallel, R3b, R6, R5, R7. R0 to R2 alone remove egress for pulls and new pushes. During dual read every reader dispatches on the row's location, so old and new paths coexist. Rollback: unset the flag and new writes return to the old storage; rows already in R2 stay readable; nothing in old storage is deleted until 14 days after a full digest verification.

## R1 write path

Off by default, and byte-for-byte the old behaviour when off. New objects go to R2 only when both the Convex environment has `FORGE_BLOBS=r2` and the project owner has opted in. Objects already stored stay where they are.

- `projectObjects:prepareBatch` inserts new rows with `location: 'r2'` and `r2Key` (`v1/p/<projectId>/o/<sha256>`) and returns `target: { kind: 'r2', url, headers }`, a 15 minute presigned PUT. The signature covers `content-length`, `if-none-match: *` and `x-amz-checksum-sha256`; no content type is signed or sent. A pending R2 row whose opt-in was later turned off returns to the Convex path.
- The CLI sends the PUT with those headers, with the existing bounded upload concurrency (8 per window), retries 5xx, 429 and network errors with backoff, and treats 412 (object already there) as success.
- `projectObjectCommit:commitBatch` (an action) sends one signed HEAD per new object in parallel and checks the size, and the checksum when R2 returns it. Verified rows get `r2Committed`; a missing or wrong object returns a typed error (`R2_OBJECT_MISSING`, `R2_OBJECT_SIZE_MISMATCH`, `R2_OBJECT_CHECKSUM_MISMATCH`, `R2_VERIFY_FAILED`) and leaves the row pending. Retrying the same call is safe.
- Missing R2 settings with the flag and opt-in on fail closed with `R2_NOT_CONFIGURED`.
Enable it for a project: set the Convex environment variables in [operations](operations.md#r2-object-storage-write-path), then run the owner-only mutation `projectObjectCommit:setR2Writes` with `{ projectId, enabled: true }`. Turn it off the same way, or unset `FORGE_BLOBS`.

## R2 dual read

Reads of committed R2 rows work end to end, so a push to an opted-in project now uploads, publishes and pulls back. Rows in Convex storage keep their old read paths unchanged, and a project can hold both.

- `projectObjectDownloads:signDownloads` `{ projectId, digests ≤ 100 }` is the single choke point. It is a mutation that writes nothing, so Convex does not cache the function result and each call signs fresh URLs. It checks current access on every call (owner, current contributor or reader, a non-revoked device credential, and a project that is not being deleted) and returns `{ digest, size, url }` for each digest that is a committed, non-removed R2 row of that project. Unknown, pending, other-project and Convex-stored digests are absent from the result.
- URLs are path-style, region `auto`, valid for 5 minutes. Revocation reaches new URLs at once; an issued URL lives at most 5 minutes. Ranged reads use HTTP `Range` on the same URL.
- Committed rows stay readable when `FORGE_BLOBS` is unset (the rollback rule), as long as the R2 settings are configured. A digest that needs signing with missing settings fails with `R2_NOT_CONFIGURED`; Convex-only projects never need the settings.
- Public projects sign without sign-in, at most 100 digests per call. TODO(owner): there is no anonymous budget counter yet. Adding one is a user-facing limit and needs owner approval.
- CLI and agent readers (`src/exchange-r2-read.ts`, used by pull, checkout, landing and agent reads through the exchange client) retain signed URLs only in process memory, per client, project and digest. They reuse a URL until 60 seconds before its signed expiry, then ask `signDownloads` only for uncached digests (at most 100 per call). URLs are never written to disk or logs. Verified local byte-cache hits skip signing and GETs while retaining current project-binding checks, including when writing those bytes to a file. Other reads use 8 parallel GETs, retry 5xx, 429 and network errors with backoff, discard a cached URL on 403, sign again once and then fail with `EXCHANGE_DOWNLOAD_DENIED` if the replacement is refused. Every download verifies size and sha256 before the bytes are used or written; a mismatch is `BLOB_DIGEST_MISMATCH`. Digests that are not R2 rows fall through to the old download actions and are not cached as signed URLs, so Convex-only fetches still ask `signDownloads`.
- Browser: `web/src/verified-blob.ts` (`verifiedBytes`) checks sha256 with `crypto.subtle`. The code view and diff do not use R2 yet (R4).

Server-side readers that still need bytes inside Convex fetch a signed GET inside the action and verify it (`BLOB_DIGEST_MISMATCH`, or `R2_OBJECT_UNAVAILABLE` when the object cannot be read):

| Site | Decision |
| --- | --- |
| `projectObjects:resolve` (every Convex-side reader) | Serves committed R2 rows; a pending R2 row is `INVALID_WORK_BACKUP`. |
| Checkpoint publication, migration, hosted main, closure validation, recipe binding | Treat a committed R2 row as stored, with no byte read. |
| Publication parsing (root manifest, `work.json`, States), derived views, diffstats, recipe ranges | Fetch via signed GET inside the action. R3 removes these byte reads. |
| `downloadBatch`, and `downloadPart` of a raw R2 object | Same fetch, for callers that do not sign. |
| Large files (recipes) | The CLI still reads them through `downloadPart`, so leaf bytes cross Convex until R3 or R4 moves recipe reading to the client. |

## R3 owner-derived publication and source return (done)

Current nforge pushes declare owner display protocol 3. The CLI computes every
new State's parents and own-parent ancestry boundaries, comparison totals, View
provenance and file lists, selected Code trees, and coordination change paths.
Selection uses the exact hosted baseline when retained locally; missing baseline
Work or cache entries cause local computation. Display items are never dropped
to fit a total sidecar budget. Large sidecars use immutable 128 KiB pages with
individual size/SHA-256 pins and a whole-document digest; small roots retain the
ordinary object transport. Metadata publication already sends these same facts
in bounded database pages with the exact Work JSON and State closure edges.

The server checks shape, safe counts, pinned references, payload hashes and
complete coverage before staging rows. It trusts owner-supplied display facts;
these facts never grant Work or Channel authority. Revision, main-history,
owner authorization, journal validation and final compare-and-set remain on the
server. Missing or invalid current-protocol data fails explicitly rather than
starting server derivation. Old writers and old publications used as a new
push receive `CLI_UPGRADE_REQUIRED`, naming nforge and an upgrade command.
Existing hosted reads and completed-operation receipt replay remain available.
See the [upgrade note](operations/source-exchange.md#cli-upgrade).

Source return drains validated rows in bounded commits without parent, ancestry,
diffstat or View computation. Small deltas install directly. Large deltas copy
retained database index rows and apply owner replacements into a private
partition before the existing atomic switch. A cold continuation reads its
snapshot/cursor from database pages, not object storage. Immutable output is stored
once with the snapshot; the cursor carries only its offset. The automatic
`projectPublicationStore:displayBaseline` negotiation requests complete local
facts when no current index exists; those facts form a new private partition
under the same source/revision CAS. Complete current publications also build
cold read indexes from their owner facts. There is no full-source
derivation fallback for current returns. Legacy read-index construction remains
available for existing hosted data; it is not a push compatibility path.

The former routine coordination path opened up to eight State objects merely
to calculate advisory changed paths. Those reads are removed: the owner supplies
paths and their total. Record-based returns still authenticate roots, catalogs,
delta descriptors and touched Work record bodies, and read owner display pages.
Those remaining metadata reads validate source/Work identity and current journal
history; they do not read file blobs or State bytes for display derivation.
Metadata-publication returns read zero stored object bytes.

No hosted backfill or migration command is needed. Upgrade the CLI before the
next new push; retained legacy operations that lack owner display facts require
a newly prepared push. The lead still qualifies actual network latency after
landing; local fake-storage timings are not hosted measurements.

## Spike findings

Run on 2026-10-19 against a throwaway bucket (western Europe) with a bucket-scoped token, from a laptop, 5 repetitions, path-style presigned SigV4 URLs. The bucket and token were deleted afterwards.

| Size | PUT median | GET median |
| --- | --- | --- |
| 1 KiB | 220 ms | 156 ms |
| 64 KiB | 204 ms | 106 ms |
| 1 MiB | 243 ms | 160 ms |
| 10 MB | 1,126 ms | 528 ms |

- Range GET returns 206.
- Create-only PUT: `If-None-Match: *` returns 412 for an existing key and 200 for a new key, so no-overwrite works.
- Checksum: a correct `x-amz-checksum-sha256` returns 200 and a wrong one returns 400, so R2 enforces the content hash on a presigned PUT and the HEAD size check is only a backstop.
- A signature reused for another key returns 403; an expired URL returns 403.
- CORS was not tested (no rule set); R4 must add and test one.
- Virtual-host style URLs failed the TLS handshake; use path-style on the account host. R2 needs a payment method on file before the first bucket (free tier unchanged).
- Consequence: small objects cost about 0.2 s per request regardless of size, so pushes with many small objects are latency-bound and need PUT concurrency of at least 8. A pack file per push for small objects is only worth it near 10,000 projects.

## Cost model

Prices checked 2026-10-19. Hosted database, Starter tier: 1M calls included then $2.20 per million; 20 GB-hours of action compute then $0.33; 1 GB database I/O then $0.22 per GB; 1 GB egress then $0.132 per GB; 1 GB file storage then $0.033 per GB-month. R2 Standard: $0.015 per GB-month, Class A $4.50 per million, Class B $0.36 per million, egress free; free each month 10 GB-month, 1M Class A, 10M Class B. Identity is free to 50,000 monthly retained users.

Formula per billed line: `max(0, used - included) * price`, summed over calls, action compute, database I/O, egress, file storage, and R2 storage, Class A and Class B operations. Allowances are applied to Forge alone; a shared account would spend them elsewhere first.

Activity profiles per project per day: a heavy project (8 agents bound 10 h, a tab open 4 h, 8 pushes, 50 file views, 2.4 GB stored); an active project (4 agents for 6 h, a tab 2 h, 3 pushes, 30 MB pulled, 20 views, 50 MB stored); a light project (3 minutes of tab time, one push a week, 1 MB pulled, 20 MB stored). At 100 and 1,000 projects: 20% active, 80% light.

Modelled monthly estimates (modelled, not billed):

| Scenario | Estimate |
| --- | --- |
| This project, after the egress and idle-tab fixes | about $2 |
| This project, with R2 | about $1.1 |
| 100 projects, fixes only / with R2 (Starter) | about $38 / about $14 |
| 1,000 projects, fixes only (Starter / Professional) | about $466 / about $313 |
| 1,000 projects, with R2 (Starter / Professional) | about $168 / about $117 |
| 1,000 projects, R2 plus the realtime levers below (Starter) | about $66, roughly $0.07 per project |

Free tiers end, for active projects only: after R2, database I/O runs out first (below one active project), then calls (about 7); R2 storage at about 200 active projects, Class B at about 220, Class A at about 560. A project nobody touches costs about nothing: no calls, no I/O, and $0.00075 a month for 50 MB.

Sensitivity: if a post-fix push really costs 100 MB of egress instead of the modelled 20 MB, the fixes-only rows grow by about $2.5 for this project, $30 at 100 projects and $300 at 1,000. That uncertainty is a reason to do R2 anyway. R2 storage is linear: 1,000 active projects of 1 GB each is about $15 a month.

What remains after R2 is realtime: database I/O and calls from open tabs and bound agents. Levers, each small: presence heartbeat from 30 s to 5 minutes and published only while someone watches; cached and coarsened session reads; token refresh no longer restarting every subscription; retiring short timers; larger page sizes. Per-project idle cost is near zero only if presence stops when idle, so leaked presence workers must be reaped and auto-unbound.

## Risks and open questions

1. Approved: trust client-supplied derived display data; authority stays server-side.
2. Approved while pre-1.0: require current owner display protocol before new pushes.
3. Revocation window of up to 5 minutes for issued GET URLs (the usual norm).
4. Anonymous signing for public projects costs one database call per batch; the Worker path needs a custom domain.
5. A second backup bucket and bucket lock delay real deletion by the lock period, which affects privacy wording.
6. The post-fix push egress is modelled, not measured; measure one real push before and after usage reads.
7. Unverified: the Professional-tier base fee, and whether websocket query results are ever billed as egress (inferred not).
8. The hosted account has a spend limit that disables the deployment when reached; watch it until the fixes are verified.
9. The browser path (CORS, client-side hunks) is untested against a real bucket.

### Lead qualification

Run from the landed runtime after the lead's dev deployment, with the existing
account login and existing bound owners. Do not use the checkpoint-only
`measure-exchange-latency` push as a source-return measurement: that harness
intentionally does not return source.

For each owner, set `R3B_OWNER` to its path and `R3B_RESULT` to a private output
file, then run:

```sh
npm run build:core
node --input-type=module - <<'JS'
import { writeFileSync } from 'node:fs';
import { boundExchange } from './dist/bound-exchange.js';
const started = performance.now();
const result = await boundExchange(process.env.R3B_OWNER, 'push');
const receipt = { elapsedMs: Math.round(performance.now() - started), result };
writeFileSync(process.env.R3B_RESULT, JSON.stringify(receipt, null, 2), { mode: 0o600 });
console.log(JSON.stringify({ elapsedMs: receipt.elapsedMs, backupId: result.backupId,
  accounting: result.sourceReturn?.accounting }));
JS
```

1. Use the real dogfood owner with its normal pending landings. Compare the
   observed total against push #10's 5,731 seconds, recording the source-return
   action time separately from publication/upload. In dev logs, retain
   `source-return owner-derived` `fastPath` and `metadataOnly`, every
   `source-return step`, and `source-return complete` accounting. Require zero
   derivation calls and no State/blob reads for display. Incomplete owner data
   must fail explicitly; the CLI computes missing items before uploading. Do not infer
   the cause of a previous push without its retained sidecar/baseline evidence.
2. Use the existing opted-in R2 throwaway. Seed a checkpoint with this CLI first
   if its current source predates the publication Work field, then return a
   second synthetic multi-landing push. Match its publication/return operation
   IDs in dev logs. Require `metadata-publication complete` and
   `source-return complete` to report `storageReads: 0`, `storageBytes: 0`;
   confirm `metadataOnly: true` on the coverage log. Repeat an interrupted push
   with its retained operation, then verify one final receipt and unchanged
   source/Work authority. A progress probe must show inner ancestry/file/output
   counters during a long step, with no gap over roughly 60 seconds.

These commands are lead-only live qualification, not local fixture results.

## R6 lead-run backfill

`nforge maintenance r2-backfill` streams project files through verified private
CLI spool files, resumes by page, and flips rows only after R2 HEAD verification
and a location/storage-id CAS. Convex copies remain intact. `--dry-run` reads
metadata only; `--verify` checks every backfilled object and downloads a digest
sample, then reports a date 14 days after the full pass. See the
[operator runbook](operations/r2-backfill.md) for opt-in, commands, recovery, cost
and verification details. No real deployment run is implied by local tests.
