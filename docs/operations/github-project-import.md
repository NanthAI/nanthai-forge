# GitHub project source import

In the development app, choose **Projects → New project → Import from GitHub**,
enter a repository URL and optional branch, tag or commit, and choose **Import
from GitHub**. The form calls `projectGithubImport.start`. Its owner-only progress
subscription opens the project when complete hosted `main` is published. The
separate read-only analysis tour calls `hosted.start` and creates no writable
project. The [quickstart](../quickstart.md) covers installation and Lane work.

From the CLI, `nforge import URL [--ref REF] [--name NAME] [--private] [--deployment URL]
[--operation-id UUID] [--no-wait]` calls the same start with the saved login,
waits on the same progress subscription (no polling) and prints one JSON report:
`operationId`, `projectId`, `commit`, `visibility`, `phase`, `ready`, file and byte counts,
`githubRequests`, any structured `error` and `next` (the `nforge clone` command,
or the resume command). The original request and operation UUID are kept in
`$XDG_STATE_HOME/forge/imports/` (default `~/.local/state`), so
`nforge import --resume UUID` replays it exactly; repeating `--operation-id` with
another repository, ref or name reports `WORK_OPERATION_CHANGED`. Each resume is
checked against the caller's current login and GitHub access. A small import costs
the start action, one subscription and one final status action.

## Migration scope

