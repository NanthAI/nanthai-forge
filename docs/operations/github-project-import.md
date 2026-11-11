# GitHub project source import

In the development app, choose **Projects → New project → Import from GitHub**,
enter a repository URL and optional branch, tag or commit, and choose **Import
from GitHub**. The form calls `projectGithubImport.start`. Its owner-only progress
subscription opens the project when complete hosted `main` is published. The
separate read-only analysis tour calls `hosted.start` and creates no writable
project. The [quickstart](../quickstart.md) covers installation and Lane work.

From the CLI, `nforge import URL [--ref REF] [--name NAME] [--deployment URL]
[--operation-id UUID] [--no-wait]` calls the same start with the saved login,
waits on the same progress subscription (no polling) and prints one JSON report:
`operationId`, `projectId`, `commit`, `phase`, `ready`, file and byte counts,
`githubRequests`, any structured `error` and `next` (the `nforge clone` command,
or the resume command). The original request and operation UUID are kept in
`$XDG_STATE_HOME/forge/imports/` (default `~/.local/state`), so
`nforge import --resume UUID` replays it exactly; repeating `--operation-id` with
another repository, ref or name reports `WORK_OPERATION_CHANGED`. Each resume is
checked against the caller's current login and GitHub access. A small import costs
the start action, one subscription and one final status action.

## Identity, access and publication

`projectGithubImport.start` takes an original operation UUID, GitHub URL, optional
ref and optional project name. The ref resolves once. Repeating the original
request resumes the same job and exact commit; changing its request reports
`WORK_OPERATION_CHANGED`. The import belongs to its signed-in importer. A public
upstream creates a public mirror; a private upstream stays private. Access is
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
counts every `api.github.com` request by who paid: `user` (the importer's token),
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

A complete recursive Git tree selects archive transfer (protocol 3). The worker
streams the selected commit's tarball, follows only the validated GitHub codeload
redirect without forwarding credentials, and verifies every retained file against
its Git object ID. Archive-omitted or rewritten members are fetched in Git protocol v2 blob packs;
submodules remain commit pointers. GitHub truncates a recursive tree reply at 100,000
entries or about 7 MB, whichever comes first. A truncated reply does not change the
path: the listing is rebuilt from smaller tree reads (the root without recursion, each
child recursively, and again non-recursively only for a child still truncated; equal
trees are read once, 8 reads at a time), about one request per split directory rather
than per directory or blob. Paged tree/Git-pack acquisition (protocol 2) is used only when
a single directory is itself above the reply limit or the split would need more than
1,500 tree reads; the reason is logged as `listing-split-unavailable`. No partial tree
is published.

The tree is listed once per import job. `start` stores the listing (path, Git object ID,
size, mode per file; plus totals) as one scratch object under the project's R2 prefix, in
columns (one paths string with offsets, binary object IDs, sizes and mode codes). It builds
those columns as it reads: each tree reply is scanned from its bytes into the same column
form (no object per entry, API URLs skipped; a reply GitHub truncated is not read, since it is
read again in pieces) and the rows are sorted once at the end, so the listing holds no object
per file. `start` pins the stored table on the job; every archive step reads that object back, verifies its digest and
tree id, and makes no tree request. A missing or altered object is listed again, never
trusted. Publication deletes it; project deletion removes it with the rest of the prefix.
The listing holds no per-file Convex rows.

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

Progress retains one compact receipt per stored window. Continuations read these
receipts in bounded pages, re-stream the same archive and skip stored logical
objects. A run stops at its 6-minute budget before the next archive member, never
after the last one: a run that stored the final file publishes in that run, so no
continuation re-reads the archive only to rebuild the path-to-blob map. Create-only uploads reconcile existing keys by verifying their physical
size and checksum. An interrupted action does not publish partial source. The
worker's finite action scheduling boundaries do not exclude files. A continuation
that cannot make progress reports a structured failure rather than looping.

Memory per file bounds the import size: a Convex Node action has 512 MB, and a near-empty
import action sits at about 190 to 200 MB. An archive step keeps its per-file state in
columns rather than objects: the listing (about 150 bytes a file at real path lengths,
looked up by binary search over its sorted paths), the verified pin of each listed row
(a 32-byte blob digest and a size) and the stored-object catalog (binary digests, sizes and
pack offsets in an open-addressing index, about 70 bytes an object). Publication sorts
that catalog in place and writes it 32 pages at a time, and a publication retry reads the
stored State one file at a time instead of parsing it whole. Before this, 150,612 files
(1.47 GB; `rssBytes` in the `FORGE_IMPORT_METRIC` records) read the listing at 292 MB,
finished the archive at 448 MB and peaked at 494 MB during publication. Now the same
150,612 files peak at 381 MB in the archive and 422 MB in publication (metadata; catalog
392 MB, projection 389 MB), in 10.5 minutes instead of 13. Measured ceiling (2026-11-10,
Firefox's 487,756 files and 3.67 GB): the start listing passes, and archive steps stayed at
or under 418 MB through 419,111 files; publication at that size is not yet measured, so
about 490,000 files is the tested bound for the archive and 150,612 for a full import.
A larger repository than the ceiling runs out of action memory (`Node.js action execution
ran out of memory`, no main published). At that size each archive step re-reads the
tarball from its start and skips imported files for 3 to 6 minutes, so later steps make
less progress: wall time, not memory, then limits the import.

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
limit is checked from the pointers before anything is downloaded; over it, the
import fails with `GITHUB_LFS_LIMIT`, naming the total, the limit and the largest
object, and publishes no main. A pointer GitHub LFS has no object for fails with
`GITHUB_LFS_OBJECT_MISSING` and names the path.

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
(28,905 files, 4,089 directories) records 33,061 REST requests, one per directory
and blob, so that path relies on the App installation token; without one, a
private repository on that path proceeds at about 10 percent of the importer's
hourly limit per window. Synthetic results establish budgets; live elapsed time and
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
