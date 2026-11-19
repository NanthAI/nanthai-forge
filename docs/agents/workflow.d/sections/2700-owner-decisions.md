## Owner decisions

Record a decision on this project or an Intent with `decide`; read records with
`decisions`. MCP uses `forge_task` action `decide` and `forge_work_overview` action
`decisions`, with the same command fields and native Work records.

```sh
nforge agent OWNER decide '{"operationId":"UUID","target":{"kind":"intent","intentId":"INTENT_ID"},"decidedBy":"Owner","what":"Use the focused contract check","why":"Keep the implementation loop short","overrides":{"kind":"default","description":"Full-suite landing gate","link":"docs/workflows.md"}}'
nforge agent OWNER decisions '{"target":{"kind":"intent","intentId":"INTENT_ID"}}'
```

Use `target:{"kind":"project"}` for project decisions; omit `target` when listing
to read all decisions. `decidedBy` names the decider; `actor`/`tool` optionally
attribute the entering agent, and `requester` records the local caller. These are
local declarations, not authenticated hosted identities. `at` is recording time;
`decidedAt` defaults to it or accepts a historical ISO day or timestamp.

`overrides` names a default (`kind:"default",description,link?`) or an earlier
decision (`kind:"decision",decisionId,link?`). `supersedes:DECISION_ID` marks an
earlier decision superseded with a link to this replacement; it also supplies a
decision override if none is given. Earlier records remain unchanged. Multiple
explicit replacements all remain linked. Replay the original `operationId` and
inputs after an unknown outcome; changed inputs return `WORK_OPERATION_CHANGED`.

Intent briefs include active project and Intent decisions with their overrides,
and briefly list superseded decisions and replacement IDs. `handoff-read` returns
the same current decision context beside the retained delivery note. Decisions
are context; recording one does not change policy, grant access or enable the
behavior it describes. Native portable Work export/restore retains these records.
The optional additive `decisions` collection uses version-1 decision records and
requires no Work format bump. Existing checkpoints without decisions stay unchanged.
