# Approved hosted command parity

Issue 657d63ee-249a-44ae-94e2-55549f84eea9 owns this approved disposition:
**5 MIGRATE, 22 FOLD, 5 DROP**. The table names implementation targets, not
additional supported hosted commands. The [hosted contract](workflow.md#hosted-command-contract)
remains the authority for availability; implementation slices keep the parent Issue open.

Forge has one client mode: hosted. The native-owner mode is removed, so no row is
reachable through a native root any more. A folder without a hosted marker is refused
with `FORGE_ROOT_UNAVAILABLE` and the next step `nforge host ROOT`. Every name below
that is not a hosted action refuses with `HOSTED_ACTION_UNSUPPORTED` and names the
hosted command that does its job (`retiredActions` in `src/agent-verbs.ts`).

- **Shipped hosted actions:** `diff`, `peers`, `log` and `records`. `log` uses
  the retained-output reader from both CLI and `forge_check`. `records` uses one
  current-authorized canonical page (100 heads and descriptors, no body hydration)
  or an exact `id`/`version`, under `forge_work_overview`. Continuations keep their
  original project, collection and filter; source references pin immutable bytes.
- **`provenance`** remains an approved MIGRATE row, pending its canonical
  Candidate/head read under `forge_review`. Legacy imported view reads do not
  establish parity for current Candidates.
- **FOLD rows** refuse and name their replacement; the replacement jobs that are
  not built yet keep their owning Issues (`save.delivery` for handoffs, Lane undo
  e7812d8f, session reports 40ad7abd).
- **DROP rows** (`view`, `views`, `save --preview`, `x undo-revert`, `x guidance`)
  are removed from the CLI, MCP and docs. Stored wire names (`viewId`) are unchanged.

| Command | Agent job | Decision | Replacement or target action | Owning Issue |
| --- | --- | --- | --- | --- |
| `diff` | Inspect selected changes | MIGRATE | Paged diff with exact Lane/Candidate/State pins; exact bytes through `show` | 5283a92f |
| `peers` | Coordinate edits to a path | MIGRATE | Bounded Lane/path peer read; reused by the first-write hook | 5283a92f; e6f4b0a6 |
| `review` | Review pinned changes | FOLD | `diff` summaries/hunks and `show`; distinguish local unsaved bytes | 5283a92f |
| `candidate` | Inspect one checked integration | FOLD | `status {candidateId}` with bounded inputs and check/acceptance pointers | 657d63ee |
| `candidates` | Find a Lane's integrations | FOLD | Lane status latest pointer and all participation pages through `records` | 657d63ee |
| `view` | Use the old Candidate spelling | DROP | Remove public alias after compatibility; retain persisted `viewId` and replay | 657d63ee; df34d40f |
| `views` | Use the old participation spelling | DROP | Remove public alias after compatibility; retain stored keys and receipts | 657d63ee; df34d40f |
| `provenance` | Explain selected file/line contributors | MIGRATE | Paged attribution/rationale under `forge_review`, pinned to Candidate/head | 657d63ee |
| `records` | Discover retained work and history | MIGRATE | Indexed, paged summaries under `forge_work_overview` with parent/source IDs | 657d63ee |
| `brief` | Recover task and next action | FOLD | Concise instruction paths, task and recovery pins in start/open/status | 657d63ee |
| `link` | Share exact selected evidence | FOLD | Pinned URLs in existing receipts and source rows; no extra lookup | 657d63ee |
| `log` | Diagnose a failing check | MIGRATE | Cause in terminal receipts first, then bounded log pages in `forge_check` | 657d63ee; 58236de6 |
| `handoff` / `save --handoff` | Save delivery evidence | FOLD | Optional `save.delivery`, including clean heads and outcome-only Lanes | 657d63ee |
| `handoff-read` | Recover prior delivery context | FOLD | Compact `status.latestDelivery`; older notes through `records` | 657d63ee |
| `report` / `save --report` | Attach optional session totals | FOLD | Later optional save session report; reads through `records` | 40ad7abd |
| `making-of` | Explain an Intent's path to main | FOLD | Intent-scoped `records`; later hosted view/metrics aggregation | 40ad7abd |
| `pending-status` / `status --pending` | Find interrupted or queued work | FOLD | Compact root status, `records` cursors and exact recovery command | 657d63ee; e34dcfe5 |
| `improve` | Group repeated workflow friction | FOLD | Bounded planning summaries with report IDs, costs and fixing Lanes | 88d3cfba |
| `save --preview` (`integrate`) | Diagnose saved-Lane interactions | DROP | Remove standalone agent mode; retain preflight and composed check-only jobs | 657d63ee |
| `land --resume-ready` (`land-ready`) | Continue dependency waits | FOLD | Original landing replay/wait command and server-driven dependency wake | 657d63ee |
| `x undo-sync` | Restore pre-sync Lane work | FOLD | Lane undo restores the last or any earlier save; landed changes use checked revert | e7812d8f |
| `land` (saved heads) | Submit saved work without local edits | FOLD | Existing finish protocol with explicit saved inputs/pins, without capture | 657d63ee; df34d40f |
| `x accept` | Submit an exact checked Candidate | FOLD | `land --save` with exact Candidate/run under existing policy | 657d63ee; df34d40f |
| `x undo-revert` | Compensate native optimistic revert | DROP | Retire native-specific agent surface; retain explicit checked compensation | 657d63ee |
| `x clean` | Reclaim regenerable local artifacts | FOLD | Existing explicit prune/maintenance with pins and in-use safeguards | 995c8da9; 75170a57 |
| `x take` | Continue another agent's Lane | FOLD | `start --open`/status delivery and pending-operation pins; retain authorship | 657d63ee |
| `x guidance` | Store agent instructions | DROP | Remove native agent surface; retain hosted guidance UI/API and repo instructions | 657d63ee |
| `x pre-edit` | Observe overlaps on first write | FOLD | The first-write hook reads board claims and notes; overlap notices were removed (Issue 853fcde3); incomplete reads fail open | e6f4b0a6; 5283a92f |
| `x install-hooks` | Install first-write notices | FOLD | Local installer/first-run, reversible and idempotent, with off setting | e6f4b0a6 |
| `x uninstall-hooks` | Undo hook installation | FOLD | Discoverable local installer/settings inverse preserving other hooks | e6f4b0a6 |
| `x friction-triage` | Record a friction disposition | FOLD | Existing planning updates/comments with IDs, reasons and fix evidence | 88d3cfba |
| `x define-check` | Configure an exact-source check | FOLD | `x configure-check` with existing authority and definition pins | 657d63ee; df34d40f |

Migrated actions extend existing MCP tools. One schema generates CLI help, MCP
accepted actions and the hosted command table; a guard rejects documented hosted
actions that dispatch as unsupported. These remain implementation acceptance work.

Under 47558a99, total tool-description size may grow slightly, but stays reasonable
and measured, including loaded schemas and project-rule text in Claude Code and
Codex. Budgets and their measurements are in
[workflow: context budget](workflow.md#context-budget-issue-47558a99); a parity slice that adds an
action keeps the budget test passing or records the new number on that Issue.

Reads stay paged, current-authorized and source-pinned, with explicit incomplete
coverage, bounded calls per page and zero idle calls. Retry identity and all
continuations remain intact. Removal preserves history and existing human approval;
this disposition adds no mandatory reports, telemetry, cleanup or retention policy.
