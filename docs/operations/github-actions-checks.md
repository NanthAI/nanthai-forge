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
plan as Modal; a positive shard count explicitly partitions all selected test files.
Every standard check runs one independent static job. Docs-only candidates run
only documentation checks in that job, with no test shards. Code candidates use
the same scoped selection as local and Modal checks; explicit full scope and
post-accept main audits retain full verification. Test matrices use fail-fast
disabled. Both call `node scripts/forge-check.mjs`; the Actions plan
selects static verification or `scripts/test-files.mjs` with Modal's selection and
worker environment. Node is 24.19.0. Each job installs with `npm ci --ignore-scripts`.
Arbitrary commands run once in the static job. Candidate sources must include the
Actions-aware standard check script to use standard sharding.

The owner exports the same immutable State used by Modal and adds a generated
workflow and recipe to that export only. The exported commit is pushed only to
`refs/heads/forge-check/<runId>`, using a compare-and-swap creation. A changed or
colliding ref is never overwritten. Check-ref creation and cleanup retry recognized
transient Git failures with at most five attempts, using exponential backoff and jitter
(up to 45 seconds of total backoff). Each attempt observes the exact remote ref:
an already-completed push succeeds without another push; different source is an
error. Progress reports each retry. Transient failures include GitHub's remote
`(failed)` or `(internal server error)` rejection, HTTP 5xx, RPC/EOF and connection
failures, and rate limits. Authentication, permission, protected-ref, stale-lease,
non-fast-forward and missing-repository failures stay immediate errors. Exhausted
creation retries interrupt the retained run for reconciliation. The GitHub mirror
uses the same retry helper while keeping its original exact lease and ancestry
check. The source State, Candidate, definition, runtime,
selection and shard membership stay digest-bound. The journal also retains the
target repository and runner label so policy changes cannot redirect adoption.
Git-backed checks and declared environment/credential inputs keep existing local
routing. The shared Modal export rules for local credential configuration apply.
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

An ambiguous HTTP 400 dispatch gets a two-minute lookup window (thirteen reads,
ten seconds apart). If it stays empty, the same check verifies branch visibility
and makes one fresh complete branch query before reserving its single recovery
dispatch. A run appearing at either lookup is adopted without another dispatch;
any other run on the branch prevents recovery. The recovery allowance is saved
before sending and survives process restarts. A rejected recovery does not settle
the original ambiguous request and never authorizes another recovery.

Other ambiguous dispatch responses (transport failure, HTTP 5xx or unknown status)
keep the longer lookup window. If that window ends without a run,
a later retry of the same operation may send one recovery dispatch, only after
another lookup window and a fresh complete branch query confirm zero runs.
Historical stranded dispatch journals use the same recovery. Retrying the original
`run-check` or interrupted `finish` operation reopens only this unresolved-dispatch
case, preserving its source, run ID and landing-batch pins. The previous interrupted
receipt is retained beside `result.json` with an `interrupted-<id>` suffix.
The journal records
the recovery allowance before sending; further ambiguous retries only observe.
An acknowledged dispatch is never sent again, and duplicate matching runs remain
an evidence error. Unknown rerun outcomes are never repeated.
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
Completed job logs, including failures, use the existing `shards/<index>.log` and
`shards/static.log` layout, with attempt suffixes for retries. GitHub exposes job
logs after completion; this backend does not claim live stdout streaming.

Failed test jobs stay failed. Confirmed unfinished jobs (runner loss, timeout or
startup failure) can retry once individually; successful siblings are retained.
Unrecoverable incomplete runs are interrupted; requested cancellation cancels the
retained Actions run and records cancellation only after observing it terminal.
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

The result and collected logs are recorded before deleting a terminal run’s ref,
including failed and cancelled executions. Unresolved dispatches and reruns keep
their refs. Source, results and local logs remain retained. Cleanup never deletes
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
