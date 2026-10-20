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
its credential, and raw gh/git error output is never logged.

The controller records dispatch intent before sending it and finds the execution
by runId and commit. An unknown dispatch or rerun outcome is never repeated.
Read-only API calls back off up to sixty seconds between attempts; job polling
uses ten seconds. A GitHub rate-limit rejection never interrupts a check: the
controller waits until the reported `x-ratelimit-reset` (at least a minute, at most
an hour per wait), says so in progress, and continues. Because GitHub performed
nothing, a rate-limited dispatch, rerun or cancel is sent again after the wait; any
other mutation failure is still never repeated. Cancellation is observed after a
wait ends. A run reported completed while its job list still shows unfinished or
missing jobs is polled again for up to five minutes before it counts as interrupted. Each shard status transition appears in numbered progress.
Completed job logs, including failures, use the existing `shards/<index>.log` and
`shards/static.log` layout, with attempt suffixes for retries. GitHub exposes job
logs after completion; this backend does not claim live stdout streaming.

Failed test jobs stay failed. Confirmed unfinished jobs (runner loss, timeout or
startup failure) can retry once individually; successful siblings are retained.
Unrecoverable incomplete runs are interrupted; requested cancellation cancels the
retained Actions run and records cancellation only after observing it terminal.
A failed job whose log has the runner's `exit code 137`, a SIGKILL/out-of-memory
error annotation or a kernel `Killed process` line gets a likely-OOM diagnosis
(exit 137); test names in passing logs do not count. This is not a
provider-confirmed memory measurement. Job API timing records rounded billable
minutes per job, including attempts, in `backend.billableMinutes`; no dollar price
is inferred for custom runner labels. These estimates are separate from Modal
allocation estimates. Selected output files are currently marked unavailable;
remote native process resource metrics are unavailable.

The result is recorded before deleting a successful run's ref. Failed/interrupted
refs and local source/log evidence remain for diagnosis, matching Modal's retained
failure artifacts. Cleanup never deletes a ref that no longer names this run's
commit. A cleanup error preserves the result and records the remaining action in
progress. Undo the published temporary source by deleting only the recorded
`forge-check/<runId>` branch after diagnosis. No local fallback is inferred from an
ambiguous remote outcome.

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
