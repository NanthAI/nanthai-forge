# Trusted hosted source worker

The source worker is fixed Forge code. It treats repository content as bytes and
never checks it out, imports it, installs its packages, runs Git, follows source
symlinks or executes repository commands. Modal project-check credentials and the
check bridge are separate from this source service.

`projectModalSource:dispatch` is an internal short action over the existing source
job controller. Its route is configured by `FORGE_SOURCE_MODAL_URL`,
`FORGE_SOURCE_MODAL_TOKEN`, `FORGE_SOURCE_WORKER` and `FORGE_SOURCE_RUNTIME`. An
unavailable route reports a structured error; it does not select another provider
or an owner computer. Each tick performs bounded metadata requests and returns.
No action waits for source computation, and no idle per-Lane worker is retained.

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
parent operation or grant landing permission. Save reducers and compose/sync
algorithms remain separate callers; this first fixed worker handles save and
register-state input plans.

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
