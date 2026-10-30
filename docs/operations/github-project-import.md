# GitHub project source import

`projectGithubImport.start` creates a hosted personal mirror owned by the signed-in
importer. Its arguments are an original operation UUID, GitHub URL, optional ref
and optional project name. Repeating the same request resumes the original job
and commit; changing an operation's request reports `WORK_OPERATION_CHANGED`.
`projectGithubImport.status` returns the project ID, exact Git commit, phase,
completed/total files and bytes, whether the total is complete, and a structured
failure. The existing `hosted.start` analysis tour remains a separate derived
import, with its own language and text-selection rules.

The worker resolves the ref once, walks non-recursive Git trees and retains every
committed regular file, executable and symlink target, including binaries, empty
files and paths matched by committed ignore rules. It verifies raw bytes against
Git's object hash before committing a logical file binding. Durable steps process
pages of up to 1,000 files or 128 directories, also bounded by physical bytes,
metadata bytes and elapsed action time. Large files stream through 1 MiB chunks;
8 MiB upload windows bound retained source buffers. These are scheduling
boundaries, not repository or file exclusions. The worker obtains fresh access through the existing
GitHub App credential path for each action. No credentials are saved in the job
or cursor, and no additional GitHub scopes are requested.

New source-import projects select R2 when deployment R2 storage is enabled. This
placement is retained on the project; missing R2 configuration fails explicitly.
Other deployments use Convex file storage. Object reuse/preparation and verified
completion are batched, with existing chunk recipes for large logical objects.
Convex physical bytes can share a storage ID across projects; R2 keys and bindings remain
project-scoped and all source reads retain current project authorization. Digest
reuse is internal and does not expose another project's source or existence.
Explicit project deletion retains other projects' shared objects through the
existing storage-reference checks and project-prefix R2 cleanup.

The inventory is immutable and read through ordered indexed pages. Import results,
unique logical-blob pins and per-page progress receipts are retained separately;
the compact cursor contains only directory positions and the last file key. No
worker reserializes the repository inventory, and there are no cursor blobs to
rewrite in R2. Project deletion removes these inventory rows in bounded pages.
State/manifest bytes stream from inventory pages into content-addressed recipes.
The derived source index is staged in retry-safe pages; selecting the final backup
and ready generation is atomic. Interrupted publication reuses the same immutable
pins and projection receipts. No idle worker is scheduled after completion.

Legacy source-import cursors report `IMPORT_RESTART_REQUIRED`, including a command
to start a new operation at the original pinned commit. They do not silently switch
revisions or publish partial main. The separate Work index cursors described below
remain resumable.

A project has no selected backup/main until the complete source and initialized
Work publish atomically. A failed or interrupted import therefore never exposes
partial source as main. Repeating `start` with the original operation resumes a
stopped worker. The importer creates a new project; it does not overwrite another
project's main, claim ownership of the upstream repository, or synchronize GitHub.
Public mirrors belong to their importer; verified upstream ownership claims are
a separate capability. Work's portable format is unchanged.

## Provider and representation boundaries

The GitHub Git blob endpoint documents support for files up to 100 MB. This is a
provider acquisition limit, separate from repository aggregate size and Convex's
1 MiB database document size. Source files larger than a database document use
file storage and existing 1 MiB physical chunks. Discovery reports
`GITHUB_BLOB_LIMIT` before publishing main if a blob exceeds the endpoint boundary.
Gitlinks/submodule entries report `GITHUB_SOURCE_UNSUPPORTED`; no source is silently
excluded. Git LFS pointer files remain the exact committed pointer bytes, matching
`git archive`; resolving external LFS content and Git history is separate.

Native State entries also retain symlink mode. Capture, checkout, sync, review and
Git projection read/write the link itself without following its target. Readers
that predate symlink State support cannot consume these States. Paths still use
Forge's existing portable path representation and metadata namespace rules.

Local acquisition qualification passes for 400 MiB as four 100 MiB files and as
1,600 files of 256 KiB. The largest physical chunk is 1 MiB. These are the largest
synthetic fixtures exercised, not a live provider or maximum aggregate-size claim.
The mixed Git fixture includes a 1 MiB + 1 byte file and compares original bytes,
executable bits and symlinks with `git archive`.

Qualification is local with synthetic GitHub responses and Convex storage fixtures.
A repeated acquisition/chunk-validation run measured 309,592,064 bytes (295.3 MiB)
maximum resident set size locally. This does not establish live provider throughput,
billing, timeout or Convex action peak memory.
The lead must run hosted-main checkout qualification after the selected-main and
empty-project slices land, and exercise live imports on a disposable project.

If qualification requires a **single 400 MB blob**, the present Git blob endpoint
cannot supply it. R2 alone does not remove that acquisition boundary. A follow-on
would need a GitHub acquisition mechanism that streams those exact committed bytes,
a resumable content-addressed multipart R2 writer with full digest verification,
project-scoped bindings over globally deduplicated physical chunks, authenticated
bounded-range reads, existing shared-reference deletion semantics, and atomic
publication through the same hosted-main receipt. It must preserve operation IDs,
source modes, private-repository authorization and lost-reply reconciliation.

Hosted Work index reads retry transient transport/storage faults up to three total
attempts, with short backoff inside the same action; application, validation and
access errors are not retried. Exhausted reads return `pending` at the committed
cursor. Resume continues that generation, retaining its View and changed-file
counters; five consecutive unsuccessful resumes without cursor movement mark it
`failed` with `WORK_INDEX_READ_FAILED` and the failing storage object pin when
available. A failed generation returns that error on subsequent resumes. Advancing
the cursor resets the failure streak. The host CLI shows committed Views and
changed files, files/minute and a resume-relative ETA for discovered file output;
file totals are labelled discovered until all Views have been projected. Legacy
in-flight cursors remain resumable: missing counters start from committed index
rows, and new counters are saved with the next ordinary step. No timer, scheduler
or idle index polling is introduced.
