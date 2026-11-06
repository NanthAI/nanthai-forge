# Approved hosted command parity

Issue 657d63ee-249a-44ae-94e2-55549f84eea9 owns this approved disposition:
**5 MIGRATE, 22 FOLD, 5 DROP**. The table names implementation targets, not
additional supported hosted commands. The [hosted contract](workflow.md#hosted-command-contract)
remains the authority for availability; implementation slices keep the parent Issue open.

MIGRATE adds a bounded hosted action; FOLD preserves the job in an existing
verb, receipt or local facility. All five DROP rows are **approved for removal;
removal is pending implementation**. Replacement jobs land before folded surfaces
are removed. Alias removal respects the promised compatibility schedule.

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
| `x undo-sync` | Restore pre-sync Lane work | FOLD | Joint Lane-undo capability; owner shapes breadth before implementation | e7812d8f |
| `land` (saved heads) | Submit saved work without local edits | FOLD | Existing finish protocol with explicit saved inputs/pins, without capture | 657d63ee; df34d40f |
| `x accept` | Submit an exact checked Candidate | FOLD | `land --save` with exact Candidate/run under existing policy | 657d63ee; df34d40f |
| `x undo-revert` | Compensate native optimistic revert | DROP | Retire native-specific agent surface; retain explicit checked compensation | 657d63ee |
| `x clean` | Reclaim regenerable local artifacts | FOLD | Existing explicit prune/maintenance with pins and in-use safeguards | 995c8da9; 75170a57 |
| `x take` | Continue another agent's Lane | FOLD | `start --open`/status delivery and pending-operation pins; retain authorship | 657d63ee |
| `x guidance` | Store agent instructions | DROP | Remove native agent surface; retain hosted guidance UI/API and repo instructions | 657d63ee |
| `x pre-edit` | Observe overlaps on first write | FOLD | Local cached wrapper over path-scoped `peers`; incomplete reads fail open | e6f4b0a6; 5283a92f |
| `x install-hooks` | Install first-write notices | FOLD | Local installer/first-run, reversible and idempotent, with off setting | e6f4b0a6 |
| `x uninstall-hooks` | Undo hook installation | FOLD | Discoverable local installer/settings inverse preserving other hooks | e6f4b0a6 |
| `x friction-triage` | Record a friction disposition | FOLD | Existing planning updates/comments with IDs, reasons and fix evidence | 88d3cfba |
| `x define-check` | Configure an exact-source check | FOLD | `x configure-check` with existing authority and definition pins | 657d63ee; df34d40f |

## Implementation order

1. **Diff/peers and exact Candidate/State show** (5283a92f), then the first-write
   hook (e6f4b0a6). Review folds after selector equivalence. The first shipped slice
   carries the generated help/contract guard.
2. **Failure diagnosis** (657d63ee; 58236de6): retained cause, provider link and log
   continuation in terminal receipts first, then bounded `log` pages.
3. **Records and compact status** (657d63ee; e34dcfe5): Candidate selection,
   participation and pending-work continuation; saved-only land and original replay.
4. **Delivery notes and receipt links** (657d63ee): optional `save.delivery`,
   `status.latestDelivery` and exact links fold handoff, brief, link and take.
   Friction discovery/triage stays with 88d3cfba.
5. **Lane undo and small folds** (e7812d8f; 657d63ee; df34d40f): shape Lane undo
   before folding undo-sync; fold check configuration and agent acceptance.
   Local cleanup stays with 995c8da9/75170a57; hook setup stays with e6f4b0a6.
6. **Selected provenance** (657d63ee): bounded contributors/rationale with exact
   source pins and explicit partial history.
7. **Approved removals** (657d63ee; df34d40f): implement the five DROP rows,
   retaining historical/wire data and unrelated UI/API behavior. Optional reports
   and making-of stay with 40ad7abd in Phase 8.

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
