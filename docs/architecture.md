# Architecture

Forge has five parts. Each owns one kind of data, and no part quietly takes over another's job.

```text
  Coding agent / human
        |
   nforge CLI, MCP, local Git/Work HTTP    Hosted browser (Netlify)
        |                                         |
  Native store + Work store  <-- exchange -->  Convex (hosted)
  (your machine, canonical)                   (checkpoints, event journal,
        |                                      sessions, messages, access)
  Local checks (your OS account)                  |
                                          Netlify worker (public analysis)
```

For the vocabulary used below (Intent, Lane, Candidate, Channel, State), see [concepts](concepts.md).

## Who owns what

| Part              | Owns                                                                                                 | Code                                                      |
| ----------------- | ---------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| Native store      | Immutable source: file blobs (SHA-256), State manifests and disposable owner-computed source indexes | `src/native-source.ts`                                    |
| Work store        | Mutable metadata: Intents, Lanes, notes, check runs, selections                                      | `src/work-store.ts`, `src/work.ts`, `src/native-work.ts`  |
| Analysis          | Derived, partial code graph with exact locators                                                      | `src/snapshot.ts`, `src/analyze.ts`, `src/graph-query.ts` |
| Local execution   | Check and Playbook processes in materialized Candidates                                              | `src/work-run.ts`, `src/work-playbook.ts`                 |
| Agent interface   | Short commands over the same owners                                                                  | `src/agent-workflow.ts`, `src/mcp-agent-workflow.ts`      |
| Convex            | Hosted checkpoints, the Work event journal, sessions, messages, current access                       | `convex/`                                                 |
| Web               | Hosted browser UI (the only browser UI)                                                              | `web/src/`                                                |
| Local server      | `nforge serve`: token-protected Git smart-HTTP and Work API on 127.0.0.1, no browser pages           | `src/http.ts`, `src/work-git-http.ts`, `src/work-http.ts` |
| Netlify worker    | Public-repository analysis in the background                                                         | `netlify/functions/`                                      |
| Git compatibility | Import, export, projections and publication                                                          | `src/native-git*.ts`, `src/work-git*.ts`                  |

The local native owner is canonical for Forge's own development. A hosted project holds checkpoints you send it plus its own metadata journal. Source synchronization is explicit unless the owner enables the separate `autoExchange` policy. Its saved-mutation driver shares bound-push serialization and retained-operation reconciliation, with no idle polling. Bound owners also send advisory agent presence and lifecycle metadata automatically, with a binding opt-out; these updates do not transfer source or check artifacts.

## Local filesystem watching

All native filesystem hints use `src/local-watcher.ts`. Processes attached to the
same owner share one helper over a private local socket. A process-identity lease
under the owner's `.forge/work` directory is elected under a recoverable lock;
a dead lease can be replaced without reclaiming a live or reused PID. Identical
path/recursive subscriptions share a native watcher and route events to every
attached client. Socket disconnect releases that client's subscriptions, and the
last disconnect exits the helper. MCP overlap notifications validate the Work
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
never source. Both probe close and subscription close wait at most 250 ms for an
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

## Source analysis

Forge reads TypeScript, JavaScript, Python, Java and Rust. TypeScript and JavaScript use the TypeScript compiler, which resolves identifier references. Python, Java and Rust use pinned Lezer parsers that give declarations and conservative lexical references. Analysis never runs repository code and needs no model.

Coverage is partial and says so. Relative imports resolve for TypeScript, JavaScript and Python, as do qualified Java imports and explicit Rust file modules. Not modelled: tsconfig aliases, installed packages, dynamic dispatch, framework routes, macros, overload resolution and complete call or data-flow graphs. A missing relationship means unknown. It does not mean independent.

`impact` means direct reverse imports. Use ordinary search for configuration, strings and unsupported languages.

Freshness comes from rereading source, never from timestamps. Re-indexing captures source twice and publishes only if both reads match. An unchanged, valid graph is reused. A worker keeps only its latest compiler program.

## Storage

**Native objects.** `NativeSource.put` hashes each file and stores it once under `.forge/work/objects`. A State is a manifest of paths, blob hashes, modes and parent States. A changed file is stored whole. Capture reports which paths were excluded and why. Retained files and their directory prefixes are indexed once per capture, preserving tracked files through ignore rules. Native ancestry queries stop at a verified match and share verified parent information only within one operation; full history traversal remains available for merge bases and exports. State manifests and their on-disk format are unchanged.

**Hosted blob access.** Convex functions access file storage through `BlobStore` (`convex/blobStore.ts`); CLI exchange uses `ExchangeBlobs` (`src/exchange-blobs.ts`). Project objects dispatch on each row's `location`, with `r2Key` and a verified commit for R2. Server-built indexed artifacts and import cursors use opaque `r2blob:` references to `artifactBlobs` metadata, alongside legacy Convex storage IDs. R2 writes require the deployment flag and the owning project's or indexed import's opt-in, reserve immutable pins before create-only checksum-bound PUTs, and commit after HEAD verification. Readers keep dual-location support and verify downloaded bytes. See the [R2 storage plan](r2-storage-plan.md) for remaining compatibility paths.

**Lanes and checks.** `materialize` writes a State into a fresh directory of ordinary files. Native Lanes clone one disposable, pinned source-tree cache per owner using APFS `clonefile` (or filesystem reflinks elsewhere). The cloned tree is checked against every manifest path, blob digest and mode before publication; an edited or incomplete cache is rebuilt from the same State. Cache preparation and cloning hold only the cache/Lane locks, outside the owner writer lock. `.forge/materialization.json` records the selected head and clone/copy result, including the reason when the filesystem needs ordinary copying. Check workspaces retain their independent byte-only materialization. Editing a Lane never changes stored objects or other Lanes.

