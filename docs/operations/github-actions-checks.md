# GitHub Actions checks

Native owners can run the pinned check candidate on GitHub-hosted or Blacksmith
compute using the owner's existing `gh` authentication and Git credentials:

```sh
nforge agent OWNER set-policy '{"checks":{"runner":"github-actions","repo":"OWNER/REPO","runsOn":"ubuntu-latest"}}'
# Or select the installed Blacksmith label:
nforge agent OWNER set-policy '{"checks":{"runsOn":"blacksmith-4vcpu-ubuntu-2404"}}'
```

The target must be a repository the owner intends to receive this source. Private
source needs a private target. The credential must permit Git pushes and workflow
dispatch. GitHub requires `.github/workflows/forge-check.yml` to be registered on
the target's default branch before dispatching a different ref. The operator must
install the workflow returned by `githubActionsWorkflow()` from the installed
`dist/github-actions-workflow.js` there once. Forge never writes the default branch.
See [GitHub's dispatch API](https://docs.github.com/en/rest/actions/workflows#create-a-workflow-dispatch-event).
No deployment, repository creation or default-branch update happens automatically.

`runsOn` defaults to `ubuntu-latest`. Omitted `shards` uses the same duration-balanced
provider-neutral check plan; a positive shard count explicitly partitions all selected test files.
Every standard check runs one independent static job. Docs-only candidates run
only documentation checks in that job, with no test shards. Code candidates use
the same scoped selection as local checks; explicit full scope and
post-accept main audits retain full verification. Test matrices use fail-fast
disabled. Both call `node scripts/forge-check.mjs`; the Actions plan
selects static verification or `scripts/test-files.mjs` with the pinned selection and
worker environment. Node is 24.22.1. Each job installs with `npm ci --ignore-scripts`.
Retained pre-upgrade Node 24.19.0 executions remain observable and cancellable,
with their original runtime identity. They cannot dispatch new work or retry shards;
an unstarted old-runtime plan needs a new check on the fixed runtime.
Arbitrary commands run once in the static job. Candidate sources must include the
Actions-aware standard check script to use standard sharding.

For this repository, code verification runs document validation and the installed
package smoke in the shared `scripts/verify.mjs` entry point. Native-owner landing
checks, hosted landing checks and the public mirror therefore exercise the same
static and package contracts. Docs-only checks retain their documentation path.
Package smoke runs once in the static job, after its other verification completes,
because it rebuilds `dist` before installing the archive in a disposable directory.
A packaging failure fails the exact-Candidate check before acceptance; the mirror
has no separate package step that could diverge from that gate.

The owner plans remote test selection with its installed selector, reading the
pinned Candidate as data. It does not execute the Candidate's selector to plan a
run. The merge-queue benchmark instead runs the selector shipped in its checked
tree. Comparing their selections therefore requires the same selector version,
as well as the same changed paths and source bytes. Updating repository selector
code alone does not update an already installed owner runtime. Retained
`changes.json`, `selection.json` and the digest-bound plan distinguish comparison
paths from conservative selection; lockfile graph fallbacks name
`package-lock.json` in the recorded reason.

Landing checks dispatch through a detached check controller, so owner driver
work cannot starve GitHub polling. Read-only API failures retry within the existing
observation window. Progress includes the HTTP status when available; retained
`apiFailures` distinguish transport failures without an HTTP response from HTTP
errors, without retaining raw stderr or response headers.

New plans use the owner's `.forge/work/test-timings.json` history for both explicit
and automatic shard counts. Complete per-file runner reports update a local EWMA
(30% newest observation) when a passed or failed check receipt is reconciled;
cancelled and interrupted checks do not train it. The store prunes files absent
from the checked snapshot and retains at most 4,096 files and 1 MiB. A bounded run
ledger and a durable per-check marker make completion reconciliation idempotent.
No timing data is written to Convex or fetched over the network.

The shared partitioner assigns longest files first, modelling the runner's two
concurrent whole-file workers. Unknown files use historical p75; missing or corrupt
history preserves sorted round-robin. Ties use portable path order and shard index.
For receipt compatibility, membership remains in the digest-bound `modal-plan.json` and generated Actions
recipe; an existing run always reuses that plan after timing history changes.
`scripts/public-verify.mjs` and the landing benchmark use the same partitioner.
They read the local history path above, or an explicitly supplied
`FORGE_TEST_TIMINGS_HISTORY` file, and cover every selected test with either strategy.

The owner exports the immutable State and adds a generated
workflow and recipe to that export only. The exported commit is pushed only to
`refs/heads/forge-check/<runId>`, using a compare-and-swap creation. A changed or
colliding ref is never overwritten. Before pushing, Forge saves an ambiguous intent;
only a successful reply or observation of the exact commit establishes publication.
A transport error (HTTP 5xx, RPC/EOF, timeout or lost reply) retains that intent for
bounded discovery. If the exact commit becomes visible, Forge adopts it without
another push. After at least sixty seconds and five empty Git observations, Forge
can push the **identical commit to the same run-owned ref** again, using the same
expected-absent lease. Empty listings do not prove non-execution; the lease makes
the repeated ref creation safe even if the original push arrives later. A different
commit is never overwritten, including a race after the final observation.

Push attempts are capped at five across restarts, including definitively rejected
transient attempts. Each ambiguous attempt retains its discovery start time and
observation count; resuming a controller continues that window rather than
restarting it. Historical journals use retained branch-observation time and count
an unrecorded original attempt toward the bound. Exhaustion ends with terminal
infrastructure error `GITHUB_ACTIONS_PUSH_EXHAUSTED`, without a source verdict or
another pending discovery loop. Source and diagnostics remain available for a new
check after the underlying access or transport problem is resolved.

Explicit Git receive-pack rejections retain a `ref-rejected` class. Authentication,
permission and missing-repository rejections retain `access-rejected`. Workflow
OAuth scope, protected-ref/repository rules and invalid ref names have specific
classes and actionable `GITHUB_ACTIONS_PUSH_REJECTED` errors. They end discovery
immediately. Classification uses the original stderr before diagnostic truncation;
only redacted, bounded Git diagnostics are retained in attempts and progress.
Known-rejected transient creations use exponential backoff and jitter (up to
45 seconds in total), checking the exact ref before every retry. Cleanup and the
GitHub mirror retain their existing retry helper and exact lease/ancestry checks.
The source State, Candidate, definition, runtime,
selection and shard membership stay digest-bound. The journal also retains the
target repository and runner label so policy changes cannot redirect adoption.
Git-backed checks and declared environment/credential inputs keep existing local
routing. The source export rules for local credential configuration apply.
No owner token is sent in the plan or check environment; checkout does not retain
its credential, and raw gh/git error output is never logged. Failed Actions API calls retain only
the HTTP status and GitHub’s structured `message` and `documentation_url` fields
in the journal and progress log, with account identifiers and credentials redacted.
This includes transient reads and optional log/timing failures.

Before dispatch, the controller waits for GitHub's branch API to report the pushed
commit (up to sixty seconds of backoff). It records dispatch intent before sending
it and finds the execution by runId and commit. Dispatch HTTP 404/422 responses
are definitive rejections: the journal records the status, clears dispatch intent,
and retries up to five attempts with seventy-five seconds of total backoff.
Exhaustion records a failed check with `GITHUB_ACTIONS_DISPATCH_REJECTED` and its
HTTP status, rather than an interrupted check.

Ambiguous dispatch responses, including HTTP 400, transport failure, HTTP 5xx and
unknown status, preserve the original POST outcome. HTTP 400 uses a two-minute
lookup window (thirteen reads, ten seconds apart); other unknown or acknowledged
responses use twelve reads over at most five and a half minutes. The journal
retains the start and observation count across controller restarts. An exact
matching execution is adopted; duplicate matches remain an evidence error.
Exhaustion records terminal infrastructure outcome
`GITHUB_ACTIONS_DISCOVERY_EXHAUSTED`, without a source verdict. Legacy exhausted
journals get one final lookup. The run is no longer automatically reopened.
Empty listings never license another ambiguous or accepted POST: GitHub has no
idempotency key. If only the push reply was lost, observing its exact commit
permits the original `workflow_dispatch` once; a definitively rejected dispatch
can still retry as described above. The ref and original identities remain
available to inspect a late execution before starting a new check.

This is an evidence policy, not an exactly-once provider guarantee: Forge cannot
prove that an ambiguous POST or push did not execute. Only a retained definitive
rejection permits another dispatch. Push creation can also be repeated after its
bounded discovery window because its identical SHA and create-only lease preserve
the same ref effect.
Dispatch attempts retain sanitized response fields and `not-found`/`unprocessable`
rejection classes; branch evidence retains the observed commit or absence and
whether it came from Git or REST. Push attempts retain their timestamp, outcome, definitive
rejection class and redacted diagnostic without raw transport text. The journal retains discovery windows
and original attempts after adoption; they are not rewritten as successful replies.

When dispatch discovery remains unresolved or push observation is interrupted
before its persisted window completes, the legacy check-run status is `interrupted` with
structured error code `GITHUB_ACTIONS_PENDING_INFRA`. Finish and submission receipts
report `pending-infra`, `terminal:false`, `complete:false`, and retain the original
source/attempt identity. This is incomplete infrastructure evidence, not a source
failure. The landing batch stays resumable without splitting or blaming a Lane.
The owner driver or a replay of the same operation continues discovery. Retrying
the original `run-check` or interrupted `finish` reopens only unresolved provider
operations, including lost push replies, preserving source, run ID and landing-batch
pins. The previous interrupted receipt is retained beside `result.json` with an
`interrupted-<id>` suffix. Explicit cancellation does not authorize a replacement.
Unknown rerun outcomes are never repeated; shard replacement remains governed by
the existing adapter.
Read-only API calls back off up to sixty seconds between attempts; job polling
uses ten seconds. A GitHub rate-limit rejection never interrupts a check: the
controller waits until the reported `x-ratelimit-reset` (at least a minute, at most
an hour per wait), says so in progress, and continues. Because GitHub performed
nothing, a rate-limited dispatch, rerun or cancel is sent again after the wait; any
other rerun or cancel failure is still never repeated. Cancellation is observed after a
wait ends. A run reported completed while its job list still shows unfinished or
missing jobs is polled again for up to five minutes. If a job status remains stuck,
the controller fetches and retains its log. Complete `__FORGE_TESTS__` markers for
every selected file, or a complete Node test summary with consistent counts and
no failures or cancellations, can corroborate a successful run conclusion. Only
that combination recovers the stuck job as passing. The journal records the log
evidence source, counts and run conclusion; progress and the result receipt explain
that GitHub's job status was stuck and which evidence was used. Observed job
statuses and timestamps remain unchanged. Missing jobs, unavailable/truncated logs
and incomplete evidence remain interrupted, even when the run is green. Failure
evidence in the log or a failed run conclusion stays failed. Each shard status
transition appears in numbered progress.
Compact job evidence, including failure excerpts and machine test reports, uses `shards/<index>.evidence` and
`shards/static.log` layout, with attempt suffixes for retries. GitHub exposes job
logs after completion; this backend does not claim live stdout streaming.

Failed test jobs stay failed. Confirmed unfinished jobs (runner loss, timeout or
startup failure) can retry once individually; successful siblings are retained.
The rerun intent and original job ID are durable before the replacement request.
A lost rerun reply or a replacement missing from a later job-list window stays
`pending-infra`; the submission driver reopens the same run operation and adopts
the replacement job without another rerun. Original and replacement compact test reports and
cost observations remain separate. The run-owned ref stays retained while that
replacement is unresolved. Recovery uses the original source, definition, shard
selection, repository and runner label even if current runner settings change;
new settings apply to new operations. Durable recovery receipts explicitly wake
the owner landing worker, including before Work metadata reconciliation.
Unrecoverable incomplete runs are interrupted. A live controller requests provider
cancellation and observes the retained execution. If the local controller is dead,
the cancel command or worker recovery promptly writes a terminal `cancelled`
receipt and releases the submission. It retains provider identities and explicitly
reports that provider cancellation is unconfirmed; it does not claim the remote
execution stopped or delete its ref. An unresolved dispatch can also complete
local cancellation without waiting through discovery.
When a newer Candidate supersedes the checked Candidate in the same Intent and
Lane-input family, the controller cancels only the retained older execution.
Each new run retains the latest family Candidate when requested, so a fresh explicit
check of an older Candidate remains possible. Historical runs without that cursor
require a replacement timestamp strictly after their request to prove supersession.
The run keeps status `cancelled` with `cancellation.reason: "superseded"` and the
replacement Candidate ID; its receipt, execution ID and logs remain available.
Cancellation provenance optionally records the first request's timestamp, actor,
reason and details. Command cancellation accepts optional actor/tool attribution
and a reason. Observed controller signals retain their signal name; an external
sender is unknown. Historical records without these fields remain readable.
Queue a new run operation to check a cancelled Candidate again.

A failed job whose log has the runner's `exit code 137`, a SIGKILL/out-of-memory
error annotation or a kernel `Killed process` line gets a likely-OOM diagnosis
(exit 137); test names in passing logs do not count. This is not a
provider-confirmed memory measurement. The timing API remains in `backend.billableMinutes` for compatibility, but can
report zero for Blacksmith. `backend.cost` estimates each retained job attempt
from its start/end timestamps, rounds up to whole minutes separately and applies
the pinned per-label rate. Unknown timestamps or unpriced custom labels retain
unknown quantities, not zero. Blacksmith Ubuntu x64 defaults to vCPU/2 ×
$0.004/job-minute, before its shared free allowance. Override any label through
`checks.ratesUsdPerMinute`; see [cost basis and summaries](../operations.md#native-runner-selection). Selected output files are currently marked unavailable;
remote native process resource metrics are unavailable.

The result and compact test evidence are recorded before deleting a terminal run’s ref,
including failed and cancelled executions. Unresolved dispatches and reruns keep
their refs. Source, results, failure summaries and provider log links remain retained; full logs stay with GitHub Actions. Cleanup never deletes
a ref that no longer names this run’s commit; it uses the same exact Git lease
as ref creation. A cleanup error preserves the result and reports reconciliation
in progress. To restore a removed temporary branch, push the journal’s retained
`commit` from the retained plan’s `source` repository to `refs/heads/forge-check/<runId>`
using an empty-ref lease. No local fallback is inferred from an ambiguous outcome.

After an observed result, a best-effort sweep visits up to twenty local run records
and reconciles at most five eligible refs. Its disposable cursor rotates through
retained history on subsequent checks. Only locally terminal operations with a
matching retained plan, journal and result qualify. An execution must also still
match the run ID, commit and run-name and be terminal on GitHub. Definitively
rejected dispatches with no ambiguous recovery can be cleaned without an execution.
Live or reopened local operations, unknown dispatch outcomes, unavailable evidence,
other repositories and changed remote refs are preserved. The sweep uses retained
local ownership records rather than assuming every `forge-check/*` branch is ours.

Offline tests inject fake gh/API and Git transports; they never contact GitHub:

```sh
node --import ./tests/check-runtime.mjs --test tests/github-actions-backend.test.mjs
```

The lead can run one opt-in tiny synthetic smoke against a throwaway repository
with the dispatch workflow already registered (substitute `OWNER/THROWAWAY`):

```sh
FORGE_GITHUB_ACTIONS_SMOKE_REPO=OWNER/THROWAWAY FORGE_GITHUB_ACTIONS_SMOKE_RUNS_ON=blacksmith-2vcpu-ubuntu-2404 node --test --test-name-pattern='one real tiny Actions smoke' tests/github-actions-backend.test.mjs
```

`FORGE_GITHUB_ACTIONS_SMOKE_RUNS_ON` selects the smoke policy runner label and defaults to `ubuntu-latest`. Register the generated workflow with the same label on the target default branch first.

Run it without `tests/check-runtime.mjs`: that runtime isolates configuration
directories, so `gh` would see no login. On 2026-10-18 this smoke passed against a
private repository in about 29 s end to end (one static job).

This sends only synthetic source, creates a run-owned ref, dispatches one tiny job
and removes the ref after recording success. It does not land Forge source.

## Convex dispatch with the GitHub App

An App runner configured without a `credential` uses the Convex dispatch path.
`installationId` is optional: each operation resolves the selected repository's
App installation and mints a short-lived token with WebCrypto RS256. Existing
credential-reference runners retain the export/controller path; the
`FORGE_HOSTED_ACTIONS_CONTROLLER_*` seam is unselected for App runners.

`projectHostedActionsConfigure:configure` accepts `projectId` and a JSON `request`
containing `operationId`, `authorityEpoch`, `expected` (current configuration digest
or null), `repository`, and optional `runsOn`. It reuses the owner-only idempotent
configuration mutation and derives the runtime and environment fingerprint;
`runsOn` defaults to `ubuntu-latest`.
It accepts no installation ID or credential secret. Before writing, it derives the
repository's App installation (one read-only GitHub call, no token minted) and
refuses with `GITHUB_APP_PERMISSIONS` when the accepted installation permissions
lack Actions write or Contents read, for example while a permission request is
still pending approval. The CLI routes
`nforge agent ROOT configure-runner '{"provider":"github-actions","repository":"OWNER/NAME"}'`
to this action; the Mac provider continues through its existing configuration
path. `check-settings` reports the selected runner under `actions` (`app-direct`
or `legacy-credential`, repository, workflow and ref). Add `"runsOn":"blacksmith-4vcpu-ubuntu-2404"`
or `"runsOn":["self-hosted","linux","x64"]` to select your runner; omission selects
`ubuntu-latest`. Labels are nonblank strings of at most 256 characters with no
control characters, or an array of 1–100 such labels (all must match one runner).
The setting is stored in the existing runner configuration and included in its
configuration and environment fingerprints; changing it invalidates old evidence.
Invalid labels fail configuration before any GitHub request or settings write.
`check-settings.actions.runner` displays `runner: LABEL`; custom labels include
`(not GitHub-hosted: billed by your runner provider)`. This is based on standard
GitHub label names, not a live billing lookup: custom GitHub larger-runner labels
also get the provider notice. No runner is blocked based on this notice.

Hosted dispatch passes `runs_on` as a JSON string or array. Both hosted jobs use
`fromJSON(inputs.runs_on || '"ubuntu-latest"')` in `runs-on`. GitHub supports
[dispatch inputs in runs-on expressions](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#jobsjob_idruns-on).
The native/BYOCI jobs and generated single-label workflows retain their behavior.
OIDC accepts GitHub's `github-hosted` and `self-hosted` runner environments with
the same signature, repository, workflow, execution and SHA checks.

App JWT signing and installation-token minting live in one module,
`convex/githubAppToken.ts` (`installationToken(ctx, repo, permissions?)`), shared
with the hosted GitHub mirror. Check dispatch and cancellation request only
Actions write and Contents read.

Backend configuration needs `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY` (PKCS#1 or
PKCS#8 PEM), `GITHUB_WEBHOOK_SECRET`, `FORGE_HOSTED_CHECK_KEY_ID`, and its matching
`FORGE_HOSTED_CHECK_KEY_<ID>`. The existing object-store configuration is also
required. `CONVEX_SITE_URL` is Convex's system-provided site URL and the exact OIDC
audience. No callback key, App key, storage key, or source URL is sent in workflow
inputs or stored as a GitHub Actions secret. The existing App needs repository
Actions read/write, Contents read/write (the check token requests only read),
Metadata read, and the Workflow run event. Its webhook remains `/github/webhook`.

The checked-in workflow branches on `deployment`. Empty deployment preserves the
native/BYOCI `plan` input and export jobs. Convex dispatches on `main` with
`runId`, `projectId`, `deployment`, and JSON-encoded `runs_on`; the run name is `forge-check/<runId>`.
The fixed workflow checkout verifies and materializes the pinned Candidate using
hash/size-checked storage downloads, including recipe-backed content, in windows
of at most 400 descriptors. Three pages overlap resolution, verified streaming
downloads and disk copies; symlinks are created only after all pages succeed.
Failures drain in-flight pages before returning without publishing a plan.
Each completed page logs files, downloaded bytes and elapsed time. Source bytes
go directly from object storage to the runner. The Candidate is transferred once as an artifact, preserving modes and
symlinks. The plan and run pins remain outside the Candidate directory. Planning
reads source as data with the installed selector and shared eight-way partitioner;
existing default full selection remains full. Docs scope uses only the static job.
Arbitrary commands run once, including the existing composed Intent contract union.

The runner first sends the oldest session shape. The reply adds `capabilities`
alongside the existing run fields, so old runners retain their response shape.
Missing capabilities mean no extensions: results omit `testFiles` and planning
uses round-robin without requesting timing history. The shared list in
`src/hosted-actions-capabilities.ts` currently advertises `results.testFiles`,
`session.timingHistory` and `sourcePack`. A runner requests history only after that advertisement,
using one additional session request (two Convex function invocations per check).
Negotiated capabilities travel with the runner's plan artifact for its shards
and the optional pack refresh job.
The server still derives retained summaries from `contractReports`; the optional
`testFiles` field is a compatibility summary, not independent evidence. The runner
reads the session's `sourcePack` field and sends pack prepare/commit commands only
when the server advertised `sourcePack`. Without it, planning uses W2 full download
and skips pack refresh.
Backend and runner updates can be deployed in any order.

Command and result metadata strip unknown fields. The identity envelope, known
field types, logs, object pins and recipes remain strict. Refusals include a fixed
`reason` (`validation`, `authorization` or `storage`); the runner includes only
these codes in its error, never arbitrary response text.

The negotiated planning session includes the project's advisory timing history. Eight-way LPT partitioning models the two test workers on each
runner; unknown files use the historical p75, or the existing sorted round-robin
split when history is missing or invalid. Complete per-file reports already carried
by shard results train that history once when a check passes or fails. Hosted Mac
completions use the same store and algorithm. Cancelled and interrupted checks do
not train it. The indexed `projectHostedTestTimings` document uses the same JSON
format and EWMA as native `.forge/work/test-timings.json`, with `timingHistoryLimits`
(4,096 files, 128 runs, 1 MiB) and space reserved for the containing Convex document.
Native owner-local history is not automatically uploaded. On a missing hosted
history document, the session bootstraps from at most the latest passed and latest
failed hosted run's retained reports through their status indexes. With no usable
reports, planning uses round-robin. Partial hosted selections
retain earlier samples for unselected paths, bounded by those limits.

`/checks/actions` accepts only GitHub-signed OIDC tokens for this exact site audience,
repository, `forge-check.yml@refs/heads/main`, `workflow_dispatch`, first attempt,
and a GitHub-hosted or self-hosted runner. The execution ID must already be bound by the dispatch
response or an HMAC-verified Workflow run event; an arbitrary first JWT cannot
claim a Forge run. Every transaction rechecks original actor authority, source
authority epoch, fence, and execution. Results and compact log receipts are atomic
and idempotent. The supervisor passes no OIDC or provider credentials into project
commands. Full logs stay in Actions; Forge retains a redacted tail of at most
64 KiB per job through checksum-bound R2 PUT and verified commit.

A dispatch reservation is committed before GitHub IO. Unknown replies retain that
reservation and are never dispatched again. GitHub has no dispatch idempotency
key: a process failure between reservation and the HTTP call can therefore leave
zero executions, while a lost HTTP reply can leave one. Neither case silently
creates a second execution. The Workflow run event binds the original execution
when its dispatch reply was lost. Failed/cancelled/timed-out workflows, including
bootstrap failures before a plan exists, settle through that event; a successful
workflow without complete per-job evidence is interrupted, never passed. One
12-hour watchdog bounds a missing completion event and is cancelled on terminal
results. There are no project scans, active-run pollers, or idle scheduled functions.

For 3,000 raw source objects, a full nine-job check uses 87 Convex function
invocations including HTTP actions, nested functions, enqueue, dispatch and webhook;
a two-job scoped check uses 45, and docs-only uses 39. The formula is
`17 + 2 * ceil(sourceObjects / 400) + 6 * jobs`, including one Candidate/base
manifest window. With `results.inlineLog` the job term is `4 * jobs`, so a full
twelve-job check uses 81, the same as an eight-job check without it. Recipe metadata/leaves add their actual bounded descriptor
windows; issued download grants expire after five minutes. GitHub API and object
storage requests are separate from Convex function calls. A 6,000-object full
fixture budgets 101 calls. The added term is one pre-spawn query per job, with no nested call or active polling. Page concurrency does not change these call counts:
raw content needs one descriptor request per page (two function invocations,
including its HTTP action). Recipe and leaf windows are unchanged. Timing history
adds one indexed document read to the existing planning session and one read/write
to terminal result processing, with no per-file function calls or idle activity. The capability bootstrap adds
two function invocations per check when the server supports timing history.
Before the first history write, bootstrap adds at most two indexed run reads.
Plan retries can retain unused small storage objects;
this path adds no deletion or retention policy.

### Forge source packs

Hosted planning uses Forge source directly, without any GitHub mirror, Git checkout
of Candidate source, or GitHub source cache. The archive codec and verification
work with any runner provider; this workflow uses its existing Actions OIDC session
for authorized metadata and signed URLs. The control-tool checkout and Candidate
artifact transfer remain workflow bootstrap, independent of Forge source storage.

The existing planning session optionally returns `sourcePack`: the newest project's
`stateRef`, `objectKey`, `sha256`, `size`, `fileCount`, `createdAt` and a five-minute
signed GET. It reuses the negotiated timing-history session; no additional
pack session or polling is needed. Planning resolves the Candidate,
base and, if different, pack State through the ordinary hash-verified source path.
One pack GET seeds a job-private blob cache; only changed content uses W2's paged,
three-worker downloader. A fresh tree applies deletions, mode changes and path-type
changes, creates symlinks last, and hashes every final file/link against the Candidate
with Forge's SHA-256 digest. Cache inventory, size, checksum, State, gzip, or final
tree failures discard all extracted bytes and run the full W2 transfer. Older
servers without `sourcePack` use that same full path.

The deterministic format is gzip (level 1), containing a four-byte big-endian JSON
inventory length, the version/State/path/mode/blob/size inventory, then exact file
bytes in sorted path order. It avoids tar's platform-specific metadata, extensions,
and link/path extraction rules; only verified hash-named cache files are written.
It is bounded to 300 MiB compressed, 1 GiB file bytes, 32 MiB per file, 100,000 files
and a 16 MiB inventory. Larger source remains checkable through W2; only caching
is skipped. Packing and hashing stream disk files; extraction buffers at most one
bounded file plus the inventory. There is no persistent runner-local cache.

When there is no usable pack, or the delta exceeds 300 paths or 10% of Candidate
content bytes, the optional `hosted-pack` job runs alongside the check shards after
matrix and Candidate artifact publication. It uses that artifact to seed its cache,
fetches any missing accepted-base blobs, verifies them, and packs the pinned accepted
base rather than speculative Candidate source. Its failure does not fail the check.
It uses separate `sourcePack` prepare/commit commands only after advertisement.
Servers without that capability receive no pack commands, and their checks use
the existing source/plan/result shapes.

`projectSourcePacks` holds one small indexed document per project, including newest
metadata and a second slot for a previous pack or reserved upload. Reservations
precede PUTs; conflicting refreshes skip, including after interrupted uploads.
A create-only, checksum/length-bound PUT grants one computed project/State/digest
key. Commit checks R2 HEAD size/checksum and repeats current session authorization.
The previous or abandoned slot is deleted before its next replacement, after its
15-minute signed PUT plus two-minute transfer grace has expired. Failed deletion
retains the slot and skips refresh; later refresh retries it. At most two pack
objects are tracked, with no idle calls, sweeps, timers or schedulers. Latest pack
metadata is never removed by that cleanup. Every consumer independently verifies
its inventory and bytes against immutable Forge State source.

For 6,000 unique raw files with 20 changed blobs and a pack of the base, planning
uses two source requests (one manifest window and one delta window), versus W2's
sixteen. Including HTTP actions and nested mutations, session/source/plan totals
are eleven versus thirty-nine function invocations; source itself is four versus
thirty-two. R2 reads are 23 GETs (pack, two manifests, twenty blobs), versus 6,002.
A different pack State adds one manifest request/GET. Recipe-backed content adds
its actual bounded descriptor and storage windows. The negotiated timing-history session adds one indexed
pack-document read; unchanged-pack planning writes no pack metadata.

A refresh adds two HTTP requests / five function invocations, one PUT (Class A)
and one HEAD (Class B), plus missing-base descriptor pages and blob GETs. Replacing
an old slot adds one nested mutation and one DELETE (free); the DELETE must succeed
before another object is reserved. Fallback adds the attempted pack/manifest reads
to ordinary full-download costs; a final verification failure can also repeat the
already downloaded delta. Check result/log operations remain unchanged.

The 100–300 MB GET + unpack + full verification + twenty-blob delta is expected to
take roughly 5–25 seconds at 25–100 MB/s with local SSD storage and two vCPUs,
excluding runner/tool bootstrap and Candidate artifact transfer. This is an
estimate, not a hosted measurement. Two packs add about 200–600 MB per project,
with a hard compressed maximum of 600 MiB. At R2 Standard's $0.015/GB-month this is
about $0.003–$0.0094/month amortized, before free allowance and account-level billing
rounding; requests also have free allowances. See [R2 pricing](https://developers.cloudflare.com/r2/pricing/).
There is no new paid provider or mirror dependency.

Without a usable pack, planning reads objects with 16 concurrent GETs per descriptor
window (the paged descriptor calls are unchanged) and logs a line naming the repair
action. Pack download and unpack also log progress. `hosted-plan` stops after 30
minutes, `hosted-check` shards after 90 and `hosted-pack` after 20, instead of
GitHub's 6 h default.

### Source packs outside checks

Signed-in clients read the same pack. `projectSourcePackClient:latest` (project
reader, one mutation, writes nothing) returns the latest pack with a signed GET.
A Lane open, sync or clone that misses 500 or more objects downloads that pack once,
writes every object whose bytes match its own digest, and fetches only what the
pack lacks through the paged object path. Older servers, a missing pack or any pack
failure fall back to that object path. The checkout is still verified file by file.

`nforge x ROOT source-pack {}` is the operator repair and backfill. It reads current
hosted main, fetches its objects through the pack, machine-store and object paths,
builds the deterministic pack locally and publishes it with
`projectSourcePackClient:publish` (owner or contributor; prepare signs one PUT for
the current main head only, commit verifies R2 HEAD and promotes it into the same
`projectSourcePacks` slots). It returns `status: current` when the latest pack
already matches main. Run it after a seed, cutover or import of a large repository;
later checks then refresh the pack through `hosted-pack`. Calls: one `latest`
mutation, two actions (four nested mutations), one PUT and one HEAD.

Clients also keep one machine-wide object store,
`${XDG_CACHE_HOME:-~/.cache}/forge/objects` (`FORGE_OBJECT_CACHE` moves it, `off`
disables it; test processes leave it off unless set). Files are content-addressed,
owner-only and written with temp-and-rename, so concurrent processes need no lock.
Each checkout root clones (APFS/Btrfs) verified objects from it into its private
cache, so a second Lane of the same project reads no bytes from R2 and makes no
object signing call. Nothing evicts it yet; a collector can delete any file at any
time, because readers verify each digest and refetch on a miss.

Deploy additive schema/backend support first, then publish the runner modules,
script and workflow together. The first successful full check seeds a base pack;
subsequent checks can use it. An old runner ignores the optional response; a new
runner on an old backend completes via W2 and skips pack publication. Qualification
of real R2 throughput, signed checksum headers and Actions job scheduling remains
an operator task.

Deploy this backend and publish this workflow on GitHub `main` before configuring
the App runner. Keep the Mac interim selected until one hosted Candidate completes
with exact shard evidence and its failure/cancellation paths have been qualified.
Then change the runner configuration with its expected digest; already-enqueued
Mac runs keep their original configuration and execution owner. Acceptance policy
and outbound GitHub mirroring are independent prerequisites and are not changed
by configuring this runner.


### Warm hosted Actions jobs and optional setup

The App/OIDC workflow uses free `ubuntu-latest` runners by default. Its existing
`hosted-plan` job restores `control/node_modules` and the npm download cache using
SHA-pinned `actions/cache`, keyed by OS, architecture, Node 24.22.1 and the control lockfile hash.
A miss runs `npm ci --ignore-scripts`. Only the trusted planning job saves this
cache; test and source-pack jobs restore it read-only. Candidate source, plans and
check results are never cache entries. Lockfile changes create independent keys;
there are no partial-key restores. Cache loss changes preparation time only.

Planning builds control `dist` once and includes it in the existing run artifact.
Shards and the optional source-pack job unpack that build beside the exact
`github.sha` control checkout. Candidate installs/builds still use Candidate code
and its lockfile; the shared control build is not evidence for Candidate tests.
There is no additional serial build job. Cache archives contain dependencies only;
monitor Actions cache storage across old lockfile keys when comparing the roughly
1 GiB cache budget. This workflow does not introduce a cache deletion policy.

Hosted test shard counts use the existing per-file timing history and two-worker
LPT estimates. When capacity is idle the planner picks the smallest count predicted to
fit 150 seconds of tests per shard, or the slowest single test file when that is longer:
no shard can finish before its slowest file, so more shards past that point only spend
runner minutes. The count is also capped by Convex calls per check: jobs times calls per
job stays within 48 (eight jobs at six calls, the cost before results carried their log).
A server advertising `results.inlineLog` takes the bounded log inside the result call,
so a job makes four calls (preflight query, result action, output and result
mutations) and a check may use twelve jobs; older servers keep six calls and eight jobs.
A result whose request would crowd the 512 KiB metadata window keeps the separate
output upload. The runner setting `concurrencyBudget` includes the static job and
defaults to twelve (eleven test jobs); test jobs never exceed twenty.
Planning is serial; an optional pack job is additional.
Configure it through the existing owner command, for example:

```sh
nforge agent ROOT configure-runner '{"provider":"github-actions","repository":"OWNER/REPO","concurrencyBudget":12}'
```

On standard GitHub-hosted runners, planning samples this workflow's queued and
running checks once: two Actions read requests, at most twenty records and 1 MiB
per response, with a five-second deadline and no pagination or polling. The Free
organization job cap is twenty. Repo demand is a lower bound on organization
demand; unrelated workflows/repos can also occupy those slots. The automatic
workflow token receives Actions read permission only in planning and never enters
Candidate code. Unavailable or malformed samples retain timing-only planning;
self-hosted runners do not use this Free-hosted capacity sample.

With competing checks, the planner compares all counts up to the idle target.
It models throughput as occupied test slots divided by predicted runner time:
slots are `min(20, activeChecks * testShards)`; runner time includes the sum of
two-worker shard estimates plus one minute per test job and the three possible
non-test jobs (plan, static, pack). The minute is a conservative preparation
estimate, above the observed 23-second p75 before test execution, not measured
test evidence. Ties prefer fewer jobs. This favors fuller shards under a deep
queue instead of spending more job-minutes chasing an isolated wall target.
For example, a fifteen-check queue selects two test shards for the recorded full
workload instead of eight; a small scoped workload still needs one. The selected
groups remain digest-pinned. This is a planning estimate, not an org reservation
or a new admission rule; GitHub enforces its actual concurrency limit.

Without timing history the planner falls back to at most eight round-robin shards within that budget;
unknown test files use historical p75. Every selected file remains in the plan.
A long individual file or a saturated budget can exceed the target; the planner
never drops tests or turns a failed test green to meet a duration. Contract tests,
changed tests and composed-Intent unions retain the existing gate selection.
This planning/cache work adds zero Convex function calls or idle activity.

A hosted check definition may declare an optional Actions preparation command:

```json
{"name":"verify","executable":"node","args":["scripts/forge-check.mjs"],"environmentLabel":"Node 24","actions":{"setup":{"executable":"/opt/forge/warm-cache","args":[]}}}
```

`actions.setup` belongs to the App/OIDC Actions supervisor, including when that
workflow uses a self-hosted runner. Other runner providers do not use this
Actions-specific option. The definition digest includes the command. It runs once
per check job, before the selected check, with the same credential-free child
environment, in an external cache directory. `FORGE_SOURCE_CACHE_DIR` names that
directory (the runner-provided value, or a run-local temporary directory). Setup
can warm npm downloads, a sticky disk or an already installed cache integration;
it does not install or select a vendor. The check command receives the directory
as well. Relative cache paths are resolved once by the supervisor so setup and
tests use the same directory. Setup output is not test evidence and its exit status is advisory: a
missing executable or failed cache warm continues through the cold path.

The supervisor verifies the artifact State hash against the exact run head, then
checks Candidate paths, hashes and modes before and after setup and rechecks the
execution plan. Added, removed or modified source fails the check before tests
start. Cache preparation must keep its files outside Candidate source. This is
source verification under ordinary OS rights, not a sandbox against a malicious
process with access to supervisor files or other account resources.

To qualify performance after installing the workflow, run the same full Candidate
and definition twice through normal Forge finish/check operations: first with a
new lockfile cache key, then with the same key. Record each Actions run URL,
Candidate/control heads, gate, selected file count, matrix, cache hit/miss, job
start/end times, dependency preparation, artifact transfer and test duration.
Compare cold and warm critical-path wall time and total runner minutes with run
40852593458 (722 seconds wall, plan 86 seconds, slowest shard 628 seconds).
Use the same timing history and workload for a causal comparison; contract gates,
batch unions and concurrent organisation jobs can change both counts and queue
latency. Keep the shared-build path only if its measured net critical path drops.
Repeat with a scoped Candidate to assess the five-minute target. These checks use
existing free GitHub-hosted Actions; no paid runner, idle service or vendor is
needed.

### Hosted cancellation

Cancelling a hosted landing releases its check in the same transaction. Abandoning
a Lane uses this same cancellation path for its live submissions. A queued,
checking or ready submission that still pins the check keeps it live, including
another member of a batch. Replacing an attempt releases its old check as well.
Once the last live submission leaves, the check is terminal `cancelled`; signed
results cannot revive it. Runner sessions, control, heartbeats and results refuse
cancelled checks with `CHECK_CANCELLED`, and the Actions HTTP endpoint returns
403 with the non-secret reason `cancelled`. Old runners already stop on that 403.
The new Actions runner checks live permission before spawning tests and prints
`Forge check cancelled.` with exit zero for cancellation.

The existing OIDC planning session supplies a run-specific signed preflight ticket
in the `X-Forge-Actions-Preflight` response header, leaving the oldest session JSON
shape unchanged. The fixed supervisor retains it beside the plan, outside the
project command environment. A shard calls the read-only
`projectHostedActionsPreflight:check` query once before spawn. This is one Convex
function invocation with no HTTP action, nested function, refresh or polling. It
verifies the ticket, current actor/authority epoch and exact execution/fence, then
returns only active/cancelled. The ticket uses a separate signature domain and
grants no source access, result publication, provider IO or signing authority. Its
lifetime inherits the original run; it introduces no additional expiry or user step.

The `session.preflight` capability gates this query and all its request fields.
A new runner on an old server uses the original saved-plan path and existing
result refusal points, sending no unsupported query or new session fields. An old
runner on a new server ignores the header and retains its existing 403 stop behavior.
Deploy the backend before publishing the new runner modules and supervisor script.

Direct App-backed Actions cancellation schedules one provider cancel action. It
uses the existing project/repository binding and an installation token requesting
`actions: write` and `contents: read`. The action consumes its reservation before
IO, sends the cancel endpoint once, and tolerates 409 when the workflow has already
completed. An unknown network outcome is not resent. Dispatch acknowledgements or
requested/in-progress webhooks arriving after cancellation can bind the retained
run ID and schedule the same cancellation without reviving the check. Completed
webhooks for a cancelled check leave its state and scheduling unchanged.

An explicit check-run cancellation stops the selected run even when live landing
requests reference it. Cancelling an individual landing stops its check only after
the last live consumer leaves.

The Actions mid-shard stop bound is **GitHub cancellation latency**: the provider's
run-cancel mechanism stops running jobs, normally in seconds; no fixed latency is
asserted by the local fakes. Actions has no new heartbeat or file-boundary polling.
The existing 60-second request deadline bounds a stalled pre-spawn/result request;
it prevents spawn on an unknown preflight outcome. It is not an active Actions
lease and does not kill an already-running child after 60 seconds. Mac and Forge
G9 self-hosted workers keep their existing 20-second heartbeat/subscription stop,
with their last acknowledged 60-second lease as fallback for a hung heartbeat.
Actions jobs on self-hosted labels use GitHub cancellation, like other Actions jobs.

Direct cancellation uses its mutation plus one scheduled action and one claim
mutation (three invocations), independent of shard count, plus one workflow-cancel
POST and existing App token acquisition. Before dispatch there is no provider call.
The planning header adds zero calls; preflight adds one call per shard because the
restored shard had no session/lease call before spawn to fold it into. Results keep
their existing call path. For a plan with eight test shards plus static, the routine check delta
is **+9 calls**, or **+12 including the complete cancellation operation**; relative
to an old explicit cancel operation, the marginal cancel plumbing is +2. Adaptive plans use the actual number of test jobs plus static; pack refresh adds
no preflight query. Existing repository-binding and App-token lookups remain
additional. No new timers, crons, polling or idle function calls were added. Legacy credential-adapter observation/cleanup
retains its prior call and retry behavior.

Installed App permissions and real-provider stop latency require operator
qualification; the local tests use synthetic installations only.
