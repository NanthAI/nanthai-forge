# Agent briefings

Forge has one client mode (hosted), and the checkout CLI and MCP do not expose `brief`.
For builder context use `planning {"id":"ISSUE_ID","reconcile":false}`,
`status {"laneId":"LANE_ID"}` and the repository's brief and rules; fetch fresh context
before acting. Detected repository instructions win over project guidance, then Forge steps.

Hosted `projectBriefings.brief({projectId,...briefInput})` is a separate API surface: it
checks current access, and source-only grants cannot read Work. It returns `copyText`
(at most 1,200 characters), Markdown (at most 32,000) and structured context; templates
make no model calls and include no source contents. `projectWorkIndexActions.ensure` and
`projectBriefingActions.prepare` prepare derived paths from State manifests, not file
blobs. API support for client preparation is not permission for builders to
auto-trigger index repair; follow [live-operation rules](lead.md#live-work-and-cost).
Budget-limited notes, events and claims report partial coverage. Claims are advisory.

Hosted `agentGuidance.read/set` uses the current account and keeps up to 4,000 characters
per scope verbatim. Owners and assigned guidance maintainers can edit project guidance;
`setMaintainer` changes only that permission.

## Building Forge

Read [AGENTS.md](../../AGENTS.md); leads also use the [lead playbook](lead.md).
These repo rules replace external builder prompts and memory. The owner's current
instructions win. Briefs specialize scope and review; they never bypass policy.
Use [workflow](workflow.md) for commands and [parallel-work defaults](../parallel-work-defaults.md)
for configurable product behavior.

### Standard builder block

Every brief includes this block by reference, keeps AGENTS.md safety rules intact
when copied, and supplies its Issue, owned files/concepts, dependencies, scale
budget, time box, acceptance bar, metrics that must not regress, and what it removes or
merges (or why nothing can go).

1. Read Lane AGENTS.md, DESIGN.md, the Issue body and **every comment**
   (`planning {"id":"ISSUE_ID","reconcile":false}`); comments can amend Done-when. Own one
   finite task. Builders on one machine share a root and identity, so generate your own
   fresh `operationId` (`uuidgen`) and pass it:
   `start {planningItemId,operationId}`; a start without it can return another builder's
   open Lane. Reuse the same id only to retry your own lost start. Edit only the returned
   Lane path; never edit or commit in the project folder or mirror, or in another
   builder's Lane. Check for an earlier Lane on the Issue (`lanes`); continue or abandon
   it, never redo work already on main.
2. Follow AGENTS.md secret handling and owner decision rights. Never print secrets
   or environment values, read credentials raw into output, use production or
   deploy/publish/change accounts/backfill without the stated authorization.
   Compare secrets by hash; use private delivery. Tests use synthetic fixtures.
3. State calls per record/operation, total Convex calls and DB I/O, peak memory and
   wall time at current scale plus growth. Calls must not rise; idle is zero.
   Batch pages; no per-item calls, polling or whole-collection/Work loads. R2 holds
   bytes. V8 Convex functions use no Node-only globals. Assert relevant budgets.
4. Fix root causes for every project, never tune to a benchmark. Search for every
   instance; fix or list them. [Repeated classes and reverted fixes need a build-failing guard](improvement-loop.md#fix-the-class).
5. Use the approved installed CLI and patched Node. Check disk before start,
   builds and tests against the reserve in the brief. Run builds and test batches
   through `nforge heavy`; start servers or browsers only when needed and stop them
   afterwards. Slot count, disk reserve and builder count come from local machine
   setup and the brief, not from the repo. Format only with `npm run format` (oxfmt);
   never `npx prettier`, which rewrites files in another style.
6. Save after each meaningful step (at least every ~30 minutes): each save runs the exact conflict check; read the head and capture coverage. Use `mktemp`
   logs, never shared fixed paths. Keep a private handoff with observation time,
   saved head, operation id and next action for interruption recovery.
7. Read hosted `behindMain` and `presence` notices before editing and coordinate
   shared scope; native owners can use `peers`. List your owned files in your first
   save message. Each save trial-merges your saved files with peers; a real conflict
   comes back as `conflictNotice` (nothing to answer: coordinate, stack or split).
   Saved-path windows exclude unsaved peer edits; no notice never proves
   independence. Record conflicts. Missing alerts mean friction, not independence.
8. Add a test only for a behaviour, contract or incident you can name, and put that name in the test (a brief
   asks for the guarded behaviour, not for "tests"; [test signal](lint-rules.md#test-signal)).
   Save then `preflight {laneId}`. Run all affected tests: tests you add, direct and
   transitive consumers of changed/deleted modules and changed literal paths.
   No arbitrary file cap. Include relevant docs/format/lint/type checks. Re-select
   after sync or main changes. A near-full set belongs to the landing runner;
   never run it, or the full suite, locally: if preflight selects one, let `finish`
   proceed with the advisory preflight status. The landing check is full verification.
   Hosted preflight can take a few minutes; when your shell stops commands after
   120 s, run it in the background and wait for it, never re-run it in a loop.
9. Never weaken, skip or quarantine tests or raise timeouts to hide races. Explain
   any correction to an impossible assertion. Report observed commands, exit codes
   and counts; label unrun work. Runtime/storage changes also need real billed
   usage and byte-placement evidence; otherwise that acceptance stays open.
   Perf/cost claims: [perf-claims](perf-claims.md).
10. Finish your own Lane unless review is required first. Check the benchmark hold
    before each submission; wait without touching it. No routine urgent priority.
    Freeze edits/saves/sync until terminal. Stay with your own landing, dry run or
    wait and all dependent work: never end the turn while one runs, and never end on a
    status line. Resume a killed shell with the receipt's blocking `waitCommand`:
    `nforge agent ROOT wait '{"operationIds":["ORIGINAL_UUID"],"until":"acceptance"}'`
    (check-only: `{"runId":"RUN_ID"}`). It blocks up to
    540 s, under agent shell limits; run it in the foreground, never sleep or end on
    a background task. Exception: when land prints `SUBMITTED` with `wake.command`,
    run that one settle wait in the background and block on it with your harness
    wait tool ([asynchronous land](workflow.md#asynchronous-land-one-wake-no-waiting-turns)). If the turn-end hook blocks a stop, run its `nforge wait ID`.
    Repeat on IN PROGRESS; follow terminal recovery on failure/conflict. A passed
    check alone is not a landing. Your finish `message` is the GitHub commit message
    (at most 1024 UTF-8 bytes, checked before any server call): end it with the commit trailers your harness asks for (for example `Co-Authored-By:`). Before admission, replay the full original request. Retryable source work follows its returned recovery.
11. Fix failures in the same Lane and land again; never cancel and recreate.
    Follow exact conflict/stale/stalled continuations; replay unknown outcomes.
    Before filing an Issue or friction, search planning and comment on an existing
    match instead. One `planning {"search":"relevant words","limit":10}` is
    enough (no `nextCursor` paging); add `status:"all"` to include closed work. Log action/code/Lane/cost/workaround, then fix or link a slice.
12. Match your receipt to your Lane/operation and verify files on accepted main:
    after landing, `nforge pull` (its own shell call; it resets the working directory)
    and grep for a named symbol or file of your change before reporting LANDED. A
    receipt alone is not proof. Convex changes also need deployment success at that
    commit; tell the lead the accepted State and do not deploy yourself.
    Comment evidence per acceptance line; unmet lines stay open or name their next
    Issue. The landing note and commit message also say what the change removes or
    merges, or why nothing can go (growth guard: `node scripts/check-growth.mjs`). After landing (and `complete` when the Lane stays open), read
    `planning {"id":"ISSUE_ID"}` once: a closed Issue is done; a held one
    (`reconciled.held`, or the "N Done-when line(s) still open" comment) names the open
    lines and the one `put-planning-item … "status":"closed"` command. Run it once the
    evidence comments cover every line, or tick the boxes; never leave the Issue
    in-progress and never close with lines unmet. Handoff files/choices/tests/counts/actual verification/receipt/head,
    unverified work and next action. Abandon unused Lanes with work preserved;
    remove only your own regenerable temporary output.
13. Convex: any `mutation` or `internalMutation` you add or touch imports from
    `./server` (the `finishReadWriter` wrapper), never `./_generated/server`.
14. Final report, short and plain: receipt and accepted State; files changed; what the
    change removes or merges, or why nothing can go; tests
    run with exact counts; per-operation call/byte budgets; friction filed; what stays
    unverified. When the brief asks for measurement, add a **Run metrics** block: start
    and landing times (UTC); hosted checks run and their minutes; overlap notices seen
    (advisory/blocking); conflicts and how resolved; time stranded or waiting on another
    Lane (minutes, why); duplicate work with another builder; rework after a failed check.

Docs-only work changes no runtime usage; no live billing benchmark is needed.

Briefs point here instead of repeating these rules or naming a private file; machine
specifics (heavy slots, disk reserve, builder count, local paths) come from local
machine setup and the brief's own lines.

Before delegating, lint the brief: `npm run check:brief -- BRIEF.md` (`-` reads stdin). It exits 1 and names each missing field: full Issue UUID, safety block, scale budget, disk floor with a number, checkpoint cadence, no-end-turn rule. It also fails `unsafe-command` when the brief or its common rules tell an agent to run `env`, `printenv`, `npx convex env list`, `pgrep -fl` or `ps -E`; sentences that forbid them pass. The standard-block pointer covers safety, cadence and no-end-turn, so a brief should link [the block](#standard-builder-block) rather than a private rules file (a local `.md` file it names is still read, for older briefs). It also resolves the brief's Issue UUID against the planning board with one read (`planning` by the first 8 characters, no reconcile) and fails `unknown-issue` when no item has that prefix and `issue-mismatch` when the full id differs. With no login, no Forge checkout in the working directory or an unreachable board it prints a `warning` and lints offline (exit 0); `--no-board` skips the read. Output never echoes the brief.
