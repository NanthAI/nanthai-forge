# Manual Modal check spike

This is an experiment, not a registered Forge check backend. It does not deploy an
application or change acceptance policy. The controller uses the owner's existing
Modal login locally; it passes no secrets, host environment, volumes or tunnels to
check containers. Source-only exports are validated against a digest-verified
native State before upload and again in the remote image before compilation.

Build core locally through the shared build slot, then export an exact State:

```sh
node scripts/modal-spike/export.mjs OWNER EXACT_HEAD NEW_DIRECTORY NEW_MANIFEST
```

Debian bookworm Git 2.39.5 rejects `--no-lazy-fetch`; the image explicitly checks
that capability before installing dependencies. GNU `/usr/bin/time` is also required
by the resource-observation fixture; omitting it produces a deterministic failure.

Run with Modal Python SDK 1.6.2, first with `--shards 1` (three smoke files), then
with 4, 8 and 16 after checking billing:

```sh
python scripts/modal-spike/runner.py --source NEW_DIRECTORY --manifest NEW_MANIFEST \
  --head EXACT_HEAD --output NEW_LOCAL_RESULTS --shards 1
```

An optional `--tests-file FILE` accepts a retained local selection (a JSON array of
test paths) for exact selected-suite parity. The full experiments omit it.

Each run builds/reuses a Node 24.19.0 Debian trixie image with Git 2.47.3 and
GNU time, dependencies keyed by the exact package and lockfile bytes, and the
compiled native source snapshot.
Each test shard requests two physical cores and 4 GiB; two test files run at once.
`FORGE_MAX_CONCURRENT_CHECKS=2` preserves two fixture check slots. With the
CPU-derived default of one slot, `agent-clean.test.mjs` starts an endless check
and waits for a second check before cancelling the first, so it deadlocks.
The isolated case passes with the existing two-slot configuration.
A sibling container runs the unmodified verifier's complete static steps with an
empty test selection. Together these execute every full-verification step.
Files are assigned round-robin in sorted order. Shards use the unmodified
whole-file supervisor, including its failure handling.
The check runs as the sandbox main command, with control-plane completion and logs.
An earlier exec-based attempt suffered repeated connection/service errors during
exit-status observation. Per-file timings are included in the main-command log
before exit, avoiding another exec call after completion.

The 900-second container lifetime and fixed resource ceilings bound this manual
experiment's spend; they are not proposed product limits. Containers terminate in
`finally`. An interrupted controller can leave a sandbox alive until that timeout.
The controller records image/installation, source upload/image preparation,
compilation/image preparation, sandbox creation API latency, test/static execution,
and total time. Execution includes sandbox readiness and command startup; provider
queue/boot time is not independently isolated.
Image phase times include API and snapshot overhead; pure network transfer and
installation CPU time are not independently isolated. Allocation cost estimates
exclude image builds and egress: billing API receipts are authoritative.

## Proposed integration

Add a backend adapter at the existing check preparation/execution boundary. Keep
View composition, policy, scope selection and acceptance on the owner. Pin the
View head, check definition, selection, operation ID and runtime/image fingerprint
before starting remote work. Export only the selected State's files and manifest;
verify their content hashes remotely. Key the dependency image by lockfile, Node,
platform and tool versions. Preserve the exact scoped file list when distributing
files, balance them using recorded whole-file durations, and run every static
check once.

The authenticated owner process alone starts runs through its saved Modal
credentials. Do not expose a public run endpoint or pass owner/hosted credentials
to containers. Stream numbered progress and log chunks back through the owner,
bound to run ID, source digest and shard identity. Retain file counts, exit codes,
runtime identity and artifacts with the exact checked digest. Reconcile an unknown
outcome using the same operation and remote execution IDs instead of starting a
duplicate. Cancellation terminates all retained sandbox IDs.

Checks that require owner-local secrets retain local execution, with the route and
reason recorded.

Use local execution on remote infrastructure failure, recording an explicit new
attempt and runner identity. A test failure remains a test failure. Never silently
change source, selection or runtime. Existing acceptance still requires exact-View
evidence; this experiment supplies none to Forge's acceptance records.

## Environment-dependent coverage

The clean image skips two Chromium fixtures and three legacy-CLI/store
compatibility fixtures because their external binaries/modules are absent. No
Modal-specific test exclusions are added. Git, temporary filesystem operations,
loopback ports, child processes, GNU time and two fixture check slots are required.
Image preparation uses public Docker/Debian/npm services; live Convex validation
is outside this experiment. Measurements are one completed run per shard count,
with preparation caches warm, not a repeated statistical benchmark.

[Measured results](RESULTS.md) · [Machine-readable measurements](results.json).
