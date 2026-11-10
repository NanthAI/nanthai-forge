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

- **Shipped hosted actions:** `diff`, `peers`, `log`, `records` and `provenance`. `log` uses
  the retained-output reader from both CLI and `forge_check`. `records` uses one
  current-authorized canonical page (100 heads and descriptors, no body hydration)
  or an exact `id`/`version`, under `forge_work_overview`. Continuations keep their
  original project, collection and filter; source references pin immutable bytes.
- **`provenance`** reads canonical Candidate inputs and Lane-version history,
  including syncs, under `forge_review`. One changed file and 20 history versions
  per page; R2 manifests/blobs use verified batch transport. Continuations keep
  the Candidate/base/head/file/line selection and walk inputs and dependencies.
  Partial pages say `historyComplete:false` and mark line attribution partial.
  Operation requesters remain separate from unrecorded executor identities.
- **FOLD rows** refuse and name their replacement; the replacement jobs that are
  not built yet keep their owning Issues (`save.delivery` for handoffs, Lane undo
  e7812d8f, session reports 40ad7abd).
- **DROP rows** (`view`, `views`, `save --preview`, `x undo-revert`, `x guidance`)
  are removed from the CLI, MCP and docs. Stored wire names (`viewId`) are unchanged.

| Command | Agent job | Decision | Replacement or target action | Use evidence / marginal context |
| --- | --- | --- | --- | --- |
| `diff` | Inspect selected changes | MIGRATE | Paged diff with exact Lane/Candidate/State pins; exact bytes through `show` | 5283a92f; 10t |
| `peers` | Coordinate edits to a path | MIGRATE | Bounded Lane/path peer read; reused by the first-write hook | 5283a92f; e6f4b0a6; 5t |
| `review` | Review pinned changes | FOLD | `diff` summaries/hunks and `show`; distinguish local unsaved bytes | 5283a92f; 0t |
| `candidate` | Inspect one checked integration | FOLD | `status {candidateId}` with bounded inputs and check/acceptance pointers | 657d63ee; 0t |
| `candidates` | Find a Lane's integrations | FOLD | Lane status latest pointer and all participation pages through `records` | 657d63ee; 0t |
| `view` | Use the old Candidate spelling | DROP | Remove public alias after compatibility; retain persisted `viewId` and replay | 657d63ee; df34d40f; 0t |
| `views` | Use the old participation spelling | DROP | Remove public alias after compatibility; retain stored keys and receipts | 657d63ee; df34d40f; 0t |
| `provenance` | Explain selected file/line contributors | MIGRATE | Paged attribution/rationale under `forge_review`, pinned to Candidate/head | 657d63ee; 12t |
| `records` | Discover retained work and history | MIGRATE | Indexed, paged summaries under `forge_work_overview` with parent/source IDs | 657d63ee; 8t |
| `brief` | Recover task and next action | FOLD | Concise instruction paths, task and recovery pins in start/open/status | 657d63ee; 0t |
| `link` | Share exact selected evidence | FOLD | Pinned URLs in existing receipts and source rows; no extra lookup | 657d63ee; 0t |
| `log` | Diagnose a failing check | MIGRATE | Cause in terminal receipts first, then bounded log pages in `forge_check` | 657d63ee; 58236de6; 18t |
| `handoff` / `save --handoff` | Save delivery evidence | FOLD | Optional `save.delivery`, including clean heads and outcome-only Lanes | 657d63ee; 0t |
| `handoff-read` | Recover prior delivery context | FOLD | Compact `status.latestDelivery`; older notes through `records` | 657d63ee; 0t |
| `report` / `save --report` | Attach optional session totals | FOLD | Later optional save session report; reads through `records` | 40ad7abd; 0t |
| `making-of` | Explain an Intent's path to main | FOLD | Intent-scoped `records`; later hosted view/metrics aggregation | 40ad7abd; 0t |
| `pending-status` / `status --pending` | Find interrupted or queued work | FOLD | Compact root status, `records` cursors and exact recovery command | 657d63ee; e34dcfe5; 0t |
| `improve` | Group repeated workflow friction | FOLD | Bounded planning summaries with report IDs, costs and fixing Lanes | 88d3cfba; 0t |
| `save --preview` (`integrate`) | Diagnose saved-Lane interactions | DROP | Remove standalone agent mode; retain preflight and composed check-only jobs | 657d63ee; 0t |
| `land --resume-ready` (`land-ready`) | Continue dependency waits | FOLD | Original landing replay/wait command and server-driven dependency wake | 657d63ee; 0t |
| `x undo-sync` | Restore pre-sync Lane work | FOLD | Lane undo restores the last or any earlier save; landed changes use checked revert | e7812d8f; 0t |
| `land` (saved heads) | Submit saved work without local edits | FOLD | Existing finish protocol with explicit saved inputs/pins, without capture | 657d63ee; df34d40f; 0t |
| `x accept` | Submit an exact checked Candidate | FOLD | `land --save` with exact Candidate/run under existing policy | 657d63ee; df34d40f; 0t |
| `x undo-revert` | Compensate native optimistic revert | DROP | Retire native-specific agent surface; retain explicit checked compensation | 657d63ee; 0t |
| `x clean` | Reclaim regenerable local artifacts | FOLD | Existing explicit prune/maintenance with pins and in-use safeguards | 995c8da9; 75170a57; 0t |
| `x take` | Continue another agent's Lane | FOLD | `start --open`/status delivery and pending-operation pins; retain authorship | 657d63ee; 0t |
| `x guidance` | Store agent instructions | DROP | Remove native agent surface; retain hosted guidance UI/API and repo instructions | 657d63ee; 0t |
| `x pre-edit` | Observe overlaps on first write | FOLD | The first-write hook reads board claims and notes; overlap notices were removed (Issue 853fcde3); incomplete reads fail open | e6f4b0a6; 5283a92f; 0t |
| `x install-hooks` | Install first-write notices | FOLD | Local installer/first-run, reversible and idempotent, with off setting | e6f4b0a6; 0t |
| `x uninstall-hooks` | Undo hook installation | FOLD | Discoverable local installer/settings inverse preserving other hooks | e6f4b0a6; 0t |
| `x friction-triage` | Record a friction disposition | FOLD | Existing planning updates/comments with IDs, reasons and fix evidence | 88d3cfba; 0t |
| `x define-check` | Configure an exact-source check | FOLD | `x configure-check` with existing authority and definition pins | 657d63ee; df34d40f; 0t |