Automatic snapshots reuse unchanged content-addressed blobs and clone newly changed regular files through the same filesystem helper. Every new clone is verified against the captured bytes before object publication; edits racing a clone retain the original captured bytes. Snapshot pointers record clone/copy counts and fallback reasons. State identities, symlink bytes, checkpoint behavior and the existing snapshot retention window are unchanged.

**Work records.** Native owners keep Work in `.forge/work`. Git-backed owners keep it in the Git common directory under `forge-work`. `work.json` is a small manifest that points to immutable, content-addressed record pages. A save writes new records, syncs them, then atomically replaces the manifest. An interrupted save leaves the previous snapshot in place. The owner lock serializes manifest publication and shared Channel mutations. Landing queue edits, native acceptance, main-audit selection and GitHub mirror recording prepare against one committed pointer outside that lock. They stage changed immutable records, then verify the exact pointer and driver/authority fences before publishing; a concurrent commit retries without overwriting either writer. Git/network operations hold no Work writer lock. Derived peer caches warm after writer release and before the mutation receipt returns, using their immutable page pins. Owner workspace refresh serializes on its own lock and selects current main after admission. Agent Lane operations also take a per-Lane lock: checkpoint capture and native sync file writes run outside the owner lock; sync publishes only its Lane into a fresh manifest with a source-field CAS, preserving concurrent changes to other Lanes. Native start reserves its records, materializes outside the owner lock, then publishes activation. Check execution and observation hold no Work, Lane or Channel lock; after a Channel CAS race finish either proves the enabled disjoint fast-path or syncs, composes and checks a fresh pinned attempt before rejoining the acceptance queue. Transient contention at the final cancellation/spawn journal step retries without rematerializing, changing the run ID or releasing its machine-capacity ticket; a never-started command is not marked failed merely because this lock was busy. The per-operation finish journal guard prevents duplicate drivers of the same operation; it does not exclude other agents.

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

**Hosting.** `nforge host` reuses owner/key project creation and device CLI authority, then a paged one-time seed, hosted Work initialization and the current derived index. The seed pins source/Work and journal-only recovery inputs before upload, commits bounded validated pages with a durable cursor, and compares hosted native main bytes with the original native digest before selecting main and recording completion. It reuses object upload/R2 transport without invoking exchange push, publication or history completion; retries retain the original snapshot. Seed authority remains pinned to its original mode/epoch, independently of the later authority cutover. Deployment/project bindings and pending operation pins live in an atomically replaced `hosted-binding.json` beside local Work. This transport state does not change Work revisions. Project creation validates the complete autonomy policy, including the optional disjoint fast-path setting; older policies without that field remain readable. Unexpected hosted errors retain a generic client response and log their name, message and stack server-side, without custom error payloads; rejected Convex document payloads are redacted.

**Browser bootstrap.** `projectBootstrap.create` prepares an empty native State,
portable Work and source manifest in storage. One transaction validates their
pins and publishes the owner/key project, retained checkpoint, initialized Work,
`main` receipt and ready Code/Work index. Retrying the owner's operation UUID
returns the same project; a changed name is refused. Concurrent prepared retries
reconcile the winning transaction and discard only their own unused preparation
bytes. Source files are added through the existing source-transfer boundaries.

**Exchange.** Native bound pushes durably retain a consistent local Work snapshot
and available mutable run outputs before their first hosted read. Hosted metadata
is merged separately into that candidate and the current local owner; later local
Work writes stay local until the next push. Known hosted checkpoint or Work CAS
mismatches reconcile fresh hosted pins with the original local capture, with up to
three automatic rebases after the initial attempt. Each attempt retains separate
immutable pins and deterministic child operation IDs. Unknown outcomes reconcile
the original receipt before changing any baseline. Explicit revision-pinned
requests retain their exact revision checks.

`nforge exchange` sends a checkpoint to a hosted project by asking which content hashes are missing and uploading only those. The Work snapshot is pinned under the owner lock; immutable source traversal, hashing and network transfer run outside it. Large files are split into content-defined chunks. Manifest and Work metadata travel as chunk trees under a small versioned root. Whole-file hashes stay the identity, and the backend verifies them before binding. A matching retry returns the original receipt. Successful native pushes retain a checksummed, project/checkpoint-scoped preparation hint: unchanged source ancestry, finished-run content and uploaded pins are reused without rereading their bytes or negotiating every object. A missing or corrupt hint falls back to full preparation. The backend reuses unchanged digest/size bindings from a completely validated prior checkpoint; those bindings are immutable until explicit project deletion, and publication rechecks active owner authority.

Native owners attach an optional content-addressed derived-row sidecar to source
return. Selection happens before derivation against the exact hosted source-return
baseline, which may differ from the checkpoint used for upload negotiation. Only
new State parents/ancestry, comparisons for changed Lane/Candidate records, changed Candidate
provenance and new selected trees are supplied. Ancestry is a State's own parents;
hosted chunks reference those parent boundaries rather than copying full closures.
Readers compose these references with previously hosted closures and parent caches.
Older preparation hints recover their exact digest-verified local Work snapshot;
if that snapshot is unavailable the optional sidecar is omitted.

Sidecar schema 2 and the disposable local delta cache each have a 4 MiB byte
budget. Oversized legacy caches are skipped before reading. The client stops
accumulating derived rows at the budget and omits oversized sidecars; the hosted
action checks declared bytes before any object read, then validates actual bytes,
digest and JSON. A budget miss falls back to hosted computation and never denies
a push. The cache retains only the latest bounded delta, not historical Candidate rows
or transitive closures. Original prepared operations retain their pins on retry;
oversized original sidecars are omitted without changing source publication pins.
Work and hosted schema versions stay unchanged.

The existing owner-only source-return action validates the Work digest, shape,
counts, unique keys, source pins, comparison pairs and Candidate identities without
reading source blobs. Valid complete sidecars bypass the parent, diffstat,
ancestry and Candidate item phases and use the existing staged delta publication.
Missing, oversized, legacy or incomplete sidecars retain hosted computation, as do
contributor sources. Final authority and source/Work CAS checks stay in the same
publication transaction. A sidecar carries the existing owner's source trust;
its metadata is disposable and never becomes source authority.

