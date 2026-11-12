# Architecture

Forge has five parts. Each owns one kind of data, and no part quietly takes over another's job.

```text
  Coding agent / human
        |
   nforge CLI, MCP    Hosted browser (Netlify)
        |                                         |
  Clone and Lane checkouts  <-- open/save -->  Convex + R2 (hosted, canonical)
  (your machine; regenerable                 (records and journal in Convex,
  caches and retry journals)                  bytes in R2; sessions, access)
                                                       |
  CI runners (GitHub Actions or your own)     Netlify worker (public analysis)
```

For the vocabulary used below (Intent, Lane, Candidate, Channel, State), see [concepts](concepts.md).

## Who owns what

| Part              | Owns                                                                                                 | Code                                                      |
| ----------------- | ---------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| Native store      | Immutable source: file blobs (SHA-256), State manifests and disposable owner-computed source indexes | `src/native-source.ts`                                    |
| Work store        | Mutable metadata: Intents, Lanes, notes, check runs, selections                                      | `src/work-store.ts`, `src/work.ts`, `src/native-work.ts`  |
| Analysis          | Derived, partial code graph with exact locators                                                      | `src/snapshot.ts`, `src/analyze.ts`, `src/graph-query.ts` |
| Local execution   | Check and Playbook processes in materialized Candidates                                              | `src/work-run.ts`, `src/work-playbook.ts`                 |
| Agent interface   | Short commands over the hosted contract                                                              | `src/hosted-agent-cli.ts`, `src/mcp-hosted-agent.ts`      |
| Convex            | Hosted records, the Work event journal, sessions, messages, current access (bytes live in R2)        | `convex/`                                                 |
| Web               | Hosted browser UI (the only browser UI)                                                              | `web/src/`                                                |
| Netlify worker    | Public-repository analysis in the background                                                         | `netlify/functions/`                                      |
| Git compatibility | Import, export, projections and publication                                                          | `src/native-git*.ts`, `src/work-git*.ts`                  |

Forge has one client mode: hosted. Hosted main, Lanes and the landing queue are canonical; the CLI keeps regenerable caches and retry journals and cannot accept. A folder without a hosted marker is refused with `FORGE_ROOT_UNAVAILABLE` and the next step `nforge host ROOT`; "offline" means a Lane keeps working and lands once back online. The native-owner mode (local source authority, its landing driver and local Work store commands) is removed; the shared kernel below (State format, merge, durable writes) serves hosted clients and the server. Exchange push, source return and the `autoExchange` policy are retired. See [source exchange](operations/source-exchange.md).

