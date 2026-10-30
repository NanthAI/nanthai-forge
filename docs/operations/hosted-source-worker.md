# Trusted hosted source worker

The source worker is fixed Forge code. It treats repository content as bytes and
never checks it out, imports it, installs its packages, runs Git, follows source
symlinks or executes repository commands. Check execution is separate from this source service.

## Default Convex provider

Hosted save, compose and sync select `convex` by default. No source-worker secret
or environment variable is required. `projectConvexSource:dispatch` runs the
existing controller transitions inside one internal mutation: its reservation,
fixed execution ID and first scheduled action commit together. A lost reply
reconciles that execution. It cannot create another execution.

`projectConvexSource:step` is a Node action. A small `projectSourceSteps` row holds
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
the same retained task only on an existing explicit recovery trigger.

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
the browser. The author resolves it locally. At both limits at once the
measured action peak is about 320 MiB; at 16 MiB it was over 500 MiB.

A single saved direct child of main needs only its two verified tip manifests to
establish the native fast-forward. Ancestry windows use derived parent rows only
to prefetch exact objects, then verify each manifest and follow its actual
parents. Missing hints never prove independence. Missing coverage can increase
metadata calls.

The action reads committed project objects using internal storage locations and
writes through Convex storage. R2 source bytes use the existing trusted object
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
work units or calls. Local dogfood fixtures measure 25 calls for a complete
ten-file R2 save, including new object uploads, output storage and manifest file
access. These are local fake-provider counts, not live latency or billing data.

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
