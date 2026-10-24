# The improvement loop

Friction belongs in structured owner Work, outside source files. Concurrent Lanes
append independent records through the existing owner transaction; source sync
never merges a shared friction paragraph. Reports and triage decisions are retained.

```sh
nforge agent ROOT friction '{"laneId":"LANE_ID","title":"Check interrupted","detail":"Runner stopped during validation","area":"checks","cost":{"minutes":8,"retries":1},"workaround":"Ran the affected tests locally","evidence":["RUN_ID"]}'
nforge improve ROOT
nforge improve ROOT --json
nforge agent ROOT friction-triage '{"frictionIds":["FRICTION_ID"],"status":"planned","reason":"Next runner slice"}'
```

`laneId`, `cost`, `workaround` and `evidence` are optional. Costs are self-reported;
missing cost stays unknown. Keep sensitive source and credentials out of reports.
Every mutation accepts `operationId`; after an unknown reply, replay the same
request with its returned `resolved.operationId`. Changed inputs with the same id
fail explicitly. CLI and MCP use the same actions: `forge_task` handles `friction`
and `friction-triage`; `forge_work_overview` handles `improve`.

Groups use area and title after Unicode normalization, lowercasing, punctuation
removal and word sorting. They make no model calls. Open groups rank before
planned, fixed and dropped groups; within each status, occurrence count, reported
minutes and reported retries rank descending, with a deterministic key tie-break.
Each group retains its individual reports, first/last seen, cost, ids and fixing
Lanes. Fixed reports can coexist with fresh open reports in the same group.

Triage accepts `planned`, `dropped`, `fixed` or `open`. Dropping a report requires
a reason; other decisions may include one. `fixed` names `laneId`. `open` reverses a prior decision without erasing it.
A fixing Lane can cite `frictionIds:["FRICTION_ID"]` in `start` or `finish`.
Triage derives closure only from a later accepted Channel receipt whose Candidate
includes that Lane, including combined Candidates. Checking, completing or
abandoning a Lane does not close cited friction. A later explicit triage decision
can reopen a report.

Forge records interrupted or infrastructure-failed checks and pending sync
conflicts in the same Work transaction as their outcome. Superseded landing
batches and finish landing bounces also produce records. Exhausted Work retries
in agent workflow phases are reported with retry cost when the owner lock is
available. Diagnostic capture outside a source transaction is best effort: if
unavailable, stderr says so and the source outcome is preserved. Ordinary test
assertion failures do not become infrastructure reports. Automatic reports use
stable operation/class identities, so reading or replaying a result does not
multiply occurrences. Finish/land receipts invite further detail only after
observed retries or bounces. Triage never runs checks, accepts code or changes
project policy.

Transaction capture compares immutable page and record hashes, inspects only
changed run headers, and reads the first input only for a reportable run. It
leaves unchanged run pages and retained run histories unhydrated and never
backfills historical failures.

The [principles](../principles.md) explain how reports guide product work.
