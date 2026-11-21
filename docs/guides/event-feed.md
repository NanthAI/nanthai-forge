# Connect a host to Forge events

Run a watcher from a hosted checkout with a Forge CLI sign-in that has write
access to the project. An agent host or CI bot can read the JSON lines on
standard output.

```sh
nforge watch ROOT --json
nforge watch ROOT --mine --json
nforge watch ROOT --lanes LANE_ID --queue --json
nforge watch ROOT --on-landing './scripts/settle-landing'
```

The default selection is the project. Use `--mine` for Lanes you hold or
`--lanes ID,ID` for up to 32 exact Lane IDs. `--kinds KIND,KIND` selects
event types. `--queue` adds position changes for one Lane, selected by a
single `--lanes` ID or the Lane checkout at ROOT.

| Kind | What happened | What to read |
| --- | --- | --- |
| `landing.landed`, `landing.failed`, `landing.cancelled` | An original landing reached its outcome | Wait for its operation ID |
| `check.passed`, `check.failed` | A check-only run reached its outcome | Wait for its run ID |
| `queue.moved` | The selected queued landing's position changed | Wait for its operation ID |
| `lane.attention` | A note reached the Lane's inbox | Read the Lane board |
| `lane.saved`, `lane.closed` | A saved head moved or a Lane closed without landing | Read the Lane status |
| `feed.gap` | The saved watch cursor was older than the 14-day event retention | Re-read the Lane list |

Each line has a version `v`, a stable `id`, the `kind`, a millisecond
timestamp `at`, and the identifiers relevant to the kind. The structured
`resume` field contains an agent action and its input. The CLI also renders
it as `command` with ROOT. Use your configured checkout and the structured
fields when launching a read from a host. The read resolves the original
operation and gives its current authoritative receipt. Landing and check
events can appear once for each input Lane in a combined submission.

Deduplicate by event ID. If one downstream task should run per combined
landing, also deduplicate that task by `operationId`. The same ID can be
replayed after a crash, including a crash between a hook's side effect and
its local acknowledgement. The host should persist its own deduplication
together with its side effect.

Use `--on-landing CMD` for all three terminal landing kinds or
`--on-event CMD` for the selected project events. The command runs in
the watch process's working directory. It receives one JSON event on
standard input, plus `FORGE_EVENT_ID` and `FORGE_EVENT_KIND`. Its output
goes to the watcher's standard error so the watcher's JSON lines can be
parsed independently. A failed hook is retried after 1, 5 and 30 seconds.
After those attempts, the next watch of the same selection retries the
retained hook with the configured command.

The CLI keeps its cursor and undelivered hook records in the Forge state
directory for the signed-in account, deployment, project and selection.
It uses one live query, reads continuation pages only for backlog and
closes the connection on SIGINT or SIGTERM. While the selected data is
idle the subscription performs no calls. The live cursor follows database
commit order because a row's `_creationTime` is assigned before commit and
can arrive behind rows a watcher already read. The feed holds identifiers and
statuses. Read the canonical landing, check or board record with your
own credentials for details. Wide landing and Intent cascade events
can arrive after the canonical change through existing completion
batches. See [how the hosted feed is emitted](../architecture.md#hosted-project-feed).
