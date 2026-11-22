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

### Planning-round brief

Page `planning {"kind":"issue","status":"active","waitingOn":"none","reconcile":false}`
for the next round. Follow `nextCursor` with the same filters, even after an empty
page. Read `owner`, `design`, `evidence` or `item` in `waitingOn` to revisit a
specific kind of wait. Update the Item's `fields.waitingOn` with its current version
when the wait changes and set it to `null` when the wait ends.

Read the candidate Item, its owner, Lanes and the queue before briefing a builder.
An Item without a recorded wait still needs the usual assignment and dependency checks.
See the [lead playbook](lead.md#the-board-is-the-work-list) for the live reads.

### Standard builder block

Every brief includes this block by reference, keeps AGENTS.md safety rules intact
when copied, and supplies its Issue, owned files/concepts, dependencies, scale
budget, time box, acceptance bar, metrics that must not regress, and what it removes or
merges (or why nothing can go).

When running unattended, edit files only with the file-edit tool inside your Lane.
Keep temporary files, including logs, in `.forge/scratch/` inside your Lane. Create it when needed.
Do not start local dev servers or pipe a read into a write.
Read first, then pass a literal argument to the write command.
If a command waits for approval and nobody can answer, cancel it and use the routes above.

1. Read Lane AGENTS.md, DESIGN.md, the Issue body and **every comment**
   (`planning {"planningItemId":"ISSUE_ID","reconcile":false}`); comments can amend Done-when. Own one
   finite task. Builders on one machine share a root and identity, so generate your own
   fresh `operationId` (`uuidgen`) and pass it:
   `start {planningItemId,operationId}`, with your model set (`export FORGE_AGENT_MODEL=<model id>`
   first, or the `model` field; start refuses without one, and takes `"unknown"` when unknown); a start without the id can return another builder's
   open Lane. Reuse the same id only to retry your own lost start. Edit only the returned
   Lane path; never edit or commit in the project folder or mirror, or in another
   builder's Lane. Check for earlier open work with `lanes {"planningItemId":"ISSUE_ID"}` (full UUID;
   follow `continueCursor`; `intentId` selects one execution Intent). Continue or abandon
   it, never redo work already on main. Starting from an Item with no owner claims it for you: the
   write that marks it in progress also sets its owner to your public identity (`@handle/agent`). An
   owner someone already set is kept, and a member who cannot edit the plan claims nothing (the server
   still moves an open Item to in progress after their start; a proposed Item stays proposed until the
   owner approves it); to hand an Item on, change its owner with `put-planning-item`.
2. Follow AGENTS.md secret handling and owner decision rights. Never print secrets
   or environment values, read credentials raw into output, use production or
   deploy/publish/change accounts/backfill without the stated authorization.
   Compare secrets by hash; use private delivery. Tests use synthetic fixtures.
