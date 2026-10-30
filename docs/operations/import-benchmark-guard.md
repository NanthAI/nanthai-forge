# Scheduled import benchmark guard

The opt-in benchmark harness in `scripts/benchmark-import-guard.mjs` stops a
named temporary project's scheduled import/index work when observed executions
exceed 300 per minute for three consecutive completed minutes, or reach 5,000
for the run. These are benchmark stop conditions, not project quotas. Normal
imports never invoke the guard or its internal cancellation mutation.

## Running a benchmark

Use `runGuardedImportBenchmark(options, workload)` from a benchmark script. Pass:

- `url` and `adminKey` for the selected DEV deployment's read-only provider log
  stream, plus a deployment-admin authenticated `admin` Convex client for the
  internal control functions. Supply credentials in memory; never log them.
- The ordinary authenticated project `owner` client. Deletion calls the existing
  `projectLifecycle:permanentlyDelete` owner mutation, with its operation/revision
  fence; the admin client does not bypass deletion authorization.
- An exact temporary project `name` and either its `projectId`, or the
  `creationOperationId` passed to `projectGithubImport:start`. The latter arms
  observation before import creates the project. Its creation marker pins the
  resulting project ID by both original operation key and name. Same-name peers
  with another creation operation do not match.
- A `workload(signal)` callback that starts and awaits the benchmark, including
  source/view measurements. Honor the signal to stop its local clients. An
  optional `stopWorkload` callback can terminate a local child process. The
  scheduler cancellation works independently of the importing client's lifetime.

The helper initializes the log cursor before starting the callback. On completion,
workload failure, a rate/total breach, or lost telemetry, it stops local work,
cancels scheduled import/index work, requests the already-approved permanent
removal, and observes the tombstone. R2 maintenance remains the existing deletion
prerequisite; a blocked purge is a failure, never successful cleanup. Do not run
this harness against a project whose deletion has not been approved.

The lower-level `importBenchmarkGuard` exposes `observe`, local `tick`, `stop`,
`confirmDeleted`, and `report` for an existing harness. Retain the guard object
and its cancellation/deletion operation identities across unknown replies;
`stop` replays the same deletion operation and original revision. Pass a mutable `journal` and a `saveJournal` callback that atomically saves it
before mutation IO. Restoring that journal in a new process reuses the original
delete request and expected revision. It restores cleanup pins, not missing
telemetry coverage. The high-level helper is one finite session, not a durable daemon.

## Attribution and counting

Shared project-access helpers emit `FORGE_PROJECT_EXECUTION` with project ID,
name and creation key after authorization, at most once per invocation/project.
Denied requests emit only the project ID the caller already supplied. Scheduled index
cleanup and deletion entry points emit the same marker. No source, function
arguments, credentials or error text are copied into the harness report.
Provider request IDs connect the marker to the action's internal calls; early
child completions are buffered until their request is attributed. Normal
project access adds no function calls or database writes for attribution.
New index cleanup schedules retain the project ID alongside the generation ID,
so they remain attributable and cancelable after a generation is retired. Legacy
payload retirement resolves its generation with one bounded read.

All attributed Completion events count, including failures and retry attempts.
Transport replay is deduplicated by request/execution identity, timestamps and
retry number. Cached query completions count as invocations too. Shared deployment calls
remain separate. The monitor retains at most 20,000 request identities and
20,000 execution identities; reaching its local telemetry capacity stops the
benchmark with an explicit coverage failure. This bounds harness memory and
changes no product capability.

The internal `projectBenchmark:cancelScheduled` mutation scans at most ten
system scheduler rows with a 512 KiB provider read window per invocation. Ten rows also bound selected identity reads when legacy jobs
contain near-1 MiB cursors, below the provider transaction read window. The scan uses the project's creation time as its
creation-time lower bound. This includes work scheduled before the monitor
started, while avoiding scheduler history older than the project. It resolves `projectGithubImportWorker:run` through
the import job ID, and index `retire`, `retirePayload`, and `sweep` through their
generation/project IDs. New index continuations keep that project identity even
after the generation row is gone. Foreign tasks and deletion continuations remain intact.
Replaying a page is harmless. There is no dependency on worker cursor internals.
Index builds themselves are currently caller-driven; stopping the callback and
project deletion fence further index writes.

[Convex scheduler cancellation](https://docs.convex.dev/scheduling/scheduled-functions#canceling-scheduled-functions)
prevents pending work from starting. An in-progress action may finish, but its
future scheduled descendants are canceled. The guard therefore waits for
cleanup and draining calls before proving five uninterrupted minutes without a
project-attributed execution. A late completion, including a failure, resets that
window. Progress and parent execution IDs retain outstanding actions until their
Completion arrives; five minutes of log silence during a long-running action
cannot pass. After the tombstone observation, proof uses only local timers and the
provider log HTTP stream: **zero Convex function calls while idle**. A stream
failure, stalled read or unfinished deletion cannot produce a passing proof.

This is an observed-execution stop trigger, not a hard billing reservation.
Concurrent/in-flight work and the cancellation/deletion calls can overshoot the
threshold before stopping; the report continues counting them. Reserve the
preflight cleanup allowance within the run budget and report the actual total.
The provider stream must run continuously from before workload start; an old,
truncated log sample cannot establish complete run usage.

## Cost model and synthetic checks

For S small scheduler rows created since project creation, cancellation takes
`ceil(S/10)` calls (one empty page when S=0), reads S scheduler documents,
at most S selected job/generation documents, and one project document per page.
Large argument rows can reduce the page count below ten and increase calls.
It performs at most S scheduler cancellations and writes no source/job records.
The scan includes shared deployment scheduler rows, so S is not a per-project
estimate. Project status is one selected document/read per explicit observation;
deletion uses the existing paged cleanup path and its storage-dependent cost.
No timer, cron, server poller or per-source-file guard execution is installed.

The synthetic runaway check observes 5,000 executions with 1,000 failures and
1,000 scheduler rows, cancels the running chain in 100 bounded calls, runs the
real deletion handlers, and checks no pending jobs and no idle function calls.
A separate fixture covers 1,500 scheduled index jobs, foreign-work isolation,
rate breach, unknown replies and blocked deletion. Run these without live
accounts:

```sh
npm run build:core
node --import ./tests/check-runtime.mjs --test --test-concurrency=1 tests/benchmark-import-guard.test.mjs
```

The test reports numeric retained metadata size and wall duration. It does not
measure live Convex billing, provider action peak memory, or real cleanup latency.
