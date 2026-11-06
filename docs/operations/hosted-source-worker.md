# Trusted hosted source worker

The source worker is fixed Forge code. It treats repository content as bytes and
never checks it out, imports it, installs its packages, runs Git, follows source
symlinks or executes repository commands. Check execution is separate from this source service.

Pending or retryable source work retains its original operation and execution;
follow the advertised continuation to reconcile an unknown outcome. A truly
terminal source receipt remains immutable on replay. A failed finish advertises
a new-attempt `next:{action:"finish", ...parameters}` plus its printed `command`,
retaining the original selection and omitting the old operation ID. CLI stderr
prints that command, and MCP exposes the same envelope (see the
[agent continuation contract](../agents/workflow.md)). Terminal observations drop
obsolete pending-source advice without an additional read or mutation; conflict
recovery retains its exact sync/resolve continuation. This response handling does
not reclassify worker failures or repair a terminal job.

## Default Convex provider

Hosted save, compose and sync select `convex` by default. No source-worker secret
or environment variable is required. `projectConvexSource:dispatch` is an internal mutation running the
existing controller transitions: its reservation,
fixed execution ID and first scheduled action commit together. A lost reply
reconciles that execution. It cannot create another execution.

`projectConvexSource:step` is a Convex-runtime action. A save with one delta
page, a raw baseline up to 4 MiB and up to 8 MiB of raw changed objects finishes
there, avoiding concurrent Node cold starts. Its input and delta page each fit
128 KiB. These are runtime routing boundaries: other saves, compose, sync and
retained continuations use `projectConvexSourceNode:step`, the same resumable
Node worker. The fallback reuses the begin result and prepared descriptors;
it does not allocate another execution or repeat the begin mutation. Both
paths retain exact hash verification, current authority checks, result formats
and the existing atomic commit/publication. Source bytes still go only to R2.
The State and its result manifest upload concurrently; publication waits for
both checksum-verified writes. There is no per-project small-save lock or
application queue.

The small-save source job uses six invocations: dispatch mutation, step action,
begin mutation, two batched descriptor mutations and commit mutation. This was
seven with the Node dispatch wrapper. Publication adds its existing action and
two mutations. Large-job fallback adds one nested Node action, offset by removing
the old dispatch action, so its function count does not increase. An ineligible
save can reread its small input/page from R2; prepared metadata is reused and no
additional descriptor RPC is needed. Input uploads and observer updates are
separate from these worker counts.

Convex documents 64 MiB for regular actions and 512 MiB for Node actions. Even
S16 permits 64 actions of either runtime (but only eight scheduled jobs); S256
permits 512 regular actions, 256 Node actions and 256 scheduled jobs. Convex
scheduling applies those deployment limits. The four-slot application pool
below governs child fan-out, not serial save steps. Its value is an application
bound on expensive verification/merge children, not a Convex four-action limit.

A small `projectSourceSteps` row holds
the exact dispatch, execution ID, step number and a storage reference to progress.
Progress references compressed metadata sections by hash and storage ID.
Unchanged inventory, queued-digest lists and file trees are reused; queue
advancement writes a small cursor. These sections contain protocol/file metadata
and verified parent links, not cached file contents. Each step rechecks current actor/project authority,
authority epoch, attempt, fence, input and provider/runtime pins. Its completion
mutation compares the step number, registers hash-verified outputs, applies the
existing heartbeat/terminal reducer and commits the next cursor and schedule
atomically. Duplicate or delayed step commits have no effect. An explicit
recovery trigger can requeue the same cursor after a failed scheduled action;
it never allocates another execution. There is no timer, cron or idle scan.

Verification windows contain at most 100 objects or about 8 MiB. Large recipe
files retain their traversal frontier, whole-file SHA-256 state and byte count
between steps; verified leaves are discarded. Save pages update the file tree
in groups of at most eight pages, without retaining the whole delta. Registered
baseline content is reused for moves and mode changes. Registration verifies the
required parent/file closure.

Independent verification and file calculations use a global completion-driven
pool, with four computation slots across projects. `FORGE_SOURCE_PARALLELISM`
optionally selects one through four slots; no configuration is required. Each
child has a durable generation and progress reference. Its completion mutation
records the result, releases the slot and starts queued work. The last child
schedules the parent join. A finished child's action can briefly overlap the
next action while returning its completion reply; it performs no more source
work. There is no join poll, idle loop or cron. Failed scheduled actions resume
the same retained task through the existing pool reschedule; explicit recovery
also reconciles a stopped action whose failure report never committed.

