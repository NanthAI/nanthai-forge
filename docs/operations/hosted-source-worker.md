# Trusted hosted source worker

The source worker is fixed Forge code. It treats repository content as bytes and
never checks it out, imports it, installs its packages, runs Git, follows source
symlinks or executes repository commands. Modal project-check credentials and the
check bridge are separate from this source service.

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

## Optional Modal provider

Set `FORGE_SOURCE_PROVIDER=modal` to select the retained Modal path. Its fixed
route requires `FORGE_SOURCE_MODAL_URL`, `FORGE_SOURCE_MODAL_TOKEN`,
`FORGE_SOURCE_WORKER`, `FORGE_SOURCE_RUNTIME` and `FORGE_SOURCE_KEY_ID`. Existing
jobs keep their pinned provider when configuration changes. The following
provisioning, HTTP transfer and signature details apply to Modal.

## Dispatch ownership

`scripts/modal-source/bridge.py` uses the existing pinned Modal SDK version
(1.6.2), a digest-pinned installed image and detached Function calls. The image
must contain Node at `/usr/local/bin/node`, this package and its built `dist` at
`/opt/forge`. `FORGE_SOURCE_IMAGE` must end with the configured runtime digest.
No repository path, image, command or environment can replace those choices.

Before calling `spawn`, the bridge calls the trusted control ingress's
`provider-reserve` endpoint. That ingress forwards the exact input/project/job
and fresh UUID token to `projectSourceProviderApi:reserve`. The reservation is an
optional additive field in the existing immutable job control record, with its
input digest and token. Concurrent reserve calls serialize in the same database
transaction; only the first returns `create:true`. Even an original-token retry
returns `create:false`. A lost reservation response or a crash before spawn stays
unknown; it cannot license another paid create. This deliberately preserves an
uncertain job until its original execution is observed.

After spawn, `provider-created` forwards the original token and SDK call ID to
`projectSourceProviderApi:created`. `provider-lookup` forwards to the matching
internal query. Lookup returns authoritative empty only when there is neither a
reservation nor an execution. A signed worker callback can bind the execution
before the create response. Every request rechecks the exact dispatch pins and
current project/contributor/authority epoch. Cancellation fences old requests.
Provider recording does not extend the worker lease or rewrite a terminal result.
These transitions read one selected job and do not scan retained history.

The H05 controller still owns its single bounded recovery after two fresh empty
lookups. The provider's transactional reservation prevents that recovery from
creating a second paid execution after an uncertain first create.

## Source and transfer contract

`workerInputSchema` pins the parent States, original timestamp/message and an
immutable linked inventory. Each page contains at most 100 source-object pins
and 100 file entries. Objects carry their whole-content hash/size and an optional
hash/size reference to the existing object recipe format. These are encoding
windows, not project/file/history limits. The worker verifies the complete
required parent/source closure; unreferenced inventory objects are not fetched.

`SourceWorkerReader` verifies streamed raw bytes into a private temporary disk
cache keyed by hash. Recipes reuse the existing ordered reader, checking page and
leaf hashes/sizes, tree shape and the final whole-file hash. Raw files are never
read with a whole-file `arrayBuffer`. Verified recipe leaves are reused within
one job. The worker retains State metadata in memory as NativeSource does; this
is not a claim of constant memory for arbitrarily large manifests or histories.
Temporary files are removed when that computation exits.

The State builder uses `parseNativeState` and `NativeSource.writeState`, preserving
native ordering, modes, symlink bytes, deletion-by-omission, original parents and
server-pinned time. It uploads the canonical State and a small exact result
manifest described by `workerResultSchema`. It does not publish a Lane, finish a
parent operation or grant landing permission. Save, register-state, compose and sync retain their existing fixed algorithms
and result manifests; source-operation reducers remain separate callers.

The optional HTTP transport calls a fixed trusted control ingress for each
`grant` with the exact dispatch, execution ID, action and content pin. The ingress
must recheck current job/fence/epoch/project authority and return an exact direct
R2 URL with signed headers. Reads accept only committed matching project objects.
Uploads use existing create-only PUT semantics and, on success or HTTP 412,
`commit` must verify the stored size/checksum before acknowledging the pin. Bytes
travel directly between the worker and object storage. Control credentials are
never forwarded to the transfer host. Each grant is fresh; the worker cannot
supply a repository-owned URL. Failed or lost commit replies prevent completed
callbacks. H07's upload/registration reducer supplies this ingress; these modules
do not register an unauthenticated or incomplete public source route.

## Callback and provisioning boundary

The fixed worker receives only selected control configuration through the named
`forge-source-worker-control` Modal Secret: `FORGE_SOURCE_CONTROL_URL`,
`FORGE_SOURCE_CONTROL_TOKEN`, `FORGE_SOURCE_CALLBACK_KEY`, `FORGE_SOURCE_RUNTIME`,
`FORGE_SOURCE_WORKER` and `FORGE_SOURCE_HEARTBEAT_MS`. The bridge additionally uses
`FORGE_SOURCE_BRIDGE_TOKEN`. No local account configuration is discovered. The
worker receives its actual Modal Function call ID directly from the SDK.

The control ingress authenticates that separate worker credential and routes
`callback` to the H05 internal callback mutation, resolving the key ID on the
backend. The callback HMAC binds all job/operation/attempt/fence/epoch, input,
provider/worker/runtime and execution pins. A first heartbeat binds worker startup;
subsequent sequential heartbeats renew the job during active streaming and source
progress. Configure the interval and transfer timeout within the selected lease.
A stalled request can expire; source computation never grants itself a new lease.
Terminal callbacks reference only uploaded, acknowledged output manifests.

The Modal service, pinned image, configured secret-use route and authenticated
control/transfer ingress require explicit provisioning. No service is deployed or
automatically enabled by adding these modules. Local tests use synthetic byte
stores, fake Convex transactions and an offline Modal SDK stub. Their transfer
counts, process RSS and synthetic-clock duration are evidence about those
fixtures, not live provider cost, latency, service memory or deployment evidence.
