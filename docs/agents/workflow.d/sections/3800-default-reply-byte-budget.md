### Default reply byte budget

Landing replies name the CLI build in `cliCommit`. When the local preflight gate
uses a run, the local landing receipt keeps `localPreflight` with the number of
test files, the outcome, elapsed seconds, and whether the run was reused. The
operation journal keeps that evidence for a replay even if a later preflight
updates the Lane's latest result.

The deterministic ledger `tests/fixtures/agent-reply-budget.json` ratchets UTF-8 JSON
bytes, including the newline, for each common CLI reply. The landing test
`tests/agent-reply-budget.test.mjs` fails any growth; change a ceiling only with its
Issue, source and reason. These synthetic fixtures measure context bytes, not
provider tokens, billed usage or command latency.

| Reply | Before (bytes) | Default ceiling (bytes) |
| --- | ---: | ---: |
| start | 254 | 254 |
| save | 200 | 200 |
| sync | 174 | 174 |
| resolve | 1,183 | 1,183 |
| land | 314 | 314 |
| wait | 371 | 371 |
| conflict | 47,557 | 1,522 |
| preflight | 15,555 | 577 |
| board | 1,117 | 552 |

Conflict defaults retain paths, kinds, marker-hunk counts (`null` when the body
was unavailable), source pins, the working folder, recovery command and undo.
Preflight retains selected/deferred counts, tier counts, reason, estimates and
outcome; failures and exact recovery commands stay. Board list reads render each note
once rather than repeating its structured row; explicit `board {"id":"NOTE_ID"}`
keeps the complete note and replies by default. `board {"all":true}` reads history.

CLI `--detail` returns every field and available inline body. For a mutation,
replay the original command with its original operation id; for a plan use
`preflight {"run":false} --detail`. MCP accepts `replyDetail:true` in the command
on `forge_task`, `forge_check` and `forge_work_overview`, and at the top level on
`forge_wait`. Full detail changes rendering only, including on safe replays; it
never changes the action, source pins or acceptance semantics.

Cost: zero added Convex calls, DB reads/writes or R2 requests per action; idle
zero. Shaping visits the existing reply once and copies metadata proportional to
that reply; conflict content is scanned for ordered marker triples without another
file read or body copy. Actor board cursors are small local files shared by this
clone's Lanes, scoped by a hash of the authenticated actor and project. Supported
servers apply the project cursor in the existing indexed page read. Older servers
may still return old project notes on the wire, where the client filters them.

MCP tools/list grows by 56 UTF-8 bytes (5,685 → 5,741, including the accepted Issue aliases) for the four reply-detail selectors; advertised description bytes stay at 675. No action or CLI command is added.