Source acquisition and validation have separate failure boundaries. Header/body
timeouts, connection resets, failed progress reads and unknown nested RPC failures
fail the scheduled action without committing its in-flight cursor or an invalid
State summary. HTTP 408/425/429 and 5xx source reads/writes, and transient HEAD
verification of worker output, follow that same path. Proven missing objects,
wrong hash/size, malformed native States and corrupt compressed metadata retain
their deterministic codes. A prefetch hint's deterministic error matters only
if traversal actually requires that State.

Repair renews the original execution only after rechecking its authority and
dispatch pins. A lease-fenced batch retains completed sibling outputs and
unfinished durable prefixes; only unfinished children advance generation. Old
in-progress actions keep their computation slots until the scheduler reports
them stopped, and their late generations cannot complete the repaired child.
The existing pending-finish watchdog wakes after 120 seconds to reconcile that
same source work without a client replay. Direct save/compose/sync callers follow
the original-operation continuation. No additional timer, poller or execution is
created, and terminal operation receipts remain immutable.

Each bounded quantum has a persisted failed-attempt count, separate from its
successful continuation generation and the source job's business `attempt`.
Failure accounting and pool rescheduling share the task-row write. Replacement
child actions back off by about 2, 4, 8, 16 and 32 seconds; the backoff function tops out
at 60 seconds. The sixth failed attempt settles rather than scheduling another
replacement. A successful committed continuation resets the next quantum's
failure count. Duplicate or late failure reports cannot consume another attempt
or replace a current generation. Unrelated pool drains use the same accounting;
completed sibling outputs and acknowledged prefixes remain retained.

Admitted finish compositions also retain the existing 30-minute watch deadline,
pinned to that compose operation's first attempt. Replaying a failing quantum
never extends it. A fresh main-race compose uses its own retained first-attempt
time, independently of the cohort's creation time or a previous check's age.
Backoff never schedules a computation beyond the current compose deadline. The
deadline bounds retries and new work: pool drains cannot start queued work after
it, and a successful quantum committed at or after
it cannot fork children, continue a child, or schedule a successor or parent join.
It instead settles through the existing exhaustion path. A success that completes
the whole source job uses first-committer-wins semantics: if its terminal result
commits before the watch settles that job, completion and landing may proceed even
after the deadline. If the watch settles first, later replies remain fenced and
cannot replace its outcome. At the deadline the existing watch settles unsettled
source/compose/finish work, rather than dropping its last wake. Reaching either
the failed-attempt cap or the watch deadline produces the
exact terminal code `SOURCE_RETRY_EXHAUSTED`. The source outcome retains the last
bounded sanitized cause (stage, exception class/code, HTTP status and elapsed
time), selected by recorded failure time across slots; an already terminal job's
cause stays fixed. The original pins and execution identity remain. Stopped and pending slots
are released; an already-running computation keeps its slot until it stops or
returns its fenced completion. Other queued projects can then use the pool.
The normal terminal finish response advertises the standard new-attempt retry
continuation above; replay of the failed operation remains immutable.

Read-after-write lag is the one R2 answer retried inside the action
(`src/hosted-r2-retry.ts`, shared policy): a 404 on the HEAD that verifies a
source object this job just stored, or on the GET of a committed source object,
is tried at most twice more (400 ms, then 1.6 s) before the exact
`R2_VERIFY_FAILED` / `SOURCE_UNAVAILABLE` stands. Timeouts, resets and
408/425/429/5xx are not retried there: they stay retryable and use the scheduled
repair above. Hash or size mismatch, 403 and malformed data fail at once. The
healthy path makes no extra call.

Failed actions emit bounded structured context to retained Convex logs: job,
step, task/generation, stage, exception class/code, available object digest,
elapsed time and HTTP status. Failure receipts also retain the source step,
allowlisted call label, digest pin and numeric byte/object counts when known.
Dependency resolution failures retain `MODULE_NOT_FOUND`, `ERR_MODULE_NOT_FOUND`,
`ERR_PACKAGE_PATH_NOT_EXPORTED` or `ERR_REQUIRE_ESM`; other unclassified runtime
failures use `SOURCE_RUNTIME_ERROR`. Existing retained code-null receipts remain
readable. Nested wrappers preserve the innermost safe context. These diagnostics omit source bytes, arbitrary
exception messages, signed URLs, headers and response payloads. Escaping action
rejections are opaque too: they carry the approved bounded classification without
the original message, stack or cause. Proven metadata schema failures settle with
their established deterministic code, including during progress persistence and
staging. Permanent output PUT/HEAD failures retain `R2_UPLOAD_FAILED` or
`R2_VERIFY_FAILED`; transient storage I/O remains repairable. These paths add no
healthy-path control call or database write.

