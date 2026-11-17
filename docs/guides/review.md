# Review and land a change

Review the saved source and the check for the exact result that will reach main.

## Read the change

Open a Lane to read its files, saves and check evidence. Saved source excludes the agent's unsaved edits. With the CLI:

```sh
nforge agent ROOT status '{"laneId":"LANE_ID"}'
nforge agent ROOT diff '{"laneId":"LANE_ID"}'
nforge agent ROOT show '{"laneId":"LANE_ID","path":"README.md"}'
```

Follow `nextCursor` with the same pinned selection when a diff is partial. Missing graph edges do not prove two changes independent. [Line provenance](../agents/workflow.md#hosted-reads-and-coordination-limits) describes retained evidence and its gaps.

## Check and land

`land --save` saves, updates from main, composes the result and checks it under project policy. Review-required or protected work waits for the configured person's approval. A person should read what changed and the evidence before answering the held request.

```sh
nforge agent ROOT land --save '{"laneId":"LANE_ID","message":"Describe the change"}'
```

Wait on the receipt until it says `LANDED` or gives terminal recovery. Keep its accepted State and receipt. Nothing should be described as on main from a passed check alone.

## When a check fails

Read the receipt's failing files and provider link. Retained output is available with the run id:

```sh
nforge agent ROOT log '{"runId":"RUN_ID","tail":8192}'
```

Fix the cause in the same Lane, run affected checks and land again. Keep the failing evidence; do not weaken a test to make it pass. For a composition conflict, use the exact resolve or sync command printed by the receipt and retain both contributors' intended changes. [Agent recovery](../agents/workflow.md) gives the full sequence.

## Documentation changes

Projects that opt into `docsPaths` use the existing [docs-only admission rules](../pre-queue-checks.md#docs-only-paths). Reading or changing docs does not introduce a new full-check requirement. Documentation readers and static inventory checks still guard the changed files.