The source import brings the selected commit's source into hosted main. Git history is
acquired separately; source readiness does not mean that history catch-up has finished.
Issues, milestones, pull requests, other branch heads, tags, CI configuration outside
source files and collaborator accounts stay at the origin. Existing source files such
as CI workflow files are ordinary imported source. Backlog recreation uses the separate
[source-agnostic planning import](../planning.md#imported-history-attribution), not ongoing
tracker synchronization or imported pull-request work.

Readers retain an optional `migration` object with origin counts for `issues`,
`pullRequests`, `branches` and `collaborators`. A `null` count means **not reported**;
zero means the provider reported zero. Older jobs have no object. The collector is staged behind `FORGE_MIGRATION_LEDGER=1`, default off. When enabled, start makes one aggregate
metadata request using its existing authorized read credential, overlapping source discovery. It stores totals in
the existing job write; retries reuse them and never refetch per row. Missing credentials, permission gaps or
provider failure keep the affected counts not reported, with `notReportedReason`; source import can continue.
Counts describe the origin at import start, not ongoing tracker synchronization. The aggregate fields follow
the [GitHub GraphQL repository schema](https://docs.github.com/en/graphql/reference/repos).
The CLI's readable terminal reply and machine report include the same migration scope in `migrationSummary`, even when counts are unavailable. When present,
it keeps the totals alongside the same operation, ref and exact commit,
including on failure and resume. No account identities are included in this ledger.

## Before the import: the report

`nforge import URL --preview [--ref REF]` (and the web import page `/new/import` before its
Import button) calls `projectGithubImportPreview.preview`: the same reads a start
makes first (repository access, the commit, one recursive listing; about three
GitHub requests on the same quota as the import) returned instead of acted on. It
writes nothing: no project, job, journal or row. It reports the repository, its
GitHub visibility and the visibilities allowed here, the pinned commit, files,
bytes, submodules and `.gitattributes` files, what happens to Git LFS files, and
warnings from limits that already exist. It adds no quota:

- A file count above the [source-step envelope](source-exchange.md#supported-repository-envelope)
  names the smallest step it crosses (sync 56,800 files, landing 68,800, save
  122,400): the import can finish, but that step on the project is refused with
  `SOURCE_STATE_TOO_LARGE` until the repository is split or the limit rises
  (Issue `c3add134` owns raising it).
- Git LFS files come across as the real files up to 1 GiB per import (raisable to
  8 GiB, or 0 keeps pointers); above that the import stops before main is published
  (`GITHUB_LFS_LIMIT`). With no `.gitattributes` the report says no LFS applies.
- When GitHub lists the tree only in parts, the file count is known once the
  import starts; nothing is published unless all of it arrives.

Refusals the listing finds (paths that are not UTF-8, unsupported modes, files
GitHub cannot return) arrive in the report, before any work begins.

## Visibility

The project is public or private as on GitHub unless the importer chooses:
`visibility: "private"` on `projectGithubImport.start` (`--private` in the CLI)
imports a public repository private here. A private repository always imports
private; asking for public is refused with `BAD_ARGUMENT` and creates nothing. A
chosen visibility is part of the request: a resume keeps it, and the same operation
with another visibility reports `WORK_OPERATION_CHANGED`. The status reply and the
CLI report carry the resulting `visibility`.

## Paused by GitHub: resume at the reset

A run stopped by GitHub's rate limit records `retryAt`. Repeating the original start
with `atReset: true` (`nforge import --resume UUID --at-reset`, or **Resume at HH:MM
for me** on the import page) keeps the same operation and schedules one worker run at that
recorded time on Forge: no client stays connected and nothing polls. Progress then
reads `phase: "paused"` with `error.resumeAt`. A replay keeps the one scheduled run;
resuming now instead replaces it, so only one worker runs. A limit hit before the
job exists (at the very first access check) leaves nothing to retain: repeat the
command after the reset.

## Identity, access and publication

`projectGithubImport.start` takes an original operation UUID, GitHub URL, optional
ref and optional project name. The ref resolves once. Repeating the original
request resumes the same job and exact commit; changing its request reports
`WORK_OPERATION_CHANGED`. The import belongs to its signed-in importer. A public
upstream creates a public project unless the importer chose private; a private
upstream stays private. Access is
checked through the existing GitHub authorization path. Credentials are never
stored in progress or cursor records.

Paths stay exactly as Git has them. Git allows any path bytes; Forge stores UTF-8
paths only. A path that is not valid UTF-8 (GitHub's API shows those bytes as
U+FFFD) is never renamed: the import, or an inbound GitHub push, refuses with
`GITHUB_SOURCE_UNSUPPORTED` naming every such path (`\uFFFD` or `\xNN` for the
bytes) and main is not changed. Rename them in Git to UTF-8 names (`git mv`), push,
and retry.

## Which GitHub token pays

| Request | Token |
| --- | --- |
| Access check (`GET /repos/OWNER/NAME`), once at start and once per worker run and publication | Public repository: the deployment's `GITHUB_PUBLIC_TOKEN` (or none); a rejected credential falls back to an anonymous visibility check. If that quota is exhausted, a configured App tries a metadata-only token scoped to the named repository. Private repositories still require the importer's current GitHub App user token, which shares their personal hourly limit with `gh` and their other tools |
| Ref resolution, tree listing, tarball, Git pack fallback, paged discovery | The Forge GitHub App installation token (`contents`/`metadata` read on that one repository; the App's own quota) when the App is installed there; otherwise the credential from the access check |
| Installation lookup and token mint | The App JWT (App quota); metadata recovery mints only `metadata:read` for the named repository, then contents reads use the numeric repository ID returned by authorization |

Owner decision (Issue 2ccd3bae): one import may use about 10 percent of the
importer's hourly GitHub limit. The worker reads the limit and reset from GitHub's
response headers and refuses the next importer-token request once the import has
used its share of the current window, before sending it. Like a GitHub 403/429
rate-limit reply, this ends the run as `GITHUB_RATE_LIMIT` with `retryAt` (ms) and
the reset time in the message; the job shows `phase: "error"`, nothing is
published, and repeating the original start after the reset resumes from saved
progress. It never stalls silently.

`githubRequests` on the job, in `projectGithubImport.status` and in the CLI report
counts every `api.github.com` request (including the staged GraphQL metadata batch) by who paid: `user` (the importer's token),
`app` (installation token, App JWT or App client credentials), `server`
(`GITHUB_PUBLIC_TOKEN`) and `anonymous`, plus the importer's current window
(`userWindow`: GitHub's reset, the requests this import used, the limit). Tokens
are classified by their public prefix and never stored. Counts ride on the
existing progress, failure and publication writes: no extra Convex call.

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

A complete Git tree selects archive transfer (protocol 3). The acquisition worker
streams the selected commit's tarball, follows only the validated GitHub codeload
redirect without forwarding credentials, and verifies every retained file against
its Git object ID. Archive-omitted or rewritten members are fetched in Git protocol v2 blob packs;
submodules remain commit pointers. GitHub truncates a recursive tree reply at 100,000
entries or about 7 MB, whichever comes first. A truncated reply does not change the
path. The listing walks smaller tree replies in State order. It reads the root without
recursion, each child recursively, and a child that is still truncated without recursion.
It holds at most eight replies outside a 16 MiB cache for repeated subtrees. A reply
that is already ordered passes through directly. Each unordered reply is sorted within
its own bounds. Paged tree/Git-pack acquisition (protocol 2) is used only when
a single directory is itself above the reply limit or the split would need more than
1,500 tree reads; the reason is logged as `listing-split-unavailable`. No partial tree
is published.

`start` resolves the commit, creates the job and schedules a listing step in the
same transaction. That step validates rows as it reads GitHub's replies and
writes create-only, checksummed R2 pages of up to 65,536 files or 8 MiB. Each
page stores UTF-8 paths, binary Git IDs, sizes and modes. A small index names
the exact tree, totals and ordered page digests. The listing step pins the index
and schedules acquisition. Every archive step verifies and loads the pages
individually into its private action-local file. A missing, altered or legacy listing
triggers a fresh listing. Publication and a switch to protocol 2 clean the scratch
prefix, including pages whose index was never pinned. The listing adds no per-file
Convex rows. Project purge removes scratch left by persistent storage failures.

Committed regular files, executable modes, symlink targets, binaries, empty files
and committed ignored paths are retained. Source names cannot overlap the
existing `.git`/`.forge` metadata namespaces. Git history and derived code
analysis are separate. [Git LFS files](#git-lfs-files) hold their object bytes.
The existing 100 MB acquisition boundary remains unchanged; large supported
files stream through the existing bounded chunk recipes.

Ordinary archive members drain the source buffer at the 8 MiB/1,000-object
thresholds; a final member can cross the byte threshold. Fallback fetches one Git
pack per page of up to 100 small blobs, sized by listed bytes to the room before
the 8 MiB drain threshold (an empty window still takes one blob). Whole objects
and offset/id deltas are verified against the pinned Git identities and sizes;
duplicate identities share the same fetch. Large missing blobs stream as singleton
Git packs into chunk recipes. Protocol 2 similarly fetches its small source blobs
and LFS attribute rules by byte-bounded pages. None of these transfers calls the
REST blob endpoint. Git fetches use the selected read credential on `github.com`
and consume no `api.github.com` primary REST quota. LFS batch requests and object
downloads remain separate; object downloads are inherently per distinct LFS oid.
The small pack decoder holds one compressed/decoded page alongside the existing
source window; large blobs hold bounded compressed/decompressed chunks. Upload holds the staged
source and one pack copy. Each window becomes one immutable, SHA-256-verified R2
object; singleton and empty objects can stay raw. The sorted
catalog retains logical digests, sizes, byte offsets and pack identities, with up
to 256 object pins per document, including protected physical-pack bindings. Recipes keep their existing format. Reads use
project-authorized byte ranges with the exact Range header bound into the
signature. They verify length, offsets and logical
SHA-256 before use, including source workers, checks and GitHub mirrors.

Progress retains one compact receipt per stored window. The first acquisition step reads the
tarball for up to six minutes. If files remain, it stores one checksummed snapshot
of the verified file pins in R2. The cursor binds that snapshot to the commit tree
and exact listing. A continuation loads those pins, checks them against the stored
object catalog, and fetches the remaining listing rows in byte-bounded Git packs
of up to 1,000 blobs. It also reloads the commit's Git LFS attributes. A missing
or damaged checkpoint sends the affected reads back to Git without reopening the
tarball. A catchable failure retains verified progress for retry.

Each successful advance retires the previous pin snapshot. A complete acquisition
of at least 65,536 files checkpoints its pins and schedules publication in a
separate action. It publishes from verified pins and the stored-object catalog
without requesting GitHub blobs or opening the tarball. A smaller complete
acquisition publishes in the same action. Main is published only after all
files are verified and stored. A continuation that verifies no new files reports a
structured failure.

Convex documents a 512 MiB RAM allocation for Node actions by default. Its
compute usage field reports billed memory. Each `FORGE_IMPORT_METRIC` reports
the runtime limit in `memoryLimitBytes` using Node's process constraint, with
system RAM as a fallback identified by `memoryLimitSource`. It reports
`heapLimitBytes` for V8, `heapUsed`, `external`, and `arrayBuffers` in bytes.
Array buffers are included in external memory. `rssBytes` and `peakRssBytes`
report current and lifetime Node process RSS. A hosted
Firefox-shaped Dev import published 487,756 files and 3.67 GB of source in 26m11s.
The publication action reported a 756 MB process RSS high-water mark and 512 MiB
of billed memory. Convex's dynamic executor can allocate more RAM than it bills.
The usage field does not identify which executor ran the action. See
[Convex action limits](https://docs.convex.dev/production/state/limits) and the
[Convex Node executor](https://github.com/get-convex/convex-backend/blob/0e4f90d3e0/npm-packages/node-executor/src/executor.ts#L36-L56).

Start holds no listing rows. The listing step retains bounded tree replies
and one write page. Each archive or publication action verifies one listing
page at a time and writes it to a private action-local file. Archive lookups
use sparse path offsets to read small verified blocks. Sequential scans keep stable
global row numbers for pins, State publication and the source path index.
Repeated scans use the same local copy, so the index and each page need one
R2 read per action. The file is discarded when the action ends.

Acquisition retains verified pins by listing row. Publication reads a complete
checkpoint by range from a private action-local file. The stored-object catalog
uses binary digests, sizes and pack offsets in an open-addressing index, about
70 bytes per object. It marks the logical source blobs in the State and uses
one digest ordering for the manifest and final catalog. State and path-index
writers consume structured file rows. A retry uses the verified listing and
pin checkpoint when available. Otherwise it verifies the pinned State into
action-local scratch and scans it in bounded ranges. Repeated scans avoid
additional R2 reads.

State, manifest and Work metadata use the same R2-backed object path. Catalog
publication and source-index materialization use bounded pages. The ready
transaction starts bounded deletion of transient inventory; large legacy
inventories may need a cleanup continuation. Archive and fresh protocol-2
imports retain catalog pages and compact path-index pages, with no per-object
`projectObjects` or `sourceBlobs` rows. Protocol 2 keeps its paged file inventory
until publication. Each page reuses earlier file pins and commits verified
object pins with its file cursor. Large files can record completed R2 windows
while they stream. Their chunks use content-addressed keys across pages. A publication
retry uses the stored inventory and windows. Protocol-2 jobs already in progress
finish using their original object rows. Hosted seed and browser bootstrap
still use per-object records.

New imports write zero bytes to Convex file storage. Missing R2 configuration
reports `R2_NOT_CONFIGURED`; it never switches byte stores. Old Convex copies
remain readable through their retained bindings. Project deletion removes catalog
and inventory rows and purges only that project's R2 prefix through the existing
maintenance-controlled deletion chain. Removing one logical binding must not
remove a pack used by other bindings. No new retention rule or automatic source
expiry is introduced.

## Git LFS files

An archive import resolves Git LFS the way `git clone` smudges it. A committed
file whose bytes are a valid LFS pointer, at a path that the commit's
`.gitattributes` files mark `filter=lfs` (Git precedence: the last matching line
wins and deeper files override shallower ones), is stored as its LFS object's
bytes. Pointer-shaped files at other paths, or under `-filter`, keep their
committed bytes. The worker asks GitHub's LFS batch API for download addresses,
anonymously for a public repository and with the import's read token for a
private one, streams each object once and verifies its SHA-256 and size against
the pointer before binding it. An LFS oid is the SHA-256 of the file bytes, the
same digest Forge stores, so an object shared by many paths, or already stored
by an earlier run of the same import, is fetched and stored once. Objects travel
through the same R2 packs and chunk recipes as other files; no Convex row is
written per object or byte range.

Lanes, checks, browser reads and source workers receive those bytes like any
other file, so tests see the real assets instead of pointer text. LFS files
inside submodules stay pointers, as submodules are fetched without LFS smudging.

The limit is 1 GiB of unique LFS object bytes per import (each oid counted once),
in line with stored Git history. Start the import with `lfsLimitBytes` to choose
another limit up to 8 GiB, or `0` to keep every pointer as committed bytes. The
worker checks the limit before downloading the objects selected in that step and
counts unique LFS objects already verified by earlier steps. If the total
exceeds the limit, the import fails with `GITHUB_LFS_LIMIT`, names the total, limit
and largest object in that step, and publishes no main. A pointer GitHub LFS has
no object for fails with `GITHUB_LFS_OBJECT_MISSING` and names the path.

Protocol 2 (a tree that cannot be split) resolves LFS the same way, page by page.
The listing records every `.gitattributes` it sees (up to 1,000, else
`GITHUB_LFS_LIMIT`; 1 MiB each) in the import cursor. A page that fetches a
pointer-shaped file reads those files once, decides the page's LFS paths, and binds
their objects before the page's receipt. The limit counts unique objects across
pages: an oid already stored is neither fetched nor counted again, so a retried
page can count a little less than the first attempt. The check runs per page, before
that page's objects download, so earlier pages' objects may already be stored when it
refuses; main is still not published. Pages without pointer-shaped files make no LFS
call. The published coverage note says which rule applied.

Two-way inbound sync resolves LFS pointers in pushed files the same way; see
[Two-way sync](github-app.md#two-way-sync).

When the project mirrors to GitHub, LFS paths are published back as LFS pointers
plus objects; see [automatic main mirror](../workflows.md#automatic-main-mirror).

## Line endings

Imports store each file's committed bytes; `.gitattributes` never changes what is
stored, so the mirror stays byte-identical to GitHub. A checkout (Lane, main,
Candidate check, runner) writes the working copy as `git checkout` does with
default settings: `text eol=crlf` files, and `text`/`text=auto` files on Windows,
get CRLF where the blob has a lone LF (`text=auto` skips binary-looking files and
files that already hold CR). Save, dirty checks and sync read such a file back as
`git add` would, turning CRLF into LF for files marked text; a `text=auto` file
whose current blob already holds CRLF keeps it, as in Git. `binary`, `-text` and
`filter=lfs` paths are never converted. The rules come from the State's own
`.gitattributes` objects, read locally from the verified object store (at most
1 MiB each): no Convex call and no extra download. A tree with no converting rule
does no work. Measured on a 4,000-file tree: 0.4 ms with
`* text=auto eol=lf`, 1.1 ms with the Gradle wrapper's `*.bat text eol=crlf`
rules, 1.4 ms with 200 `*.ext` lines (indexed by extension). Hundreds of
directory globs cost more (about 170 ms for 200 `dir/**/x/*.ts` lines). Not
applied: `ident`, `working-tree-encoding`, filter drivers other than Git LFS, and
conflict files written by a merge (they hold LF until saved). Git settings such
as `core.autocrlf` are not read.

## Measurement

`scripts/benchmark-t3code-import.mjs` calls the same source-import start entry
point as the app and observes its status action on a disposable project. It keeps retry pins in its
journal and observes sanitized, project-attributed provider telemetry. Set
`FORGE_IMPORT_STATUS_MS=10000` for ten-second finite benchmark observations, and
`FORGE_IMPORT_TEARDOWN=1` to cancel the project's scheduled work and delete the project
after the run. The guard repeats a failed deployment-admin call (a cancellation page or a
status read) with the same arguments and journals the cancellation cursor, so rerunning
with the same directory resumes a teardown that stopped part way. A dropped provider log
stream (a dev redeploy) is reopened with recent history up to 10 times (`logRestarts` in the
report); events already counted are dropped, so totals stay exact.
Record the installed CLI `.commit`, repository commit, project ID and timestamps
for every run. Numeric `FORGE_IMPORT_METRIC` records distinguish archive/listing,
upload waits and attempts, metadata, catalog, projection and ready publication.
The separate-process publication fixture in `tests/github-publication-memory.test.mjs`
checks exact State identity and retained-memory growth at 487,756 and 1,000,000
files. On a machine with Docker, set `FORGE_GITHUB_PUBLICATION_CGROUP=1` to
exercise publication and both retries under a 435 MiB Linux cgroup with swap
disabled. The measured worker uses Node's default heap sizing in that run.
The fixture guard in `tests/github-import-archive.test.mjs` bounds PUT count on a
28.9k-file import and fixes its GitHub REST total at 8 requests (start: repository,
commit, tree; run: repository, tarball, two fallback blobs; publication:
repository); `tests/github-import-archive.test.mjs` also asserts that a two-step
import with a split listing makes one listing's tree reads in total, and that an archive
step retains column storage at archive-complete: fewer than 300 backing-buffer bytes
per file and at most a few data objects per upload window, with no per-file pin or catalog
objects. The same structural assertion rejects the earlier per-file Maps (which measured
about 500 heap bytes per file). The guard counts the actual action tables and their owned
data, independent of garbage collection, process caches, elapsed time and machine load;
it does not estimate total action heap or RSS. The protocol-2 fixture in `tests/github-import-pages.test.mjs`
(28,905 files, two gitlinks and 4,089 directories) guards the complete import
call budget, the retained metadata budget and packed uploads. It records 4,157
GitHub REST requests for access and tree discovery. Git packs carry the blobs.
Without an App installation token, a private repository on this path can proceed
at about 10 percent of the importer's hourly limit per window. Synthetic results establish budgets; live elapsed time and
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