3. State calls per record/operation, total Convex calls and DB I/O, peak memory and
   wall time at current scale plus growth. Calls must not rise; idle is zero.
   Batch pages; no per-item calls, polling or whole-collection/Work loads; a web page
   opens with one bounded page or a summary ([bounded web reads](lint-rules.md#bounded-web-reads)). R2 holds
   bytes. V8 Convex functions use no Node-only globals. Assert relevant budgets.
4. Fix root causes for every project, never tune to a benchmark. Search for every
   instance; fix or list them. [Repeated classes and reverted fixes need a build-failing guard](improvement-loop.md#fix-the-class).
5. Use the approved installed CLI and patched Node. Check disk before start,
   builds and tests against the reserve in the brief. Inspect reclaimable copies with
   `nforge prune` (or `nforge prune --scan DIRECTORY`); `--apply` removes eligible
   regenerable roots. Live processes, unknown coverage, pins and unresolved state
   retain their copies; the result explains unresolved state and recovery. Never
   remove another builder's files to meet the floor. Run builds and test batches
   through `nforge heavy` ([what it bounds](../parallel-work-defaults.md#localheavyslots)); start browsers
   or attended local dev servers only when needed and stop them afterwards. Slot count, disk reserve and
   builder count come from local machine setup and the brief, not from the repo. Format only with `npm run format` (oxfmt);
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
   Use optional `notVerified` on `save` or `land --save` to report verification limits
   on that operation. Omit the field if you have no report. Send `[]` only if you
   verified everything you changed. This claim is separate from [run evidence](../run-evidence.md).
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
   Any one local test run stops at 600 s (finish, retry and trim:false too); the
   landing check runs the rest. Pass `budgetSeconds` above 600 only when a longer
   local run is worth the slot time; the receipt names the override.
9. Never weaken, skip or quarantine tests or raise timeouts to hide races. Explain
   any correction to an impossible assertion. Preflight and `land --save` flag a
   changed existing test (`weakenedTests`: removed or loosened assertions, added skips
   or name filters, a removed test, a changed input under the same assertions) by file
   and test; a flag never fails the Lane. Fix it, or put one line
   `Weakened-tests: <why>` in the `land --save` message to clear it
   ([how](../parallel-work-defaults.md#preflight)). Report observed commands, exit codes
   and counts; label unrun work. Runtime/storage changes also need real billed
   usage and byte-placement evidence; otherwise that acceptance stays open.
   Perf/cost claims: [perf-claims](perf-claims.md).
10. Finish your own Lane unless review is required first.
    The reviewer prompt must include the AGENTS.md safety line verbatim.
    Copy the full line starting with “Never print environment values or secrets”
    from [AGENTS.md](../../AGENTS.md#hard-rules).
    Check the benchmark hold before each submission; wait without touching it.
    No routine urgent priority.
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
    (at most 16 KiB of UTF-8, checked before any server call; pass the same
    `--message-file` to preflight to check it before the tests run): end it with the commit trailers your harness asks for (for example `Co-Authored-By:`). Before admission, replay the full original request. Retryable source work follows its returned recovery.
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
    lines and the one `put-planning-item … "status":"closed"` command. Tick each proven line
    with its evidence in one call: `tick-planning-item {"planningItemId":"ISSUE_ID","line":2,"evidence":"…"}`
    (`line` is the checkbox's 1-based position or a unique text prefix; it ticks the box and posts the
    evidence as a decision comment, retrying a version race). Run the close command once every line is
    ticked (the next planning read also closes it); never leave the Issue
    in-progress and never close with lines unmet. Handoff files/choices/tests/counts/actual verification/receipt/head,
    unverified work and next action. Abandon unused Lanes with work preserved;
    remove only your own regenerable temporary output.
13. Convex: any `mutation` or `internalMutation` you add or touch imports from
    `./server` (the `finishReadWriter` wrapper), never `./_generated/server`.
14. Final report, short and plain: receipt and accepted State; files changed; what the
    change removes or merges, or why nothing can go; tests
    run with exact counts; per-operation call/byte budgets; friction filed; what stays
    unverified; follow-ups found, each either done under the Item's Done-when list or
    filed as its own Item with its reason ([brief item 9](brief-template.md#standard-safety-and-delivery-block)). When the brief asks for measurement, add a **Run metrics** block: start
    and landing times (UTC); hosted checks run and their minutes; overlap notices seen
    (advisory/blocking); conflicts and how resolved; time stranded or waiting on another
    Lane (minutes, why); duplicate work with another builder; rework after a failed check.

### Builder decision rules

Leads settled these questions repeatedly for placement and cost slices; apply them without asking.
A brief or a lead comment on the Issue can override one for that slice.

- **Rollout order for a changed stored format or reply.** Expand, then contract, in separate
  landings: readers that accept both forms first; then the writer behind a default-off setting;
  then clients and runners without the new capability get `CLI_UPGRADE_REQUIRED`. Reuse the
  existing capability and setting mechanism instead of adding a parallel one. Never change the
  writer and its readers in one landing.
- **Budgets.** Report per-landing cost separately from fixed per-project cost. Measure on the
  dogfood-shaped fixture as well as the small one, and count worst-case rows whole, not averaged.
  A budget below one operation, or worth a fraction of a cent, flips on one landing: make it a
  ratchet with an absolute floor, and weight request classes by price when they differ.
- **Core queue paths (Guard 4).** A change to queue, admission, acceptance, check, wake or
  scheduler code is core whatever it claims to do, including a cost-only change. It gets the same
  proof as any queue change: its tests, the queue simulation and incident replays, and a
  fresh-context review before landing. The landing check classifies these paths by path alone
  (`scripts/core-queue-paths.mjs`) and always runs `tests/hosted-landing-queue-sim.test.mjs`,
  the cost guard and every file in `tests/fixtures/incident-replays.json` for them, in scoped checks
  and in re-checks of that change (a core change on main alone ran them in main's own check).
  Local preflight ranks those tests like any other, so a changed module's own importers still run
  first, and the pre-queue check runs what it leaves; run the queue simulation yourself in
  `nforge heavy` before you save a queue change. A new core module outside those patterns joins
  the list in the same landing: `tests/core-queue-paths.test.mjs`, also in that set, fails when the
  queue simulation reaches a queue module that is neither core nor a listed exception with its
  reason (the 2026-11-17 wake cut saved a little and cost hours of landing time; incident 5e3c3a3c).
  The landing check also requires a [qualifying proof](#attaching-queue-proof) for every
  changed core queue path (Guard 1, Item d4289a6a).
- **Cost pins have a byte band.** The pinned Convex baselines in `tests/keep-the-run-scenarios.mjs`
  (`MEASURED`, `WIRED`) keep calls and document counts exact, and allow stored bytes to move inside a
  stated band: `WIRED` deltas by 256 B either way, `MEASURED` totals up to 0.25% (at least 64 B) over
  the pin. Growth of a few bytes in a stored message therefore edits no pinned row, so concurrent
  Lanes do not conflict on it (Item 168e4ed8). Do not touch a pin while the measurement is inside the
  band. Past it, the guard names the scenario and the delta, and the change re-pins that row with
  its reason; a feature-sized move (a new fact on a row, an extra read) always does. Where the band
  numbers come from is written beside `WIRED_BYTE_BAND` in the file.
- **Automatic settings.** Forge adapts to each project ([principle 6](../../PRODUCT.md#product-principles)).
  Every new automatic setting declares:
  - its signal, read from the project's own records;
  - its formula and its bounds (the lowest and highest value it may pick);
  - its manual override, and the hint manual mode shows: "Automatic would pick X because Y";
  - a one-line reason it exists;
  - that it is judged on the shared top metric, flow (landings that stay landed), never on its own
    local metric; CI minutes, wall time and $/1,000 landings are guards, not goals;
  - the settings it touches or interacts with.

  At most one automatic setting changes per project at a time, with a cooldown before the next,
  and the change rolls back when flow regresses against the project's own baseline. Every change
  keeps a (setting, context, outcome) record. A workaround the lead repeats by hand (notice,
  measure, act or not, roll back when worse) is a sign that a setting should become automatic.
  The shared registry and tuner are built in Item 0807b632. Until then, put the declaration beside
  the setting, as the preflight guard set does
  ([`setting` in preflight-guard-set.ts](../../src/preflight-guard-set.ts)), and test that it is
  complete.
- **Data access.** History and evidence objects in R2 are server-only. Clients read them through
  a server action that checks current access and redacts; no client-readable raw object or signed
  URL unless the design proves it safe. Replies never contain object keys or signed URLs.
- **Slice order.** A review's slice order is about capacity unless it names a dependency. Slices
  that run in parallel coordinate on shared files: sync before landing, keep peers' accepted
  changes in any conflict, and post on the board when you change a shared budget file.
- **Conditional slices.** When a slice runs only if evidence shows a pattern, the lead decides
  whether the evidence meets the trigger and records it on the Issue.
- **Web UI checks.** Besides axe, screenshots at 390 and 1440 px in both themes and the eager
  JavaScript budget, measure load layout shift on a local build before and after the change, at
  phone and desk width: `agent-browser vitals URL --json` (pinned `agent-browser@0.43.0`, installed
  with `--ignore-scripts` outside the repository, pointed at the Playwright Chromium with
  `AGENT_BROWSER_EXECUTABLE_PATH`). A new sheet or dialog also gets its dialog check (background
  inert, focus inside, Escape returns focus). Pin versions, never `@latest`; set
  `DISABLE_TELEMETRY=1` for the `modern-web-guidance` CLI. Local only: never in the hosted check
  (Item 88c08511 trial: it found the Plan list's load shift that axe, screenshots and tests missed).
- **When to stop.** Stop at the evidence when a Done-when line cannot be met after a real attempt,
  not after a first naive probe: report what you tried, the measured breakdown, and the cheapest
  alternative you see. Never change scope, raise a budget, or add a job, service, poll or wait to
  pass a line. Land the parts that meet their own lines. Architecture and placement questions go
  to the lead for a design review; do not settle them yourself.

Docs-only work changes no runtime usage; no live billing benchmark is needed.

### Attaching queue proof

Before landing a core queue change, retain its proof and attach a JSON file at
`.nforge/queue-proofs/<item-or-change>.json` in the Lane. Use a distinct filename for each
proof. The `changes` object maps each covered queue path to the SHA-256 of its final source
bytes (`shasum -a 256 PATH`), or to `null` for a deletion. For a symbolic link, hash its target
text. A Candidate can carry multiple proofs, and together they must cover every changed core
queue path. After fixes or a sync, refresh a replay proof offline instead of hashing by hand:
`nforge heavy npm run build:core && nforge heavy node scripts/refresh-queue-proof.mjs PROOF.json`.
It re-runs only that proof's registered replay, rewrites the digests and records in `exercised`
the top-level units the replay ran. With that scope, the proof still holds when main changes
only functions the replay neither ran nor referenced. A change to a unit it ran, a referenced
function's signature, the import order or anything that runs at load, a removed unit, or a Lane
edit after the proof still refuses before any test job, with this command.

For an **incident replay**, identify the incident and exact test title in
[`incident-replays.json`](../../tests/fixtures/incident-replays.json). From the Lane, run
`rg -n -F 'convex/projectHostedFinishWake.ts' tests/fixtures/incident-replays.json` with
your path in place of the example. Each matching entry names the incident, test file and
title. The `paths` lists come from function calls observed during each isolated replay.
If there is no matching entry, use an on-path bench cell or add a replay that reaches the
path. A pure schema or validator module (all of its code runs at load) never appears in
a replay's `paths`: prove it with an on-path bench cell. `QUEUE_PROOF_REQUIRED` lists such files
under `recovery.queueProof.uncoverable`, and every other path with its own next step. To refresh the registry after replay or source changes, build the project and run
`nforge heavy node scripts/incident-replay-coverage.mjs --write` from the Lane. The
normal suite checks existing mappings during their replays. Registry edits schedule the
named replays in the landing check. The read-only `--check` command verifies the mappings in
isolation. Run one fresh-context review, fix its findings, and land without a second review.
Retain the passing replay result, the review, and a record of the fixes on the Item or in the
check records.
Record the full session or thread IDs in `authorSession` and `review.session`. The IDs must
differ. The reviewer may use the same model as the author. Use a full receipt or comment UUID
or a stable HTTPS link in each `receipt` field.
The record has this shape (example digests and IDs):

```json
{
  "version": 1,
  "kind": "replay",
  "changes": {
    "convex/projectHostedFinishWake.ts": "0000000000000000000000000000000000000000000000000000000000000000"
  },
  "replay": {
    "incident": "5e3c3a3c",
    "test": "incident 5e3c3a3c: passed followers land within the pass-to-land ceiling while the holder re-checks",
    "receipt": "11111111-1111-1111-1111-111111111111"
  },
  "authorModel": "gpt-6.2-sol",
  "authorSession": "33333333-3333-3333-3333-333333333333",
  "review": {
    "model": "gpt-6.2-sol",
    "session": "44444444-4444-4444-4444-444444444444",
    "receipt": "22222222-2222-2222-2222-222222222222"
  }
}
```

For a **bench cell**, use `"kind": "bench"`, the same `version` and `changes` fields,
a `receipt` for the retained report, and `rule` naming the verdict for the affected path.
Copy the cell's `cellId`, `landed`, `voided`, `failed` and the matching `paths[rule]` entry
from the [scenario report](../../scripts/bench-t3code/scenario-report.mjs) into `cell`.
The cell must have landings, empty `voided` and `failed` lists, and an `on path` verdict
with recorded evidence for the [rule's source paths](../../scripts/bench-t3code/path-evidence.mjs).
For example, the bench result in 9faeae30 had healthy cells without a reached N1
path, so the 5e3c3a3c replay is the proof route for the wake case that motivated this guard
(8bc06644).

The standard verify check reads the Candidate's changed proof files and checks their
references, the replay or path verdict and the covered bytes locally. The references
point readers to the retained evidence. No hosted evidence lookup runs in the check.

### Briefing setup

Briefs point here instead of repeating these rules or naming a private file; machine
specifics (heavy slots, disk reserve, builder count, local paths) come from local
machine setup and the brief's own lines.

Before delegating, lint the brief: `npm run check:brief -- BRIEF.md` (`-` reads stdin). It exits 1 and names each missing field: full Issue UUID, safety block, scale budget, disk floor with a number, checkpoint cadence, no-end-turn rule. It also fails `unsafe-command` when the brief or its common rules tell an agent to run `env`, `printenv`, `npx convex env list`, `pgrep -fl` or `ps -E`; sentences that forbid them pass. The standard-block pointer covers safety, cadence and no-end-turn, so a brief should link [the block](#standard-builder-block) rather than a private rules file (a local `.md` file it names is still read, for older briefs). The lint checks that the standard builder block retains its exact reviewer-prompt instruction (`reviewer-prompt-safety`). It also resolves the brief's Issue UUID against the planning board with one read (`planning` by the first 8 characters, no reconcile) and fails `unknown-issue` when no item has that prefix and `issue-mismatch` when the full id differs. With no login, no Forge checkout in the working directory or an unreachable board it prints a `warning` and lints offline. `--no-board` skips the board read. Output never echoes the brief.
