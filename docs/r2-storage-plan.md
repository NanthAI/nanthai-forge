# R2 storage plan

Plan to move every file blob from the application database's file storage to Cloudflare R2, so that file bytes never pass through database functions. Status: R0–R3 and R6 are landed; R4 browser bytes, R5 artifacts and R7 purge/sweep are implemented and awaiting landing. R4 has local fake-browser qualification; live CORS qualification, deployment qualification and the actual R6 backfill remain lead-run work. Related: [roadmap](roadmap.md), [egress](operations/egress.md), [compute and egress](operations/compute-egress.md), [source exchange](operations/source-exchange.md).

## Why

The first month of hosted use taught a general lesson: when file bytes are read by server functions, every read is billed as egress, and some reads are billed twice (once as a fetch, once as file serving). Hosted pushes re-read stored bytes once per durable step, and thousands of steps add up to hundreds of gigabytes. Other sources were open browser tabs (calls and database I/O, not egress) and a key-set endpoint fetched on every request. Fixes landed for all of these, but while bytes live in function-readable storage, any new code path can reintroduce the cost.

R2 has zero egress fees. If clients move bytes directly to and from R2 with short-lived signed URLs, the database only handles metadata, authority and realtime state.

## Target design

Principle: R2 holds every blob. No database function receives or returns file bytes. Functions only sign URLs, record digests and check membership.

- **Keys and dedupe.** Key `v1/p/<projectId>/o/<sha256>`; the key is the content address. Large files keep their 1 MiB recipe leaves, so chunk dedupe across versions carries over. A per-project namespace gives prefix purge, prefix-scoped credentials and no cross-project existence oracle. Forks duplicate storage, which costs about $0.015 per GB-month.
- **Integrity, three layers.** (1) The signed PUT is create-only (`If-None-Match: *`) and carries a sha256 checksum that R2 enforces. (2) A commit step checks each new object with a HEAD request. (3) Every reader verifies the sha256 of what it downloads, as Git does, so a corrupt upload can only damage a project the uploader could already write to.
- **Upload.** The client asks which objects are missing, asks for signed PUT URLs for up to 100 at a time, uploads directly, then commits the batch. About 3 database calls per 100 objects instead of 2 to 3 per object.
- **Download.** One call returns signed GET URLs for up to 100 keys after a membership check. Ranged reads use HTTP `Range` on the same URL.
- **Browser.** The bucket gets a CORS rule for the web origin. The code view, diff and object archive download fetch blobs directly, verify sha256 with `crypto.subtle` and compute hunks client-side.
- **Access control.** Private projects: the bucket is private, and the only way to obtain bytes is a URL signed after a current access check. Revocation applies immediately to new URLs; issued URLs live at most 5 minutes (GET) or 15 minutes (PUT). Public projects may be signed without sign-in, limited to 100 keys per call plus a per-project anonymous budget. The signing secret is a bucket-scoped token held only as a server environment variable.
- **Retention.** Objects are never overwritten. Project purge lists and deletes a prefix (deletes are free). Prepared-but-uncommitted uploads are swept after 24 hours. Optional later: a weekly copy to a second bucket and a bucket lock.
- **Moving byte processing.** Diffstats, views and tree derivation move to the CLI (it already holds the bytes and sends derived data); publication validation becomes database lookups over a bounded manifest the CLI supplies; source-return cursors become database rows; the web code view runs in the browser; GitHub-import artifacts are built by a runner or the CLI. The trust shift: derived display data is client-supplied, so a malicious pusher can mislabel only their own project's display data. Authority (who may land, main heads) stays server-side. Current pushes require owner display protocol 3; R2 opt-in controls storage placement, independently of display derivation.
- **Public reads at scale (later).** A small Worker with an R2 binding and edge cache on a project subdomain, so anonymous reads need no database call. Presigned URLs do not work on custom domains, so this is a separate path.

## Slices

