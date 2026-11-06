# GitHub project source import

In the development app, choose **Projects → New project → Import from GitHub**,
enter a repository URL and optional branch, tag or commit, and choose **Import
from GitHub**. The form calls `projectGithubImport.start`. Its owner-only progress
subscription opens the project when complete hosted `main` is published. The
separate read-only analysis tour calls `hosted.start` and creates no writable
project. The [quickstart](../quickstart.md) covers installation and Lane work.

## Identity, access and publication

`projectGithubImport.start` takes an original operation UUID, GitHub URL, optional
ref and optional project name. The ref resolves once. Repeating the original
request resumes the same job and exact commit; changing its request reports
`WORK_OPERATION_CHANGED`. The import belongs to its signed-in importer. A public
upstream creates a public mirror; a private upstream stays private. Access is
checked through the existing GitHub authorization path, with a repository-scoped
read installation token when available. Credentials are never stored in progress
or cursor records.

`projectGithubImport.status` returns the project ID, pinned commit, phase, file and
byte counts, known-total flag and structured failure. The browser subscribes to
`projectGithubImportProgress.current`; server writes update it without a polling
timer. **Resume import** keeps the original operation after an interruption.

The project has no selected main or backup until all source, initialized Work and
the ready index publish atomically. Publication selects server authority and
hosted `main` directly. No local owner, recovery, seeding or second source upload
is needed. Agents can start Lanes immediately. Check commands, runner setup and
acceptance policy are configured separately. Import does not modify the upstream
repository or claim ownership of it.

## Archive acquisition and packed storage

A complete recursive Git tree selects archive transfer (protocol 3). The worker
streams the selected commit's tarball, follows only the validated GitHub codeload
redirect without forwarding credentials, and verifies every retained file against
its Git object ID. Archive-omitted or rewritten members are fetched by Git blob;
submodules remain commit pointers. A truncated recursive tree uses paged tree/blob
acquisition (protocol 2) instead; no partial tree is published.

Committed regular files, executable modes, symlink targets, binaries, empty files
and committed ignored paths are retained. Source names cannot overlap the
existing `.git`/`.forge` metadata namespaces. Git history, external LFS objects
and derived code analysis are separate. LFS pointers remain their committed bytes.
The Git blob endpoint acquisition boundary remains 100 MB per blob; large
supported files stream through the existing bounded chunk recipes. This is a
provider boundary, not a new repository quota.

Ordinary archive members drain the source buffer at the 8 MiB/1,000-object
thresholds; a final member can cross the byte threshold. Git-blob fallback
fetches windows of up to 100 small blobs, each sized by listed bytes to the room
left before the 8 MiB threshold (an empty window still takes one blob), stages each
verified blob as it arrives and drains after every window, so staging stays within
about 8 MiB plus one blob. Large members stream through chunk recipes. Upload holds the staged
source and one pack copy. Each window becomes one immutable, SHA-256-verified R2
object; singleton and empty objects can stay raw. The sorted
catalog retains logical digests, sizes, byte offsets and pack identities, with up
to 256 object pins per document, including protected physical-pack bindings. Recipes keep their existing format. Reads use
project-authorized byte ranges with the exact Range header bound into the
signature. They verify length, offsets and logical
SHA-256 before use, including source workers, checks and GitHub mirrors.

Progress retains one compact receipt per stored window. Continuations read these
receipts in bounded pages, re-stream the same archive and skip stored logical
objects. Create-only uploads reconcile existing keys by verifying their physical
size and checksum. An interrupted action does not publish partial source. The
worker's finite action scheduling boundaries do not exclude files. A continuation
that cannot make progress reports a structured failure rather than looping.

State, manifest and Work metadata use the same R2-backed object path. Catalog
publication and source-index materialization use bounded pages. The ready
transaction starts bounded deletion of transient inventory; large legacy
inventories may need a cleanup continuation. Archive imports retain catalog
pages and compact path-index pages, with no per-object `projectObjects` or
`sourceBlobs` rows. Protocol-2 fallback and legacy seed/bootstrap still use their
per-object records; they are not covered by that catalog-write claim.

New imports write zero bytes to Convex file storage. Missing R2 configuration
reports `R2_NOT_CONFIGURED`; it never switches byte stores. Old Convex copies
remain readable through their retained bindings. Project deletion removes catalog
and inventory rows and purges only that project's R2 prefix through the existing
maintenance-controlled deletion chain. Removing one logical binding must not
remove a pack used by other bindings. No new retention rule or automatic source
expiry is introduced.

## Measurement

`scripts/benchmark-t3code-import.mjs` calls the same source-import start entry
point as the app and observes its status action on a disposable project. It keeps retry pins in its
journal and observes sanitized, project-attributed provider telemetry. Set
`FORGE_IMPORT_STATUS_MS=10000` for ten-second finite benchmark observations.
Record the installed CLI `.commit`, repository commit, project ID and timestamps
for every run. Numeric `FORGE_IMPORT_METRIC` records distinguish archive/listing,
upload waits and attempts, metadata, catalog, projection and ready publication.
The fixture guard in `tests/github-import-archive.test.mjs` bounds PUT count on a
28.9k-file import. Synthetic results establish budgets; live elapsed time and
billing require separate measurement. A source checkout or local fixture is not
a published npm release or a production deployment.

Full Work index rebuilding remains an explicit operator repair:

```sh
nforge hosted-work DEPLOYMENT PROJECT_ID '{"action":"rebuild-index"}'
```

Normal import, browser reads and agent commands do not trigger
`projectWorkIndexActions:ensure` to rebuild history. Retained incompatible or
missing indexes report their existing repair command. No idle worker is scheduled
after import completion.
