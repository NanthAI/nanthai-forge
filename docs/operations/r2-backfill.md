# R2 backfill

The project owner runs this maintenance command after enabling R2 writes. It moves
stored project objects (including checkpoint roots, metadata and recipe leaves),
legacy backup/proposal archives and retained original archive receipts. Logical
recipe rows have no file of their own; their stored leaves move independently.
No Convex storage file is deleted. Imports, zones and agent artifacts are handled
separately by the R5 work; this command scans project storage only.

Use the existing owner login (`nforge login`) or `FORGE_AUTH_TOKEN`. Supply a
bound local `ROOT`, or a deployment URL and project ID. Do not put credentials in
command arguments. Signed URLs stay in memory, outside progress files and logs.

```sh
nforge maintenance r2-backfill ROOT --dry-run
nforge maintenance r2-backfill ROOT --state /private/path/backfill.json
nforge maintenance r2-backfill ROOT --resume --state /private/path/backfill.json
nforge maintenance r2-backfill ROOT --verify --state /private/path/verification.json
nforge maintenance r2-backfill ROOT --verify --resume --state /private/path/verification.json
nforge maintenance r2-backfill ROOT --verify --full-digest --state /private/path/full-verification.json
nforge maintenance r2-backfill ROOT --verify --full-digest --resume --state /private/path/full-verification.json
```

Before the real run, the lead configures the existing R2 environment settings
(see [operations](../operations.md#r2-object-storage-write-path)), including
`FORGE_BLOBS=r2`, and calls the owner-only `projectObjectCommit:setR2Writes`
mutation with `{projectId, enabled: true}`. The command checks that opt-in; it does
not change it. Enable it before scanning so concurrent new pushes already use R2.
A previously pending Convex upload can still finish while scanning. A final
inventory detects rows missed behind the cursor; run a fresh pass with another
state file if it reports `BACKFILL_REMAINS`.

Dry-run queries indexed project rows in pages of at most 100 and reports counts,
bytes and estimated cost. It signs no URLs, downloads no bytes, flips no rows and
creates no local progress. The real run prints the same estimate before writes:
decimal Convex egress GB × $0.132 plus one planned R2 standard Class A PUT per row
at a planning rate of $4.50/million (before free tiers; HEAD/GET and storage are
excluded; retries can add operations). Repeated digests and already-present R2 keys can reduce actual PUTs.
For 22,800 rows and 1,475,814,506 bytes the estimate is approximately $0.2974;
archives beyond those totals add their own bytes and operations. This is an
estimate, not a bill or measured deployment performance.

The CLI HEAD-checks keys first, signs missing destinations in batches, then
streams up to eight files concurrently through private local spool files. It
hashes the entire Convex download before uploading. PUT uses the existing signed
create-only condition and SHA-256 checksum. Existing keys succeed only after a
HEAD confirms both size and checksum. A small mutation flips rows using their
original project, row ID, location, storage ID, digest and size; changed rows are
skipped. The mutation reads 101 row/project documents for 100 rows, plus the existing credential guard when applicable. No Node action
holds file bytes. Every reader dispatches on each object's location; archive
readers resolve the R2 URL through their retained Convex storage ID. Copies and
metadata in Convex remain available for explicit recovery.

Progress JSON records the operation ID, current table/page, completed counts and
failures. It is atomically replaced and fsynced. Keep it and its `.files`
directory together until completion. A durable spool avoids another Convex GET
after an upload failure; an R2 HEAD avoids another download after a lost PUT or
flip reply. Interrupted partial downloads must restart. The cursor advances only
after row outcomes are known. Resume preserves the original operation ID and
replays the original page; it does not overwrite existing R2 bytes. Digest or
HEAD failures retain the row and report its ID and error code. Fix the cause,
then resume. Use a different state file for a fresh complete pass. The command
prints rows, bytes, elapsed time and an estimated remaining duration; no actual
throughput is assumed before rows complete.

Verify scans every backfilled row, HEAD-checks its R2 size and checksum, and
streams the first then every 100th selected row through SHA-256 verification.
Unflipped Convex rows, missing objects, metadata mismatches or a failed sample
prevent a successful pass. Add `--full-digest` to download **every** migrated R2
object, checking its complete SHA-256 and size with at most eight concurrent
streaming downloads. It uses the same 100-row pages and durable cursor; a failed
page replays on resume. The receipt adds `fullDigest: true` and `digestChecks`
(equal to `count` on success). Resume must retain the same digest mode.
Full-digest verification reads metadata from Convex; object bytes come from R2,
with no Convex file downloads. It adds no Convex calls beyond sampled verification.
A completed verification records `verifiedAt` and
`safeToPurgeAfter` (14 days later) in its local receipt and prints the date. This
is evidence for the lead's later R7 purge, not permission or an automatic purge.
If another backfill flips rows during verification, the command resets the pass and reports the change; resume then checks the full current set. A new verification needs a new state file; `--resume` on a completed receipt
returns that same receipt rather than claiming a fresh check.

There is no measured time estimate for a deployment. With eight transfers and
22,800 objects, 0.25–1 second of effective latency per object would imply roughly
12–48 minutes before batched metadata calls, archives and retries. Network speed,
object sizes, server latency and disk throughput determine the actual duration;
use the observed progress ETA during the run.

## Owner-approved early purge

The normal purge retains Convex copies for 14 days. The owner may approve an
earlier purge only after the full-digest pass above completes without failures,
covers all four row kinds and matches the current backfill revision. Its
`verifiedAt` must be within 24 hours at each purge page and deletion mutation.
A completed file-inclusive hosted backup must also exist within the current
seven-day backup cadence. Use the existing weekly backup state directory from
[hosted durability](hosted-durability.md); `last-run.json` identifies the completed
receipt and the published format-1 manifest under its existing prefix. The
command verifies manifest/deployment/digest pins and snapshot presence. Pending,
missing and database-only backups do not qualify.

After a fresh full verification, use the same receipt, backup state directory
and explicit owner decision note for dry-run and apply:

```sh
node scripts/r2-maintenance.mjs purge --deployment NAME --project PROJECT_ID --verification /private/path/full-verification.json --backup-state-dir /private/backup-state --early-owner-approved "Owner approved early purge after current-data verification"
node scripts/r2-maintenance.mjs purge --deployment NAME --project PROJECT_ID --verification /private/path/full-verification.json --backup-state-dir /private/backup-state --early-owner-approved "Owner approved early purge after current-data verification" --apply
```

Dry-run remains the default and deletes nothing. The approval note and exact
verification/backup evidence are retained before any page call in
`full-verification.json.purge.jsonl` and in the returned purge receipt. Unknown
outcomes leave a started/page journal entry; rerunning uses existing row markers
and rechecks current evidence. Each eligible R2 object is still re-HEADed before
deleting its Convex copy; current row pins and other references are rechecked.
Rows created or migrated after `verifiedAt` are excluded. Early purge removes
the Convex fallback copy; recovery then uses the verified R2 copy or the hosted
backup. Without early approval, existing 14-day commands and checks are unchanged.