Use evidence is the linked friction/implementation Issue per row; 657d63ee records
the native-command discovery in docs Lane c8dec75d and owner approval a8947c0e.
No hosted-use transcript is claimed for formerly unavailable commands. The retained
native synthetic reader supplies the provenance output specification; records and
log tests exercise their shared canonical/output readers and refusal paths.

`t` estimates tokens as marginal compact-list characters / 4, rounded up, with
one action removed at a time: diff 38, peers 17, log 70, records 30, provenance 48
characters. Shared fields make these non-additive. Fold/drop rows add no alias or
mode to the list (0t); their existing replacement is already charged there.

Migrated actions extend existing MCP tools. One schema generates CLI help, MCP
accepted actions and the hosted command table; a guard rejects documented hosted
actions that dispatch as unsupported. The generated help table and dispatch guard enforce this contract.

The no-growth guard in `tests/mcp-tool-list.test.mjs` retains eight tools and the
measured pre-parity ceilings: tools/list 5,758 characters, Codex 5,874, Claude Code
5,746, descriptions 920. Current measurements are 5,670 / 5,786 / 5,658 / 675;
short descriptions pay for restored actions, with full guidance behind `help`.
See [context budget](workflow.md#context-budget-issue-47558a99).

Reads stay paged, current-authorized and source-pinned, with explicit incomplete
coverage, bounded calls per page and zero idle calls. Retry identity and all
continuations remain intact. Removal preserves history and existing human approval;
this disposition adds no mandatory reports, telemetry, cleanup or retention policy.

`records` costs one query per 100-head/descriptor page; exact-version reads hydrate
one selected record. `log` keeps its existing manifest + stream pages + selected
chunk downloads. `provenance` uses at most three metadata queries per page plus
batch object descriptors/download authorization (no per-file RPCs). Its 20-version,
3,000-file synthetic fixture transfers about 7.44 MB of State metadata and 366 bytes
of selected source on a cold cache; the fixture process peaks around 375 MB, including
its compiler and seeded data. These are synthetic observations, not live billing or
performance-gain claims. All reads perform zero writes/wakes and zero idle calls.
Large files retain the existing native attribution limits; incomplete history,
rationale and dependency evidence is disclosed, never treated as independence.