Native object source returns compare the validated metadata with the selected generation, reuse immutable diffstat pairs and unchanged Candidate provenance, and derive only new source prefixes and affected Candidates. State-parent caches and complete legacy ancestry boundaries carry earlier work across receipts. New ancestry closures store bounded chunks of hashes instead of expanding a new head into individual historical pair rows. Reads compose those closures with legacy positive pairs; previously retained ancestors absent from an older candidate-pair table can be resolved from cached parents. Existing generations require no schema migration or backfill.

A private return generation holds its computational cursor in file storage. Small deltas keep the selected physical record partition: the final source/Work CAS applies their changed rows and removals atomically with the receipt. The publication budget accounts for new rows, old rows read, protocol bytes and payload-cleanup scheduling. Larger deltas use the existing complete private-partition rebuild and atomic switch. These are internal transaction budgets, not limits on retained source or Work.

The initial metadata reader has an 8 MiB byte memo. Derived steps share a 2 MiB immutable State-byte memo within an action, checking current authority and storage on every use. A logical step reads at most 16 States or roughly 2 MiB of source (one larger State remains readable), and drains at most 100 rows or about 500 KB. Steps checkpoint many logical items together: native delta cursors after at most 64 items or about a second of computation, full partitions once the step's State, byte or row budget is used. The server loops over committed steps for up to 30 seconds (or 1,000 steps) per invocation rather than requiring a client round trip per item, because every cold invocation rereads the cursor and snapshot. State comparison and Candidate provenance still discard historical file lists; arbitrary individual metadata or States do not have a flat-memory guarantee. The [documented action execution limit](https://docs.convex.dev/production/state/limits) remains ten minutes.

Cursor contents and validated metadata travel through file storage as gzip JSON; legacy plain JSON cursors still resume. A warm worker reuses a cursor or snapshot body it stored or read, after checking current storage size and SHA-256. Each committed cursor carries the push's running storage reads, bytes, steps and invocations; the completing call returns them as `accounting` (the stored receipt is unchanged) and the CLI prints them. Setting `FORGE_SOURCE_RETURN_MAX_STEPS` or `FORGE_SOURCE_RETURN_MAX_STORAGE_BYTES` on the deployment pauses a return after a committed step with `SOURCE_RETURN_BUDGET`; pushing the same operation again resumes once the limit is raised or unset. Both are unset by default. The cursor and private rows commit atomically under a step CAS; replaced disposable cursors are removed. An old R3 partition without a computational cursor restarts its disposable rows with the original operation timestamp. Only the final source/Work CAS selects the complete result. Lost replies resume the original cursor or return the exact final receipt. Older CLIs receive `SOURCE_RETURN_PENDING` rather than mistaking partial preparation for success; current CLIs continue automatically and print phase, items done/total, durable step, elapsed time, ETA and saved restart position on stderr. JSON stdout retains the original final receipt.

Diagnostics log `source-return prepare`, `prepared`, `step` (phase, durable step, row count/bytes, State count/bytes, derived rows, elapsed milliseconds and CAS result), and `complete` (published revision). No source payloads are logged. Unavailable optional ancestry/provenance remains explicitly unknown and does not deny a source return; each staging/final mutation still checks current owner authority. Unknown hosted failures remain typed `HOSTED_ACTION_FAILED` and preserve pending push pins. Full fallback Work validation and manifest/catalog processing still scale with retained metadata. Legacy archive/Git projection retains its existing full reconstruction path. The target of under 200 MB on the dogfooding project needs live post-deployment measurement. Retained-byte coverage lives in `tests/hosted-source-memory.test.mjs`; transaction/RPC budgets and the 9,200-object/854 MiB logical-source regression live in `tests/hosted-return-progress.test.mjs`. Incremental landing fixtures live in `tests/source-return-incremental.test.mjs`. See [source exchange](operations/source-exchange.md).

Without a valid owner sidecar, hosted native Lane/Candidate diffstats advance through the same durable return cursor. Only changed records schedule comparisons; a step advances as many records as its State and byte budget allows, looks up immutable base/head totals in batches, compares changed files in batches of up to 100, and publishes each summary once with the index. A partly compared pair resumes from its saved offset. Unavailable or inexact source keeps line totals unknown.

**Archives.** `export-work` writes the full retained closure: source States, Work and recorded run files. It can pack this as a `.tar.gz`. Source-only release archives are narrower and contain empty Work. Browser backup and contributor-proposal imports unpack local exports and upload reusable logical objects. New hosted archive registrations are retired; historical stored archives and pending uploads retain read/resume support. Object proposals pull as validated unpacked exports for direct native contribution import. Older hosted archives are still readable and can be converted explicitly. See [operations](operations.md).

**Collection.** Object collection removes only verified, unreferenced objects. Referenced history, Lanes, logs and backups are never pruned.

## Work record delta exchange

Native exchange schema 2 keeps ordered collections of stable record keys and
SHA-256 pins in a chunked record catalog. Planning versions use their id and
version together. Only missing record bytes and catalog chunks travel; the
delta names the exact baseline catalog, checkpoint Work digest and hosted journal
revision, with prior/result hashes for additions, replacements and removals.
The local Work format and its canonical pretty-printed JSON bytes stay unchanged.

New checkpoint rows can carry an optional verified-record marker. The first v2
checkpoint and old baselines use complete validation; existing rows are not
rewritten. Later publication validates changed records and their source/record
references, including inbound references on removals. It streams the complete
logical Work SHA-256 from exact record segments in bounded batches rather than
assembling another Work JSON or parsing every unchanged record. Local snapshot
preparation, catalog reads and this hashing still scale with retained metadata.