Compose and sync journal native per-file results in bounded object/byte windows.
Replaying assembly uses those immutable outcomes, preserving recursive merge
bases, text insertion orientation and conflict alternatives. Final flat State
assembly stays serial; publication still uses the existing single atomic CAS.
Resolution-marker checks stream through recipe windows. A verified non-text
prefix establishes the native binary-conflict outcome without buffering a large
file. Overlapping text calculations use the native whole-file text/import
parser, whose memory grows with both bytes and line count.

A file changed on only one side takes that side's content, streamed, at any
size. A text file changed on both sides is merged line by line only when base,
ours and theirs are each at most 4 MiB and 65,536 lines. Otherwise the job
reports a normal conflict for that path with the reason "too large to merge
automatically", like Git hosts that decline to merge or diff very large files in
the browser. The author resolves it locally.

Compose (not sync) then parses each text-merged JS/TS file of at most 256 KiB
(see [architecture](../architecture.md#hosted-composition-and-candidates)). One
that fails although both sides parse is a normal conflict with a parser reason.
Measured: about 0.6 ms per typical source file, 12 ms at 100 KB and 40 ms at
256 KB (50 files at the bound: about 1.9 s; 50 typical files: under 0.1 s); the compiler adds about 100 ms on first use and about 10 MB to each
Convex Node action bundle that reaches the compose worker, loaded only then. At both limits at once the
measured action peak is about 320 MiB; at 16 MiB it was over 500 MiB.

A single saved direct child of main needs only its two verified tip manifests to
establish the native fast-forward. Ancestry windows use derived parent rows only
to prefetch exact objects, then verify each manifest and follow its actual
parents. Missing hints never prove independence. Missing coverage can increase
metadata calls.

The action reads committed project objects using internal storage locations and
writes verified output bytes directly to R2. R2 source bytes use the existing trusted object
store's signed URLs; there is no worker HTTP grant, callback or provider ingress.
Repository bytes never choose executable code or a transfer host. No local disk
or checkout is used. The same State ordering, modes, parents, timestamps and
terminal result manifests remain authoritative; publication stays in the
existing save/compose/sync reducers.

Convex documents 512 MiB for Node actions, a ten-minute action timeout, 5 MiB Node
arguments and 16 MiB returns. This provider targets less than 400 MiB and 60 seconds
per invocation. Only IDs and small metadata windows cross function boundaries;
large progress/output bytes use storage. Batching boundaries are internal
encoding choices, not file, project or history quotas. See
[Convex limits](https://docs.convex.dev/production/state/limits) and
[scheduled-function guarantees](https://docs.convex.dev/scheduling/scheduled-functions).

With no job, this provider makes zero calls and schedules zero functions. Each
serial step has one action, one begin mutation and one commit mutation, plus
bounded metadata windows and storage accesses. Intermediate steps also read and
write one progress blob, reusing unchanged compressed metadata sections. Each
child similarly has one action, one begin mutation and one completion mutation,
plus its metadata windows and progress/output storage. Forking and joining each
add one mutation. Changing the cap changes scheduling order, not the number of
work units or calls. The synthetic 3,000-file dogfood fixture measures 21 calls for a complete
ten-file R2 save, including new object uploads and result publication, with zero
Convex byte-storage calls. These are local fake-provider counts, not live latency or billing data.

`@convex-dev/workflow` 0.4.4 and its Workpool 0.4.7 development dependency
were evaluated (both Apache-2.0). Neither is installed. Workpool retains a
scheduled cooldown loop after its queue drains, and a lone work item adds at
least five orchestration invocations before Workflow start/resume costs. The
application-owned pool preserves the zero-idle requirement and the small-save
call budget. No Convex component configuration or component deployment is needed.

## Retired provider compatibility

Hosted source operations use the internal Convex source worker. The Modal source
bridge, Python workers, signed network callbacks and provisioning configuration
have been removed. `FORGE_SOURCE_PROVIDER=modal` is refused; select `convex` or
leave the setting absent. Existing job documents keep their original provider
and execution pins and remain readable. They are never silently rerouted.

The worker uses bounded source-object windows and verifies exact hash/size pins.
Source-operation reducers own publication; no repository commands execute during
source construction. No idle poller or external source-service credential is needed.

The landing Convex runtime check bundles registered functions and their reachable
modules, imports their emitted bundles from a private directory without checkout
`node_modules`, and rejects first-party runtime package discovery, including lazy loader
aliases and nonliteral imports. Import reconciliation uses the pinned portable
Lezer parser through a static import so the parser ships inside the source-worker
bundle. Tests never execute repository source as part of parsing.
