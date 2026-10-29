# Modal checks

Modal and Actions share the owner's bounded per-file timing history and deterministic
partitioner. Complete terminal checks train the local EWMA; new plans balance whole
files across each shard's two workers, with p75 for unknown files and round-robin
when no history exists. Retained plans preserve their original shard membership.
See [timing history and plan replay](github-actions-checks.md) for storage and
public-verification details.

The native owner selects the backend through project autonomy policy:

```sh
nforge agent OWNER set-policy '{"checks":{"runner":"modal","credentialsRef":{"kind":"env","tokenId":"PROJECT_MODAL_ID","tokenSecret":"PROJECT_MODAL_SECRET"}}}'
nforge agent OWNER set-policy '{"checks":{"runner":"local"}}'
```

Owners without this setting keep local execution. Forge's rollout selects Modal
on its canonical owner; switching back to local changes subsequent runs. Existing
runs retain their selected backend and exact inputs. Finish, Playbooks and owner
check requests share the same check execution boundary.

The owner installs Python Modal SDK **1.6.2** in
`~/.local/venvs/forge-modal`, or selects its Python with `FORGE_MODAL_PYTHON`.
The SDK receives only the explicitly referenced project's token values, with an
empty config instead of the owner's default account. Configure `checks.credentialsRef`
with environment variable names or an absolute external local JSON secret file
containing `tokenId` and `tokenSecret`; values never enter Work or hosted storage.
Missing project credentials return `MODAL_CREDENTIALS_REQUIRED` without local
fallback. See [runner selection](../operations.md#native-runner-selection). There is no deployed
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
is added and verified afterward. Runtime is Node 24.22.1 on Debian trixie with Git,
GNU time and Python 3 (for bridge contract tests), two CPUs and 4 GiB per test or arbitrary-command sandbox, with a fifteen-minute lifetime. Arbitrary commands use their recorded
arguments; owner Node paths map to this recorded remote Node runtime. Commands
requiring other owner-specific executables must use local policy.

The bridge refuses new image builds and sandbox launches whose retained Node
runtime differs from the fixed image. Existing executions can still be collected
or cancelled under their original identity; old-runtime retries need a new check.

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
Docs-only and arbitrary commands do not retry for OOM. A failed standard test shard retries once on the same pinned image and Candidate, retaining both attempts. Test-failure, OOM and stall recovery share one retry per shard, including across adoption; they never stack into a third attempt.
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
child there instead of the machine-wide pool. Numbered controller progress is retained as
`controller-summary.txt` (4096 characters). Plans, execution IDs, log cursors,
source exports and terminal receipts remain in `.forge/work/check-<run>/` for
reconciliation. Full stdout/stderr stay with Modal. Each execution retains
compact test reports and bounded failure excerpts in
`check-<run>/shards/<index>.evidence`; static evidence uses `static.evidence`, and
retry evidence uses `<index>.attempt-2.evidence`. `test-reports.json` is the
portable compact sidecar used by timings and coverage readers.

Failed receipts and finish output retain failing shard/attempt identities, named
failures and a bounded error excerpt (4096 characters). Only each shard’s latest
attempt determines its failure summary; earlier attempts remain attributable for
flake analysis. The agent log action returns the provider-held disposition,
execution IDs, provider link and retained failure summary, rather than full log
bytes:

```sh
nforge agent OWNER log '{"operationId":"RUN_ID","shard":0}'
nforge agent OWNER log '{"operationId":"RUN_ID","shard":"static","attempt":2}'
```

Older bridge
observations without shard identity retain their provider execution IDs and links; they do not invent shard evidence.

Restart reuses completed shard receipts and observes saved sandbox IDs. It replaces only confirmed stopped incomplete standard work and the recorded test-failure/static-OOM retries. A creation with an unknown response is
never repeated. Recovery completion explicitly wakes the owner landing worker
after its result receipt is durable; a missed filesystem event or delayed Work
publication does not require the submitter to redo passing shards. Recovery keeps
the original plan, image, shard membership and credential-use reference; current
settings do not replace those attempt pins. Cancelling records a local control file and terminates retained
sandboxes through the owner-side SDK. For unaccepted Candidates, a newer Candidate
in the same Intent and Lane-input family cancels the superseded Candidate's retained execution through
that same control file. New runs retain the latest family Candidate at request time,
so a fresh explicit check of an older Candidate can run. Historical runs without
that cursor require a strictly later replacement timestamp to prove supersession.
The receipt keeps status `cancelled`, optional
`cancellation.reason: "superseded"`, the replacement Candidate ID and execution
IDs. Cancellation provenance records an observed request's timestamp and reason,
plus actor/details for command cancellation or the observed controller signal.
An unobservable external sender stays unknown; historical records omit these
optional fields. Queue a new run operation to check a cancelled Candidate again.
Modal and local cancellation polls defer a
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
same retained Candidate and plan before publishing a terminal receipt. Completed shards
are retained. Intermediate interruption receipts stay separate so finish observers
do not mistake active recovery for completion. Source, Candidate, definition, selection,
shard membership, command, artifacts and runtime are digest-bound; changing a
retained recipe refuses adoption.

## Flakes and quarantine

Standard test shards emit per-file, named test reports, including nested test
names. A failed shard may retry once; a named test that passes after a shard retry has a
`recovered` verdict, never a clean verdict. Original exits, named results and
attempt summaries and test reports remain available, with full logs held by Modal. A recovery on a change that touches the test or
its statically identified code is labelled **Recovered, related change**, never
`flake`. Missing source or inconclusive impact data stays recovered with unknown
cause. A shard retry alone does not establish flakiness. A file retry inside one supervisor execution uses the exact same Candidate bytes and records a flake directly, including the first error and both attempt durations; see [file retry budgets and reporting](../operations.md#flake-evidence-and-quarantine).

A `flake` verdict needs another completed run of the same named test and check
runtime/definition: a failure or recovery on unchanged source bytes, or a recovery
across unrelated changes. Changed paths and the conservative test-impact selector
supply this evidence; missing edges do not prove independence. Receipts record the
source relationship and supporting run ID. Legacy flake labels without this
evidence do not count toward quarantine. Two supported flake verdicts within
seven days quarantine that exact file/test identity and list it in Needs you.
Recovered tests do not count toward quarantine and still block landing.
Quarantined tests continue running; attributed failures become non-blocking only
when the current source comparison is unchanged or unrelated to that test.
Failures on related changes, unknown source relationships, static checks,
unrelated tests and incomplete or unattributed reports continue to block.
Receipts retain actual process exit codes, including nonzero exits for
non-blocking quarantined failures. A named failure outside the effective ledger
has verdict `failed`; `quarantined` applies only when all attributed failures can
use the ledger for this source comparison.

OOM (137) or a confirmed stopped sandbox without a named test failure, followed
by a complete passing report for every selected file on the same pinned
Candidate/plan, is a clean infrastructure recovery. Its attempts and
infrastructure reason stay recorded, without recovery or quarantine ledger input.
A named failure before that recovery follows the recovered-test behavior. A
nonzero test process exit without attributed failures still blocks even if its
retry passes; an incomplete passing retry report cannot exonerate an
infrastructure failure.

Twenty consecutive clean test passes release quarantine; failures, recoveries and flakes
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

`agent status` includes `modalCost`: the current UTC month's Sandbox
compute **estimate (conservative)** and run count, including charges retained before a local fallback.
`legacyRuns` counts runs without quantity records. It is **not billed spend**:
workspace credits, discounts, taxes, subscription charges and unrelated usage are
unknown locally. Historical allocation estimates stay identifiable; Forge does
not halve them or assume a credit balance to match a dashboard number.

New shard journals record worker elapsed seconds and the corresponding physical
core-seconds and GiB-seconds. The request and limit are both two physical cores
and the selected 4/8/16 GiB memory, so billed resources are the request (Modal bills
`max(request, actual)`). Each recorded attempt contributes once, including failed
attempts and retries; controller adoption never adds a second copy of its quantities.
Worker elapsed time excludes controller queues, reconnection and log draining.
Older journals use controller elapsed time, bounded by the Sandbox's 900-second
lifetime, and label that basis explicitly. Worker timing excludes container
startup/teardown. New plans pin `MODAL_COST_SAFETY_MARGIN` (1.15) from
`src/modal-cost.ts`; each usage record retains that multiplier. The formula is
`1.15 × Σ(seconds × (requested cores × CPU rate + requested GiB × memory rate))`,
using fractional worker seconds and counting each distinct execution once,
including cancelled and failed attempts. Resources are reserved, not sampled
process CPU/RSS: using less than the request does not reduce Sandbox billing.
Controller-time fallbacks retain their explicit basis and 900-second bound.
The margin supplies headroom for unmetered startup/teardown; it does not establish
an upper bound on an invoice or cover unknown image-build/egress charges. Older
plans and receipts without a retained margin keep their original estimate.

After `npm run build:core`, a read-only back-test is available locally:

```sh
node scripts/modal-cost-backtest.mjs OWNER YYYY-MM-DD
```

It reads pinned Work run records and retained execution journals, without loading
the SDK or contacting any service. The date is inclusive, in UTC. It reports old
estimates, missing journals/worker measurements and controller intervals exceeding
the Sandbox lifetime. A complete recomputed total is `null` if any priced run
lacks the necessary worker measurements; partial known costs are reported
separately. Controller timestamps and TAP file durations cannot recover billed
runtime. The 15% margin targets modest overestimation on measured compute; its
accuracy against actual spend remains uncalibrated until matching usage and
billing evidence exist.

The published [Sandbox prices](https://modal.com/pricing) are
$0.00003942/physical-core-second and $0.00000667/GiB-second, with minimum requests
of 0.125 physical cores and 128 MiB. [Resource billing](https://modal.com/docs/guide/sandbox-resources)
uses the higher of request and usage; there is no minimum usage-time increment
([billing](https://modal.com/docs/guide/billing)). An 8 GiB allocation adds
$0.00002668/second over 4 GiB for equal runtime; a 16 GiB retry costs
$0.00018556/second in addition to its first attempt. These estimates exclude image
builds and egress. Failed preparation or unknown outcomes may have unrecorded
charges. Modal billing and the owner's existing spending cap are authoritative;
Forge adds no spending limit.

Selected output files stream back with offsets and verified hashes; unsafe or
missing outputs remain explicitly unavailable. Native process resource metrics
are unavailable remotely and are reported separately from compute cost.

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