An exchange-only journal adapter replays hosted events over touched records,
checks retained history by ordered record hashes, and uses the existing
source-return event with its whole-JSON digest. It hydrates affected dependants,
referenced records, Candidate families, the default Intent and selected Channels for
the existing derived-index planner. Small updates publish through the original
atomic source/Work CAS and operation receipt. No new writer authority or portable
Work event is introduced.

Schema-1 exchange and full reconstruction remain supported. Missing/old
baselines, unsupported metadata changes, schema transitions, planning-journal
operations, inserted/reordered histories and contexts beyond the internal 4 MiB preparation budget use that
complete path. This budget selects an implementation path and never denies a
push. A partial index cursor that outgrows atomic publication selects the
verified checkpoint and lets the existing complete index rebuild run. Recovery
and the logical-manifest compatibility endpoint reproduce and verify the
original Work bytes. Current CLI readers understand both exchange versions.

Local preparation pins a Work revision and immutable root under the short owner
lock, then durably retains the operation's snapshot before network access. Running
outputs are captured as available immutable bytes; later output and Work writes
belong to the next push. Retries reuse the retained snapshot, never recapture it
under the same attempt ID. A known hosted CAS mismatch reconciles the hosted
journal with that pinned local snapshot and derives a fresh delta, with at most
three automatic rebase attempts before returning the existing stale/conflict
outcome. Each attempt has immutable pins and its own deterministic operation ID
under the retained parent push ID. Unknown outcomes reconcile that attempt's
receipt before any rebase; reusing an ID with changed pins remains invalid.

Hosted publication, Work metadata loading and source-return continuation reuse verified immutable storage bytes in bounded process memos, including recipe nodes and leaves. Every reuse resolves current project authority and checks current storage metadata; recipe closures are revalidated. CLI exchange sessions retain bounded downloaded objects by content hash and size and recheck current project bindings before returning cached bytes. Warm reuse is expendable and does not establish production savings.

Imported Code subscribes to source-free import/status-derivative invalidations. Changes, focus, network recovery and explicit reads trigger current GitHub authority and latest-head checks. Persisted endpoint derivatives and process-local public JWKS reuse avoid repeated derivation; idle tabs do not periodically invoke status actions.

## Checks and evidence

Native checks select local, Modal or GitHub Actions execution through `checks.runner` in project
autonomy policy. The Modal owner-side adapter pins source, definition, selection
and runtime, verifies snapshot hashes remotely, uses independent remote capacity,
and binds the terminal receipt to those pins. Owner credentials stay on the
controller; declared secret inputs stay local. Infrastructure fallback is explicit;
unknown executions retain IDs for adoption rather than repeating commands.
See [Modal checks](operations/modal-checks.md) and [GitHub Actions and Blacksmith checks](operations/github-actions-checks.md) for execution and cost details. `checks.fallback` is `manual` by default for existing and new policies; automatic local fallback requires explicit opt-in and owner-originated candidates. Confirmed runner outages and budget exhaustion produce retryable infrastructure outcomes, not failed-test evidence; see [runner fallback](operations/runner-fallback.md).