Projects land exclusively through the [hosted landing queue](#hosted-landing-request-queue).
Landing clients submit a durable goal and observe its handle. The read-only `landing`
action reconciles no work and starts no service. A goal registered while the first
composition runs owns a fenced server wake; source completion resumes that goal into the
hosted check and acceptance controller. Domain failures roll back admission before a
separate terminal failure publication. Upload/save preparation remains an explicit
pre-admission phase. Hosted aliases and observations recheck current project access. The
native-owner landing driver, its owner services and the presence workers were removed with
one client mode (Issue 657d63ee).

Server-authority main publication also records an indexed GitHub mirror job and
schedules its first fixed Convex action atomically. A single active job per
project serializes accepted States; immutable job rows use the existing
`githubSyncCommitSchema` State/commit mapping. The latest mapping is a constant
size pointer. Bootstrap verifies the entire exported Git tree against exact
Forge source before trusting the imported native mapping or GitHub commit's
State trailer. Later jobs resolve two State manifests and only changed blobs,
in 100-object/8 MiB windows. Source recipes reuse the fixed source worker's
hash-verifying reader; the cache holds one logical file at a time. Compact
continuations live in storage, not growing Convex documents. Git Data tree
creation uses the last mapped `base_tree`; commit dates and bytes are pinned to
the acceptance so replay retains its SHA. Ref publication observes expected
main and updates with `force:false`. Errors remain on the original job for
explicit same-step recovery, with zero idle scheduling. GitHub App installation
tokens are transient and scoped to the selected repository. See [mirror operation](workflows.md#automatic-main-mirror).

## Local filesystem watching

All native filesystem hints use `src/local-watcher.ts`. Processes attached to the
same owner share one helper over a private local socket. A process-identity lease
under the owner's `.forge/work` directory is elected under a recoverable lock;
a dead lease can be replaced without reclaiming a live or reused PID. Identical
path/recursive subscriptions share a native watcher and route events to every
attached client. Socket disconnect releases that client's subscriptions, and the
last disconnect exits the helper. Closing the last local subscription also joins
an in-flight helper election through its lease publication or exit, so owner
teardown cannot race late election writes; it does not wait for native watcher
teardown or stop a helper serving another process. MCP overlap notifications validate the Work
format before creating coordination directories or scheduling helper election,
so unsupported owners retain their bytes even if asynchronous startup would
outlive the rejecting request. Unowned diagnostic paths use a private helper.
Native open and close run only in the helper, so a synchronous FSEvents hang
cannot block the owner or agent event loop or shutdown. Worker threads can still
wait in native teardown during Node shutdown.

Opening errors (including EMFILE, ENOSPC and EPERM) mark the affected subscription
degraded. Startup, native open and private-probe open have separate three-second
deadlines; the event deadline starts when the signal is written, after a finite
100 ms stream-arming delay. Overlapping requests share one native probe, avoiding
stream changes from closing one probe while another signal is in flight. The
helper owns its private directory independently of subscribers; the parent tracks
cleanup if it must kill the helper. Probe directories use the real temporary path,
never source. Native-close acknowledgements are flushed before directory cleanup,
so cleanup latency cannot falsely consume the close deadline. Directory removal
is asynchronous and does not delay target events or close acknowledgements. Both probe close and subscription close wait at most 250 ms for an
acknowledgement. A timeout degrades all subscriptions on that helper, kills it,
disconnects the affected transport and unrefs it without waiting for native teardown. A replacement
requires an existing consumer's probe or a new subscription, a completed prior
process exit, and the one-minute failure backoff. No retry timer is installed.

Degradation itself starts no polling, network calls or notifications. Presence
keeps its existing minute reconciliation and retries the health probe on that
tick; degraded watching on other platforms also uses that metadata fallback.
Lane presence also compares its pre-open metadata snapshot when the helper
acknowledges native attachment, covering edits during asynchronous startup or
recovery that Linux inotify cannot replay.
Agent wait keeps its existing two-second local receipt fallback. Landing and
exchange retain their durable socket wakes and existing pending deadlines; MCP
notices remain in the durable next-call inbox. No new idle reconciliation timer
is installed. A successful later probe restores native hints. `nforge doctor`
reports one `watching` health result from a finite local probe, including a
structured degradation code; no permanent UI notice is added.

## Four kinds of state

- **Source** is a State: immutable bytes.
- **Analysis** is a result computed over source by a specific analyzer version.
- **Work** is changing collaboration data.
- **Authorization** is what a caller may access right now.

Changing one never silently changes another. A Candidate pins its base, ordered Lane heads and dependencies. A Channel records which Candidate was accepted. Repeating a mutation with the same operation UUID returns the original result. It never moves a Channel backward or reruns a finished check.

Canonical Candidate pages read `projectViewReads.read` with the
`candidate-source-files` feature. The query selects the immutable canonical
Candidate before consulting any legacy Work generation. The browser verifies
its exact R2 State manifests, or a server-pinned source-only file-list object,
and its ordered composition pages. Continuation cursors bind the Candidate,
base and head; the existing object reader rechecks current access after IO,
including cache hits. CLI provenance negotiates
the same file-list pointer on its existing Candidate query. Legacy indexed
Views remain readable. A file list does not claim complete save attribution;
canonical CLI provenance still reads the pinned version history.

## Source analysis

Forge reads TypeScript, JavaScript, Python, Java, Rust, Go and C#. TypeScript and JavaScript use the TypeScript compiler, which resolves identifier references. Python, Java, Rust and Go use pinned Lezer parsers that give declarations and conservative lexical references. No Lezer grammar exists for C#, so a small header scanner (comments, strings and `#` lines masked; bodies skipped) gives its declarations and `using` directives. `src/languages.ts` is the one place that names the languages and their extensions.

Every other text file (Markdown, YAML, a Makefile, `go.mod`) gets a file-level entry: its path, size and digest in the source files and one `File` node spanning the file, so declaration and file reads are never empty. Binary files, files over the per-file bound and files past the file or byte budget are counted in `excluded` (`unsupported-language`, `inventory-limit`) and never read twice; code is captured first, so an entry never displaces a code file. Entry text is not retained.

Coverage is partial and says so. Relative imports resolve for TypeScript, JavaScript and Python, as do qualified Java imports and explicit Rust file modules. A Go import resolves through the `module` line of a captured `go.mod` to the package directory and edges every non-test file of that package (at most 64); same-package names resolve across files, and `alias.Name` resolves to an exported package-level declaration. A C# `using` resolves to the captured files that declare that namespace. Go workspaces, `vendor/`, `replace`, build tags, struct fields and methods reached through a selector, and all C# references are not modelled. Not modelled: tsconfig aliases, installed packages, dynamic dispatch, framework routes, macros, overload resolution and complete call or data-flow graphs. A missing relationship means unknown. It does not mean independent.

`impact` means direct reverse imports. Use ordinary search for configuration and strings.

Freshness comes from rereading source, never from timestamps. Re-indexing captures source twice and publishes only if both reads match. An unchanged, valid graph is reused. A worker keeps only its latest compiler program.

## Storage

**Native objects.** `NativeSource.put` hashes each file and stores it once under `.forge/work/objects`. A State is a manifest of paths, blob hashes, modes and parent States. A changed file is stored whole. Capture reports which paths were excluded and why. Retained files and their directory prefixes are indexed once per capture, preserving tracked files through ignore rules. Native ancestry queries stop at a verified match and share verified parent information only within one operation; full history traversal remains available for merge bases and exports. State manifests and their on-disk format are unchanged. `src/state/git.ts` converts a State to Git blobs and trees in-process and back to its exact manifest bytes, keeping the SHA-256 State identity; it reports a manifest it cannot reproduce instead of converting it.

**Hosted blob access.** Bytes go to R2; Convex holds records ([data placement](data-placement.md) lists every table and byte store). Every deployment (self-host included) and every project writes R2, with no opt-in, flag or Convex byte mode; missing R2 settings fail with `R2_NOT_CONFIGURED`. Nothing writes Convex file storage, and `tests/hot-storage-invariant.test.mjs` fails verify on any write, and on any read, storage handle or `_storage` field outside its dated allowlist. Convex functions read bytes through `BlobStore` (`convex/blobStore.ts`); CLI exchange uses `ExchangeBlobs` (`src/exchange-blobs.ts`). Project objects dispatch on each row's `location`, with `r2Key` and a verified commit for R2. Server-built indexed artifacts and import cursors use opaque `r2blob:` references to `artifactBlobs` metadata. R2 writes reserve immutable pins before create-only checksum-bound PUTs and commit after HEAD verification. Readers still read legacy Convex storage IDs until cleanup and verify downloaded bytes.

**Object catalog and upload packs.** A GitHub archive import writes no row per object. Each bounded upload window concatenates source objects into one immutable, content-addressed R2 pack; singleton and empty objects can remain raw. One transient receipt retains logical digests, sizes and optional pack digest/offset/physical-size bindings. Publication writes a sorted `projectObjectCatalog` of 256 pins per row. Physical packs also retain protected source bindings, so a later identical artifact cannot cause their cleanup while accepted source uses them. `findObject` (`convex/projectObjectFind.ts`) is the only digest lookup: an object's own row first, then the covering catalog row. A request reads each catalog row at most once. A writer needing a row ID copies the complete binding with `objectRow`. Readers authorize the project or selected worker grant, sign the exact byte Range for packed objects, and verify offsets, size and logical SHA-256. Raw objects and existing recipes remain readable. The generation's `sourceBlobs` resolve from the catalog, so there are no per-blob records. `finish` scans no inventory: it schedules a purge that deletes transient inventory in pages bounded by bytes read (rows stream in key order; a page stops after 4 MiB or 1,000 rows), because a window row is about 135 KB and a row-count page overran Convex's 16 MiB read limit on a 62k-file repository. Once every file is stored, the portable State is pinned on the import job. A publication failure maps to `GITHUB_IMPORT_PUBLICATION_FAILED` (never `GITHUB_IMPORT_INTERRUPTED`), and a retry of the original operation rebuilds the path-to-blob rows from that stored State and publishes without any GitHub archive, tree or blob request. `tests/github-import-archive.test.mjs` imports a 28.9k-file tree and guards fewer than 1,000 document writes, no per-object/per-blob rows and at most 80 R2 PUTs. `tests/object-catalog.test.mjs` guards the digest lookup boundary; `tests/import-object-packs.test.mjs` covers byte ranges, retry/replay, current access and cleanup bindings. The import needs no Mac: publication selects hosted main and server authority ([birth](#hosted-source-authority-and-operation-contracts)). The earlier live t3code reading was 16 min 56 s, before the catalog and window packs; with them it takes 2 min 31 s and 2 min 37 s in two runs, until the project is agent-writable, within the five-minute target ([Phase 5](phase5-plan.md)).

Trusted source-worker recipe outputs may additionally retain a bounded ordered
projection of raw R2 leaf pins and exact pack ranges on their existing object row. Publication validates
those pins against committed project objects; client recipe completion never supplies
the projection. Existing authorized download and job-descriptor reads sign the whole
projection together without leaf lookups or new calls. Browser, exchange, Lane checkout and trusted source readers consume the leaf
projection in their existing signed descriptor/signature call. Leaves fill their
final destination spans in bounded byte windows; only logical bytes enter existing
caches. Physical leaf and whole-object hashes, pack ranges and ordinary final
access fences remain checked. Legacy recipes without that projection batch known
sibling descriptors in disjoint windows through the existing 100-pin preparation
window in both source
readers, then read and verify the same physical objects. This removes per-leaf
descriptor round trips without prefetching file bodies or changing State identity.
Small saves can consume a projected recipe baseline
within their existing byte bound. Legacy recipes without the projection retain
their original readers. State identity and recipe bytes are unchanged.

Within the existing 1–4 MiB State window, fixed source writers select path-anchored
file-list chunks (256 KiB to 1 MiB), isolating parents and the suffix. Verified raw
State reads supply reusable ranges in their existing R2 body; projected baselines
supply their already trusted leaf bindings. Only changed chunks and recipe metadata
are uploaded. A cold legacy baseline or a layout with no net byte saving keeps the
flat encoding. Physical bindings travel with the logical output in the existing
commit, with one atomic cleanup fence, so no chunk staging RPC is added. The State
pin, parent list and generation retain their original meaning. Larger States keep
the existing flat path, including its unresolved large-manifest memory risk.

The existing `forge-source-step` log line includes `putBytes`: State (including
recipe metadata), continuation/progress, final result and other attempted bodies;
`refused` is the subset answered 412 and `avoided` counts reused destination bytes.
Failed attempts use the same marker with `outcome: "failed"`.
These are action-local counters, not billed egress: headers, responses, RPC metadata,
platform accounting and other functions are outside this body measurement. No
metrics query, retained counter, timer or idle call is introduced.

Trusted source actions also accept a State's optional `statePhysical` recipe pin
in the descriptor reply they already read. The root and requested digest buckets
are hash/size verified and State-bound before their raw, packed or recipe
bindings enter the action-local transport. Missing or invalid manifests name the
catalog fallback without changing selected digests. The shared default-off
`FORGE_PHYSICAL_MANIFESTS` setting is captured when a source step is dispatched.
With it enabled, compose seeds legacy main once; later State writes share
unchanged manifest buckets and resolve only new bindings. Ordinary save and sync
never seed. Roots and packed changed chunks use the existing R2 output commit;
Convex holds one root pin per State. Legacy noncanonical bindings retain explicit
catalog fallback. State-bound external endpoints and Actions/clone readers accept
compact grant replies and full physical-run plans through the negotiated `source.state`
(Actions) and `source-state` (CLI) capabilities. State bootstrap replies carry the
trusted root pin only when requested by a negotiated reader. They check current
access before and after R2 I/O, refuse nonmembers,
and prove recipe descendants from a selected logical member. Full metadata is
hash/size checked before member rows enter the client cache. Raw or fragmented
States use the named one-time window and existing check-published source pack.
Readers negotiate protocol 2 through `source.state.v2` (Actions) and `source-state-v2`
(CLI). A failed transfer refreshes the selected State descriptor once and follows a
changed root; it never selects another State. The server also rechecks a rebound
root once before falling back, then checks current access again. Healthy reads
keep their existing calls. A second rebind refuses the reply. Catalogs remain
available; descriptor retirement requires complete point authority independently of root encoding. A trusted, enabled source step that
commits a complete root marks that project as requiring protocol 2. Its existing
project read supplies the marker; only the first qualification writes it, with no
extra resolver call. Discovery, State bootstrap and State-source endpoints return
`CLI_UPGRADE_REQUIRED` to older clients. Runner source reads are State-bound; the
legacy arbitrary-digest route cannot bypass selection. A skipped or missing root
keeps the protocol requirement and its complete State-checked catalog fallback.
Unqualified projects keep the compatible contract; general project browsing is unchanged.
Readers also accept FPR2 roots with optional membership fingerprints and FPM2
bindings that preserve exact raw/pack nonce keys (`/o/SHA/u/UUID`). Catalog,
bootstrap and Lane download routes use the same project-key grammar, including
recipe metadata and leaves. Adjacent content runs group by the exact stored key,
so nonce copies never coalesce. Grant grouping,
metadata downloads and operation-local caches distinguish nonce copies. FPR1/FPM1
bytes remain compatible. The default-off writer emits fingerprint-free FPR2 roots and
exact nonce bindings; it compares verified parent-State membership before sharing a
bucket, packs changed buckets together, and carries the smallest live parent pack
when needed to stay within 63 metadata keys. The carry is bounded by one 63rd of
the parent manifest. It never scans descriptors for unchanged files. Metadata plans grant one covering range per exact root-listed pack key, from its
first live bucket to its last; only hash-checked root-listed chunks are decoded.
Before returning an adopted State, compose checks its root against main: each key
must already belong to main or contain only live chunks. It copies failing keys
with one verified range read per key and rebinds the same State in the existing
commit. Saves and syncs keep their working roots; only trusted compose outputs may
replace a binding. A kept compose writes no metadata. A repairing fast-forward
adds the row work of one State write inside the existing commit, with no added
resolver call. Invalid roots are rebuilt from main; other storage errors fail the
step for ordinary retry. Adopted raw and packed nonce States retain the exact
verified object key when compose adds or repairs a root; the commit validates and
protects that same whole carrier pack instead of reconstructing a canonical key.
A compiler-based publication inventory follows Candidate and Channel writes,
including record dispatch, DB wrappers and renamed imports. Seeds check the exact
selected head has no working physical root. Work metadata copies cannot create
Candidates; authority cutover preserves the selected Channel's source and changes
only its authority pin. These checks add no RPC or idle work; a seed checks its
head through the existing indexed object lookup in its publication mutation.
A whole plan above 64 grants takes the named catalog fallback. Content grants
remain exact. Root encoding alone does not bound metadata key fragmentation;
descriptor retirement remains pending.

Immutable point bindings share the existing receipt table
(`source-point:PROJECT:DIGEST`). The request-cached `source-points:PROJECT`
header is `1` while any dense fallback remains and `2` only after the bounded
writer verifies the catalog is empty. Full mutable rows retain precedence.
Complete points preserve exact raw/pack nonce keys, recipe pins and imported
State dimensions. Row promotion preserves every existing State/recipe field;
generation repair promotes a point or legacy catalog State before changing its
metadata instead of rewriting its dense page.

The existing internal catalog compactor accepts an explicit `points:true`
operation that qualifies point authority without changing client protocol policy. It first
copies original upload IDs, nonces and sizes into self-contained binding
receipts, at most 64 rows/64 KiB per mutation. It then publishes at most one
256-pin catalog page's complete points and removes that page in the same
transaction. The final empty-catalog check also catches a concurrent page placed
before its cursor. Original operation/cursor retries reconcile without repeated
writes. Pending raw/pack uploads and mutable State provenance stay in their
original rows. Content reads can use a complete retained binding while another
upload of that hash is pending, without consuming its original ID or unverified
pack members. Trusted publication retains any additional verified physical key
in the same receipt/index authority rather than pretending the pending members
were committed. New catalog-store/compaction writes use point authority; a direct
bulk import reopens mixed fallback before publishing dense pages, which the same
bounded writer can subsequently retire. Nothing automatically runs a migration,
schedules work or changes the default-off physical writer.

Original-ID commit and reconciliation use their complete receipt after checking
current project access. Completed projects do not read a predecessor catalog row
for a point miss. The 402/1,387 packed fixtures preserve their original
48,542/48,919 B dense-row baselines and enforce under 1 KB for stored, absent and
original-ID retry lookups. These are serialized whole-document fixture reads;
billed usage and live deployment qualification remain open.

Whole physical keys remain protected after descriptor retirement. Raw and metadata
carriers resolve through the existing digest index. Member packs retain one
whole-key proof through the existing receipt-key index before their descriptors
disappear; this avoids adding index writes to every ordinary upload. Cleanup's existing source-union page
also retains known physical keys; logical protection still works when optional
old descriptors are missing. Reviewed log selection, final claim and R2 sweep
consult exact key ownership, including a source member inside a shared pack.
Point/receipt publication appends the existing cleanup fence atomically. This
removes dense pages and the separate State-generation page rewrite, merges point
and original-ID binding validation, and adds no healthy source RPC or idle call.
The explicit migration holds one descriptor page (or a bounded 64-receipt lookup
window), never a State/file body. All source and metadata bytes remain in R2.

**Save-time upload packs.** A save (and any hosting upload window) with more than one new small object sends them as one pack in the same format: members back to back, nothing between, at most 8 MiB (`src/object-pack-upload.ts`, contract feature `upload-packs`). The client names the pack (digest, size, member indexes) in the prepare it already makes (`projectHostedSaves:prepare` `uploadPack`, `projectObjects:prepareBatch` `pack`); the server signs one create-only, checksum-bound PUT and writes one pending pack row holding the member list, and no member row. R2's checksum covers the pack, not its members, so the commit that already runs (`commitObjects`, inside `projectSourceRun:submit` or `commitBatch`) reads the pack once and checks every member digest before it writes the member rows with their byte ranges, in the transaction that commits the pack. An unverified member therefore never exists as a stored row: a planted member fails closed, binds nothing, never dedupes, and a later honest upload of that digest prepares afresh; readers still check every digest. A member that is already stored makes the whole proposal fall back to per-object PUTs, so no bytes are kept twice. The commit hands the small checked members (the save's delta page) to the save step in memory. A clone reads each save's new objects with one ranged GET per run, like an import window; `tests/r2-write-path.test.mjs`, `tests/r2-read-path.test.mjs` and `tests/hosted-save-sync-efficiency.test.mjs` cover the PUT and GET counts, the planted member and mixed history.

**Source packs.** A large checkout does not fetch objects one by one. A project keeps one gzip source pack of a State in R2 (`convex/projectSourcePacks.ts`, `src/source-pack.ts`): at most 300 MiB and 100,000 files, with one latest pack and one in-flight slot reserved before the signed PUT. When a client checkout is missing 500 or more objects, after the shared machine object store (`src/machine-object-store.ts`; `FORGE_OBJECT_CACHE` moves it, `off` disables it), `src/hosted-checkout-cache.ts` downloads the latest pack and unpacks it, then fetches only what is still missing. A pack is a cache: if it is absent or fails, ordinary object transfer runs. The check runner publishes packs for its pinned base through the same reservation. `nforge x ROOT source-pack` packs current hosted main from the operator's machine; run it after a seed, cutover or large import.

Indexed imports and binary derivatives go to R2. Legacy derivative reservations
made before that still reconcile through Convex storage. Existing R2 references always retain R2 reads.

The fixed Convex source provider writes output bytes and durable cursor/fanout
progress directly to R2. Checksum-bound create-only PUTs
and HEAD checks precede existing batched output publication; there is no new
per-object Convex RPC. Cursor and task data use project-bound `r2source:`
references carrying their exact digest and size, alongside existing Convex IDs.
These internal progress references address immutable project object keys directly;
the owning step/task rows retain them. R2 placement takes precedence over any
retained legacy Convex copy.

The durable reader checks legacy IDs against a live `projectObjects` binding
using the project/storage/removed index before reading bytes. Unowned IDs fail
with `SOURCE_REF_UNOWNED`, including old unregistered cursor/section blobs;
those continuations need migration before resumption. Each legacy read adds
one internal query and at most one indexed lookup. R2 reads add no Convex calls.

Hosted check selection/recipe objects, browser bootstrap objects, Work detail
objects and mirror continuations use the same checksum-verified R2 source seam.
Repeated check selections reuse an existing digest-bound object after HEAD
verification, without uploading its body again; the recipe format is unchanged.
Bootstrap reserves its operation-bound project namespace and original timestamp
before R2 upload, then publishes source/Work atomically. A reservation is not a
completed creation and retries preserve its bytes. Legacy Convex upload
receipts written before R2 became the only byte path remain reconcilable.

Merge preparation first verifies nearby parent frontiers. Composition and
resolution pin their selected tips; resolution retains the two tips from its
hash-verified conflict page across continuations. Prefetched ancestors never
become additional selected roots. Native merge/file calculations still use exact
State bytes.

New hosted State objects retain an optional `stateGeneration` on their existing
`projectObjects` record (or sparse catalog entry). A root has level 1; a child has
1 + the largest authenticated parent level. The fixed source worker derives it
from the exact output State's parents and current server descriptors, then writes
it with the ordinary output batch. Bootstrap, verified Git seed roots and GitHub snapshot import derive
level 1 from their constructed parentless State. The original Git bundle's commits
are not extra Forge States. No generation enters State manifests, content hashes,
client plans or ancestry hints; there is no additional healthy-path RPC or object
write. A missing parent level leaves the new level unknown until the explicit
operator pass. Generation numbers are unrelated to mutable Work generations or
worker lease generations.

The same worker records the State's exact parent list (`stateParents`, at most 16)
beside its level, as Git's commit-graph keeps parents beside generation numbers.
Both are written once from the hash-verified manifest, in the same output batch, and
never change. Ancestry preparation takes a State's parents from its descriptor when
recorded and reads the manifest only for older rows, so a sync or resolve far behind
main reads object rows, not the whole tree of every State in between. Descriptor
prefetch follows recorded parents to warm a window of up to 100 rows in one call, so
calls do not grow with distance either. This holds only for States the hosted worker
saved: GitHub-imported history and rows saved before parents were recorded carry no
parents, so a walk into them still reads their manifests.

For verified selected tips with authenticated levels, preparation uses a
generation-ordered paint walk with one colour per tip, extending Git's two-colour
walk. Common ancestors mark their parents
stale. Once one non-stale side is exhausted and exactly one maximal base is
proven, remaining branches cannot add a base. The cursor records those explicit
cuts separately from stored parents. This stops closed side branches and wide
or deep history without requiring every parent path to cross one singleton.
Equal-generation ties retain the existing object/byte windows. Multiple or differing pairwise bases
retain BFS and their recursive virtual-base ancestry; selections with additional
restore roots also retain BFS. Prefetched cycles prevent generation pruning.

States without generation retain the existing shallowest-distance BFS and
root-relative singleton-cut proof, with stable ties and identical merge results.
Only verified parent edges determine distance; hints never select byte reads or
install proof edges. This fallback bounds speculative depth, not width, and can
still traverse closed-side history. Failed graph probes retain their exact error
and unresolved edge in the R2 cursor while independent frontier work continues.
Only an authenticated cut may retire that edge; a genuinely required failed State
surfaces its original error. Descriptor failures remain page-batched.

The dev operator's [generation pass](operations.md#state-generation-pass) previews
existing publication and imported-State headers, verifies bounded source pages,
and assigns missing levels parents-first. Discovery retains unresolved dependency
identities as untrusted scheduling hints instead of repeatedly downloading their
bodies. Its compressed private continuation contains candidate identities, sizes,
parent-order hints and scan positions, never authoritative levels or source bytes.
Assignment re-verifies the exact bodies and current server parent levels; cached
size hints retain the reader's before/after access and binding checks. A State is
read at most twice in an uninterrupted pass, independent of candidate order.
It installs no job or idle scheduler,
and never changes R2 bytes. Save/closure validation, pins, retry identity and
worker concurrency are unchanged.

**Lanes and checks.** `materialize` writes a State into a fresh directory of ordinary files. Native Lanes clone one disposable, pinned source-tree cache per owner using APFS `clonefile` (or filesystem reflinks elsewhere). The cloned tree is checked against every manifest path, blob digest and mode before publication; an edited or incomplete cache is rebuilt from the same State. Cache preparation and cloning hold only the cache/Lane locks, outside the owner writer lock. `.forge/materialization.json` records the selected head and clone/copy result, including the reason when the filesystem needs ordinary copying. Check workspaces retain their independent byte-only materialization. Editing a Lane never changes stored objects or other Lanes.

Automatic snapshots reuse unchanged content-addressed blobs and clone newly changed regular files through the same filesystem helper. Every new clone is verified against the captured bytes before object publication; edits racing a clone retain the original captured bytes. Snapshot pointers record clone/copy counts and fallback reasons. State identities, symlink bytes, checkpoint behavior and the existing snapshot retention window are unchanged.

**Work records.** Local projects keep Work in `.forge/work`; the local landing driver that wrote through the paths below was removed with one client mode, and hosted projects keep Work on the server. Git-backed owners keep it in the Git common directory under `forge-work`. `work.json` is a small manifest that points to immutable, content-addressed record pages. A save writes new records, syncs them, then atomically replaces the manifest. An interrupted save leaves the previous snapshot in place. Lock-free pointer readers validate one open descriptor, allowing atomic replacement to unlink that descriptor while retaining its coherent bytes. In-place mutation and unsafe file types still fail explicitly; source capture retains its separate pathname validation. The owner lock serializes manifest publication and shared Channel mutations. Landing queue edits, native acceptance, main-audit selection and GitHub mirror recording prepare against one committed pointer outside that lock. They stage changed immutable records, then verify the exact pointer and driver/authority fences before publishing; a concurrent commit retries without overwriting either writer. Git/network operations hold no Work writer lock. When enabled for the publication, derived peer caches warm after writer release and before the mutation receipt returns, using their immutable page pins. Owner workspace refresh serializes on its own lock and selects current main after admission. Agent Lane operations also take a per-Lane lock: checkpoint capture and native sync file writes run outside the owner lock; sync publishes only its Lane into a fresh manifest with a source-field CAS, preserving concurrent changes to other Lanes. Native start reserves its records, materializes outside the owner lock, then publishes activation. Start activation also retains its original receipt metadata in the Lane, without local filesystem paths. Start/checkpoint publish without inline preview preparation or peer indexing. Outside the owner writer lock, their receipts include queued hosted activity, indexed peer observations, pending overlap delivery, coordination recording, friction and start warnings. Hosted activity uses the transport-state lock shared by binding writers, without entering the owner writer queue. A local per-operation receipt preserves those observations on replay. Incomplete indexes remain explicitly `local-incomplete`. Checkpoint preparation primes saved region summaries before publication. Checkpoint receipts retain overlap-save metrics from immutable manifests, using the latest save delta and excluding accepted peer heads; missing ancestry or source leaves metric coverage incomplete. Receipts compare those summaries and committed contract data, retain observed conflict identities with current repair/sync lineage, and resolve links only from local identity (otherwise returning `links.error`). CLI/MCP source re-indexing, overlap recomputation and enabled previews run in a finite detached refresh; that refresh never marks unreturned notices delivered. A pending ticket makes worker startup visible; MCP shutdown and synthetic-owner teardown join scheduled refreshes. Read-only actions never schedule a refresh. Stacked start replay preserves original head/base while reporting the latest saved `currentHead`. Exact-operation checkpoint replay reads retained history without source capture or workspace restoration. Check execution and observation hold no Work, Lane or Channel lock; after a Channel CAS race finish either proves the enabled disjoint fast-path or syncs, composes and checks a fresh pinned attempt before rejoining the acceptance queue. Transient contention at the final cancellation/spawn journal step retries without rematerializing, changing the run ID or releasing its machine-capacity ticket; a never-started command is not marked failed merely because this lock was busy. The per-operation finish journal guard prevents duplicate drivers of the same operation; it does not exclude other agents.

Native Work formats 23 (separate Intents) and 24 (unified Intents) retain run
selection inventories, coverage details and named verdicts in hash-bound Work
objects. The run keeps its outcome, source/check/provider pins, timing fields,
selection scope, counts and at most twenty bounded failing test names. Detail
objects use the existing Zstandard codec; their object hash covers the encoded
bytes. Native export, seed, exchange, recovery and object collection follow those
pins. Full Work loads and indexed list reads do not hydrate them. Check reuse,
flake history, timing ingestion and diagnosis load selected details and preserve
the original execution evidence fingerprint. Agent receipts include the detail
pin and counts. A native `read-work-detail` command with `kind: "run"`, `id`
and `expectedHead` hydrates that selected run; `kind: "automatic-action"` with
`id` reads an original automatic result. Hosted detail reads resolve the selected record, verify its object
and recheck the generation and current access before returning it.

Automatic-action records keep a small result summary plus the immutable full
result pin. Lifecycle completion and cleanup retries read that full result, so a
lost reply preserves the original response. No action history or result is aged
out or deleted by this change. Git-backed owners retain their existing inline
representation.

`nforge work ROOT '{"action":"migrate-record-details"}' REVISION` migrates a native
owner in finite record pages, atomically publishing each cursor with its records.
The representation change preserves the Work revision, identities, old pages and
receipt digests. A retry resumes the saved page; a completed retry writes nothing.
Ordinary native writers externalize new or changed detailed records too. Upgrade
all writers sharing the owner first: previous CLIs reject formats 23/24 through
`WORK_UPGRADE_REQUIRED` before preparing a write.

For hosted Work, `nforge hosted-work DEPLOYMENT PROJECT_ID
'{"action":"migrate-record-details","operationId":"UUID"}'` uses the same page
conversion under existing owner authority in native-owner and server modes. Its
original operation saves a cursor after each page. Publication checks the original
backup, Work revision and authority epoch, then selects a compact record catalog
and retains the ready disposable index: the logical records are unchanged. Original backups, source identities,
acceptances and journal request bytes remain intact. Loads start at the migrated
journal revision and replay later events; original journal rows remain readable.
Object-backed migration reads selected catalog pages. Legacy archives use their
existing compatibility loader. Final catalog composition currently loads one
complete original Work before replacing its migrated records; it does not build
multiple complete snapshots or a new source archive.

The standalone synthetic measurement is
`node --expose-gc tests/measure-work-record-details.mjs` after `npm run build:core`.
It reports portable Work and logical record bytes, retained record/detail disk
bytes and five warm-filesystem full-load samples for 1,446 runs and 1,968 actions.
Old immutable record versions remain on disk until the existing explicit
collection workflow; migration itself applies no retention policy.

Lock admission uses FIFO filesystem tickets with process-start identities. Writers wait up to ten minutes by default (`FORGE_WORK_LOCK_WAIT_MS`); agent `start`, `checkpoint` and `sync` accept `waitMs`, and `lockWaitMs` selects lock patience separately from finish's existing observation window. Waiting emits compact stderr progress initially and every five seconds with queue position, operation/run identity, elapsed time and published holder phase. Check observation reports queued/preparing/running phases without taking a writer lock. Finish-driver and landing queues also use bounded waits (`FORGE_LANDING_LOCK_WAIT_MS`, falling back to the Work lock setting); timeout returns a typed, retryable outcome. `WORK_BUSY` after timeout includes available holder identity and instructions to replay the original operation. A not-yet-published holder is described as pending admission. Dead local holders and queue tickets recover; ambiguous/remote locks remain intact. All writers must use the current queue-aware CLI for FIFO ordering; the exclusive owner file still protects against older writers. `FORGE_WORK_LOCK_TRACE=/absolute/file.jsonl` records operation, actor, lock path, wait and hold milliseconds for each released lock. No source or prompt bytes enter this optional trace. Nothing is capped or deleted automatically.

Native composition prepares its pinned source merge outside the owner lock. Direct compose commands retain their Work revision precondition. Finish and land instead revalidate the selected Lane heads, Intent source base and dependencies against current locked Work, retaining the prepared merge across unrelated metadata writes. Publication restores any newly merged objects collected during preparation and writes the Candidate in the short owner critical section. Receipt-reconciled phases retry contention with the same operation ID, including transient admission tickets during prepared record publication; changed source pins remain explicit failures. Pinned review detail reads use an immutable Work snapshot without joining the writer queue. Idle landing-worker observations with no active runs also avoid writer admission.

**Owner working copy.** Optional `ownerRootUpdates` (default off) refreshes tracked
owner files after durable main acceptance, inside the same owner lock. It uses
the final composed main head, not the original candidate. Owner-local journals
pin the last applied State and any interrupted target; retries finish that target
before selecting current main. The shared atomic workspace writer has a separate
owner apply journal and a strict first-apply guard. It reads only selected tracked
paths, refuses local edits and untracked obstructions, and preserves `.forge/`
source exclusions and ignored/untracked content. Skips retain acceptance and
publish a local Needs you notice with `nforge owner refresh ROOT` recovery. The
explicit command uses the same lock and guard. Recovery/notice files live under
`.forge/work`; no Work schema changes or real-owner policy migration occur.

Selected-run observation retries transient `SOURCE_CHANGED` reads from concurrent
Work publication within its existing observation window. It keeps following the
original run without restarting execution or taking a writer lock for live reads;
invalid metadata and other read failures remain explicit.

**Compatibility.** Older JSON journals stay readable. The first indexed write migrates them, and older CLIs then refuse the owner rather than damage it. Never copy `work.json` alone. Use an export, or keep the `records` directory with it.

Hosted Lane opens share a per-user/device worker queue; CPU and network waits hold
no worker. FIFO bakery admission admits either I/O phase under the same capacity;
a separate global phase gate no longer stalls free workers behind an incompatible
phase. Unknown trees and trees exceeding 4,096 files or 16 MiB of logical
installed bytes keep phase-specific worker batches. Smaller trees reuse workers
across phases. Every tree takes the device-wide editing write-pass lease, one pass
at a time: on APFS, ten 28,881-file opens measured ~3.5 s serial passes versus
15-75 s each when three overlapped (`FORGE_CHECKOUT_WRITE_PASSES` overrides the
bound for qualification only). Direct machine-store hits get a safe-file check
only; each installed file's digest is checked once as it is cloned into the stage,
and a damaged or vanished entry is fetched again instead of failing the open. They still
acquire the same shared volume and local worker permits, including cache devices,
and retain independent verified inodes and every file/directory durability barrier.
Repeated blobs count once per installed path toward the byte threshold. Cancelled
or removed worker and write-pass tickets fail with
`CHECKOUT_QUEUE_CANCELLED` or `CHECKOUT_QUEUE_LOST`; retry uses the original checkout
operation. No waiting worker survives checkout completion. The local-only
`scripts/qualify-checkout-open.mjs` harness measures real synthetic opens against an
explicit retained runtime at 1, 6, 12 and 10 concurrent opens, warm (machine store
present) or cold (loopback pack server), including slot wait, first completion,
tail, RSS, hosted-call and pack/object GET counts; it makes no hosted calls.

**Hosting.** `nforge host` reuses owner/key project creation and device CLI authority, then a paged one-time seed, hosted Work initialization and the current derived index. The seed pins source/Work and journal-only recovery inputs before upload, commits bounded validated pages with a durable cursor, and compares hosted native main bytes with the original native digest before selecting main and recording completion. It reuses object upload/R2 transport without invoking exchange push, publication or history completion; retries retain the original snapshot. Seed authority remains pinned to its original mode/epoch, independently of the later authority cutover. Deployment/project bindings and pending operation pins live in an atomically replaced `hosted-binding.json` beside local Work. This transport state does not change Work revisions. Project creation validates the complete autonomy policy, including the optional disjoint fast-path setting; older policies without that field remain readable. Unexpected hosted errors retain a generic client response and log their name, message and stack server-side, without custom error payloads; rejected Convex document payloads are redacted.

**Browser bootstrap.** `projectBootstrap.create` prepares an empty native State,
portable Work and source manifest in storage. One transaction validates their
pins and publishes the owner/key project, retained checkpoint, initialized Work,
`main` receipt and ready Code/Work index. Retrying the owner's operation UUID
returns the same project; a changed name is refused. Concurrent prepared retries
reconcile the winning transaction and discard only their own unused preparation
bytes. Source files are added through the existing source-transfer boundaries.

**Exchange.** Exchange push and source return are retired (Bet 1, B1.6 to B1.8): the push client and the `FORGE_SOURCE_RETURN_*` budgets no longer exist, and the delta planner no longer runs. Old `nforge exchange … push` commands and the former publication RPC addresses (for example `projectSourceReturn:returnSource`) return `CLI_UPGRADE_REQUIRED` before any transfer. `nforge exchange` now pulls hosted main into a client directory, opens a Lane, restores a retained checkpoint, receives or pulls contributor proposals and migrates older archives. Transfers ask which content hashes the other side is missing and move only those. Large files are split into content-defined chunks; manifest and Work metadata travel as chunk trees under a small versioned root. Whole-file hashes stay the identity, and the backend verifies them before binding. The remaining readers keep exact digests and recheck current project access. Saves and landings use the hosted Lane APIs below. See [source exchange](operations/source-exchange.md).

**Archives.** `export-work` writes the full retained closure: source States, Work and recorded run files. It can pack this as a `.tar.gz`. Source-only release archives are narrower and contain empty Work. Browser backup and contributor-proposal imports unpack local exports and upload reusable logical objects. New hosted archive registrations are retired; historical stored archives and pending uploads retain read/resume support. Object proposals pull as validated unpacked exports for direct native contribution import. Older hosted archives are still readable and can be converted explicitly. See [operations](operations.md).

**Collection.** Object collection removes only verified, unreferenced objects. Referenced source history and Lanes are preserved. CI-provider logs stay with the provider; local logs use the explicit opt-in and finite retention described in [operations](operations.md#check-logs-and-retention).

Large server-held native checkpoints build their Work index from pinned record
pages. An action parses the manifest/catalog once and shares bounded immutable
record bytes, exact build lookups and main heads across its steps. Summary pages
batch dependency frontiers and acceptance payload chunks. The reseed upload splits
its already prepared owner display facts into independently pinned diffstat pages
(up to 100 pairs) and selected View provenance pages, bound to the exact Work digest.
The build reads only relevant pages, validates their source pins and View identities,
and stores counts with `owner-reported` provenance and explicit exactness. It reuses
the supplied provenance without rereading State or file bytes. Older uploads retain
State-only provenance projection; index building never downloads changed-file bytes
to count lines. Missing diffstats remain “not computed yet.” Tree parsing runs in a separate source window;
only chunked path rows return to the coordinator. State actions compare up to ten
Views and at most 100 distinct source pins, then return only their changed paths.
Whole base/head file maps cover at most twenty States; optional saves are filtered
to the changed paths as they parse. Verified byte bodies cover at most
100 selected pins and live only in that source action, not in the historical
coordinator. Byte windows share recipe frontiers across their selected States,
resolving at most 100 digests / 2 MiB at a time. Equal subtree digests share a single page parse and physical
read in that frontier; destination spans reconstruct each flat State manifest
and verify its whole digest. Directory paths are manifest entries, not separate
Merkle directory objects. Access is rechecked before and after each byte window,
including shared subtrees. Blob rows drain in 500-row windows. Journal pages apply up to 50 ordered events with an overlay of preceding
updates, then commit rows and the original revision/cursor continuation together.
Existing partial summary and single-event journal cursors retain their meaning.
Scratch cleanup does not reread the default Intent unless a page changed Intents.
All source reads and durable steps retain current authority and exact generation
checks; invocation-local byte reuse is not an authorization cache. Transient
platform/storage reads retry up to three total attempts with 50/100 ms backoff.
Exhausted reads propagate through optional-provenance fallbacks and return a
retryable continuation without committing the in-flight step. Only durable
rows and cursors survive; the next ensure resumes that position. Validation,
access and digest failures retain their existing errors/fallbacks. Builds have
no idle timer. `tests/projectWorkIndex-phases.test.mjs` measures the remaining
phases on synthetic dogfood-sized Work, 2,500 files in 304 directories at depth
six, shared multi-level State recipes and recipe-stored MiB files. Views change
1–40 files and use the State projection even without owner-supplied View facts.

Opening a View with missing counts invokes one finite `projectViewDiffstats:compute`
action. It resolves the immutable base/head and changed-file pins in bounded pages,
uses the ordinary comparison's 50-file/2 MiB windows and saves the display result.
A second open uses the saved result. If optional comparison fails, a fresh
authorized metadata read keeps the View available; access revocation and generation
changes remain explicit errors. Oversized or otherwise inexact comparisons
save explicit unknown line totals rather than restarting on every open. Current
actor/project access and the selected generation are checked before reads and again
when saving. Owner-reported counts are labeled in the detail view; an explicit
server comparison replaces them and later owner publications preserve that result.
Diffstats are disposable display metadata; acceptance and check evidence never use
them. No timer, background comparison or idle scheduler is installed.

## Work record delta exchange

Native exchange schema 2 keeps ordered collections of stable record keys and
SHA-256 pins in a chunked record catalog. Planning versions use their id and
version together. The local Work format and its canonical pretty-printed JSON
bytes stay unchanged. Schema-1 byte trees and schema-2 record catalogs remain
readable for retained checkpoints, hosted seeds, Work projections, journal
reconstruction and recovery; readers verify exact Work and manifest pins. The
publication delta planner that wrote them no longer runs, because exchange push
is retired (see [source exchange](operations/source-exchange.md#work-record-exchange)).

Hosted recipe reads share bounded descriptor windows (at most 100 digests and 2 MiB per window) across recipe bodies and tree frontiers, including ranged reads; every window resolves current project access and availability before and after byte transfer, without retaining an access cache. Full metadata-tree reads also batch internal pages by frontier into the existing result buffer.

Hosted Work metadata loading and index building reuse verified immutable storage bytes in bounded process memos, including recipe nodes and leaves. Every reuse resolves current project authority and checks current storage metadata; recipe closures are revalidated. CLI exchange sessions retain bounded downloaded objects by content hash and size and recheck current project bindings before returning cached bytes. Warm reuse is expendable and does not establish production savings.

Imported Code subscribes to source-free import/status-derivative invalidations. Changes, focus, network recovery and explicit reads trigger current GitHub authority and latest-head checks. Persisted endpoint derivatives and process-local public JWKS reuse avoid repeated derivation; idle tabs do not periodically invoke status actions.

## Checks and evidence

Native checks select local or GitHub Actions execution through `checks.runner` in
project autonomy policy. The Actions controller pins source, definition, selection
and runtime, and binds the terminal receipt to those pins. Declared secret inputs
stay local. Unknown remote outcomes retain execution IDs for reconciliation.
Forge's own project runs its checks on free GitHub-hosted `ubuntu-latest` runners;
Blacksmith use ended on 2026-10-25 and the Mac check worker stopped on 2026-10-29.
See [GitHub Actions checks](operations/github-actions-checks.md).
Modal execution has been removed. Historical policy, runner, cost and evidence
literals remain accepted by readers; new Modal runner configurations are refused.
Shared named-test verdicts, quarantine evidence and retained attempt logs remain
available to local and Actions runners.

A check is an executable, its arguments, an optional environment label and explicit environment/credential passthrough names. A run records the pinned Candidate, the check definition, an environment fingerprint and the process owner. It runs in a fresh workspace under your OS account with private HOME/XDG/temp directories and a clean runtime allowlist plus declared passthrough. Passthrough values are transient; receipts retain names only. It is not sandboxed. The runner keeps outcomes, bounded failure summaries, compact test evidence, provider log links and chosen build outputs. Local logs stay local for seven days; upload requires explicit project opt-in with finite retention. Cancelled, interrupted and failed are different results. After a lost reply, a retry observes the existing run and does not start another.

Playbooks run a sequence of checks. Automation rules start a Playbook on an event. Evidence is reused only under the explicit native disjoint fast-path policy; acceptance revalidates the exact check and manifest-path proof and schedules full main verification. Missing coverage is unknown. A passing check, a model critique and a human review are separate facts. Accepting a Channel is an explicit step against an observed previous head. An optional Invariant can require specific evidence first.

Hosted checks run on the project's configured runner (`configure-runner`); the local `nforge local-checks` computer path is retired.

## Making-of record

`making-of` is a read model over existing records: the Intent, its Lanes (by `intentId`), its Candidates, their runs and accepted Channel moves (by `viewId`), plus local presence and self-reports from `hosted-binding.json`. Records-v2 owners read only those indexed records; older owners read loaded Work. The derivation (`src/making-of.ts`) is pure and omits values whose inputs are missing. Runs record `queuedAt` at creation and move `startedAt` forward when the command spawns, which separates queue from running time. Self-reports are keyed by Lane, actor and optional session, keep their applied operation IDs for replay, and never change the Work revision or format.

Designed, not built: an opt-in OpenTelemetry intake. Claude Code and Codex can export OTLP metrics (token and cost counters with model and session attributes) when the user enables telemetry. A future telemetry listener would accept OTLP/HTTP JSON, map the session to a Lane through a `forge.lane_id` resource attribute set from the Lane environment, and write the same self-report record. It stays off unless the user configures the exporter, and it drops prompt and tool-content attributes.

## Acceptance from the hosted browser

**Status.** The owner-request relay is retired. Since the cutover on 2026-10-28, a project with server authority accepts only through hosted landing (see the last paragraph of this section), and nothing waits for a local owner receipt. The former `ownerAcceptance`, `ownerLifecycle` and `projectOwnerSync:publish` RPC addresses return `CLI_UPGRADE_REQUIRED`, and `nforge host` refuses `--listen`, `--sync-agent`, `--auto-sync` and `--no-auto-sync` with the same error, so no owner process polls for requests. Their retired table definitions remain readable for older backups; there are no active writers. Hosted Review accepts, requests changes and reverts through the hosted landing client and queue (`web/src/review/`). The browser no longer offers owner-listener actions such as Requested / Waiting for the named machine or Re-check on latest main. The local Git/Work HTTP server and owner recovery/reconnect are removed.

A native project created by `nforge host` keeps the `acceptanceOwner:true` role in its `hosted-binding.json`, and `nforge host ROOT --status` reports a legacy binding with no recorded role. That legacy field grants no recovery/reconnect or hosted acceptance capability. A bound local owner that is not under server authority accepts through its own native `accept-channel`.

Revert creates a compensating-change Intent and a hand-to-agent prompt. The agent
must create a reverse-diff Lane on current main, preserve later work, then check
and accept the new Candidate normally. Creating the Intent does not reverse source.
Main is never rewound by this action.

Once hosted holds source authority (`sourceAuthority.mode` is `server`, or a
switch to it is pending), hosted landing is the only acceptance writer
(`projectHostedLanding` / `projectHostedAcceptance`). The native `accept-channel`
writer, shared by CLI, MCP, agent accept and landing batches, then
rejects with `HOSTED_AUTHORITY`, naming the hosted project URL and
an explicitly addressed hosted landing command. It checks at entry and again
under the publication lock. There is no local override: hosted downtime pauses
landing while editing continues. Before the switch and after a rollback to
`native-owner`, the local owner accepts through that writer at its pinned epoch.

## Collaboration

Source changes and live coordination are separate. Convex stores sessions and an append-only message feed outside the Work journal. A session is an attributed claim: who, where, status and optional Intent, Lane or path. Last-seen is the time a report arrived. A heartbeat touch moves only receipt time (`lastSeen`), preserving `lastActivity` and `activityKind`; real MCP activity advances both. CLI lifecycle calls persist local session observations; one process-owned observer with per-Lane filesystem watchers coalesces edits about once per minute without reading or hashing source. The same edit observations drive debounced Lane auto-snapshots: a background, Lane-locked (never waited for) capture with a metadata cache into a local State and a pointer under `.forge/work/auto-snapshots`, published under its own short lock that object collection also takes; the owner Work lock is never taken. Its minute tick also observes queued/running checks. Presence observers validate the current Work format before creating owner or Lane queue tickets; unsupported formats leave the owner untouched. HTTP owns its in-process presence observer: closing the last handle aborts watchers and waits for Lane queue releases. MCP connections do not own background presence or landing workers. CLI lifecycle activity wakes an existing owner worker or retains a detached presence worker. CLI/MCP check execution uses a detached controller with an exclusive per-run process lease, retaining the original run and provider pins independently of transport lifetime. Hosted Now uses shared 15-minute working and 90-minute folding defaults, keep quiet sessions visible, and collapse duplicate name+Lane observations. Silence never completes a session; explicit completion or accepted/closed Lanes do. Messages and handoffs target a session, a participant or the project; acknowledgements refer to the original and are recorded per participant. Claims are advisory path scopes with an expiry. Hosted Work writes insert `change` events in the same transaction. Events carry denormalized kind, recipient, Intent and Lane for indexed inbox and scoped feeds. Nothing pauses an agent, locks a file or accepts source.

Hosted Intent, note and Channel operations use a derived indexed Work generation, rebuilt from the checkpoint and the event journal. Browser query identities stay stable; CLI pagination cursors additionally pin the source revision, and multi-part record hydration retries if that revision changes. Missing or incompatible derived indexes return `PROJECT_WORK_INDEX_MISSING`; normal web/agent reads and commands never rebuild history. An operator can explicitly resume full preparation with `nforge hosted-work DEPLOYMENT PROJECT_ID '{"action":"rebuild-index"}'`. The cockpit strip selects the latest accepted `main` move from the local `channelMoves` and hosted selection records, including its recorded timestamp, actor and exact-Candidate check. Indexed Lane `main.included` means main contains that Lane head; Candidate/run `main.included` means the checked head contains main. These opposite ancestry directions are kept separate, with unavailable ancestry reported as unknown. Accepted moves and their exact Candidate inputs also identify landed Lane heads in older indexes. Unanchored notes, Intent creation/status, planning comments and planning puts (from the web and from agent `comment-planning-item` and `put-planning-item`) use `projectWorkCommand.command`, a single mutation with an operation UUID and no client-held revision. A put's only check is its item version: a stale `expectedVersion` fails with `ITEM_CHANGED`, whose `recovery` names `kind`, `id`, `expectedVersion` and `currentVersion`, so an unrelated write never refuses it. A CLI talking to a server that does not advertise `planning-put-mutation` still reads the revision and calls the revision-checked action. It reads current headers, applies the shared reducer and assigns the next journal revision atomically; Convex retries concurrent transactions. Coordination messages and heartbeat touches are already independent server mutations.

The `projectWorkHeads` row owns the mutable Work revision and projection metadata. Legacy project/generation fields seed it lazily; ordinary writes leave those shared documents unchanged. Revision-sensitive reads (provenance plans and exports) hydrate the head, and each such query re-runs for every open tab on every journal write. Neither the project `state` query nor the `projectWorkIndex:workspace` query every tab subscribes to reads the head: `state`'s `work.revision` is the seed value, the workspace carries the generation's counts (a collection the generation had no rows of is probed for its first row) and no revision, and pages that show live counts count their loaded rows. The live revision is `projectWorkIndex:revision`, held only by the transfer screen and an open source verification. Collection/detail reads depend on the stable generation and their selected record ranges, so one planning write re-runs two queries per tab: the Intent list (an Issue is also an Intent row) and the page holding the item. Opening or hosting a project does not run full index preparation. The compatibility `ensure` action only reads the current generation unless the explicit operator request supplies `rebuild:true`. Detail-storage migration retains the ready generation, and canonical hosted main moves do not invalidate it. Anchored notes still validate source bytes in an action (the web reads the revision once for that one command); Channel acceptance retains its pinned revision check. The legacy command action delegates those five metadata commands to the same atomic mutation and ignores their client-held revision; original retries reconcile by actor, operation and command. Its project-revision checks now apply only to pinned Channel/anchored-source paths. Journal replay and operation receipts retain contiguous revisions and original retry identities.

Filtered planning lists use the existing `planningSearch` roots as a selection index,
then hydrate only matching items from their current reader (record heads in records mode,
journal rows otherwise). Seven ordinary compound indexes on `projectPlanningRecords`
(the original table until a legacy generation completes migration) cover every kind/status/Initiative combination while retaining append-position order;
no row, backfill, write call or text-search query is added. State counts on the existing
`records` read inspect root metadata in one page (up to 1,000 rows / 1 MB), without bodies,
actor lookups or reconciliation. Larger ranges return partial page counts and continuation.
At a 1,500-item board and a 397-item Initiative, list I/O scales with matching roots and
items; count I/O scales with that Initiative. Working memory is bounded by the root page
and selected item bodies, rather than the board; CPU is linear in the selected page. The
existing authorization and generation pins apply. Idle calls remain zero. Older projections
retain ordinary list scans; count coverage reports their incomplete search preparation.

Planning is moving to the hosted record store, which keeps a version and a head per item and no project-wide revision. Issues and Initiatives are kind `issue` (one record version per planning version); planning comments and Intent notes are kind `comment` (insert-only; the parent is the Issue or Intent id, which is the same id for a planned Issue). Journal Intents (web Intents and the Intent each Issue is) are kind `intent`, the kind hosted start already writes: the shared fields keep their names, the rest stay verbatim under `journal`, and the base has no landing receipt (or no base before any Lane). An Intent with no recorded creator was the project owner's. Status moves are kind `lifecycle` (insert-only, parent the Intent), so neither a note nor a move rewrites the Intent's other fields. The journal owns a copied Intent until a hosted Lane starts on it: that start stores the next version with the Lane's base and receipt (a `proposed` Intent becomes `active`), and from then on hosted paths own its status; the copy, compare and dual write report such an Intent as `hosted` and leave it. Each command retains its original operation identity and ordered history; writer cutovers below choose the primary store. The owner copies existing rows with `nforge hosted-work DEPLOYMENT PROJECT_ID '{"action":"copy-work-store"}'`: one mutation per page of 100 index rows. A version already stored with the same digest is left alone and one with other bytes is reported, never overwritten, so a rerun copies nothing. `{"action":"compare-work-store"}` checks read-only, one query per page: rows missing or different in the store, rows that do not read under their schema, Issue heads behind the journal, and store heads with no journal Issue. `{"action":"set-work-store","mode":"dual"}` turns on the dual write, after a clean copy and compare: each journal append also stores the Issue versions, comments, notes, Intents and lifecycle moves it projects, in the same mutation (no extra call; up to 3 more documents per item). `"mode":"records"` keeps the dual write and serves the planning reads from the store: `projectWorkIndex:records` for the Issue list, an Issue's versions and comments, and an Intent's notes and status moves, and `projectWorkIndex:detail` for an Issue, for the web and agents alike. Rows keep the journal's shape (the whole item, never a payload header) and its append order (the order the heads were created). Each head of kind `issue`, `comment` or `lifecycle` keeps its current version inline as the journal row read it, so a page reads one document per row, no more documents or bytes than the journal page it replaces; planning comments and notes on the same id are told apart by head status (`comment` or `note`). Note heads store their Intent id only in the parent field; readers reconstruct it in the returned journal shape. Heads stored before they kept their value are read from record and body, and a copy run brings them up to date (`refreshed`). A write then re-runs only the page holding its item. The compare also checks each journal row against what the store reader returns for it, and that the inline value is what the verified body reads back as, field for field (`readItems`, `readVersions`, `readComments`, `readNotes`, `readLifecycle`); `"newest":N` checks only the newest N rows of each collection (one or two pages each) instead of the whole history. A bounded compare uses compact journal fingerprints and canonical version hashes; matching hashes open no full record bodies. While any eligible writer is still migrating, ordinary journal and canonical writes update those fingerprints in the same transaction. Once all five commands are primary, ordinary writes stop computing or storing migration reader hashes and stop reading or writing fingerprints and target pointers; explicit comparisons use the full current records. Crossing that writer boundary invalidates old digest coverage once, so rollback cannot reuse stale hashes. The owner can initialize a bounded legacy baseline with `{"action":"copy-work-store","digestsOnly":true,"newest":200}`: this writes only disposable hashes and compact pointers, without refreshing heads or copying record bodies. Fingerprints use private collections in the existing index table and stay outside portable Work and source-return read ranges. Missing fingerprint coverage uses the existing full comparison; the result labels each page method `full` or `digest`, and the cursor pins that choice. Hash differences open the original values for diagnosis. Full unbounded comparison retains its reader and body-integrity checks. The Intent list, search, id resolution, briefs, view rationale and note counts use transactional index projections. Those projections are updated from the primary command in the same mutation and rebuilt by replaying retained event history. They do not require a second journal append. `"mode":"dual"` switches the reads back and `"mode":"journal"` turns the dual write off. A row the store cannot read is skipped there and the compare reports it; the journal write stands. Native-owner projects keep their Work in the journal.

`set-work-store` optionally accepts `writers`, independently of the reader mode:
`note`, `intent`, `intent-status`, and `planning` (puts and comments together).
Each enabled command retains its operation provenance in its primary immutable
version's existing body document instead of appending a journal row. That document
keeps the original operation, command, request, actor, timestamp and revision;
previous revision derives from revision minus one. The canonical value moves inline
to the same version header and is still checked against its immutable digest and
byte length. There is no additional audit version or body. A no-op status retains
a new Intent version with the same attributes; a pinned hosted Intent's status
stays owned by its hosted path.

Existing history remains in place. State, export and index rebuild replay both
stores by revision. Planning's unbounded command shapes switch together; retained
reader epochs select the side that can contain large records first, then read the
bounded metadata side within that exact revision window. Byte-driven partial pages
and flag transitions neither lose nor re-read operations. The query fills across
epochs within one client call. Removing a writer restores future journal appends;
previously retained versions remain readable. Original-operation retries and
Intent creator/source-pin lookup recognize either location. Anchored notes,
Channel acceptance retain their existing authority and `WORK_STALE` checks.
Older metadata action clients share the revision-free mutation; scheduled internal
writers pass their trusted actor and recheck current project authority there.

Compact source fingerprints also retain independently captured canonical version
hashes, and current heads have independent compact target pointers. Equal hashes
never read inline primary values; differences open the original documents.
Old versions without derived reader hashes use the verified full reader, and
equal source is reported as matched. Full verification still detects out-of-band
immutable-header corruption, which is outside the disposable digest cache.



Related work is found by comparing changed paths against each Candidate's base. Composition merges independent text-line changes. Overlaps, binary changes and add/delete conflicts stay explicit. Agents should announce scope, watch related activity, message when needed and acknowledge agreements. See [agents](agents.md) and [decisions](decisions.md).

## Source durability and interrupted workspace updates

`NativeSource` fsyncs new object bytes before publishing their hash names. The
objects directory is fsynced before returning a retained capture or individual
object write, including retries that find an existing object. Capture batches
that directory flush across all files; each new file still receives its own
file fsync. Creating metadata directories also flushes their parent entries.
Directory fsync is used on Unix; Windows does not expose the same directory
flush through this API. This is write-ordering coverage, not a claim of tested
power-loss recovery on every filesystem or storage device.

Sync records its selected target and merge timestamp per operation durably in the Lane's
excluded metadata before applying files. A separate durable apply signature
records removals, so interrupted additions, deletions and file/directory
transitions can resume against that same plan. Replacements are written and
fsynced in private files on the workspace filesystem, then renamed atomically
into place; an interruption inside the write leaves the previous complete file.
Directory entries are flushed before publishing the Lane metadata. Retry
recognises old/new versions and planned removals, while unrelated edits still
surface as conflicts with the working copy. Completed selections are retired at
metadata publication; undo also reconciles selection cleanup after a lost reply.
Partial private files are retained.

New Lane directories are built in unique staging siblings, including their
native owner marker. File bytes and directories are flushed before the complete
directory is renamed to its reserved Lane path. Start replay and explicit resume
therefore see either no final directory or a complete marked one. Interrupted
staging directories are retained rather than deleting potentially edited work;
unknown or changed final directories remain untouched. Check workspace
materialization keeps its existing behavior.

## Client error capture

The hosted browser reports its own failures through one module, `web/src/error-capture.ts`: window `error` and `unhandledrejection` events, the app error boundary, and every failed mutation or action made through the hosted Convex client. Failed calls are rethrown unchanged after reporting, so existing toasts and retries behave as before. Opaque cross-origin `Script error.` events are ignored, and an error object reported as a failed call is not reported again as an unhandled rejection. The local app does not report.

The client keeps only the URL path (no origin, credentials, query or fragment), strips query strings from URLs in messages and stacks, and redacts JWTs, bearer tokens, `fga_`/`sk_`/`rk_` tokens and `token=`/`secret:`/`password=`-style values. Thrown non-Error objects are never serialized. The same failure (kind, function, code, message, top stack frame) is sent at most once per ten minutes, at most ten reports per minute per page, and up to ten reports wait until a signed-in session attaches. Anonymous visitors send nothing. The build hash is the content hash of Vite's entry chunk (`assets/index-<hash>.js`), or `dev`.

`clientErrors:report` is a retry-safe mutation keyed by the caller's auth subject and a client operation id. The user always comes from auth, never from arguments; anonymous calls are dropped. The server scrubs and clips every field again with the shared `src/client-error-text.ts` rules (message 500 characters, stack 4,000, route 300). A project id is attached only when the caller currently has read access to that project. `clientErrors:recent` lists a project's reports newest first, for the project owner only; reporters other than the owner appear as `reportedByYou: false`, never by account. The table is additive and has no retention rule.

## Hosted coordination paging

`projectCoordination.sessions({projectId, paginationOpts, parentSessionId?, all?})`
returns Convex `{page, continueCursor, isDone}` pages. The default selects roots;
`parentSessionId` selects immediate children of that session; `all: true` selects
flat project sessions (including descendants). Each row preserves `parentSessionId`,
strips credentials and has `subagents: []`; descendants are never recursively read.
Consumers expand a branch with a separate child query or page the flat stream for
complete presence. Pages use immutable creation order, newest first, so heartbeats
do not move records across cursors. New inserts appear on the live first page.
`recent` uses the same Convex cursor contract in immutable newest-first event order.
The cockpit hook exposes `sessionsComplete`, `loadMoreSessions`, `eventsComplete`,
`eventsLoading`, and `loadMoreEvents`. Presence consumers read flat pages to completion;
Activity requests additional retained events explicitly. UIs must distinguish partial
observations from a complete absence of a participant.

Activity counts range-read optional derived `projectWorkRecords.activityAt` through
`by_generation_and_collection_and_activityAt`, selecting only recent Lane saves
and runs before resolving their Candidates. All index writers derive the timestamps.
Existing rows are populated by the bounded, idempotent internal
`coordinationBackfill:activity({cursor})` mutation, repeating the returned cursor
until `isDone`; counts for unbackfilled imported history are incomplete until then.

Hosted Review lands through the hosted landing queue and offers every retained
clean Candidate, including Candidates without a previous acceptance. People may
accept clean unchecked Candidates; agents still need exact-Candidate passing evidence and
the current autonomy policy (see [hosted final acceptance](#hosted-final-acceptance)).
The `hosted-work` CLI and `forge_hosted_work` no longer have an `accept` action: agents
land with `finish` or `land`, and device credentials can never obtain person authority.

The owner-listener variants of the hosted Intent and Lane lifecycle menus (complete,
reopen and abandon queued on a canonical owner) and of **Re-check on latest main**
(an owner request that composed a Candidate on the latest local main) are retired
with the owner relay: `ownerLifecycle` and `ownerAcceptance` return
`CLI_UPGRADE_REQUIRED`. Hosted agents use the lifecycle and landing APIs below.
B4's cancel command cancels check runs: there is no cancelled Intent or Lane state.

Hosted Code uses paths-only `sourceTreePaths` pages, keyed by an exact source
head and published with the selected Work generation. The `sourceTrees` marker
records complete availability, including an empty tree. Current source and main
are prepared during source indexing; older or unavailable tree indexes use the
existing exact-source review reader. File text is read only for the selected
file, independently of the tree. The project frame shares summary pages and
coordination subscriptions with its child pages. Summary and non-summary pages use the backend's existing 100-record window,
continuing through all history. Ancestry closure, chunk and pair reads share one
request-local cache across summary rows; it never outlives that authorized query. Code and Candidate
chunks are warmed when their navigation links receive hover or keyboard focus;
module preloading never caches project data.

An open tab costs nothing while nobody is looking. The browser's Convex client
drops every live subscription after 30 s hidden or 5 minutes without input or
focus (`web/src/live-reads.ts`); mounted pages keep their last values, the strip
shows Paused, and the next input or visibility change subscribes each mounted
read once for fresh data. Nothing polls. Relative ages re-render on a local 15 s
timer (`useNow`) that stands still while reads sleep, with no server call. A server
count that depends on the clock, such as active agents, changes only on a server
write or a wake, so it can read stale in an awake tab. `scripts/check-idle-queries.mjs`
fails `npm run check` on any live query argument derived from the clock or a
`refreshKey`.

Page readiness distinguishes the first summary page from complete retained
history. Summary consumers can render available rows while continuation pages
arrive; complete-history flags remain available for counts and editor writes.
Updated backends advertise `recentSummaryPages`, allowing the browser to request
newest summary pages first and restore positional order as history arrives. The
default records API order stays ascending. Actor labels are resolved once per
actor within a records query; that reuse ends with the query and never skips a
fresh name or authority read on a later request.

Lane headers use the indexed header immediately while save payloads hydrate in
the background. Selected Intent, Candidate and run summaries use the existing keyed
and parent indexes rather than waiting for unrelated project history. For native
object checkpoints, source-pin lookups recognize an absent base or head before
starting a manifest read that would return the same source-unavailable error.
Archive and older index readers keep the existing source-review path. ID-based
routes subscribe to project state and workspace alongside canonical URL
resolution; the route gate and every query retain their existing access checks.

Development builds, or explicit QA builds with `VITE_FORGE_PERF=1`, expose
`window.__forgeCritical` first-result marks for Projects, Now, Work, Lane and Code.
They record timing and query labels only, exclude presence updates, and never
change a recorded complete time when a live tick rerenders the page.

Source review also resolves exact State and selected-file pins through the
existing `sourceBlobs` index when its generation names the requested backup.
It reads only those immutable objects, without walking the complete retained
manifest. Each object read still verifies current access, storage metadata,
size and digest; the final checkpoint check remains. Missing or inconsistent
disposable pins, an older backup, or an index race restart the
original manifest reader with the same backup, base and head. No source revision
or visibility is substituted, and no new index format or backfill is required.

## Unified Work formats (schemas 18/20)

`src/work-unified-types.ts` defines unified Work formats 16, 18 and 20: a unified
Intent plus separate Initiative grouping records. `convertWork15To16` in
`src/work-intent-converter.ts` is a pure converter for schema-15 portable Work,
with schema-16 pass-through for deterministic retries. Local stores read and write
formats 15/16/17/18/19/20. Format 18 combines unified Intents with format-17 landing
batches; explicit migration accepts 15, 16, 17 and 19. Formats 19/20 explicitly
carry the capability for batches above four entries (up to eight). Selecting a
larger batch promotes 17→19 or 18→20; later writes preserve the capability.
Migration maps 19→20 with unchanged batch records. Older format-aware readers
report `WORK_UPGRADE_REQUIRED` and “upgrade nforge” before reading records or
preparing writes. Current readers retain the earlier formats, including batches
already written before this capability was versioned. Historical migration
receipts remain exact.

Unlinked issues retain their UUIDs. A single issue-to-execution link folds only
when that pair is unique in both directions across retained planning history;
its issue UUID becomes an alias. Execution title and lifecycle status win, while
the issue body supplies the description. Ambiguous components keep separate
Intents with reciprocal related IDs. Legacy ready maps to active; closed issues
map to completed and in-progress issues to active, without creating execution
or acceptance evidence. Pre-execution Intents have no source pin. Unknown
creator or assignment identities remain absent.

Original Intents, planning versions and comments remain in `legacyIntentMerge`,
including unknown fields, conflicting facts and legacy ready observations.
Planning versions/comments also retain their original collections and byte order;
conversation references retain comment IDs and assign deterministic UUIDs to
notes by Intent UUID and note index. Notes and source anchors are unchanged.
Initiatives retain all versions in planning history. Current memberships retain
each source placement (direct Initiative links and issue placement), ordered by
the existing planning display: direct links first, then issue insertion order.
No Initiative is derived from an empty membership list. Historical memberships
remain in the original planning versions.

The migration receipt records before/after cardinalities, folded-pair counts,
SHA-256 of exact input/output JSON, and original Intent/version/comment hashes.
The output digest covers the payload without the receipt to avoid a circular
hash. Conversion never rewrites journal commands or request hashes. A conflicting
issue/execution UUID reports `INTENT_MERGE_ID_COLLISION` without mutating input.
The anonymous count/topology fixture contains only ordinal IDs, lifecycle facts
and counts; every title, note and comment in its generated Work is synthetic.

New Work stores start at current unified format 24, including packed evidence.
Ordinary owner reads and writes require that format before reading collection
pages. Native backup restoration validates the original archive and source pins,
replays any hosted journal with its original request hashes, then converts older
Work in the private recovery directory. Already unified Work is relabelled without
folding again or replacing `legacyIntentMerge`, `intentMergeReceipt` or aliases.
Fresh stores omit those historical conversion facts. The completed live migration
commands and feature-promotion ladder are removed. Historical journal replay
retains its format-specific representation until compaction.

In unified Work, record writers complete unified fields on any Intent they write
(`unifyIntent`): title, description, empty relation lists and a stable
conversation entry per note. `intent-status ready` keeps the Intent active and
records the request as lifecycle history; Ready is derived attention. The legacy
planning commands (`put-planning-item`, `comment-planning-item`) remain the write
API: an Issue write updates the unified Intent (title, description, version,
relations, memberships) and still appends its planning version or comment, which
keeps operation-ID retries and exports exact. Issue IDs folded at
migration resolve through `intentAliases`, and writes through the alias or the
Intent ID extend one version chain. Planning status sets the status of an Intent
with no source pin (closed → completed, otherwise active); once a Lane has pinned
an Intent, its execution lifecycle owns status. An Intent created from an Issue
has no source pin until `agent start` with its `intentId` captures one from its
first Lane; composition and Git `lane` commands on an unpinned Intent fail with
`INTENT_NOT_STARTED`. The web derives an Intent's display stage from its status
and Lanes (`intentProgress`), for presentation only.

Hosted Work keeps unified fields and unpinned Intents without down-projecting them
(`hostedPushWork`, sent by the retired exchange push, is now called only by tests). Record reference validation uses the declared Work format, so
formats 16, 18 and 20 accept an Intent without a base before its first Lane. Unknown
extension fields remain opaque to reference discovery. Unified collections use format-aware record catalogs and deltas, including stable
alias keys. Unsupported layouts keep the complete compatibility path; streamed
complete reads validate schema-owned array segments without a full schema clone.
No Work migration or synthetic source base is needed for existing planned Intents.

Hosted journal reads and local recovery replay original events through the Intent
migration revision, convert once at that cutover, then apply later events to
unified Intents. Companion reconciliation uses the same cutover for the
already-received event prefix before normalizing merge inputs. Legacy
source-return digests are checked against their original representation; errors
identify the event, revision, action and expected/actual Work digest prefixes.

### Hosted main read contract

`nforge pull ROOT` (agent `pull {}`, existing MCP `forge_task`) refreshes a clone
through `checkoutHostedMain`, using the shared clean/stage/artifact-preservation
engine. Its sibling operation journal automatically resumes an interrupted pull;
refresh preserves the root and surviving directory inodes and applies through the
same in-place delta journal as a Lane checkout (below): only changed paths are
fetched, verified, staged and flushed, the checkout is validated through its stat
index, and the baseline marker is published last. File/directory flips apply in
place too (the old file moves aside before the directory is made; a directory
emptied by removals goes before a file takes its name), and so do renames that
change only case or Unicode normalization: a file's old spelling moves aside
before the new one installs, and a directory is renamed through a temporary name
in the same parent to its exact new spelling, on case-insensitive and
case-sensitive filesystems alike. Such a journal is version 3, so an older client
asks for an upgrade instead of finishing it without the renames. Only an ambiguous
spelling (two paths that share one folded name) still builds a full stage, and
that stage copies unchanged bytes from the clone instead of downloading them. An
untracked file or folder where the pull must install refuses with an
`extra-source` obstruction before anything is fetched or staged. Any other untracked
file or folder (editor swap files, `.DS_Store`, a tool's lock file) stays where it is,
as with `git pull`: the clean check carries it instead of refusing, and a name that
meets an incoming path only by case or Unicode spelling counts as meeting it. Tracked
edits still refuse. A pull killed mid-apply is
finished, rolled back or refused by the next pull exactly as in a Lane; an error
inside a live pull rolls the root back at once, because people read the clone
between commands. A `publish.json` journal left by an older client still rolls back
before validation.
Local
tracked edits refuse with a Lane next step. Ignored build outputs and dependency
links survive disjoint changes; occupied incoming paths are refused. Completion
follows durable marker publication and backup cleanup. Initial clone publication
retains its directory-swap path and interrupted legacy swaps remain recoverable.
Main clone roots remain
outside Lane pruning, and sibling editing Lanes are untouched.

The recorded source protocol selects the authorized head endpoint directly:
no change is one bounded query and no R2 bytes. Changed pulls reuse the machine
object cache and verified unchanged root files, fetching only a missing target
manifest and changed blobs in 100-object descriptor pages. They never fetch full
source packs. A final current-access query follows staging. The result reports
Convex requests and byte totals; idle is zero. Root `status` compares installed
and current receipts and reports accepted source revision distance within the
same authority epoch, without source downloads or Work hydration.

Source clients use the schema-1 `HostedMain` contract (`src/hosted-main.ts`), read
atomically by `projectMain:current`: project, source generation, backup, native
main head and its Channel receipt, including previous head/receipt pins. Hosted
Channel selection overrides the uploaded native main seed. An expected head plus
receipt detects stale selection, including rollback to the same source bytes.
This endpoint reuses the current accepted receipts and selected generation; there
is no new main table, Work format, acceptance rule or storage authority.

Lane checkout combines size discovery and signed R2 GET descriptors in 500-object
metadata pages. The CLI downloads directly from R2 with size/digest verification,
then rechecks current credential, project access and object bindings once per byte
window before exposing those bytes. Pages retain the existing 16 MiB transfer
window; Convex-only objects and recipes keep their legacy download actions. No
Convex file bodies or storage metadata are read for R2 descriptors. Signatures are
disposable process memory, and URL expiry refresh retains the same authorization.

Client checkout downloads only that State and missing file blobs through existing
project-scoped object storage, validates exact bytes, and materializes a source
client directory. It never restores native Work or derives current main from an
uploaded checkpoint's root head. Explicit independent-owner restore remains the
full retained-closure recovery operation. Client cache and retry receipts are
transport state; they do not grant hosted access or move a Channel. See
[hosted main client checkout](operations/source-exchange.md#hosted-main-client-checkout).

Source and Work archives retain physical metadata through an optional `physicalSource`
linked inventory. Recovery protocol 1 adds roots to the existing bounded State
registration pages without changing canonical hosted rows. Downloads share the
logical recovery queue: at most 100 objects and 2 MiB per buffered window, with
large opaque bodies streamed and successful objects reused after interruption.
Each entry retains the exact State/root pins and whole metadata objects, including
legacy chunks and nonce pack identities. Export validates every chunk against
its whole carrier; retained roots keep their packs in the native archive closure.
Work exports carry all retained entries. A Source release filters entries to its
selected ancestry and carries no unrelated Lane source or original Work records.
Skipped roots retain their complete logical source closure. Missing or corrupt derived metadata
records its exact expected pins and an unavailable physical closure, preserving
any verified root and the complete canonical Source/Work recovery.

These coordinates are explicitly archival, never destination-project read
authority. Independent restore preserves their bytes and nonce identities, while
ordinary transfer establishes destination bindings and a rootless seed; trusted
compose can subsequently write a root for that namespace. Pending transfers keep
their existing durable content receipts and resume only unfinished bodies. No
State job, save, sync or compose RPC, scheduler or idle call is added. This merges
metadata capture with the existing recovery download queue; the inventory is needed
because a logical State/file closure alone cannot retain whole metadata packs.

### Hosted source authority and operation contracts

Plain-directory hosting reuses the native capture initializer before opening
Work metadata, with no Git subprocess. A fresh native host pins server birth in
its original seed request. Only the existing final seed mutation, after complete
source/record validation and the original authority/source/journal fences, selects
both server authority and its matching schema-2 main. This adds no Convex call or
idle work. Older pending seeds and existing projects retain their authority;
their cutover guards are unchanged. Source bytes stay in R2 and metadata transfer
remains bounded by seed pages.

Projects have an explicit optional `sourceAuthority` record with mode
`native-owner`, `server-shadow` or `server` and a nonnegative fencing epoch.
Fresh native hosts start as an unselected reservation at `native-owner` epoch 0;
their completed seed selects server authority at epoch 1 and verified main in one
transaction. Older native uploads retain the drained-owner cutover. Browser bootstrap and GitHub import have no
native owner: their publishing transaction moves the project to `server` at epoch
1, selects hosted `main` at the published head and writes the same cutover receipt
(`projectHostedBirth`). An older completed GitHub import still owned by a native
owner switches the same way with `nforge make-editable DEPLOYMENT_URL PROJECT_ID`
(owner only; it uses the stored bytes and uploads nothing). A project whose native
owner journal exists keeps the drained-owner cutover instead. Missing legacy fields mean `native-owner` at epoch 0;
creation retries preserve an existing record. Hosting reservations, presence and
heartbeats never select authority. `projectSourceAuthority:current` checks
current project access and reads that project row without scanning or migrating
history. The shared transition helper checks expected mode/epoch and increases
the epoch, including when preparing a return to native authority. H01 adds no
cutover mutation and enables no server writer.

`src/hosted-main.ts` retains the strict schema-1 contract and adds schema 2:
project, snapshot ID, source revision, authority mode/epoch, State head and
Channel receipt with previous State/receipt pins. Optional seed backup/generation
pins are recovery information; they do not constrain the current State or select
main. The source checkout reader accepts both schemas. Clients advertise their
maximum schema to `projectMain:current`; omitted means schema 1. After current
access checks, an unsupported server-source reader receives
`CLI_UPGRADE_REQUIRED` before any legacy generation lookup. Server snapshot
publication is a subsequent implementation slice; until it exists, a capable
reader receives `SOURCE_UNAVAILABLE`, never a native head labeled server main.
Existing native and shadow projects retain schema-1 main selection.

`src/hosted-source-operation.ts` defines shared versioned operation, attempt,
expected-pin and terminal-receipt envelopes. Payload hashing recursively sorts
JSON object keys and retains array order, with original expected pins included
in the hash. A first attempt pins its time, operation/project identity and child
UUIDs before external work. Named child attempts can carry new observations
without changing the original operation. The preparation helper requires a
current authorization callback before reading a saved receipt, rejects changed
payloads/identity/pins with `WORK_OPERATION_CHANGED`, and returns original
first-attempt and terminal data on retry. Completion retains the first terminal
outcome, including failure. Callers must persist fresh envelopes transactionally
before external effects; H01 defines these contracts without adding operation
storage or changing existing receipt formats.

### Hosted record and snapshot storage

`src/hosted-records.ts` defines server Intent, Lane, save, Candidate and source-job
records. `projectHostedRecords` retains immutable, hashed versions; their bodies
live in `projectHostedRecordBodies`, while small indexed headers hold exact byte
counts and content pins. `projectHostedRecordHeads` is a per-resource CAS pointer,
with project/kind/key, parent and status indexes. Independent Lane writes touch
no global Work revision. Old-version retries reconcile the original bytes without
rewinding a newer head. Save and Candidate identities are immutable; Intent, Lane and job
updates append versions. Candidate inputs/dependencies/conflicts and job inputs
are immutable object/page references, never repository bytes or growing arrays.

These storage functions are internal primitives; the hosted start APIs below use them transactionally. Their
callers must resolve the actor from current authentication and commit the source
operation reducer, related record changes and receipt in one transaction. Existing
project read/contributor authority applies. New writes also check the explicit
server/shadow authority epoch; an authorized immutable retry can still reconcile
an original record after the epoch changes. `projectHostedOperations` persists
H01 envelopes before external work and retains original terminal outcomes for 90 days
(`HOSTED_OPERATION_RETENTION_MS`): each new operation deletes up to four of its
project's older receipts through the creation-time index (one extra indexed range, zero bytes when none
expired), skipping legacy cancel receipts that metrics read. No timer exists and an idle project does nothing; a
retry of an operation id older than that starts a new operation.
Native-owner projects are not converted in place; their owner moves them with `nforge host`.
Existing Intent/planning journal commands and portable Work formats are unchanged.

`projectHostedSnapshots` stages recovery/export snapshots as immutable pages of
exact canonical record-version references, pinned to a seed checkpoint, prior
snapshot, source head/receipt and journal sequence. A later snapshot adds only new
references; its prior snapshot retains earlier history. This is a checkpoint of
the canonical records, not another mutable Work authority. Pages are ordered and
unique, hash-chained, validated against indexed record headers, and committed with
progress in the same transaction. The transport helper automatically splits at
100 references or about 128 KiB of encoded references plus referenced metadata;
a larger individual metadata record uses its own page. There is no total history
or project record-count ceiling. Body/header separation bounds staging reads even
when a supplied byte count is wrong.

Only complete matching page/count/root plans can atomically select the recovery
snapshot. Publication reads constant-size metadata, not every page or historical
record. Lost replies reconcile original page receipts and the final result;
replaying an older completed publication cannot rewind a later selection.
`projectHostedSnapshotRead` reads the selected manifest and exact immutable pages
under current project access. Neither staging nor selecting a recovery snapshot
moves main or a Lane. Registered source validation, schema-2 main publication,
source-job execution and public save APIs remain subsequent slices.

`projectHostedDisplayRecords` contains disposable snapshot-delta display rows.
`projectHostedProjection:rebuildPage` reconstructs one immutable page from canonical
bodies without writing record heads, operation outcomes, snapshot selection or
Channel truth. Rows represent only that snapshot's delta; consumers must follow
its prior snapshots and seed for earlier records, and use manifest page counts
for completeness. They must never treat partial display coverage as absence or
use a display row to authorize a source transition.

### Trusted source-job dispatch contract

`projectSourceJobApi` exposes internal enqueue, controller claim/advance,
callback, cancellation and paged pending-job recovery. Enqueue pins the H01
operation's original job ID/time, input page root/digest, authority epoch and
fixed trusted worker/runtime/provider. Transitions append H02 job versions;
they do not publish source, finish the parent operation, or move a Lane/main.
Legacy job records remain readable without the optional dispatch control data.

`hosted-source-job-controller` performs one bounded control tick through
`projectSourceJobDispatch`: at most two provider lookups and one dispatch, with
no worker wait or repository bytes in Convex. A control lease fences competing
actions and late provider responses. Durable dispatch intent precedes the
external request. Every adapter must submit idempotently by the original stable
dispatch key and bind lookup results to that exact request. Ambiguous errors and
eventually consistent empty lookups remain unknown. A single recovery request
requires two distinct, fresh, authoritative empty lookups, including the final
lookup immediately before reservation. It reuses the same execution key and
worker pins. Accepted executions are only reconciled. A rejected recovery request
cannot prove that the original ambiguous request created no execution.

Internal Convex source results bind project, job, operation, attempt, fence,
authority epoch, input digest, worker, runtime and execution identity. Current
project/contributor authority and epoch are rechecked, including duplicates.
Terminal receipts cannot be rewritten. External source callbacks and worker
credential resolution have been removed. Cancellation advances the worker fence.

Recovery reads only a selected project's pending/dispatching/running status
index in bounded pages; it does not scan terminal history or every project.
There is no persistent idle source worker. The default Convex provider reserves
its fixed execution and schedules its first bounded Node action atomically. Each
step commits its durable cursor and successor schedule together; terminal jobs
schedule no successor. Internal results keep the same execution, fence, epoch
and manifest checks without an HTTP callback or HMAC. Verified output references
alone grant no source publication or landing authority.

## Integration preview

`nforge agent ROOT integrate '{"laneIds":["LANE_ID","OTHER_LANE_ID"]}'`
composes accepted main with the latest saved heads of the selected active Lanes.
Omitting `laneIds` selects every active Lane with a checkpoint; unsaved edits are
excluded. The preview uses the existing in-memory source composition and disposable
workspace materialization, for native owners and Git compatibility workspaces.
It never creates a Candidate, moves a Channel, runs a landing check, or calls a
remote runner. `set-policy {integrationPreview:{auto:true}}` enables automatic local
previews for this owner; the default is false. Successful checkpoints and syncs
(including finish's saved phases) wake a detached finite worker. A 200 ms quiet
window coalesces bursts across processes, one owner drain processes the latest
saved request, and the existing preview lock also serializes manual previews.
Requests arriving during checks trigger another pass. The worker exits as soon as
it catches up: no idle timers, polling, subscriptions or remote calls. Failures
are advisory local status; the checkpoint reply never waits for checks. Disable
future work with `set-policy {integrationPreview:{auto:false}}`; saved source and
notices are retained. `peers` and pending status include one compact observation.

Checks marked `static:true` through `define-check` are the configured fast commands.
Without marked checks, the existing `package.json` scripts `typecheck` and `lint`
are selected when present, with npm lifecycle hooks disabled. Missing configuration
is reported as `not-configured`, never as a passing check. When `convex/schema.ts`
exists in a composed input, a built-in source-only TypeScript AST check rejects
duplicate literal index names on each `defineTable` chain (including search and
vector indexes). It never loads schema code or contacts Convex; computed names
and cross-file schema construction remain outside this static check. Commands run locally
with the normal clean check environment and private HOME/XDG/temp directories;
explicit check environment/credential passthrough still applies. Static commands
execute repository code with OS rights; disposable workspaces are not sandboxes.
No dependencies are installed and Forge makes no network requests. A pinned npm
lockfile requires matching, already prepared local package/lock bytes and
`node_modules`; those dependencies are copied into the disposable preview.

A failed combination is compared with main and each Lane alone on that same main.
Every pair of individually passing Lanes is then checked, reusing observations
within the preview. Each failing pair names both Lane/head pins and the first
check diagnostic lines. Text conflicts, failing main, individual failures, and
higher-order failures without a failing pair remain distinct observations.
The existing coordination journal retains an advisory notice for both participants;
local brief messages include the pinned diagnostics and peers surfaces the advice
while both saved heads remain current. Notices require no acknowledgement and never serve as acceptance evidence.

Landing does not run these previews: the hosted queue checks each Candidate itself, and preview
advice never substitutes for evidence.

A per-owner preview lock serializes execution. The disposable cache keys accepted
main, ordered Lane/head pins, static definitions and the clean runtime fingerprint.
An unchanged request returns its cached result and reconciles notices without
rerunning checks; a changed main, save or definition gets a new key. Cache entries
are advisory observations, not proof of current dependencies or external-input
health. The result names its exact inputs and duration; a concurrent save or main
advance does not silently change those pins. Workspaces and private dependency
copies are removed after each preview; saved source and Work remain unchanged.

### Hosted Intent and Lane start APIs

`projectHostedStart:start` atomically creates an Intent and Lane, or a sibling
Lane for one existing canonical hosted Intent. `createIntent` creates a planned
Intent without a Lane. Both take a project ID, original operation UUID, authority
epoch, expected main `{head, receiptId}` and an `intent` variant: `new` with outcome
and optional constraints, or `existing` with Intent UUID (`start` only). Results
are JSON validated by `hostedStartResultSchema`; an absent Lane is explicit null.
No filesystem path, owner listener, full Work document or Channel-history read is
involved. New canonical Intent headers preserve outcome, constraints, creator and
assignees, base receipt and status; existing portable Intent/planning formats are
unchanged.

Start reads `projectHostedChannels` by exact project/main identity. Its selection
is an explicit schema-2 main contract, independent of recovery or display
selection. The internal `projectHostedChannels:seed` boundary accepts already
validated bootstrap/cutover pins from a trusted caller under current owner and
server/shadow authority. It is insert-only, operation-reconciled, and cannot
rewind a later Channel selection. This is not a source validator, a public main
writer or a conversion of native projects; bootstrap/cutover integration and
later landing CAS publication remain separate slices. `current` returns this
explicit schema-2 selection under current reader authority. It does not change
the legacy `projectMain:current` generation read path. An unseeded server project
returns `SOURCE_UNAVAILABLE`; a mismatched authority returns
`SOURCE_AUTHORITY_CHANGED`, with no historical or native-head fallback.

The first successful start retains its IDs, time, original main pins and result
in `projectHostedOperations` in the same transaction as its resource records.
Authorized retries return that original result after later main/Lane movement or
authority changes, without writing it again. Changed payloads or expectations
return `WORK_OPERATION_CHANGED`. New stale main expectations, including the same
bytes with a different receipt, return `CHANNEL_CHANGED` atomically. Project
owner/contributor access is checked before retries. Starting siblings preserves
the existing creator/assignee authority rule for contributors; the project owner
can start any hosted Intent. Concurrent new or sibling starts write distinct
resource and operation rows and the Intent-scoped child revision used by
lifecycle cascades; they do not update the Intent record or global Work revision
merely to add a Lane.

`projectHostedLanes:head` returns the current head and record/source/lifecycle
versions. `detail` hydrates one current or exact historical canonical record.
`select` returns a schema-2 `HostedLaneSelection` with project/Lane/Intent IDs,
head, versions, lifecycle state, base State/main receipt and current authority;
it has no backup/generation dependency. Optional exact head/source/record version
expectations return `WORK_STALE` on movement instead of silently selecting newer
source. Selection is a read and does not move a Lane or main. `intent` reads one
canonical hosted Intent. `siblings` pages compact Lane IDs, versions and lifecycle
states through the parent index in 100-row/128-KiB transport windows. Continue its
cursor until `isDone`; no total sibling or project-history ceiling is imposed.
All reads recheck current project access, including historical records.

## Trusted remote source computation

The default fixed-code Convex source provider runs bounded Node actions over the
existing project object store. Durable progress lives in a job-scoped storage
blob, with one small CAS row holding the exact dispatch, execution, step and
cursor reference. Compressed immutable metadata sections are reused across steps;
queue advancement writes only the small cursor. A global completion-driven pool
limits independent child calculations to four computation slots, configurable
downward. Children persist exact outcomes; the last completion schedules the
join without polling. A small calculation set (at most 1 MiB of input blobs; a
round holds at most 100 requests) runs inside the step that found it instead of a
fan-out round, which would otherwise cost a fork, a join and a fresh step. The step
then re-runs the merge, once per round of a recursive merge. A round that needs a
blob this step created (a virtual-base merge result used as the next base) yields to
a fresh step, since that blob's object row exists only after the step commits. Inline
rounds of one step reuse the merge inputs an earlier round read (at most 4 MiB), and
a step reuses descriptors it already resolved instead of asking Convex again. Merges
read the merge base manifests (found from parents already verified) in the same wave
as the tips; a resolve reads its draft and first conflict page with the saved head;
compose merges from the tip manifests its graph step read. Native text calculations are journaled per path, while
final State assembly and source publication remain serial. Raw/recipe verification proceeds in windows of at most 100
objects or about 8 MiB. Recipe traversal and SHA-256 progress survive action
boundaries. Ancestry retains verified parent links; full file trees are read only
when the native merge needs them. Derived ancestry rows are prefetch hints, never
closure evidence. No temporary disk, repository execution, worker credential,
HTTP control ingress, idle poller or Workflow component is required.

A one-input fast-forward finishes its small result in the quantum that verifies
its tips and changed paths, even when those manifests consume the byte window;
there is no subsequent merge heap to initialize. New State and State-chunk writes
first confirm an existing project-scoped R2 key's exact checksum and size. A retry
or recompose reuses that binding without resending its body, including after a
lost PUT reply; new content retains the create-only PUT and publication checks.
This uses no additional Convex call. A new physical State/chunk costs one extra
R2 HEAD; an existing one costs a HEAD instead of PUT plus confirmation. Small
result/progress writes keep their existing path. Save, sync and compose remain
separate jobs; fusion has not met the peak-memory gate.

Source-operation reducers own publication for the internal Convex provider. See [trusted hosted source worker](operations/hosted-source-worker.md).

### Hosted Lane and Intent lifecycle APIs

`projectHostedLifecycle:transition` changes canonical server/shadow saved work
through an original operation UUID and exact record/source/lifecycle pins.
Abandon and reopen retain source, saves and acceptance history and never move
main. Known dirty client abandonment uses an explicit save-first child; unknown
disconnected drafts remain on that client and are never claimed saved. Reopen
requires no reason and changes only its selected target. Intent reopen retains
independent child lifecycle states.

Intent abandonment can cascade over active children. Bounded parent-index pages
stage private immutable Lane versions and events. Every canonical Lane writer
increments a separate Intent-scoped revision; new siblings, saves, completion or
reopen invalidate a staged selection. Final publication compares that revision,
the original Intent version, current authority and preparation identity, then
activates one marker with the Intent event and terminal receipt. It never reads
all children. A stale selection leaves every staged child invisible. Authoritative
current/version reads and sibling pages resolve the applied marker immediately;
bounded scheduled projection promotes these same versions into canonical head
indexes. A later writer promotes its selected visible version first, retaining
save and landed-head lifecycle CAS behavior. No project-wide revision, source
scan, cleanup, count ceiling or idle observer is introduced.

The project owner can pin a Lane (agent verb `pin`, `{laneId, pinned}` with `pinned`
defaulting to true; `projectHostedLanePin:setPin`). Pinning is one optional field on
the Lane record, so it adds no table or scheduler. A pinned Lane is skipped by
cleanup: `complete-merged`, `completeOnAccept`, Intent abandonment cascades, client
prune and cache GC. Completing or abandoning it directly fails with `LANE_PINNED`
until it is unpinned (`pinned:false`); reopen is allowed. Any Lane state can be pinned.

The thin `transitionHostedLane` helper retains its command, child UUID and exact
capture in its private client cache. H07 handles direct source transfers and
save reconciliation. The lifecycle parent can wait durably for that exact save;
terminal save publication and a parent wake commit together. Failed saves never
apply abandonment. Pending work sleeps until its save callback or explicit resume.
Working files and sparse scope stay intact, including newer local edits after
capture and lost replies. Only a matching baseline's metadata advances on replay.
Abandoning a Lane cancels its live landing submissions through the ordinary
idempotent cancellation path. Indexed, bounded pages follow that Lane's canonical
compose selections; continuations recheck authority and exclude submissions
beyond the queue sequence pinned when abandonment applies. Requests queued during
a pending save or cascade are included. Intent cascades start the same work from their existing
materialization pages. Standalone checks remain independent; the legacy lifecycle
receipt field `cancellation: not-requested` refers to standalone check cancellation.
An abandonment receipt does not claim the provider has already stopped.

Lifecycle plans, events and staged versions remain retained authoritative
metadata. Portable source-return/export folding and authority-cutover recovery
must include them with H14's acceptance ledger; they are not legacy owner Work
journal events. The hosted agent CLI and MCP route through these APIs;
UI controls remain a separate integration slice.

### Hosted Lane delta saves

The hosted save APIs retain one original operation and a separate small staging
record per save. Immutable linked delta pages are project objects; bounded staging
transactions validate their order, counts and committed blob/recipe pins. A
server-pinned input binds the exact baseline State, delta root, message and first
attempt time. Source construction defaults to the fixed Convex worker, using the
native State format and bounded, resumable changed-blob verification. One-window
raw saves run in the Convex runtime to avoid Node cold starts; larger/recipe
saves retain the resumable Node worker under the same execution and publication
fences. Dispatch is transactional and adds no Node action. Unchanged
paths are preserved from the verified baseline; no repository code runs.
The Node worker entries load their static import graph on every cold start, so
they reach no CLI hub (local workspace, records, checks, GitHub, network clients)
by static import; `tests/convex-source-worker-graph.test.mjs` enforces this.
A step's output writes (create-only, checksum-bound PUT and HEAD) run behind the
merge work after them, at most 8 at a time; digest checks and State generations stay
in upload order and the step waits for every write before it stages or commits.
Each step reports its run, R2 read/write and Convex call time with its commit, plus
the cursor phases it ran (`phase`, `from>to`), why it stopped (`stop`: `done`,
`fanout`, a `bytes`/`objects`/`time` budget, or another named yield) and how many
State manifests, other Forge JSON pages and file blobs it read; the execution's step
row keeps them (at most 16 entries) and a sync's or save's state carries them to the receipt's
`timing.server` split (dispatch, steps, publish, watch). Save receipts also split the client
side (`settle`, `capture`, `prepare`, `upload`, `submit`, `hostedWait`, `apply`); resolve nests
its save's split under `timing.save`.

A save commits the R2 objects of its changed blobs and its metadata pages in one
`commitBatch` round, after both uploads; the delta is acknowledged only after that commit.
When the server advertises `save-submit-page`, submit stages the last delta page itself, so a
one-page save makes no `stage` call. For a one-page raw save whose page is at most 128 KiB and
whose raw baseline is at most 4 MiB (the shape the V8 step runs), `begin` hands the step the
locations of its baseline State and its page beside the input, with the baseline's State
generation and parents as a descriptor resolve returns them, so all three download in
parallel and the changed blobs' descriptors resolve during the baseline read. A CLI from before
this one-commit round that retries a save the current CLI left between its PUTs and that commit
does not re-send the bytes, and its stages fail `SOURCE_UNAVAILABLE` until a current CLI retries.

When the server advertises `prepare-upload-targets`, a save whose changed files are each at most
2 MiB (at most 99 uploads with its pages) names its new blobs raw (`{object, recipe: null}`)
without a describe call and sends their pins and its pages' pins to `projectHostedSaves:prepare`
as `uploads`. That one transaction returns every upload target, the input's last, so the blobs,
pages and input go up in one PUT wave with no `prepareBatch` round. It refuses
`SAVE_CONTENT_RECIPE`, before any operation begins, when such a blob is stored only as a recipe;
the CLI then rebuilds that request the described way. A sync prepare called with `targets` returns
its input's target the same way.

When the server advertises `source-submit-run`, a save with no separate `stage` call, a sync and a
compose submit through one `projectSourceRun:submit` action. It runs the same HEAD-verifying
commit round on the caller's deferred uploads (at most 100; a larger save commits the rest first),
then the submit mutation, which also dispatches in the same transaction, then step 0 in the
action itself. Neither the dispatch nor the first step waits for the scheduler, and step budgets
are unchanged: a job that step 0 does not finish continues on scheduled steps. The dispatch
schedules a fallback step 30 s out, inside the 60 s worker lease. The step's commit cancels it
when it is still pending. A fallback that fires while the inline run may still be going (inside
the lease the submit opened) re-arms once to that lease's end instead of running the step a second
time; a fallback that does run the step renews the worker lease first, so its commit is not fenced. A transient failure of the inline step moves the retry to the normal
backoff, and an action that dies before its step leaves the fallback to run it. A save acknowledges
its delta only after the action returns, so a lost reply re-sends the same request and converges.
The commit round returns the uploads whose HEAD confirmed their checksum, and the small save step
does not download those again to hash them: the create-only checksum-bound PUT and that HEAD
already bind them, and every other read is still hash-verified. The caller may send the job input
text (at most 64 KiB) with the submit; the step reads it from memory only when its digest and size
equal the job's input pin. With `source-run-publish`, an action whose step published the job
replies `{terminal, state}` (the receipt and its server timing), so the CLI opens no progress wait.

When the server advertises `save-then-resolve`, a resolve's save request names the sync that
follows it (`then`: its operation id, authority epoch, lifecycle version and message); the CLI
retains `then` in its journal before the save and builds its own resolve request from that value.
When the save's step published inside `projectSourceRun:submit`, that action runs the chain at
once and adds it to its reply as `chain` (the resolve receipt, or `submitted` while the chained
step continues); the publication schedules `projectHostedResolveChain:run` only as a fallback 5 s
out, which the chain's prepare cancels. Any other publication schedules it at once. The chain builds the resolve request
from the save's own result with the same function the CLI uses, prepares it as the save's actor,
writes its input to R2 (checksum-bound PUT, then HEAD), submits with the dispatch inline and runs
the first step. `projectHostedSaves:progress` reports that sync as `chain`, so the CLI's one save
subscription receives the resolve receipt without a second round of calls. The CLI resolves
itself, replaying the identical idempotent request, when the chain records a failure before its
submit (`chainFailure`), or when 10 s pass after the save completed with no chained receipt.

A trusted source-job completion schedules the save finalizer independently of the
editing client. A save, sync or compose step whose result manifest is at most 64 KiB publishes
it inside its terminal commit, in the same transaction and with the same publish function, which
checks it against the job's signed output digest; a publication refusal rolls the commit back and
the step settles as failed. Any other result goes through the finalizing action, which reads it
back from storage. One publication transaction verifies the original job/input/output and
committed State, compares Lane source/record/lifecycle versions, appends the save,
updates that Lane and retains the terminal operation receipt. A stale attempt
retains its original delta and failure receipt. Registered States are immutable
source evidence for later compose/sync; they confer no main or landing authority.
Neither staging nor final publication loads retained Work or Channel history.
See the [save API](operations/source-exchange.md#hosted-lane-save-api) for transfer,
retry and provisioning boundaries.

### Hosted composition and Candidates

`projectHostedCompose` prepares an original operation against the authoritative
main head **and receipt**, then stages hash-linked ordered input and dependency
pages. Each transport window contains at most 100 selections or 128 KiB; there
is no total Lane/history ceiling. Staging checks exact Lane record, source and
lifecycle versions and Intent membership, or an exact clean dependency Candidate,
and verifies committed, registered State bindings. A project object's presence
alone does not establish source validation or ancestry. Page receipts and indexed
selection identities make retries idempotent and reject duplicate Lane selections. Repeated dependency pins retain native semantics.

`projectHostedComposeJobs:submit` pins the original plan, timestamp, implementation
and configured fixed worker/runtime through the source-job owner. Dependencies
compose before Lane inputs, in their declared order, starting at the pinned main.
The worker calls `NativeSource.compose`, including its existing recursive merge
bases and text/binary/mode/symlink/delete/path conflict semantics. Its disk-backed
reader obtains job-authorized descriptors and fetches only missing State metadata
and blobs actually read by the native reducer. Ancestry comes from verified State
bytes, never client display flags. Native merge still holds manifests and the
blobs needed for text merging in memory; this is not a constant-memory guarantee.

Composition also parses every JS/TS (`.js .mjs .cjs .ts .mts .cts .tsx .jsx`),
Python (`.py .pyi`), Java, Rust and JSON file
that two inputs both changed and the line merge combined. A line merge cannot see
that two clean edits declare `root` twice or unbalance a brace, and the composed
file would only fail later in a check. JS/TS uses the TypeScript parser and
binder already in the dependencies, plus an import/declaration redeclaration test
the binder leaves to its type checker. Python, Java and Rust use the Lezer parsers
already in the dependencies (the first error node), and Python also requires the
statements of one block to share one indentation, deeper than the line that opens
it. JSON uses `JSON.parse`. All of it is source only: nothing is imported,
evaluated or run. Type errors and unresolved modules are not syntax and are not
reported.
If the composed file fails while the left and right versions each parse, that path
is a normal composition conflict whose retained page entry has the exact side
variants and a reason `composed FILE:LINE:COL does not parse although each side
does: MESSAGE`; the receipt's recovery advice shows `reasons`. It stops merging at
that pair like a text conflict, before any check is dispatched. A file that
already fails on one side, a file over 256 KiB, any other language (Go, YAML and
TOML have no parser in the dependencies) and any parser fault are never blocked;
the check still sees them. Each parser loads on first use for its language only. Both the journaled hosted path (inside the byte calculation) and the
fixed worker (after the synchronous merge, by rerunning with the file blocked)
return identical pages. Sync and local composition do not run this check.

A signed result publishes one immutable Candidate and original operation receipt.
Clean results register their State. Conflict results reference linked conflict
pages with exact left/right States and per-path base/left/right variants; the
retained side States preserve all recursive-base alternatives. As in local
composition, the first conflicting pair stops merging; the Candidate retains the
entire ordered selection, including its remaining suffix. No Lane or main moves,
no check runs, and source registration grants no landing permission.

Lane pins are validated when their selection page is staged. Later saves do not
change those immutable inputs: an older Candidate remains explicitly bound to
its original Lane versions and base receipt. A fresh stale selection fails with
`WORK_STALE`; stale main preparation fails with `CHANNEL_CHANGED`, including ABA
receipt changes. The final publication reads only the operation, small staged
plan, exact signed job result, committed output and Candidate/State records. It
does not hydrate input pages, all Lane heads, Channel history or Work. Landing
must independently validate its current main and policy/evidence pins.

### Hosted explicit sync and resolution Lanes

`projectHostedSync:prepare` pins one explicit source operation: a saved Lane plus
an exact main head/receipt or clean Candidate, an immutable conflict Candidate
plus its conflict root, or completion of a pending resolution Lane. Progress
returns the original worker plan; `projectHostedSyncJobs:submit` dispatches the
existing fixed source worker once under the retained job identity. There is no
recurring sync, idle worker, owner listener or browser lifetime dependency.

The sync worker uses native right-first sync composition and `conflictPlan`.
A Lane sync onto main, and every hosted compose, whose only conflicts are
Markdown docs or main's declared `forge.json` merge lists applies native
finish's docs or list rule and records it (see
[Markdown conflict resolution](agents/workflow.md#markdown-conflict-resolution-on-finish)).
Only missing State metadata and blobs read by the merge are fetched. A clean
sync registers its exact State and CAS-updates its original Lane. A conflict
retains the original Lane and creates an isolated resolution sibling, with the
exact left/right States, conflict root and draft head. Starting a resolution
from an older Candidate never substitutes newer Lane saves or current main.
Drafts keep the left parent and local conflict markers (binary/path conflicts
keep the Lane side); they do not claim the right input as a resolved ancestor.

Resolution source saves use the existing H07 delta API. An explicit `resolve`
operation validates descent from that draft, applies the local text-marker
rule, and records a two-parent State and `resolved` receipt on a final Lane CAS.
This is a source API phase that callers can drive as part of their resolution
flow, not a new person-review requirement. Pending resolution Lanes cannot be
submitted as completed composition inputs. To compose after resolving, first compose the
resolved Lane alone with empty dependencies to obtain a clean resolution Candidate.
Prepend that Candidate to the original ordered dependencies, then retain the
original ordered Lane inputs and unmerged suffix at explicitly observed heads.
This also handles conflicts reached during dependency composition, which runs
before Lane inputs. Native ancestry preserves later disjoint saves and surfaces
new overlap as a new conflict. Main never moves.

Original operation receipts survive retries and later source/authority changes
after current access checks. A concurrent save on the target Lane retains a
terminal `WORK_STALE` result and the newer Lane; another Lane's save does not
invalidate the operation. Finalization reads constant-size canonical metadata
and only the small signed result manifest, without Work/Channel history or
repository bytes in the action. Draft/resolved States remain source evidence,
not check or landing permission.

`applyHostedSync` uses the checkout's exact result pins and an added previous
client-baseline guard under its cache lock. It preserves sparse scope and uses
verified cached unchanged blobs. Dirty contents, deletions, modes, links and
untracked obstructions, including changes during transfer, retain the old marker
and files. Interrupted original-operation retries cannot replace a newer client
marker, and completed retries never reinstall over later edits. Untracked artifacts excluded by the project's layered `.gitignore`/`.forgeignore`
rules or Forge's source exclusions survive installation in place, including
external dependency links. The source baseline and incoming manifest take
precedence over exclusions: changed saved bytes/modes and incoming path or parent
collisions remain structured conflicts. Matching untracked incoming source is
safe to install. Ignored directories without source intersections are pruned;
link targets and ignored output bytes are never scanned. The clean check skips
reading saved files whose exact lstat the checkout stat index vouches for. Like
Git's index, an entry whose file changed within the racy window before it was
indexed (a fresh install or save) is re-read until a complete clean check, or the
dirty check of a command working in that Lane, sees it safely older than the pass
start and rewrites the index with that start; every rewritten entry was observed
after it, and a file written inside the window stays racy. The window is measured
against both the client clock and the index file's own mtime (the filesystem
clock). Housekeeping probes never write the index.

When the checkout already has a trusted installed marker, apply is in place and
proportional to changed paths: only paths whose bytes or mode differ are fetched,
verified, staged privately and flushed. A durable `delta-apply.json` journal names
the stage, the paths to move aside (with their verified baseline), the paths to
install, and the digests of the marker it replaces and the marker it publishes.
Every command that trusts the marker (open, sync, resolve, save, abandon with
`keepPatch`, preflight, rebase, lifecycle changes and save receipts) first finishes
an interrupted journal under the work lock; the dirty check reports a pending
journal as dirty and status reports it. Finishing rolls forward only while the
root marker is the one the journal replaces and its stage is whole; when the
target marker is already published only bookkeeping remains. A missing stage rolls
back: installed paths are removed only while they hold exactly the incoming bytes,
and moved-aside bytes return. A local edit found before anything was installed
also rolls back and refuses, from any command; a recorded rollback resumes as one.
A marker changed by anything else, a parent replaced by a link or a file, or a
filesystem error refuses with a `delta-apply-pending` obstruction naming the path
and keeps the journal; explicit `recover-apply` moves its moved-aside bytes into the
kept-apply folder with the changed files. A journal from a newer client asks for an upgrade. Bytes
moved aside after installing began (an edit or a recreated incoming path) are kept,
listed in `displacedRecovery` with a `warning`, and refuse a save once. Every
parent directory the journal touched is flushed before the marker is published,
and kept folders before the journal is removed; the stage and verified backup are
removed before the journal, so the journal is the last record to go. Unchanged files keep their inodes,
ignored output stays where it is, and emptied directories are removed. Without a
trusted marker, when a path changes between file and directory, or when an incoming
path or parent differs from an installed one only by case or Unicode
normalization, a Lane checkout builds and swaps the whole private stage (a Lane is a
Forge-managed directory; the clone root applies these in place, above). An untracked
file or folder at an incoming path or parent refuses with an `extra-source`
obstruction before any object is fetched or staged; day-old stages no
journal names are swept. A local artifact-path
journal precedes that directory swap. Artifacts move from the retained previous
checkout only after publication, and original-operation replay resumes those
renames without overwriting an occupied destination. Main checkout uses the same
validation and preservation functions and, for a pull, the same delta journal. Server source
publication and optional local installation have separate outcomes.

### Hosted check definitions and provider evidence

`projectHostedCheckDefinitions` writes versioned check definitions and the selected
remote runner configuration with original-operation reconciliation and expected
definition/configuration pins. Definitions use the local command normalization
and definition digest; import preserves the original check UUID, timestamp and
command. Project check settings use owner authority; contributors can request
checks under current project access. Configuration contains a Mac machine identity or a
GitHub Actions repository, App installation and selected `runsOn` label, exact
runtime/environment fingerprints and a credential-use reference, never account
credential values or a local credential file. These APIs do not configure a live
provider.

`projectHostedChecks:enqueue` freezes one clean canonical Candidate, its registered
State, input/dependency roots, base receipt, definition, runner configuration and
environment under the original operation and authority epoch. Retries retain its
run UUID and dispatch key. Later saves, main movement or definition/configuration
changes cannot replace those pins. Fresh stale selections fail. A later passing
run remains historical when its definition or runtime configuration changes;
landing must use current exact evidence, not a display verdict.

Internal plan preparation binds the exact source, definition, runtime, lockfile,
selection reference and immutable shard-plan manifest before dispatch. The
provider-neutral controller performs at most two lookups and one submission per
tick, retaining dispatch intent first. Ambiguous outcomes remain unknown. Like
source jobs, one recovery needs two distinct authoritative empty lookup receipts
under the current control lease, the last immediately before reservation. It
reuses the original key and plan; adapters must deduplicate it. A rejected recovery
does not prove that the original ambiguous execution never started. Controller
takeover fences old responses without replacing an accepted provider execution.

Only an internal trusted collector callback can supply provider result evidence.
Its domain-separated HMAC binds project/run/operation, epoch/fence, provider and
execution, exact source/definition/configuration/environment, runtime, plan,
lockfile and selection. The key comes from backend configuration and must stay
outside project-code processes. Source-worker signatures and owner-uploaded
display claims are not check evidence. Current project/actor authority and epoch
are checked even for callback duplicates. Every shard execution/attempt retains
its callback receipt; current shard metadata is paged separately from the compact
run record. Terminal results cannot be rewritten.

An overall provider success cannot pass a run until every selected shard has
settled successfully with exit zero. Missing, running or failed shard evidence
leaves that success unresolved under the same run. Failed, cancelled,
interrupted, runner-unavailable and unknown outcomes remain distinct. Every reader
names a stored status through `src/check-run-state.ts` (a foundation check refuses
new hand lists): runner-unavailable and runner-budget-exhausted read `Not run`
(the code was not judged), and stored `unknown` resolves from the recorded facts to
one of four states: `dispatch-unconfirmed` (dispatch reply lost),
`dispatch-refused` (the provider refused or rate-limited it), `recovery-unconfirmed`
(the controller could not confirm after recovery) and `shards-unconfirmed` (a pass
before every shard reported), each with its own "can't confirm" next step. Cancellation
makes an unneeded check locally terminal before or after dispatch reservation and
refuses late evidence. Live landing consumers preserve their shared check. The
provider-stop request is separate; local cancellation never claims remote compute
has already stopped.
For the direct GitHub App path, a workflow failure without authenticated failed
shard or test-report evidence is `runner-unavailable`, including bootstrap/OIDC
failures before a plan exists. It never proves a Candidate failed. Job-side IO
uses bounded transient retries with unchanged success-path call counts; see
[Actions infrastructure recovery](operations/github-actions-checks.md#convex-dispatch-with-the-github-app).
Cost starts unknown and only signed provider usage supplies observations. New
stdout/artifact bytes never enter these Convex APIs; only object references do.

`projectHostedCheckRead` reads one run in constant time and pages definitions,
Candidate runs and shard metadata through indexes. The shared
`requireHostedCheckEvidence` helper rechecks current definitions/configuration and
exact passing provider evidence inside the caller's transaction. It does not move
main, implement landing policy or require checks for person-selected acceptance.
Live provider dispatch, credential use, callback ingress and
check-output transfer remain adapter work; the contracts are exercised with local
fake providers. See the
[check API](operations/source-exchange.md#hosted-check-api).

Mac runs use the same signed shard and terminal callbacks through the pull-based
`projectHostedCheckWorker`. Forge's own Mac check worker stopped on 2026-10-29, so
its checks run on GitHub Actions; this path remains in code. Completion retains `macEvidence`: machine ID, machine
owner, registration session, runner fingerprint (runtime plus environment), and
`reuseKey`. The reuse key is explicitly null until Q3 supplies the hosted content
key; it is not evidence reuse permission. Final acceptance copies this receipt.
The runner installs the checkout in slices of about 25 ms of work between event-loop turns,
so the 20 s lease heartbeat and the 60 s local deadline run during a 62k-file install, and a
lost lease stops the install at its next file. The install skips the per-file fsync: the
private root is removed after the run and rebuilt after any crash.

The single server-side sufficiency rule in `requireHostedCheckEvidence` allows Mac
evidence for owner-controlled work under trusted/autonomous acceptance, including
custom policies retaining `auto-on-pass`. The machine owner, check requester,
Candidate creator and accepting account must match the project owner. Candidate
creator provenance is written by the canonical record writer, independent of the
account requesting its check. Missing creator provenance, supervised projects and
outside contributors require hosted-runner evidence (`HOSTED_RUNNER_REQUIRED`).
GitHub Actions retains its existing sufficiency rules, and unchecked
person review remains available.

`projectHostedCheckMachines:revoke` is an idempotent project-owner mutation with
`operationId`, `authorityEpoch` and `machineId`. Revocation is checked against the
current registration on work, control, heartbeat, callback and acceptance; rejected
evidence returns `MAC_MACHINE_REVOKED` naming the machine. A new registration
session cannot clear revocation. Already committed acceptances retain their original
receipts. These decisions use indexed reads in existing transactions, with no new
polling, timers or paid provider calls.

### Hosted check output and artifact manifests

`projectHostedOutputApi` is an internal, provider-neutral collection boundary.
Its domain-separated signed messages bind the original run/operation, authority
epoch, controller fence, provider execution, source head and immutable plan.
`projectHostedOutputBatch` prepares and commits up to 100 signed records in one
window. The collector retains at most 32 chunks/2 MiB before publication and may
include the stream seal in that window; live input flushes keep their existing
visibility. Each chunk keeps its ordered revision and duplicate receipt. Batch replays also
return the current aggregate root, including after a lost seal acknowledgement. Authority
is checked once per transaction window, every message signature/pin is validated,
and the apply transaction repeats those checks after external storage HEADs.
`prepare` signs a create-only checksum/length-bound R2 PUT in a separate check
namespace. `commit` verifies storage with HEAD and rechecks current project,
actor and run authority in the publication transaction. No new stdout/artifact
byte body crosses Convex. Missing storage, corrupt checksums and unavailable
verification remain explicit retryable outcomes, with no storage/provider fallback.

The fixed collector redacts configured credentials and private roots before
retaining or uploading bytes, including matches crossing input/chunk boundaries.
It also masks common credential syntax and other absolute paths; binary artifact
bytes remain unchanged outside redaction matches. Redaction cannot discover every
unknown or encoded credential. Collector signing authority stays outside project
commands. The collector batches output, applies storage backpressure and retains
exact redacted chunks through an injected durable spool before publication.
Provider adapters own that spool and reconnect/replay of original bytes and pins.
They must preserve redaction settings and chunk size when recollecting a stream.

Each stream pins shard, attempt, execution, stdout/stderr/artifact kind and a
redacted portable name. The collector retains an opaque original-descriptor digest
so distinct artifact names cannot collapse after redaction. Sequence, byte offset and content digest make duplicate
chunks idempotent. Out-of-order chunks remain readable, gaps remain recoverable,
and adjacent offsets are checked on insertion. A stream seal requires every
sequence and byte; an immutable final root requires a terminal check, all streams
sealed and exact current counters/hash-chain. Trusted final collection attests
that its declared streams exhaust output; a provider status alone does not.
Incomplete collection never claims completeness. Terminal check evidence and
output retention remain separate, and neither changes landing policy.

`projectHostedOutputRead` exposes constant-size status/completeness and paged
stream/chunk indexes. Chunk readers resume a numeric commit revision; stream
sequence is separate so late arrivals cannot disappear behind a sequence cursor.
Fresh signing rechecks current read access; `downloads` signs up to 100 exact
committed chunk/root selections in one authorized window. Downloads go directly to R2 and the
portable reader verifies chunk digests, offsets, sequence and full sealed-stream
hash without a whole-log server read. Existing five-minute signed GET expiry
still bounds already-issued URL access after revocation. Reads create no timers,
scheduled work or URL refresh loops. UI adapters use the existing idle gate.
These APIs and transfers are covered with local fake runners/R2; no live adapter,
UI, deployment, retention policy or account provisioning is supplied here.

The hosted Actions adapter runs fixed export/control code outside Convex.
`exportHostedActions` reads the exact pinned State, recipe and selection through
the hash-verifying source-worker reader. Export deduplicates file digests before
requesting windows of at most 100 descriptors and direct read grants through
`projectHostedActionsReadBatch`. Each window rechecks current actor, epoch,
exact run/mapping and live worker lease. Grants are consumed within that window;
verified byte files never authorize another window. Recipe leaves retain their
exact-pin grant checks. It builds bare Git objects from streamed
storage objects, preserving binary bytes, modes and symlink targets without a
checkout, filters, hooks or project execution. The existing generated Actions
workflow honors the selected `runsOn` label (`ubuntu-latest` by default; Blacksmith
labels are still accepted but unused since 2026-10-25). The native State
and harness export commit remain distinct pins. The immutable export bundle is
retained in project object storage before publication of `forge-check/<runId>`.

`projectHostedActionsExports` retains State, configuration, plan, export bundle,
commit, dispatch intent and adopted Actions run. Indexed, fenced control calls
never download source or scan retained Work/history. Lost export/control replies
reuse the saved bundle; a crash before that receipt rebuilds a deterministic
commit/bundle. A lost ref-publication reply reconciles the exact run-owned ref.
Publication and deletion use an exact lease, preserving any changed branch.
The App installation token is supplied privately by the existing credential-use
reference; this adapter registers no App and uses neither `gh` nor owner Git.

Short provider ticks split export, publication and dispatch/lookup. Like the local
Actions path, HTTP 400 is ambiguous. Accepted dispatches are only adopted, never
redelivered. An ambiguous dispatch gets twelve spaced complete branch lookups,
then one fresh empty lookup immediately before its single recovery dispatch.
Nonmatching runs, incomplete lookups and transport errors do not establish an
empty branch. This hosted adapter retains that recovery allowance. The native
owner [retains one bounded discovery window across restarts](operations/github-actions-checks.md)
and ends exhaustion with an infrastructure outcome without redispatch; GitHub offers no atomic idempotency key, so an empty listing
cannot prove non-execution.
Multiple exact matches surface an evidence error. No global project scan runs.
The retained mapping survives terminal-result branch cleanup. Targeted,
generation-fenced wakes target only an adopted run. Existing authenticated provider
callbacks record progress directly and wake terminal branch cleanup; cancellation
also wakes the retained run. One coalesced five-minute fallback deadline reconciles
lost callbacks and defers while real callbacks continue. Before controller HTTP it
retains a takeover deadline for lost replies. The fallback backs off with quiet time (at most hourly) and stops after a day without callbacks; a terminal callback or cancellation re-arms it. Finished cleanup stops scheduling;
no project/history scan or 10–60 second active-run poll is created. Exact State/export/run/job checks precede stable
signed H10 shard and terminal callbacks. Cancellation retains its request until
provider completion. Stuck jobs reuse the local complete-log plus run-conclusion
rule; provider logs alone never claim live output.

The fixed runner supervisor projects command pipes into compact machine test reports and bounded failure excerpts before H12 retention; full CI-provider logs stay with the provider. Local Mac pipes stay in private machine log directories for at most seven days, with raw hosted upload only by explicit opt-in and finite retention. The supervisor atomically
retains redacted chunks/seals in a private durable spool before publication.
Reconnect replays exact records without rerunning commands. Missing seals remain
incomplete; final H12 retention is separate from H10 verdict authority. Existing
Check-panel readers consume that same output protocol. Live fixed-controller,
runner-bootstrap and H12 ingress provisioning remains a lead deployment operation;
the generated workflow command must run under that trusted supervisor. These
modules do not install or deploy those services or register an App.

### Hosted landing request queue

Agent finish/land can register `projectHostedLandingDesired:submit` while its
staged source job is still composing. This desired goal retains the original
operation, check settings and stable submission handle before the requester exits.
A fenced scheduler/watchdog advances the completed source job into the ordinary
landing queue, or records its structured terminal failure. Source publication
wakes the goal transactionally. Duplicate saved input/dependency selections reuse
the canonical handle through operation aliases; current access is checked on every
observation. `projectHostedFinishObserve:page` returns preparing, queued and terminal
versions through the same selected-operation read without scheduling work.

Capsule-capable reads declare `capsuleProtocol: 1` on the five landing-history
queries. A selected capsule returns a content-pin marker and current redacted
context. `projectLandingCapsuleRead:history` calls the same authorized query before
and after its private R2 read, verifies the complete compressed object and each
table digest, then reconstructs the ordinary reply and applies current public
identity mapping. The CLI negotiates `landing-capsules-v1` on its existing
capability read; browser reads negotiate only after the existing
`CLI_UPGRADE_REQUIRED` history error. An old-protocol history request that needs a
capsule receives that error; uncapsuled reads and past-end current-state probes
retain their existing calls. Attempt ordinal cursors remain stable across
relocation.

The writer is gated by the default-off server setting `FORGE_LANDING_CAPSULES=1`.
Readers must be deployed before enabling it. A terminal transition schedules one
wake at settlement plus seven days; mutable acceptance completion or shared checks
retain an event-driven waiter, not a poll. Existing completion/expiry events wake
those waiters. A bounded, resumable project bootstrap indexes compose identities
and original attempt creation times once. New writes maintain those fields in their
existing transaction, adding no hot-path function call.

The internal Node action captures canonical row strings in bounded pages, gzip
encodes one complete content-addressed object, reconciles an unknown write by its
content pin, and verifies a complete GET plus all table digests before publishing.
The pointer and original transaction pins live outside the request document in
`projectFinishReadRows`, so adding metadata cannot overflow a formerly valid
request. Oversized policy pins continue automatically through internal storage
pages. Publication removes its first verified page atomically; later pages commit
their original offset and return it on replay. A changed captured row is retained
with `WORK_STALE`. No history object or reuse alias is deleted.

Canonical acceptance receipts and compose selections stay. Compact exact accepted
Lane/state ledgers, frozen plan/attempt pins, original metric timestamps/scalars,
landing evidence and callback/compose replay digests stay readable by transactions.
Receipt leaves split automatically when their storage page fills. Shared run,
project, Channel and queue projections remain transactional; they are never packed.
Future expiry receipts reuse the compact owner ledger, retaining their original
request and numeric result rather than recreating global cleanup rows.

Recovery preparation and every page bind a capsule revision in addition to their
existing source/Work/Channel pins. Publishing a capsule advances that revision,
fencing an export already in progress. Published capsules own their whole logical
corpus throughout resumable physical removal: live pages exclude those copies and
then enumerate verified server-side capsule pages. The action rechecks owner and
exact pins after R2 IO, applies the ordinary identity mapping and returns the same
row shape. Raw per-table hashes are checked before redaction. No client sees the
compressed object, a storage grant or private transaction metadata. Old clients
receive `CLI_UPGRADE_REQUIRED` when the selected recovery needs capsules.

`projectHostedLanding:enqueue` records a durable submission, immutable first attempt,
original H01 operation and coalesced Channel wake in one transaction. The request
selects an exact canonical Candidate/head (or a retained conflict), main head and
receipt, authority epoch and optional exact check run or check request. Actor kind
comes from the existing account/device acceptance boundary. The check-request
variant calls the same H10 enqueue transaction, retaining one child operation and
run before any provider I/O. This API does not require a check for person requests
or publish source.

Requests and attempts have their own indexed tables, separate from Work/display
projections. An attempt freezes canonical Candidate digest/input/dependency roots,
main receipt, actor, current policy snapshot/digest, exact check identity and child
operations. Progress updates never replace those pins. A later agent rebase can
append a named child attempt; the original request and all earlier attempts remain.
A person request cannot silently become approval of another Candidate. The shared
`landing-submission-state` module is extracted from the S01 submission contract;
queued/checking observations are pending, conflicts and check/infrastructure failures
retain their causes, and ready remains pending until an actual landing receipt.

The finite internal driver makes two short metadata transactions: claim, then
advance. Claim also schedules a lease-recovery wake. A stopped driver therefore
recovers the same attempt and run with a higher fencing token. Lease expiry grants
reconciliation only; lease expiry alone never repeats provider work or allocates a
replacement run. A terminal infrastructure check uses the existing two-retry batch
budget for standalone landings too: each retry retains the exact Candidate and
request pins, creates a fresh check operation/run, and appends a parent-linked
attempt with `platformRetries`. Earlier runs remain immutable. Exhaustion settles
as an infrastructure `CHECK_NOT_PASSED`; a genuine failed check still settles as
`CHECK_FAILED`. Driver replies and scheduler deliveries are safe to repeat. Enqueue retries
can repair a failed wake by inspecting its durable scheduler receipt. There is no
empty-queue poller, browser heartbeat or recurring check observation.

Only runnable requests enter selection. Indexed priority-class heads select urgent
owner requests before normal requests; shared native ordering supplies arrival
order and within-class fairness for batch selection and queue positions. Missing
legacy priority means normal. Owner reprioritisation patches one queued submission
without a wake or poller. Eligible hosted automatic-accept projects group by
default (`acceptance.landing: "serial"` opts out). Up to six groups check at once
(`checks.concurrency` overrides), each on its predecessor's pinned head and final
receipt. Publication retains exact-source evidence and queue order; a failed or
changed predecessor invalidates only its dependent stack. An owner-held submission leaves
the predicted chain immediately and releases its reservation. Its followers recompose on
current main; a full passed check carries only when every file path, blob and mode
is identical, under the existing reuse policy and main-audit gates. Approval later
recomposes the held submission on then-current main. Unstarted batches yield
to urgent work before reserving
a check; reserved checks continue. Admission runs (`acceptance.admissionCheck`; the default `"full"` is the
[pre-queue Lane check](pre-queue-checks.md) on any runner, `false` opts out) hold no
queue order while they run. A strict, disjoint unplaceable global-risk follower
can use a compatible pending full admission as the first exact predicted-head
predecessor instead of running a solo admission that would need a combined recheck.
One indexed admitting head and bounded train metadata select this route; unchanged
head/receipt pins survive admission settlement, while refused or changed generations
cannot supply a predecessor. Publication and invalidation use the existing train
fences. Independent, overlapping, placed-manifest, fast-mode and unknown-evidence
arrivals retain ordinary admission. Admissions wake their request only on a terminal
run write, and size and split cohorts as
described in [hosted queue priority](operations/landing-batches.md#hosted-queue-priority). A retained train with no member checking holds
later deferred entries for at most `HOSTED_TRAIN_HOLD_MS` after its newest compose;
then selection drops it, with one scheduled queue wake for the hold's end. See [hosted queue priority](operations/landing-batches.md#hosted-queue-priority). Checking,
ready and terminal records remain readable without hiding later independent work.
H10 run updates transactionally schedule one coalesced check wake; bounded metadata
pages reactivate its waiters and wake their Channel. The current run binding owns
completion across both queued and checking phases. Per-run event versions and an
indexed last-delivered version on each waiter consume at most 100 requests per
page without changing queue phase; legacy rows join on their next event. An event
arriving between pages advances the same fanout, including waiters that already
consumed earlier progress. A replacement run resets delivery identity. Shared and
solo evaluators retain nonterminal progress and restore checking atomically, so
progress keeps speculative slots available without granting publication authority.
Fan-out automatically continues
below document/byte windows, with no total request/history ceiling. A complete
passing run is revalidated with `requireHostedCheckEvidence`; an overall success
without complete shard evidence remains checking. Unexpected failures abort the
step with its recovery wake intact; structured request failures retain an outcome
and let later work proceed. Idle checking/ready/terminal queues schedule no work.

H13 stops at `ready`. It never moves a Channel, selects a snapshot, issues an
acceptance receipt or completes a Lane/Intent. H14 uses `claimReadyLanding` and
`requireLandingLease` in its constant-size final transaction, independently rechecks
current authority, main head **and receipt**, policy and exact check evidence, then
records its canonical receipt and request settlement together. The queue lease and
policy snapshot do not grant acceptance. Large included-Lane/projection work stays
outside that boundary. See the [landing queue API](operations/source-exchange.md#hosted-landing-queue-api).

Landing cancellation is its own idempotent operation over one request. Its
transaction checks the exact acceptance receipt before settling a pending request
as rejected, releases only its queue claim and invalidates pending finish IO.
Acceptance and cancellation read/write the same request and queue, so concurrent
publication resolves through OCC and the actual receipt. A committed acceptance
is preserved; late source/check results cannot revive a cancelled request.
Cancellation leaves Lane lifecycle and source execution independent. It releases
an unneeded check atomically after its last queued/checking/ready submission leaves,
including superseded attempts. Live batch peers keep their shared check running
when an individual landing is cancelled. An explicit check-run cancellation stops
the selected run, including a run shared by live landings.
Direct Actions cancellation schedules the provider run-cancel API; restored jobs
make one signed read-only preflight query before spawn, with no new heartbeat.

A pending entry with no progress for 15 minutes records a `LANDING_STALLED` observation
(`src/landing-stall.ts`). For a queued entry the alarm also arms one drop deadline 60
minutes after the last progress (`LANDING_DROP_MS`, `convex/projectHostedLandingStall.ts`); entries
waiting for review or a dependency are exempt. At the deadline Forge re-drives the
entry, and a batch stuck composing splits into halves. If that makes no progress and
nothing live will drive the entry (the queue, its own pending attempt, an active
batch or a batch peer), it is ended through the cancellation path with a stated
reason: nothing lands, the operation is settled, the queue claim is released and
batch peers are re-selected. If something live still drives it, the deadline re-arms
at 2, 4, 8 and 16 hours and then stops; live work is never ended. Finish the same
Lane again to retry. See [landing workflow](agents/workflow.md).

A scheduled landing step that throws (a refused write during a storage pause, OCC
exhaustion) is not retried by Convex, so lost steps are re-driven by events, never by
a poll (`convex/projectHostedLandingRedrive.ts`): the end of a storage pause window,
the first write after it expires, one task armed at its expiry, and a waiting reader
whose Ready entry stays quiet for 2 minutes. That reader's ask also follows the
entry's order wait to each older holder (at most 8) and replays their lost steps, so
a holder that lost every driver cannot strand the entries parked behind it.

### Hosted final acceptance

`projectHostedAcceptance` consumes H13's prepared attempts. Preparation stages the
Candidate's hash-bound ordered input/dependency metadata in transport pages, retaining
the original accept operation UUID. No Lane or Channel changes during staging.
The final transaction independently validates the live queue fence, server authority
and epoch, main head and receipt, canonical clean Candidate/registered source,
current policy digest and exact passing run/definition/configuration/environment.
A same-source new receipt still invalidates the old attempt. Server-shadow prepares
source but cannot publish a competing main.

Publication atomically writes the immutable acceptance, journal event, selected
source-snapshot delta, main CAS, landed request/original operation settlement and
queue release. The receipt retains input/dependency roots, previous head/receipt,
actor, policy, exact run and terminal evidence, authority epoch and attempt. It also
retains the supplied landing message by value; the first shared-cohort receipt
retains the ordered member messages for their one mirrored commit. These bounded
fields travel through existing records and calls (see [mirror messages](workflows.md#automatic-main-mirror)). Automatic
acceptance records its revert target; compensation remains the ordinary revert
path. Original authorized retries return that receipt after later main/policy/epoch
changes without repeating publication. H15 owns named recomposition/recheck on races;
H14 never substitutes another Candidate or transfers old check evidence.

The accepted receipt activates the staged landed-head completion ledger. Canonical
Lane status is materialized in finite scheduled transactions of at most twenty
entries, with retained page/entry progress. Each write compares the exact saved
record/source/lifecycle versions and head; saves or reopen events before or after
publication remain active. Intent/sibling completion, source cleanup and deletion
are not performed. The receipt and its input pages are authoritative acceptance
and completion evidence while Lane status materialization is pending. Failed
materialization can resume from the retained receipt; completed work schedules
nothing. Recovery/export folding of these snapshot deltas remains H21 work.

Owners can explicitly accept clean unchecked Candidates. Agents and public-project
contributors need an exact passing run and current autonomy permission. Trusted
compose results retain exact changed paths and server-derived owner-only input
provenance. Public contributor changes to protected paths wait for explicit owner
approval at final publication; missing legacy coverage cannot bypass that gate.
Review waits schedule no idle work. See [public governance](operations/governance.md)
for defaults, policy edits, version skew and the owner acceptance API. The API is
exercised with local metadata/provider/source-worker fakes.

### Finish observation read model

`projectHostedFinishObserve:page` reads selected `projectFinishReadRows`
projections maintained inside the source mutation. `server` wraps public
and internal mutations; `cliServer` retains its existing authentication guard.
The build rejects raw mutation registrations that could bypass projection upkeep.
A projection is replaced only when its selected fields change. Work revisions,
request bookkeeping, attempt progress, check output, finish restore bases and
controller fence changes therefore do not invalidate a waiting observer.

The selected request is read once. Finish pending state and predecessor ownership
use separate rows, so a selected finish's private wake is not progress. Queue-ahead
reads select Candidate head/input pins, check status and the current main head.
History remains an exact, at-most-twenty-version page, and the queue directory
remains one bounded page with at most eight queue-ahead entries. Reads do not grow
with retained landing history. Current access, authority changes, scheduled-owner
state, queue advice, progress and acceptance retain their existing dependencies.
New journal entries retain the public pending-attempt projection; private
precompose metadata remains on the canonical finish only. Existing journal entries
remain readable without a backfill.

Older untouched records use their original selected source row until an ordinary
write installs the projection. Reads never backfill, schedule a repair or scan
history. No timer, polling, delivery delay or controller wake rule is added.
Projection maintenance adds bounded metadata reads/writes to existing transactions,
not Convex calls; source and log bytes retain their R2 placement. Synthetic budgets
cover executions and read bytes per landing plus invalidation/delivery parity.
Live per-function usage, wall time and billed savings require separate deployment
and matched-load measurement; the synthetic budgets do not establish them.

### Composed Intent contracts

Native landing prefix Views retain the declared contracts of their selected
Intents and accepted changes since the saved base. Accepted receipts are read in
100-record pages, with selected Lane/Candidate metadata deduplicated. Hosted
composition carries the declarations with canonical Candidate metadata; the
current receipt, Candidate and Intent are selected directly rather than scanning
Intent or acceptance history. Accepted sequence pins distinguish later peer
changes from contracts already present when an Intent began. Dependency staging
merges the declarations in its existing metadata pages. Hosted storage interns
shared test paths in a per-plan dictionary, retaining exact per-contract membership
and measurements; readers normalize both plain and indexed encodings. This bounds
repeated path overhead without reading each Intent again or changing source bytes.

The existing exact check executes the unique test union, retaining complete
per-file durations and outcomes. A file that a complete `__FORGE_TESTS__`
line or JUnit report from the configured command names counts as run; only missing files are
executed in the same owned check rather than reserving another run. Q3 reuse observes the original complete
reports and never dispatches another semantic check. Hosted collectors sign the
compact reports with the existing exact source/plan callback. Landing settlement
records a covered failing union as a named Intent semantic conflict in its existing
write; no conflict table, observer-driven execution or idle poller is introduced.
The source Candidate remains clean. Review/status distinguish semantic conflicts,
ordinary unrelated failures and measured per-pair budget refusals.

### Hosted finish orchestration

`projectHostedLanding:enqueue` accepts an optional `finish` selection naming the
original completed compose operation and an optional parent submission (`after`).
The original request, actor, ordered input/dependency manifests and check settings
are immutable. Ordinary enqueue continues to stop at ready; finish schedules the
short driver that prepares and publishes through the same H14 acceptance path.
Person requests keep their selected Lane versions across recomposition, including
when a later save changes that Lane. Unchecked person acceptance remains available.

A main head **or receipt** race reserves a named child with distinct compose/check/
accept identities before source IO. The driver yields with exponential backoff,
recomposes the original H08-validated manifests on the newly observed main and
requests a new exact-Candidate check. It never rereads current Lane heads, changes
selection order, transfers evidence between Candidates or treats a queue lease as
permission to accept. Overlap retains a conflicted Candidate with the exact H09
resolution root; the existing explicit resolution path remains available.

Each driver action makes one short control transaction, at most one metadata
transfer, and one guarded completion transaction. Acceptance input pages stay within
H08's transport windows. A small canonical compose-plan object uses the existing
hash-verified storage boundary; repository source and logs never cross this action.
H08's fixed source job and H10's configured check provider retain execution ownership.
No persistent worker, long action, project scan or idle polling loop is introduced.
A retained IO generation/watchdog fences late replies. Event/startup repair resumes
only the pending source job, run, page or publication; expiry allocates no replacement
compute. Repeated metadata uploads after an interrupted reply may retain unused
storage objects; no new retention or deletion policy is applied.

Check/source completion wakes the selected request. A parent receipt or failure
wakes dependent submissions through indexed bounded windows. Pending dependencies
and review waits schedule nothing while idle. Current authorization, epoch, policy,
registered source, exact check and main CAS remain H14's publication conditions.
Submission status reuses the native pending reasons and terminal causes. Input-page
status shares the native source-relative projection: later Lane saves show
`superseded` while preserving the actual pending/failed/landed outcome. Versioned
status reads are observation only and start no compute. The landing request is the sole current snapshot.
Each observation stores a compact transition with only changing fields; readers
rebuild its immutable identity and request from that snapshot without reading a
predecessor. Previously stored full observations remain readable. This API and its crash,
contention and scale tests use local fakes; deployment and live provider qualification
remain separate.

Explicit finish resume checks current project/contributor write authority before
scheduler repair, plus the original epoch while work is pending. Completed
requests retain current-access checks while acknowledging historical epochs.

### Hosted compensating revert

`projectHostedSync:prepare` accepts `kind: revert` with an exact acceptance receipt
or submission identity. One project-scoped indexed lookup selects the actual
previous and accepted main heads from H14's receipt. It never reads the requested
Lane head, guesses from current bytes, or hydrates the accepted input/history
pages. A submission with no acceptance receipt fails explicitly, including when
its final reply is unknown. The original operation retains its target, time,
Intent/Lane IDs and source job; authorized retries reconcile those same identities.

The existing fixed sync worker reuses native `compensatingState`: pre-acceptance
files with the accepted head as synthetic parent. This reverses the actual main
transition, including all batch inputs, dependency merges and prior compensation.
It publishes an isolated active Lane with receipt provenance, preserving all
original States and current main. Only the two State manifests are needed to
construct the reverse; file blobs are fetched later only as ordinary merge needs.

Compose that saved Lane with H08, then use H15 finish for the exact Candidate.
Current accept authority, policy and exact agent checks remain H14's ordinary
rules; people retain their existing unchecked acceptance capability. H15 recomposes
and rechecks on main races. Later disjoint work survives, while overlaps retain
H08 conflict roots usable by H09 resolution. Source preparation alone never
claims a check or acceptance, and reverting a revert selects that new acceptance's
actual delta by the same API. The shared hosted agent transport exposes this source phase.

### Hosted agent transport

All checkout-root sibling paths use `root-paths.ts`: the existing filesystem prefix,
including a symlinked checkout, is resolved before any suffix is appended. Before
cache eviction, pruning or copy adoption, filesystem identities are compared using
canonical roots, including relative sibling links and registry aliases. Before
checkout publication, exact legacy read-cache candidates with verified hash-named
private regular objects are atomically quarantined outside source and every
containing disposable cache. Re-verification after the move restores unexpected
content when possible, or retains it with an obstruction; even verified quarantines
stay outside GC because open handles can still write to moved directories.
Tracked source paths retain ordinary obstruction handling. Blocked sync/resolve applies
retain typed recovery through CLI/MCP; explicit `recover-apply` keeps only the
unsaved changes that meet the incoming change (computed from the baseline and target State
exactly as the in-place apply does), restores just those paths to the baseline in place and
resumes the same pinned installation, which carries every other edit and new file. When the
apply will replace the whole checkout, or something the clean check ignores blocks the
incoming change, every change is kept instead. The changed set is found with one
stat-indexed pass over the materialized files, so the kept copy and its receipt grow with the changed paths, not the
tree; ignored output (dependency links, build output) is never touched. Kept bytes live in
the outermost client cache at `ROOT.forge-client/kept-apply/APPLY_ID/` (never beside the
root): `files/` mirrors the changed paths (a later round adds `files-UUID/`), and
`receipt.json` lists every path as edited, extra or deleted, with digests. A path edited
again after it was kept starts another round instead of being overwritten, and a legacy
read-cache folder holding local files is kept the same way. Status lists kept entries
(`keptApply`, paths and counts only, at most 20) with their expiry. The retention clock starts when
the pinned apply is confirmed and lasts seven days; an unconfirmed entry never expires.
Expired entries are swept by later recoveries, applies and Lane housekeeping scans, and
Lane pruning keeps the folder until then. Restoration requires the exact journaled marker and clean materialized baseline;
a recreated or re-edited checkout is preserved in another durable round. Recovery uses one
serialized private baseline stage of the restored files only, cleans it on exit, and never
restores a baseline over a completed apply. Interrupted local failures retain executable recovery.
The recovery journal and preserved bytes stay local and add no idle server calls.

A sync apply onto a trusted baseline carries unsaved changes in paths its delta does not
touch, as Git carries them through a pull: in place, only a change that meets an installed
or removed path (or a parent or child of one), or any Forge metadata change, refuses before
anything is installed, and the refusal removes its pending receipt so a retry re-checks its
pins. The judgement reuses the publication's one stat-indexed clean pass. A whole-checkout
publication never removes the prior root wholesale: an editor can recreate paths in it until
the rename lands, so `hosted-checkout-dispose.ts` walks it once (the walk `rm -r` did). Each
baseline path is first renamed into a private folder inside the old root and only then
compared, so a write through the old path after that lands in a new file that stays; exact
baseline bytes are unlinked, others go back to their path without replacing anything. Forge
metadata is removed and anything else moves whole into a held kept-apply folder that never
expires; results report it in `displacedRecovery`. A walk that stops on a filesystem error (a
read-only folder) holds the remainder the same way, so the publication finishes and later
checkouts are not refused; if even that rename fails, a typed `WORK_CONFLICT` names the
folder and the retry. Hosted main
pulls do the same. Recovery wrappers keep typed recovery for filesystem errors
(`local-filesystem`), an unreadable quarantined cache (left quarantined), a lost marker (a
private baseline copy taken with the handoff), and a checkout root replaced by a link (a
`root-link` blocker; nothing is written through the link). When the Lane moved before the
first apply receipt, `recover-apply` returns `status:"superseded"` with both pin sets and
`next: open` before moving anything; it never switches pins silently. A checkout that already
holds the apply's target pins or a newer version of its Lane (an `open` while the sync waited)
is reported as `alreadyApplied` and left untouched; the handoff's baseline copy stands in only
for a marker that is missing or unreadable, never for a newer one. Recovery removes its exact journaled baseline
stage even after an interrupted earlier run.

`HostedAgentTransport` is the shared hosted CLI/agent boundary. `agent-cli` selects
an explicit deployment/project, a verified Lane marker or a retained client
address before constructing any client service. All hosted actions reuse the
canonical start, checkout, delta save, paged compose, sync/revert, check, durable
finish and lifecycle APIs. Source bytes use the existing verified exchange and
object transport, without a native owner or listener. Native addressing retains
its previous workflow.

The private client journal records original normalized parameters, actor, exact
resolved source/check/main pins and compound operation UUIDs before mutation IO.
Lost replies retain those requests; source phase replay resumes the same server
job and preserves newer client files. Check and finish always retain agent actor
semantics even with account authentication. The journal is recovery data, never
source, Work or acceptance authority; current project access is checked for every
dispatch. Capability discovery reports the implemented protocol, authority and
configuration presence through a constant-size authorized query. Requested status
observations perform finite reads without wakes, subscriptions or idle polling.
MCP uses the existing agent workflow registration and CLI adapter with those same
schemas, response envelopes, address retention and recovery journal. Hosted
addressing is selected before native Work, presence or graph construction; it
starts no local owner/listener. Source reads reuse the verified H04 object cache,
return saved Lane/State/blob pins and recheck current authorization before returning
bytes, without Work/history hydration or substitution of local drafts. Only an
explicit live run or submission wait creates subscriptions; every exit and server
disconnect closes them. Finite status/observe installs no observer. All stdio MCP
entry points close on stdin end/close or a broken output pipe, and after two
hours without a request (`FORGE_MCP_IDLE_MS` overrides the deadline). One
unreferenced timeout sleeps while idle; it is removed while any request is in
flight and rearmed after the last response. Closing releases graph workers,
watcher attachments and live waits without taking over background owner work.
Account authentication never selects person acceptance in these tools. Live
provisioning and provider qualification remain separate.

### Child process environments

Forge background workers and native helpers construct child environments with
`childEnv` from ordinary OS settings and explicit per-operation names. Unknown
variables, including unrelated credentials and ambient `NODE_OPTIONS`, are not
inherited. Git helpers retain their explicit Git identity/configuration and CGI
settings. GitHub and hosted synchronization controllers receive only their
selected provider credential names; check controllers preserve the check's declared
environment and credential inputs. Project commands continue to use their private
check runtime directories and declared passthrough. The self-host backend receives
its explicitly selected S3 file settings. These are environment boundaries, not
OS sandboxes or protection from credentials in files accessible to the account.

Check-log cleanup protects source and artifact hashes, including shared recipe chunks.
Each reachable State is verified and parsed once into a durable deduplicated reference
union. Hash buckets split at 512 entries; propagation consumes bounded union pages,
without rereading State bytes or treating missing projection coverage as absence.
Hosted output chunks carry an indexed run/digest binding. Cleanup fills missing legacy
bindings in bounded pages, then revalidates candidate windows and original stream pins
before deletion. Digests with unusually many references continue through the existing paged safety scan.
Automatic expiry uses the same resumable planner with one project sweep identity;
finite continuations stop after draining due receipts, with no idle timer. Hosted source staging records object provenance before publication; each bounded save or publication batch marks every newly referenced object and appends one cleanup fence atomically. A new source batch changes the cleanup guard, so a reviewed cleanup cannot delete bytes that became source during the operation. Replaying an already marked batch performs no protection writes.

Hosted agent `diff` pins Lane base/head, reads their R2 manifests and at most 100
blob descriptors per 50-path page. Source/hunk budgets report omissions; cursors
retain the pair. Exact State `show` checks project membership even on cache hits;
Candidate `show` uses its clean result. All source reads recheck current access.
`peers` extends `projectHostedOverlaps:read`, including a path before its first
save, with the same classifier and honest saved-only coverage. No read adds
subscriptions, writes or idle work.

### Landing message metadata

Acceptance freezes supplied subject, body and trailers by value. Messages are
limited to 1 KiB UTF-8; controls are stripped, CRLF normalized, and reserved
Forge-State/Acceptance/View lines escaped with `> `. Other trailers retain their
order; authoritative Forge trailers follow. A cohort's first receipt carries
all supplied messages in member order for its shared commit. Native batches do
the same. Raw State exports keep State messages; published history is unchanged.
Legacy CLI `Agent change` defaults mean omission; negotiated requests distinguish
an explicit identical subject. Pre-upgrade pending finishes recover their saved
message at acceptance. Released status/wait projections omit this internal
provenance so strict older clients keep working; canonical records retain it.

Metadata uses existing calls and records, with zero idle calls. Each message adds
at most 2,061 JSON bytes; the first cohort receipt adds at most 16,427 more for
eight messages. Only legacy pending finishes need an indexed finish-record read.
Source and cursor artifact bytes remain in R2.

### GitHub containment and adoption

When GitHub advances, sync checks that its net changes are contained in accepted Forge main. A three-way merge uses the recorded GitHub tree as base, current GitHub as theirs and the accepted export as ours. Every path must merge without conflicts and leave Forge bytes and modes unchanged, including additions, deletions, binary files and symlinks. Line merges allow later Forge edits beside already-contained external hunks.

An exact historical version (including mode or absence) can supply a per-path base. Sync reads the pinned acceptance interval after the mapped base in pages, plus saved checkpoints ancestral to accepted Lane inputs; it excludes unaccepted saves, older versions and older branches. Dry-run records State/acceptance/Candidate pins in `reconciliation.historyProofs`, plus Lane/checkpoint pins for saves. Squash merges, merge commits and empty changes use this same check.

Containment proposes one new adoption commit with current GitHub as parent and the exact exported main tree. Earlier mappings and history remain intact; subsequent syncs continue from this adoption. Dry-run reports `reconciliation.status: "contained"`, external commit IDs/paths and the proposal. Only `--push` changes Work metadata.


Work journal history readers accept verified private R2 segments alongside live
rows. A dedicated `projectJournalSegments` index retains revision ranges, scoped
coordination positions, immutable record hashes, Lane source pins and metric
facts. Exact versions, planning history, provenance, Lane history, event replay
and recovery use the same logical readers through a server action; current access
is checked again after IO and public identity mapping remains at the boundary.
Reactive page clients keep live subscriptions and hydrate only selected cold
pages. Legacy provider cursors require the existing format upgrade when archived
rows exist, rather than silently omitting history. No journal writer is installed
by this reader expansion. Larger existing documents can use verified transport
fragments without changing their original row bytes or record limits.
