# Modal checks

The native owner selects the backend through project autonomy policy:

```sh
nforge agent OWNER set-policy '{"checks":{"runner":"modal"}}'
nforge agent OWNER set-policy '{"checks":{"runner":"local"}}'
```

Owners without this setting keep local execution. Forge's rollout selects Modal
on its canonical owner; switching back to local changes subsequent runs. Existing
runs retain their selected backend and exact inputs. Finish, Playbooks and owner
check requests share the same check execution boundary.

The owner installs Python Modal SDK **1.6.2** in
`~/.local/venvs/forge-modal`, or selects its Python with `FORGE_MODAL_PYTHON`.
The SDK reads the owner's existing local Modal credentials. There is no deployed
function, public trigger, hosted token, shared volume or tunnel. Only an
authenticated process on the owner machine starts remote checks. Credentials and
SDK diagnostics are never sent to check containers or copied into check logs.
Checks with declared environment/credential passthrough stay local. Snapshots
containing local credential configuration (`.env` files other than `.env.example`,
`.npmrc`, `.netrc`, `.modal.toml`) are never uploaded. They use local execution only
when local fallback is enabled for owner-originated work; otherwise the run reports
`runner-unavailable` with instructions to select a runner explicitly.
Git-backed checks retain local execution.

Each run records its requested/actual backend and any fallback reason. Before
upload, the owner pins the native State digest, check definition, exact test
selection, lockfile hash and runtime recipe. It materializes only that immutable
State, excluding owner metadata, dependencies and credentials. Both the owner and
remote image verify source bytes against the digest-verified State. Dependency
image layers use only package/lockfile bytes and `npm ci --ignore-scripts`; source
is added and verified afterward. Runtime is Node 24.19.0 on Debian trixie with Git,
GNU time and Python 3 (for bridge contract tests), two CPUs and 4 GiB per test or arbitrary-command sandbox, with a fifteen-minute lifetime. Arbitrary commands use their recorded
arguments; owner Node paths map to this recorded remote Node runtime. Commands
requiring other owner-specific executables must use local policy.

The standard `scripts/forge-check.mjs` definition uses the installed impact
selector on immutable source. Full checks balance whole files across sixteen
shards; scoped checks use fewer shards. Recorded file durations inform longest
file first balancing; missing timings have equal weights. Static checks run in a
sibling sandbox with 8 GiB, at most two concurrent verification commands and
`NODE_OPTIONS=--max-old-space-size=3072`. Local verification keeps its existing
parallelism unless `FORGE_STATIC_WORKERS` is explicitly set. Exit 137 (including
SIGKILL of a verification child) reports **out of memory (137)**; this is a likely
OOM diagnosis, not a provider-confirmed memory measurement. A completed non-docs
standard shard with that exit retries once at 16 GiB. The original execution and
its cost remain recorded; the latest attempt determines that shard's outcome.
Docs-only and arbitrary commands do not retry for OOM. A failed standard test shard retries once on the same pinned image and View, retaining both attempts. Test-failure, OOM and stall recovery share one retry per shard, including across adoption; they never stack into a third attempt.
Plans pinned to the older 4 GiB runtime keep that allocation and do not acquire
the new retry behavior when adopted.
OOM attempts do not publish artifacts that a retry would supersede. Docs-only checks retain the documentation checks, including
interaction static checks. The check does not invent test exclusions.

The detached App context stays open until every shard has completed and its logs
and process exit code have been collected. Normal App context exit stops running
sandboxes, so it happens only after collection. Each shard durably retains its exit code as soon as collection completes,
without waiting for sibling shards, and reports it in progress and the terminal receipt.
The controller polls process status every five seconds with a ten-second RPC deadline.
A broken stream or 45 seconds without output triggers re-observation of the same
execution ID; a completed process whose log streams do not close also triggers recovery.
If reconnection cannot recover collection, the controller confirms termination before
retrying only the incomplete standard-check shards once on the same image. Stall recovery and OOM recovery share one retry per shard: a replacement cannot
receive another retry through either path. Stall replacements keep their recorded
memory allocation; OOM replacements use 16 GiB. Completed
shards and all attempt IDs/costs stay retained. Observed nonzero process exits remain
failures even when log collection is incomplete. Arbitrary commands and artifact-bearing static jobs do not create replacement executions. With the current pinned runtime, adoption reuses completed exits without contacting their sandboxes and reconnects retained running executions; confirmed stopped incomplete standard shards may be replaced only within the same one-retry budget. Unknown creation remains interrupted. Exhausted recovery records an infrastructure interruption. Unknown creation or termination never authorizes
replacement work or local fallback.
Explicit provider capacity/concurrency rejections wait and retry admission; unknown
creation outcomes remain interrupted and are never retried.

Remote checks have a separate machine-wide admission pool of four; they never
consume local check slots. When `FORGE_CHECK_QUEUE_DIR` selects a private queue
root (including test fixtures), Modal admission uses a separate `modal-check-queue`
child there instead of the machine-wide pool. Numbered progress and streamed stdout/stderr appear in
`.forge/work/check-<run>/`. Plans, execution IDs, log cursors, source exports and
terminal receipts remain there for reconciliation. Each execution also retains a combined
stdout/stderr log under `check-<run>/shards/<index>.log`; the static job uses
`static.log`. Retries use `<index>.attempt-2.log` or `static.attempt-2.log`,
while the existing run-level stdout/stderr logs continue to include every shard.
Failed receipts and finish output include a bounded summary with failing shard
indices, attempt log paths, TAP `not ok` test names and the first error-block
lines from that shard's log. Static failures without TAP include the last output
lines. Only each shard's latest attempt determines its failure summary.