| Slice | Content | Status |
| --- | --- | --- |
| R0 | A single blob-store seam in the backend and CLI (no behaviour change), `location` and key fields on object rows, and a presigner using `crypto.subtle` with the AWS reference test vector | Landed |
| R1 | Signed PUT write path behind a flag and per-project opt-in; commit step with HEAD checks; CLI direct upload with PUT concurrency of 8 or more | Landed |
| R2 | Signed GET read path; readers dispatch on each row's location; browser sha256 helper; mixed-location tests, revoked members, expired URLs | Landed; local fake qualification, real-bucket smoke pending |
| R3 | Owner display data, metadata publication and durable source return | Landed; protocol 3 removes push-time display derivation, local qualification only |
| R4 | Browser bytes: code view, review and archive download through signed URLs; CORS | Done; awaiting landing, local fake-browser qualification, live CORS qualification remains lead-only |
| R5 | Imports, zones, agents and proposals build artifacts into R2 | Done; server/runner artifacts and browser logical-object uploads use the project opt-in |
| R6 | Backfill: export, upload each file after checking its digest, flip rows in pages; keep old storage 14 days as fallback | Landed; lead-run command implemented, deployment qualification and actual run remain |
| R7 | Prefix purge, abandoned-upload sweep, scheduled database-only export, optional bucket lock | Done; awaiting landing |
| R5 | Imports, zones, agents and proposals build artifacts into R2 | Done; awaiting landing |
| R7 | Prefix purge, abandoned-upload sweep, scheduled database-only export, optional bucket lock | Done; awaiting landing, local purge/sweep and database-only backup fixtures; live operator run remains |
| R8 | Optional public Worker with edge cache on a custom subdomain | Later |

Order: R0, R1, R2, then R3a and R4 in parallel, R3b, R6, R5, R7. R0 to R2 alone remove egress for pulls and new pushes. During dual read every reader dispatches on the row's location, so old and new paths coexist. Rollback: unset the flag and new writes return to the old storage; rows already in R2 stay readable; nothing in old storage is deleted until 14 days after a full digest verification.

## R1 write path

Off by default, and byte-for-byte the old behaviour when off. New objects go to R2 only when both the Convex environment has `FORGE_BLOBS=r2` and the project owner has opted in. Objects already stored stay where they are.