Modal interruptions preserve completed exact-plan shards. Failed test shards retry once; two named flake verdicts within seven days quarantine that exact test identity. Quarantined tests continue running without blocking on fully attributed failures; twenty consecutive clean passes or an explicit fix release quarantine. Infrastructure recovery keeps its attempts without contributing flake verdicts. See [flakes and quarantine](operations/modal-checks.md#flakes-and-quarantine).

A check is an executable, its arguments, an optional environment label and explicit environment/credential passthrough names. A run records the pinned Candidate, the check definition, an environment fingerprint and the process owner. It runs in a fresh workspace under your OS account with private HOME/XDG/temp directories and a clean runtime allowlist plus declared passthrough. Passthrough values are transient; receipts retain names only. It is not sandboxed. The runner keeps outcomes, logs and chosen build outputs. Cancelled, interrupted and failed are different results. After a lost reply, a retry observes the existing run and does not start another.

Playbooks run a sequence of checks. Automation rules start a Playbook on an event. Evidence is reused only under the explicit native disjoint fast-path policy; acceptance revalidates the exact check and manifest-path proof and schedules full main verification. Missing coverage is unknown. A passing check, a model critique and a human review are separate facts. Accepting a Channel is an explicit step against an observed previous head. An optional Invariant can require specific evidence first.

A hosted project can ask a connected local computer to run a check. The request carries only pins and the check name. The local owner validates them and keeps the logs and evidence. A queued, claimed or finished status is a report. It does not prove the machine is online.

## Making-of record

`making-of` is a read model over existing records: the Intent, its Lanes (by `intentId`), its Candidates, their runs and accepted Channel moves (by `viewId`), plus local presence and self-reports from `hosted-binding.json`. Records-v2 owners read only those indexed records; older owners read loaded Work. The derivation (`src/making-of.ts`) is pure and omits values whose inputs are missing; loading and the `report` mutation live in `src/making-of-read.ts`. Runs record `queuedAt` at creation and move `startedAt` forward when the command spawns, which separates queue from running time. Self-reports are keyed by Lane, actor and optional session, keep their applied operation IDs for replay, and never change the Work revision or format.

Designed, not built: an opt-in OpenTelemetry intake. Claude Code and Codex can export OTLP metrics (token and cost counters with model and session attributes) when the user enables telemetry. `nforge serve` would accept OTLP/HTTP JSON on its existing token-authenticated loopback listener, map the session to a Lane through a `forge.lane_id` resource attribute set from the Lane environment, and write the same self-report record. It stays off unless the user configures the exporter, and it drops prompt and tool-content attributes.

## Acceptance from the hosted browser

A native project created by `nforge host` remains canonical on its bound local
owner. The hosting key and native backup format distinguish it from Git-backed
and hosted-canonical projects. Hosted Accept records an owner-scoped request,
not a `hostedChannelMoves` selection: operation UUID, exact Candidate/head, expected
main, server-attributed requester and person/agent classification. The original
request survives source/index refreshes. Bound pulls materialize source client directories without native Work or
acceptance authority. Existing independent bound owners can exchange source and
activity, but do not consume canonical acceptance requests or report their local
Channel moves as canonical main.
Bindings without an explicit `acceptanceOwner:true` role are not canonical owners.
They do not consume owner requests or publish local Channel moves as canonical main;
`nforge host ROOT --status` reports that the legacy binding has no recorded role.
An operator must establish which directory is canonical before migrating that binding.
No role is inferred from a matching project key or an old binding. Retry of the same operation reconciles
its original pins and terminal result.

`nforge host ROOT --listen` and `nforge serve ROOT` poll every five seconds while
running. B5's detached `host --sync-agent` worker also consumes one request after
flushing activity; it is opportunistic, not a persistent connection. Hosting
performs an initial poll. Owner machine observations live separately from project Work and policy.
The owner reports its machine name, last-seen main and
the listener command with a `ROOT` placeholder. Last-seen is an observation; a machine not seen for
30 seconds is labelled accordingly, not declared incapable of accepting.

The consumer uses the existing native person acceptance path under the owner
lock and current autonomy policy. Device requests retain agent classification
and cannot acquire person acceptance authority. If main advanced after a person
request, the owner-approved fast-path compares source manifests against the
expected main. Only disjoint changed paths (including directory-prefix clashes)
compose on current main without a new check. The receipt records the comparison base, both path sets,
original Candidate/head and current main. Before the first main acceptance, the retained
native bootstrap supplies the comparison base. Overlap or unavailable ancestry rejects as
needs re-check; original source, checks and accepted work remain. The composed
Candidate has a new identity; it does not inherit a passing run on that identity.

Local Channel moves are durable before network delivery. The binding retains
terminal receipts and exact metadata publication payloads for lost-reply replay.
The consumer refreshes indexed hosted main from local receipts before reporting
completion. Source and check-artifact transfer uses exchange, manually or through
opt-in `autoExchange`: indexed source pins do not promise that newly composed
bytes have already been uploaded.
The browser says Requested / Waiting for the named machine, and only says
Accepted into main after the local receipt arrives. Git-backed and hosted-canonical
projects retain their existing hosted selection path.

Revert creates a compensating-change Intent and a hand-to-agent prompt. The agent
must create a reverse-diff Lane on current main, preserve later work, then check
and accept the new Candidate normally. Creating the Intent does not reverse source.
Main is never rewound by this action.

## Collaboration

Source changes and live coordination are separate. Convex stores sessions and an append-only message feed outside the Work journal. A session is an attributed claim: who, where, status and optional Intent, Lane or path. Last-seen is the time a report arrived. A heartbeat touch moves only receipt time (`lastSeen`), preserving `lastActivity` and `activityKind`; real MCP activity advances both. Bound owner observations pin activity time before transport, so delayed delivery cannot look like fresh editing. CLI lifecycle calls persist local session observations; one process-owned observer with per-Lane filesystem watchers coalesces edits about once per minute without reading or hashing source. The same edit observations drive debounced Lane auto-snapshots: a background, Lane-locked (never waited for) capture with a metadata cache into a local State and a pointer under `.forge/work/auto-snapshots`, published under its own short lock that object collection also takes; the owner Work lock is never taken. Its minute tick also observes queued/running checks. Presence observers validate the current Work format before creating owner or Lane queue tickets; unsupported formats leave the owner untouched. HTTP owns its in-process presence observer: closing the last handle aborts watchers and waits for Lane queue releases. MCP connections do not own background presence or landing workers. CLI lifecycle activity wakes an existing owner worker or retains a detached presence worker. CLI/MCP check execution uses a detached controller with an exclusive per-run process lease, retaining the original run and provider pins independently of transport lifetime. HTTP shutdown also clears the acceptance interval and waits for its active poll before returning. Hosted Now uses shared 15-minute working and 90-minute folding defaults, keep quiet sessions visible, and collapse duplicate name+Lane observations. Silence never completes a session; explicit completion or accepted/closed Lanes do. Messages and handoffs target a session, a participant or the project; acknowledgements refer to the original and are recorded per participant. Claims are advisory path scopes with an expiry. Hosted Work writes, exchange publishes and source returns insert `change` events in the same transaction. Events carry denormalized kind, recipient, Intent and Lane for indexed inbox and scoped feeds. Nothing pauses an agent, locks a file or accepts source.

Hosted Intent, note and Channel operations use a derived indexed Work generation, rebuilt from the checkpoint and the event journal. Source return updates a ready generation in place: small deltas modify changed rows, while larger deltas stage a replacement record partition before an atomic switch under the same public generation. Browser query identities stay stable; CLI pagination cursors additionally pin the source revision, and multi-part record hydration retries if that revision changes. Unavailable derived indexes retain the rebuild fallback. The cockpit strip selects the latest accepted `main` move from the pushed local `channelMoves` and hosted selection records, including its recorded timestamp, actor and exact-Candidate check. Indexed Lane `main.included` means main contains that Lane head; Candidate/run `main.included` means the checked head contains main. These opposite ancestry directions are kept separate, with unavailable ancestry reported as unknown. Accepted moves and their exact Candidate inputs also identify landed Lane heads in older indexes. Unanchored notes, Intent creation/status and planning comments use `projectWorkCommand.command`, a single mutation with an operation UUID and no client-held revision. It reads current headers, applies the shared reducer and assigns the next journal revision atomically; Convex retries concurrent transactions. Coordination messages and heartbeat touches are already independent server mutations.

The `projectWorkHeads` row owns the mutable Work revision and projection metadata. Legacy project/generation fields seed it lazily; ordinary writes leave those shared documents unchanged. Revision-sensitive reads (Work state, workspace, provenance plans, exports and source return) hydrate the head; collection/detail reads depend on the stable generation and their selected record ranges. Index preparation remains the existing hosted-open step. Anchored notes still validate source bytes in an action; planning-item replacement, Channel acceptance and source return retain their pinned revision checks. The legacy command action remains compatible. Source return atomically selects the new checkpoint and head; journal replay and operation receipts retain contiguous revisions and original retry identities.

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

Hosted Review uses this owner request path for native projects and offers every
retained clean Candidate, including Candidates without a previous acceptance. People may
accept clean unchecked Candidates; agents still need exact-Candidate passing evidence and
the current autonomy policy. `hosted-work` CLI and `forge_hosted_work` expose
`accept` with operationId, revision, viewId, head, archiveSha256, channel and
previousId. The CLI/MCP command explicitly downscopes to agent authority even
when supplied an account JWT; device credentials can never obtain person authority.
Repeating the original pins reconciles the same request or receipt.

Hosted native Intent and Lane lifecycle menus queue complete, reopen and abandon
on the same canonical owner listener. Requested and machine-waiting states are
observations; only the owner receipt reports an applied lifecycle transition.
Commands pin the target head/base and lifecycle state. Abandon uses B4's existing
reason, save-first and Intent cascade semantics. Complete/reopen retain source
and acceptance history. B4's cancel command cancels check runs: there is no
cancelled Intent or Lane state, so these menus do not invent one. Hosted-canonical
and Git projects retain their existing Intent status controls.

An overlap rejection offers **Re-check on latest main**. It queues a separate
owner request, composes the pinned reviewed Candidate with the latest local main using
normal Candidate dependencies, and queues the configured check through the existing
runner. It never accepts source. Original request ids replay the same composed
Candidate and run even if main advances later. A text conflict retains a conflict Candidate
and reports why no check was queued. Re-check receipts are separate from acceptance
receipts; new source/check artifacts still require manual or opt-in automatic exchange. Deterministic
acceptance failures do not offer an unchanged acceptance retry; transient owner
failures retain Request again.

Hosted Code uses paths-only `sourceTreePaths` pages, keyed by an exact source
head and published with the selected Work generation. The `sourceTrees` marker
records complete availability, including an empty tree. Current source and main
are prepared during source indexing; older or unavailable tree indexes use the
existing exact-source review reader. File text is read only for the selected
file, independently of the tree. The project frame shares summary pages and
coordination subscriptions with its child pages. Summary pages start with 20 rows and continue through all history in 100-record
pages. Non-summary readers retain the backend's existing 100-record page size. Code and Candidate
chunks are warmed when their navigation links receive hover or keyboard focus;
module preloading never caches project data.

An open tab costs nothing while nobody is looking. The browser's Convex client
drops every live subscription after 30 s hidden or 5 minutes without input or
focus (`web/src/live-reads.ts`); mounted pages keep their last values, the strip
shows Paused, and the next input or visibility change subscribes each mounted
read once for fresh data. Nothing polls; time-window counts advance only while
awake.

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
disposable pins, an older backup, or an index/source-return race restart the
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
receipts remain exact. Hosted pushes retain the current representation and format.

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

Local Work unifies legacy Intents only through the explicit owner command
`{"action":"migrate-intents"}` (`src/work-intent-migration.ts`); no reader or
writer migrates implicitly. Take a verified backup first. Under the owner lock it
converts the current Work, writes the converted pages as content-addressed
records, reads them back and validates them, writes `intent-merge-receipt.json`,
then switches `work.json` with one atomic rename. A failure before the rename
leaves the original format-15/16/17/19 pointer and records untouched. The migration ID derives from
the original Work hash, so a retry reproduces identical pages and receipt; once switched,
a retry returns the stored `intentMigration` receipt without writing. The large
`legacyIntentMerge` copy is stored as a one-record paged collection, so ordinary
commits never rewrite it inside the commit pointer.

In unified Work, record writers complete unified fields on any Intent they write
(`unifyIntent`): title, description, empty relation lists and a stable
conversation entry per note. `intent-status ready` keeps the Intent active and
records the request as lifecycle history; Ready is derived attention. The legacy
planning commands (`put-planning-item`, `comment-planning-item`) remain the write
API: an Issue write updates the unified Intent (title, description, version,
relations, memberships) and still appends its planning version or comment, which
keeps operation-ID retries, exports and the hosted push exact. Issue IDs folded at
migration resolve through `intentAliases`, and writes through the alias or the
Intent ID extend one version chain. Planning status sets the status of an Intent
with no source pin (closed → completed, otherwise active); once a Lane has pinned
an Intent, its execution lifecycle owns status. An Intent created from an Issue
has no source pin until `agent start` with its `intentId` captures one from its
first Lane; composition and Git `lane` commands on an unpinned Intent fail with
`INTENT_NOT_STARTED`. `intentState` derives Proposed, Planned, In motion and Done
for presentation only.

Native exchange sends `hostedPushWork` without down-projecting unified fields or
unpinned Intents. Record reference validation uses the declared Work format, so
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

Source clients use the schema-1 `HostedMain` contract (`src/hosted-main.ts`), read
atomically by `projectMain:current`: project, source generation, backup, native
main head and its Channel receipt, including previous head/receipt pins. Hosted
Channel selection overrides the uploaded native main seed. An expected head plus
receipt detects stale selection, including rollback to the same source bytes.
This endpoint reuses the current accepted receipts and selected generation; there
is no new main table, Work format, acceptance rule or storage authority.

Client checkout downloads only that State and missing file blobs through existing
project-scoped object storage, validates exact bytes, and materializes a source
client directory. It never restores native Work or derives current main from an
uploaded checkpoint's root head. Explicit independent-owner restore remains the
full retained-closure recovery operation. Client cache and retry receipts are
transport state; they do not grant hosted access or move a Channel. See
[hosted main client checkout](operations/source-exchange.md#hosted-main-client-checkout).

### Hosted source authority and operation contracts

Projects have an explicit optional `sourceAuthority` record with mode
`native-owner`, `server-shadow` or `server` and a nonnegative fencing epoch.
New projects from native upload, browser bootstrap and GitHub import all record
`native-owner` at epoch 0. Missing legacy fields mean that same authority;
creation retries preserve an existing record. Hosting requests, presence and
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
H01 envelopes before external work and retains original terminal outcomes.
Native-owner projects retain their existing Work owner and are not converted.
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

Callbacks use HMAC-SHA-256 with a backend-resolved key identified by the pinned
worker configuration (`FORGE_SOURCE_JOB_KEY_<keyId>`). The signature binds project,
job, operation, attempt, fence, authority epoch, input digest, provider, worker,
runtime, execution identity and the completed output manifest digest/size or
failure code. Current project/contributor authority and epoch are rechecked on
every callback, including duplicates. A verified callback may reconcile before
the dispatch response. Terminal receipts cannot be rewritten. Signed sequential
heartbeats renew a worker lease across action lifetimes; replayed heartbeats do
not extend it, and expired workers cannot commit. Cancellation advances the
worker fence without implying that remote compute was stopped. Controller lease
takeover preserves a running worker's execution fence.

Recovery reads only a selected project's pending/dispatching/running status
index in bounded pages; it does not scan terminal history or every project.
There is no persistent idle source worker. The dispatch seam is exercised with a
local fake provider; a real provider action, its bounded HTTP transport, callback
ingress, key provisioning and trusted object/State validation are subsequent
worker-adapter work. Verified output references alone grant no source publication
or landing authority.

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

With automatic previews enabled, `land` previews precisely its saved selection
and `finish` previews its saved Candidate inputs before a landing check starts.
The batch driver also previews the actual queued batch against its pinned base,
including independently submitted finishes. Exact cached inputs are reused.
Failing individuals are excluded; for a failing pair, the later selected input is
excluded while the first is retained. Exclusions retain main, Lane/head, cache key
and diagnostic pins in the result; safe selected Lanes continue through normal
checks. A grouped finish stops with `preview-excluded` if any input is excluded.
Submit a new operation with `preview:"skip"` on `finish` or `land` to override this
preflight (ordinary landing checks still apply). A skipped queued entry is never
excluded by another entry's preview. Baseline failures, text conflicts, missing
configuration, higher-order-only failures and unavailable preview execution use
the existing landing/check path; preview advice never substitutes for evidence.

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

### Native Lane stacks

A stacked Lane stores its parent Lane ID, saved parent State and target Channel.
The stack pin is independent of an Intent's source base and of a Candidate's
inputs. Start reserves it with the new Lane before materializing source. Sync
uses the pinned parent tree as its explicit three-way base, then writes the
child's aggregate delta as a new State on the selected target, retaining the prior
child head as a second parent. This preserves causal history for ordinary Candidate
composition without reintroducing the old parent's tree. Checkpoint history
retains pre-restack source; conflicts retain the selected target until resolution.
Sync's durable selection and checkpoint receipts also retain the old/new stack
pins, so interrupted application and undo restore the same base.

A retained accepted Candidate input and Channel receipt establish parent landing;
source containment or lifecycle status alone does not. Landing retargets the
child's next sync to main without mutating its live files. Finish/land preserve
the existing dependency wait, including multi-level chains. Work formats 21/22
protect stack metadata from older writers, with legacy/unified Intent semantics
respectively; record pages, source exchange and explicit Intent conversion retain
the pins. See [stacked Lanes](agents/workflow.md#stacked-lanes).

## Trusted remote source computation

The first fixed-code Modal source adapter reuses hosted source jobs and short
control actions. An optional per-job transactional provider reservation permits
one paid create across lost replies and competing bridge instances. Signed
callbacks retain their original execution and authority pins. The worker verifies
hash-pinned raw/recipe objects into temporary disk storage and constructs States
through NativeSource without materializing or executing repository code. Direct
transfer grants and publication remain with the source-operation reducers; no
public writer or deployment is enabled. See [trusted hosted source worker](operations/hosted-source-worker.md).

### Hosted Lane and Intent lifecycle APIs

`projectHostedLifecycle:transition` changes canonical server/shadow saved work
through an original operation UUID and exact record/source/lifecycle pins.
Abandon and reopen retain source, saves and acceptance history and never move
main. Known dirty client abandonment uses an explicit save-first child; unknown
disconnected drafts remain on that client and are never claimed saved. Reopen
requires no reason and changes only its selected target. Intent reopen retains
independent child lifecycle states. Native-owner menus keep their owner path.

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

The thin `transitionHostedLane` helper retains its command, child UUID and exact
capture in its private client cache. H07 handles direct source transfers and
save reconciliation. The lifecycle parent can wait durably for that exact save;
terminal save publication and a parent wake commit together. Failed saves never
apply abandonment. Pending work sleeps until its save callback or explicit resume.
Working files and sparse scope stay intact, including newer local edits after
capture and lost replies. Only a matching baseline's metadata advances on replay.
Check cancellation remains a separate H10 request and provider acknowledgement;
lifecycle receipts say `cancellation: not-requested`.

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
attempt time. Source construction runs through the fixed Modal worker, using the
native State format and streaming changed blobs to private disk. Unchanged paths
are preserved from the verified baseline; no repository code runs.

A signed source-job completion schedules the save finalizer independently of the
editing client. Only its small result manifest passes through the finalizing
action. One publication transaction verifies the original job/input/output and
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
marker, and completed retries never reinstall over later edits. Server source
publication and optional local installation have separate outcomes.

### Hosted check definitions and provider evidence

`projectHostedCheckDefinitions` writes versioned check definitions and the selected
remote runner configuration with original-operation reconciliation and expected
definition/configuration pins. Definitions use the local command normalization
and definition digest; import preserves the original check UUID, timestamp and
command. Project check settings use owner authority; contributors can request
checks under current project access. Configuration contains a Modal route or a
GitHub Actions repository, App installation and selected `runsOn` label, exact
runtime/environment fingerprints and a credential-use reference, never account
credential values or a local credential file. These APIs do not configure a live
provider or change existing native-owner checks.

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
interrupted, runner-unavailable and unknown outcomes remain distinct. Cancellation
before dispatch is certain; after reservation it records a request until the
provider acknowledges it. No cancellation request claims remote compute stopped.
Cost starts unknown and only signed provider usage supplies observations. New
stdout/artifact bytes never enter these Convex APIs; only object references do.

`projectHostedCheckRead` reads one run in constant time and pages definitions,
Candidate runs and shard metadata through indexes. The shared
`requireHostedCheckEvidence` helper rechecks current definitions/configuration and
exact passing provider evidence inside the caller's transaction. It does not move
main, implement landing policy or require checks for person-selected acceptance.
Live provider dispatch (including Modal), credential use, callback ingress and
check-output transfer remain adapter work; the contracts are exercised with local
fake providers. See the
[check API](operations/source-exchange.md#hosted-check-api).

Mac runs use the same signed shard and terminal callbacks through the pull-based
`projectHostedCheckWorker`. Completion retains `macEvidence`: machine ID, machine
owner, registration session, runner fingerprint (runtime plus environment), and
`reuseKey`. The reuse key is explicitly null until Q3 supplies the hosted content
key; it is not evidence reuse permission. Final acceptance copies this receipt.

The single server-side sufficiency rule in `requireHostedCheckEvidence` allows Mac
evidence for owner-controlled work under trusted/autonomous acceptance, including
custom policies retaining `auto-on-pass`. The machine owner, check requester,
Candidate creator and accepting account must match the project owner. Candidate
creator provenance is written by the canonical record writer, independent of the
account requesting its check. Missing creator provenance, supervised projects and
outside contributors require hosted-runner evidence (`HOSTED_RUNNER_REQUIRED`).
Modal and GitHub Actions retain their existing sufficiency rules, and unchecked
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
Fresh signing rechecks current read access. Downloads go directly to R2 and the
portable reader verifies chunk digests, offsets, sequence and full sealed-stream
hash without a whole-log server read. Existing five-minute signed GET expiry
still bounds already-issued URL access after revocation. Reads create no timers,
scheduled work or URL refresh loops. UI adapters use the existing idle gate.
These APIs and transfers are covered with local fake runners/R2; no live adapter,
UI, deployment, retention policy or account provisioning is supplied here.

The hosted Actions adapter runs fixed export/control code outside Convex.
`exportHostedActions` reads the exact pinned State, recipe and selection through
the hash-verifying source-worker reader. It builds bare Git objects from streamed
storage objects, preserving binary bytes, modes and symlink targets without a
checkout, filters, hooks or project execution. The existing generated Actions
workflow honors the selected GitHub-hosted or Blacksmith label. The native State
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
generation-fenced wakes observe only an adopted outstanding run and rearm before
contacting the fixed controller. Exact State/export/run/job checks precede stable
signed H10 shard and terminal callbacks. Cancellation retains its request until
provider completion. Stuck jobs reuse the local complete-log plus run-conclusion
rule; provider logs alone never claim live output.

The fixed runner supervisor streams command pipes through H12 and atomically
retains redacted chunks/seals in a private durable spool before publication.
Reconnect replays exact records without rerunning commands. Missing seals remain
incomplete; final H12 retention is separate from H10 verdict authority. Existing
Check-panel readers consume that same output protocol. Live fixed-controller,
runner-bootstrap and H12 ingress provisioning remains a lead deployment operation;
the generated workflow command must run under that trusted supervisor. These
modules do not install or deploy those services or register an App.

### Hosted landing request queue

`projectHostedLanding:enqueue` records a durable submission, immutable first attempt,
original H01 operation and coalesced Channel wake in one transaction. The request
selects an exact canonical Candidate/head (or a retained conflict), main head and
receipt, authority epoch and optional exact check run or check request. Actor kind
comes from the existing account/device acceptance boundary. The check-request
variant calls the same H10 enqueue transaction, retaining one child operation and
run before any provider I/O. This API does not require a check for person requests
or publish source. Native-owner projects retain their current acceptance route.

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
reconciliation only; H13 never submits/repeats provider work or allocates a replacement
run. Driver replies and scheduler deliveries are safe to repeat. Enqueue retries
can repair a failed wake by inspecting its durable scheduler receipt. There is no
empty-queue poller, browser heartbeat or recurring check observation.

Only runnable requests enter selection, ordered by Channel sequence. Checking,
ready and terminal records remain readable without hiding later independent work.
H10 run updates transactionally schedule one coalesced check wake; bounded metadata
pages reactivate its waiters and wake their Channel. Fan-out automatically continues
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
Cancellation leaves Lane lifecycle and shared source/check execution independent.

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
actor, policy, exact run and terminal evidence, authority epoch and attempt. Automatic
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

People can accept clean unchecked Candidates. Agents still need an exact passing
run and current autonomy permission. Existing supervised/actor/protected-path rules
return waiting-for-review. H08 currently supplies no trusted changed-path coverage;
protected-path policy therefore uses its existing unavailable-coverage review rule,
never caller-supplied path claims. No new policy, UI step, provider call or cutover
is introduced. The API is exercised with local metadata/provider/source-worker fakes.

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
status reads are observation only and start no compute. This API and its crash,
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

`HostedAgentTransport` is the shared hosted CLI/agent boundary. `agent-cli` selects
an explicit deployment/project, a verified Lane marker or a retained client
address before constructing native owner services. All hosted actions reuse the
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
entry points close on stdin end/close or a broken output pipe, and after fifteen
minutes without a request (`FORGE_MCP_IDLE_MS` overrides the deadline). One
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
settings. GitHub, hosted synchronization and Modal controllers receive only their
selected provider credential names; check controllers preserve the check's declared
environment and credential inputs. Project commands continue to use their private
check runtime directories and declared passthrough. The self-host backend receives
its explicitly selected S3 file settings. These are environment boundaries, not
OS sandboxes or protection from credentials in files accessible to the account.