Read one shard through the existing agent log action (the run id is `operationId`):

```sh
nforge agent OWNER log '{"operationId":"RUN_ID","shard":0,"tail":4096}'
nforge agent OWNER log '{"operationId":"RUN_ID","shard":"static","attempt":2,"tail":4096}'
```

Shard reads combine stdout and stderr; `attempt` defaults to 1. Older bridge
observations without shard identity retain their run-level logs.

Restart reuses completed shard receipts and observes saved sandbox IDs. It replaces only confirmed stopped incomplete standard work and the recorded test-failure/static-OOM retries. A creation with an unknown response is
never repeated. Cancelling records a local control file and terminates retained
sandboxes through the owner-side SDK. Modal and local cancellation polls defer a
transient `SOURCE_CHANGED` record-read race until the next tick. Other polling
errors interrupt the Modal controller or fail the local run through its normal
completion path, preserving the error instead of throwing from a timer.

Missing auth and unreachable Modal record `runner-unavailable`; billing/budget
exhaustion records `runner-budget-exhausted` when remote termination is confirmed.
The default `checks.fallback: "manual"` never automatically runs these candidates
locally. These terminal, retryable infrastructure outcomes are not failed tests;
finish returns recovery instructions. Opting into `checks.fallback: "local"`
preserves local fallback for owner-originated work only. Contributor imports,
external PRs and their parent/dependency candidates never automatically fall back
locally. See [runner fallback](runner-fallback.md) for policy commands and retry
semantics. A failing check remains failed. An uncertain creation or termination
remains interrupted and does not start duplicate local work. Controller
interruptions retain the error message in numbered progress and receipt details,
with credentials and filesystem paths outside the installed package redacted;
stacks are not recorded. Local fallback retains the original source and check
definition, records its route and uses ordinary local admission.

Other infrastructure interruptions receive one automatic recovery attempt on the
same retained View and plan before publishing a terminal receipt. Completed shards
are retained. Intermediate interruption receipts stay separate so finish observers
do not mistake active recovery for completion. Source, View, definition, selection,
shard membership, command, artifacts and runtime are digest-bound; changing a
retained recipe refuses adoption.

## Flakes and quarantine

Standard test shards emit per-file, named test reports, including nested test
names. A failed shard retries once; a named test that passes after failing has a
`flake` verdict, never a clean verdict. Original exits, named results and attempt
logs remain available. OOM (137) or a confirmed stopped sandbox without a named
test failure, followed by a complete passing report for every selected file on
the same pinned View/plan, is a clean infrastructure recovery. Its attempts and
infrastructure reason stay recorded, without flake or quarantine ledger input.
A named failure before that recovery retains the flake behavior. A nonzero test
process exit without attributed failures still blocks even if its retry passes;
an incomplete passing retry report cannot exonerate an infrastructure failure. A flake blocks until the test is quarantined. Two flake
verdicts within seven days quarantine that exact file/test identity and list it in
Needs you. Quarantined tests continue running; only their completely attributed
failures become non-blocking. Static checks, unrelated tests and incomplete or
unattributed reports continue to block. Receipts retain actual process exit codes,
including nonzero exits for non-blocking quarantined failures.

Twenty consecutive clean test passes release quarantine; failures and flakes
reset the streak. The ledger derives from retained run receipts and deduplicates
run IDs. Explicit fixes are retry-safe owner-local records:

```sh
node scripts/check-quarantine.mjs OWNER list
node scripts/check-quarantine.mjs OWNER fix OPERATION_UUID "tests/example.test.mjs :: test name"
```

Reuse the operation UUID after an unknown reply; it cannot name a different test.
An explicit fix clears the named test's streak and flake history; two later flakes
can quarantine it again. Local fix records live beside check output and are not
part of portable Work. The next completed Modal check refreshes the quarantine
snapshot used by hosted Needs you; a local fix alone does not publish hosted Work.
Older candidate sources without named reports retain their failures; quarantine
never guesses which tests failed from interleaved console output.

`agent status` includes `modalCost`: the current UTC month's recorded allocation
estimate and run count. Each completed remote run retains its estimated compute
cost. Selected output files stream back with offsets and verified hashes; unsafe
or missing outputs remain explicitly unavailable. Native process resource metrics
are unavailable remotely and are reported separately from compute cost.
Estimates use each sandbox's recorded memory allocation (older execution journals
default to 4 GiB) and two CPUs. At the published sandbox rates, 8 GiB adds
$0.00002668/second ($0.0016008/minute) over 4 GiB for equal runtime; a 16 GiB retry
costs $0.00018556/second ($0.0111336/minute), in addition to its first attempt.
Concurrency changes can change wall time; no runtime savings are assumed. Estimates
exclude image builds and egress and are not billing receipts. Failed preparation
or unknown outcomes may have unrecorded charges. [Modal billing](https://modal.com/pricing) and the owner's
existing spending cap are authoritative; Forge adds no spending limit.

Tests mock the Modal client. Remote admission uses `modal-check-queue` under
`FORGE_CHECK_QUEUE_DIR` (default `~/.forge`), independently of the local test
queue; `tests/check-runtime.mjs` points it at a temporary directory. A single tiny
real smoke is opt-in:

```sh
FORGE_MODAL_SMOKE=1 node --import ./tests/check-runtime.mjs --test \
  --test-name-pattern='one real tiny Modal smoke' tests/modal-backend.test.mjs
```

It exports synthetic source, runs one short Node command and asserts the recorded
allocation estimate is under $0.05. It is excluded from ordinary tests. No full
suite, deployment or hosted source publication is part of this smoke.