- `projectObjects:prepare` and `prepareBatch` insert new rows with `location: 'r2'` and `r2Key` (`v1/p/<projectId>/o/<sha256>`) and return `target: { kind: 'r2', url, headers }`, a 15 minute presigned PUT. The signature covers `content-length`, `if-none-match: *` and `x-amz-checksum-sha256`; no content type is signed or supplied by Forge. A client can add an unsigned content type; typed `Blob`/`File` PUT bodies can supply it implicitly. Forge PUTs use byte arrays or untyped streams. A pending R2 row whose opt-in was later turned off returns to the Convex path.
- The browser archive importer uploads each logical source/Work object through `projectObjects:prepare`. Opted-in new objects use the signed PUT directly from the browser, omitting JavaScript's forbidden Content-Length header so the browser supplies it from the Blob. A successful PUT or create-only 412 goes through the same HEAD-based `commitBatch`; failed or aborted transfers leave pending rows and do not complete the import. Existing Convex objects and projects without the opt-in keep the POST/reconcile/complete path.
- The CLI sends the PUT with those headers, with the existing bounded upload concurrency (8 per window), retries 5xx, 429 and network errors with backoff, and treats 412 (object already there) as success.
- `projectObjectCommit:commitBatch` (an action) sends one signed HEAD per new object in parallel and checks the size, and the checksum when R2 returns it. HEAD requests send unsigned `Accept-Encoding: identity` so compressible content types retain their stored length. A successful HEAD without `Content-Length` is a verification error, never a size mismatch. Verified rows get `r2Committed`; a missing or wrong object returns a typed error (`R2_OBJECT_MISSING`, `R2_OBJECT_SIZE_MISMATCH`, `R2_OBJECT_CHECKSUM_MISMATCH`, `R2_VERIFY_FAILED`) and leaves the row pending. Retrying the same call is safe.
- Missing R2 settings with the flag and opt-in on fail closed with `R2_NOT_CONFIGURED`.
Enable it for a project: set the Convex environment variables in [operations](operations.md#r2-object-storage-write-path), then run the owner-only mutation `projectObjectCommit:setR2Writes` with `{ projectId, enabled: true }`. Turn it off the same way, or unset `FORGE_BLOBS`.

## R2 dual read

CLI/server object, artifact, backfill and archive reads request unsigned
`Accept-Encoding: identity` wherever stored byte lengths, checksums or offsets matter.
Archive part reads retain HTTP Range with identity encoding; restore and checkout
reuse these verified readers.

Reads of committed R2 rows work end to end, so a push to an opted-in project now uploads, publishes and pulls back. Rows in Convex storage keep their old read paths unchanged, and a project can hold both.

- `projectObjectDownloads:signDownloads` `{ projectId, digests ≤ 100 }` is the single choke point. It is a mutation that writes nothing, so Convex does not cache the function result and each call signs fresh URLs. It checks current access on every call (owner, current contributor or reader, a non-revoked device credential, and a project that is not being deleted) and returns `{ digest, size, url }` for each digest that is a committed, non-removed R2 row of that project. Unknown, pending, other-project and Convex-stored digests are absent from the result.
- URLs are path-style, region `auto`, valid for 5 minutes. Revocation reaches new URLs at once; an issued URL lives at most 5 minutes. Ranged reads use HTTP `Range` on the same URL.
- Committed rows stay readable when `FORGE_BLOBS` is unset (the rollback rule), as long as the R2 settings are configured. A digest that needs signing with missing settings fails with `R2_NOT_CONFIGURED`; Convex-only projects never need the settings.
- Public projects sign without sign-in, at most 100 digests per call. TODO(owner): there is no anonymous budget counter yet. Adding one is a user-facing limit and needs owner approval.
- CLI and agent readers (`src/exchange-r2-read.ts`, used by pull, checkout, landing and agent reads through the exchange client) retain signed URLs only in process memory, per client, project and digest. They reuse a URL until 60 seconds before its signed expiry, then ask `signDownloads` only for uncached digests (at most 100 per call). URLs are never written to disk or logs. Verified local byte-cache hits skip signing and GETs while retaining current project-binding checks, including when writing those bytes to a file. Other reads use 8 parallel GETs, retry 5xx, 429 and network errors with backoff, discard a cached URL on 403, sign again once and then fail with `EXCHANGE_DOWNLOAD_DENIED` if the replacement is refused. Every download verifies size and sha256 before the bytes are used or written; a mismatch is `BLOB_DIGEST_MISMATCH`. Digests that are not R2 rows fall through to the old download actions and are not cached as signed URLs, so Convex-only fetches still ask `signDownloads`.
- Browser: Code (including exact State/raw), Lane/Candidate review, change maps and search use `web/src/browser-source.ts`. `projectObjectDownloads:source` returns exact checkpoint and disposable source pins, never file bytes; an absent pin index falls back to reading the same immutable manifest in the browser. `describe` returns project-authorized location metadata (R2, Convex URL or recipe), in pages of 100. `src/blob-download.ts` batches R2 signing at 100 and GETs at eight, calls `verifiedBytes` before exposing bytes, and refreshes once on 403 or a CORS-masked network failure. Convex rows remain readable directly through their storage URLs. Private access is rechecked before and after reads, even on byte-cache hits. Public anonymous reads use the same source/describe/sign access boundary. No anonymous budget number has been added; its owner-approval TODO remains.
- Browser bytes are cached in memory per client/project, by sha256, for 60 seconds with a 16 MiB cache budget. This is an internal cache budget, not a content limit: larger files remain readable. Review panels re-enter the reader on each file selection rather than retaining independent permanent content caches. Expiration is lazy, no timer or polling runs, and signed URLs are fetched only on demand and never persisted. Recipe pages and full leaves are digest-verified; leaves use full GETs, and complete reconstructions also verify the whole-file hash. Browsers cannot set `Accept-Encoding`; full GETs let fetch decode transport compression before size/hash verification without addressing compressed byte ranges. Selected ranges verify complete touched leaves before slicing.
- `projectExchangeActions:downloadBatch` and `downloadPart` return `{direct:true,digest,size}` for R2 or recipe rows, with no byte read. Updated CLI readers follow that hint through the same direct object reader, including mixed recipes. The public `projectSourceReview:read` compatibility endpoint now returns a checkpoint plan only; server-only anchor validation retains `readSourceReview`. Retained R2/recipe check logs return a pin and are verified, redacted and paged in the browser. Convex-only logs retain the old server path.
- Stored-checkpoint history offers an object-backed source-and-Work archive download through `web/src/object-archive.ts`. It reconstructs exact manifest/member bytes (including record-based Work) and makes a new gzip container in the browser. The resulting container digest is distinct from the original source receipt. Matching source/journal handoff controls retain their existing pull request and journal identities. Legacy archive/proposal downloads remain in Convex storage and retain their existing download and whole-archive checksum paths.

Server-side readers that still need bytes inside Convex fetch a signed GET inside the action and verify it (`BLOB_DIGEST_MISMATCH`, or `R2_OBJECT_UNAVAILABLE` when the object cannot be read):

| Site | Decision |
| --- | --- |
| `projectObjects:resolve` (every Convex-side reader) | Serves committed R2 rows; a pending R2 row is `INVALID_WORK_BACKUP`. |
| Checkpoint publication, migration, hosted main, closure validation, recipe binding | Treat a committed R2 row as stored, with no byte read. |
| Publication parsing (root manifest, `work.json`, States), derived views, diffstats, recipe ranges | Fetch via signed GET inside the action. R3 removes these byte reads. |
| Public `downloadBatch` / `downloadPart` | Metadata-only direct-read hints for R2/recipe rows; Convex-stored raw rows retain byte responses. |
| Large files (recipes) | Browser and CLI resolve recipes client-side, fetching complete verified R2 leaves directly before slicing selected ranges. |

## Browser CORS handoff (lead only; not applied by local tests)

The exact Cloudflare API rule array is:

```json
[
  {
    "allowed": {
      "origins": ["https://nanthai-forge-dev.netlify.app", "http://localhost:5173"],
      "methods": ["GET", "HEAD", "PUT"],
      "headers": ["Range", "Content-Type", "If-None-Match", "x-amz-checksum-sha256"]
    },
    "exposeHeaders": ["Content-Range", "Content-Length", "ETag", "x-amz-checksum-sha256"],
    "maxAgeSeconds": 3600
  }
]
```

The dev site origin comes from the `nanthai-forge-dev` site in
[development](development.md); localhost is Vite's default port, 5173. Use that
exact localhost origin for qualification. Full leaves use GET without Range; create-only
browser PUTs send If-None-Match and x-amz-checksum-sha256. Content-Length is set
by the browser rather than JavaScript. Content-Range must be exposed so the reader
can validate a 206 response. No wildcard origin or public bucket is required.

With the lead's existing cf CLI profile and bucket selection, apply the rule array:

```sh
cf r2 buckets cors update "$R2_BUCKET" --rules '[{"allowed":{"origins":["https://nanthai-forge-dev.netlify.app","http://localhost:5173"],"methods":["GET","HEAD","PUT"],"headers":["Range","Content-Type","If-None-Match","x-amz-checksum-sha256"]},"exposeHeaders":["Content-Range","Content-Length","ETag","x-amz-checksum-sha256"],"maxAgeSeconds":3600}]'
cf r2 buckets cors get "$R2_BUCKET"
```

These are lead-only account commands. This Lane does not run them. The update
replaces the bucket's rule list; the lead should retain its current list to undo
that change. Rule shape and flags follow the cf CLI schema and
[Cloudflare CORS documentation](https://developers.cloudflare.com/r2/buckets/cors/).
Expired URLs can omit CORS headers, so the browser also refreshes once after a
network error; a second failure remains an error. Real-bucket propagation and
GET/HEAD/PUT from the dev origin still need qualification after applying CORS.
Local fake-origin tests do not establish that the real bucket is configured.

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

## R5 server and runner artifacts

Hosted GitHub-import source objects, recipe parts and bootstrap metadata use the
same project opt-in as exchange. Their immutable progress cursors use the artifact
blob seam once the project is opted in. Legacy exchange metadata materialization and compressed archive metadata
sidecars also respect that opt-in. A committed R2 root is valid for proposal completion;
check outputs, logs and native agent artifacts already travel as exchange objects.

Indexed imports predate `hostedProjects` and have their own owner-only
`importStorage:setR2Writes` mutation (`{ id, enabled }`). With this opt-in and
`FORGE_BLOBS=r2`, the indexer stores its gzip artifact in R2. Public analysis runners
build the bytes locally, then send only digest/size to `/worker/uploadTarget`, PUT
directly, and publish after the backend verifies HEAD. The in-action indexer and
hosted GitHub-import worker still process source bytes inside Convex; moving their
execution to a runner/CLI remains future work.

`BlobStore` retains opaque legacy storage IDs and adds `r2blob:` references to
`artifactBlobs` metadata rows. Reservations bind a resource/generation namespace,
SHA-256, size, content type and immutable R2 key before upload. Create-only signed
PUTs carry checksums; HEAD verifies each new artifact before commit. Repeating an
unknown upload or commit reuses that reservation. Reads resolve each row's location
and verify full downloaded bytes. References grant no authority: owning actions
retain current access checks. Existing resource cleanup tombstones the binding and
schedules a signed DELETE; it does not start a new retention timer.

Zones and source-agent grants retain exact indexed-artifact references, including
old Convex rows. Zone binary exports and large hosted-query derivatives use the
indexed import's current opt-in, even when their original artifact is old. Small
inline derived JSON remains database metadata. Turning off writes keeps committed
R2 artifacts readable with the existing R2 configuration.

Compatibility boundaries: empty-project bootstrap and the first hosted-import
cursor precede any project opt-in, so they retain their existing placement. New
backup/proposal archives are already retired; resumptions of old archive uploads
retain their original Convex upload protocol. The browser archive uploader
uses `projectObjects:prepare` with the same opt-in and verified R2 upload/commit
path as `prepareBatch`; existing Convex objects retain their original placement. No backfill or live migration runs as part of R5.

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

## R7 storage maintenance

Maintenance is implemented and disabled for writes until the lead sets
`FORGE_R2_MAINTENANCE=1` on the backend. There is no new cron. Purge and abandoned
upload sweep are explicit deployment-admin commands; both default to dry-run.
The command uses the pinned Convex CLI and existing operator authentication;
provider output and credentials are withheld.

```sh
node scripts/r2-maintenance.mjs purge --deployment NAME --project PROJECT_ID --verification /private/r2-verify.json
node scripts/r2-maintenance.mjs purge --deployment NAME --project PROJECT_ID --verification /private/r2-verify.json --apply
node scripts/r2-maintenance.mjs sweep --deployment NAME --project PROJECT_ID
node scripts/r2-maintenance.mjs sweep --deployment NAME --project PROJECT_ID --apply
```

The verification input is the completed R6 `--verify` state, with zero failures,
all four kinds visited, `verificationRevision`, `verifiedAt` and
`safeToPurgeAfter`. It binds the deployment and project. This is a lead-supplied
local receipt, not a server-signed proof. Only deployment-admin internal functions
accept it. R6 currently HEAD-checks all migrated rows and downloads SHA-256
samples; it does not download every object during the final verification pass.
The original migration checks every transferred file's digest. Purge never
manufactures a verification receipt.

Purge refuses until at least 14 days after the verified pass and its recorded
safe date, or if the backfill revision changed. Only committed R2 rows migrated
before that pass qualify. Each 100-row page re-HEADs every eligible object and
requires its size and checksum to match before any deletion in that page. The
mutation rechecks the pass, original row pins and other storage references.
It uses at most 1,401 document reads (below 4,096). Storage IDs remain immutable
archive lookup aliases with `r2ConvexPurged: true`; they no longer assert a live
Convex file. Archive readers resolve them through the authorized R2 pointer,
including when old Convex-derived caches are absent.

Sweep removes only prepared, uncommitted R2 keys under `v1/p/PROJECT_ID/`, older
than 24 hours since their latest preparation (legacy rows use creation time).
It retains a pending deletion key, rechecks commit state, and rotates the upload
key on a concurrent retry. A delayed or repeated DELETE cannot remove that
retry's newly committed copy. Failed deletes retain their pending cleanup key.
Both commands report page, scanned, eligible, deleted and skipped counts. Deleted
counts represent acknowledged delete operations, including already-absent keys.
A retry starts the indexed pages again and reconciles row markers/pending keys.
Dry-runs do not claim uploads or delete storage. Failures do not advance the
operator command past the failing page; earlier completed pages remain applied.

Existing explicit permanent project deletion also removes the entire R2 project
prefix in 100-key S3 pages once maintenance is enabled. When maintenance is off, Convex-only projects need
no R2 configuration. Once enabled, prefix cleanup also covers projects without a
prior R2 marker, including artifact-only or orphaned uploads. A failed prefix action
reports its error and schedules the same page again after 60 seconds, retaining its
cursor. The project stays deleting until prefix cleanup succeeds; replaying the
original project deletion also remains available. Already-issued PUTs can complete late;
the lead can run the internal `projectR2Maintenance:purgeDeletedProjectPage`
action again for the retained deleted-project tombstone after the 15-minute PUT
expiry. No new project or source-history expiry is introduced.

The weekly backup supports database-only snapshots after deployment-wide source
bytes are in R2; see [database-only backup and restore](operations/hosted-durability.md#database-only-backup-and-restore).
