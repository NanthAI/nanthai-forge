# Leading work on Forge

Read [AGENTS.md](../../AGENTS.md), [principles](../principles.md),
[status](../status.md), [roadmap](../roadmap.md), the [Phase 7 plan](../phase7-plan.md) and its
Forge planning Issues before leading a new stage or resuming after a context reset.
Read [architecture](../architecture.md) before changing internals. Fetch current
hosted main; a local Git mirror can lag.

The owner's current instructions win, then AGENTS.md and these linked working
rules. They replace external lead prompts, builder rule files and personal
memory. Briefs specialize scope and acceptance; they do not silently override
these rules. Generated help and [workflow](workflow.md) describe the supported
command contract. [Parallel-work defaults](../parallel-work-defaults.md) describe
product settings, not permission to introduce a new policy.

## Plan in Forge

- Keep the backlog in Forge planning: Initiatives group Issues, with decisions,
  Intents, Lanes and evidence linked. Read every page needed for a complete count.
- Discuss an owner question, link or idea before filing an Issue, note or plan
  entry. Record it after agreement. Builder-found friction and decisions within
  delegated scope can be recorded directly. This qualification wins over older
  instructions to file every idea immediately.
- Create the Issue before assigning a slice. A behavior change needs a measurable
  **Done when** checklist. Before dispatch, read the Issue body and every comment and
  rewrite Done-when from them, so the builder starts from current lines. Check main
  first: never dispatch work that has already landed; close or narrow the Issue instead. Put every promise of work in an Issue or an existing
  checklist before reporting that promise; name the Issue in the reply.
- Keep public plans in repo docs as well as Forge planning. Land updates to the
  roadmap, phase plan and backlog when a decision changes them and at each stage
  close. Verify the configured GitHub mirror has caught up to accepted main.
  Session state and private handoffs are not the backlog or durable rulebook.
- At each phase close run `node scripts/check-growth.mjs --print --machines` and record the counts, including the machine
  dependencies (product paths that need one specific machine; target 0), against the phase start ([growth guard](lint-rules.md#growth-guard)).
- Say stages, not weeks. Continue through the authorized stages without asking
  again. Calendar waits become dated planning re-checks with a metric and failure
  action; they do not by themselves block a stage or phase close. The same holds for
  evidence that only builds up by dogfooding (landing counts, a busy wave, a soak):
  check now what can be checked now, and move the rest to the next phase as a re-check
  with the metric, the bar, the trigger and the failure action.
- Prioritize core-claim incidents and structural blockers to cheap, fast landing.
  Each core-claim incident gets a replay on the [regression ladder](regression-ladder.md#rung-3-incident-replays).
  Rank removal of dependence on an operator's machine highly. Measure single
  operations against the GitHub equivalent within measurement noise; the intended
  advantage is concurrent work. Keep fast paths Forge-native, independent of Git
  or a GitHub mirror. Take quick wins and significant uplifts now; defer
  nice-to-haves with an Issue. Use cost and critical-path evidence to shape the
  next stage before adding breadth.

When the owner repeats or corrects a rule, update the shared repo page the next
agent reads. Memory alone does not carry it to another harness or lead.

## Current Forge project builder profile

For Phase 7 (owner, 2026-11-16), UI and web builders use Claude through Claude Code: Opus 5.5 or Sonnet 5.5. Fable 5.2 gives design direction and helps when a builder is stuck. Mythos 5.2 runs read-only security reviews. GPT through Codex (`gpt-6.1-sol`, reasoning effort `high`, service tier `default`) builds non-UI engineering slices and reviews every few landings; it gives no architecture or placement verdicts. This is the current project instruction, not a generic Forge product default; capacity does not authorize a silent provider switch.

Builder model choice (owner, 2026-11-23): Sonnet by default. Opus only for core queue, landing and ledger work, security and access, deletion and purge safety, and root-cause hunts a Sonnet already failed. Review rounds run through [the review script](review-api.md) on the API credits, GPT-6.2 Sol first; Claude reviews alone only when GPT's daily cap is spent or the builder is not Claude; a core Lane gets both providers in one merged round, a UI Lane with a mock also runs the mock check (`scripts/review-mock.mjs`) and the lead's look starts from its list; a subscription reviewer only after both caps.

API credit cap rule (owner, 2026-11-27): never spend past remaining API credits into card auto-refill. Reviews through [the review script](review-api.md) on the API credit stay the default review route while bounded by their cap. Any API-billed path (the review script, credit runners, Pi or any other API-key provider) may run only with a hard cap that stops at the remaining credit; uncapped paths such as Pi builders are forbidden unless the owner explicitly says so. Because the review script tracks only its own spend log, account for any other org or key usage before relying on its local cap.

The approval design on Issue 7f085ec9 treats AI and human approvals equally, binds approval to exact heads and classifies the change rather than its author. Mandatory human or multiple-human approval is not the selected design. Implementation/enablement remains tracked there; this instruction does not change an existing gate.

Now has no user-facing money or ledger; operator Convex costs stay internal (Issue 50f2e809). Public mirroring follows [Sync identity](../workflows.md#sync-identity), preserving personal Git identity.

## Delegate finite slices

Give each builder one finite task, its own Lane and a compact handoff. Follow-ups
use a fresh agent; recovery of an interrupted task resumes from its saved head.
Builders start, finish and fix their own Lanes. Do not ferry scratch patches or
land a builder's unverified work for them. The builder rules replace older
instructions to stop before landing, unless the brief explicitly requires review
before acceptance.

Follow-ups found during a slice join its Item's Done-when list and are done before the Item closes ([brief item 9](brief-template.md#standard-safety-and-delivery-block)). A new follow-up Item is the exception and names its reason: an owner decision, a dependency on another open Item, a different feature or area, or a dated re-check. When a review or report lists follow-ups, sort them into these two groups before accepting the work.

Run independent ready slices in parallel within the authorized delegation scope.
Serialize real dependencies and name them. Before launch, check shared model
usage, memory pressure, swap and disk; all projects share these resources (see
[localHeavySlots](../parallel-work-defaults.md#localheavyslots) for outside-slot memory accounting
and 16 GiB RAM concurrency limits, since heavy cannot gate agents or browsers started outside it). Pace
usage to avoid exhausting a short window in one burst. Use the owner's chosen
models and approved fallback policy; retry transient capacity failures on the
same provider up to three times before an authorized fallback. Never silently
switch models.

A queue alarm stops wide fan-out (Guard 6, after incident 5e3c3a3c). While a
queue speed budget is broken, start no new builders and fix the queue first: the
landing-to-main budget and the [queue health alarm](#queue-health-alarm) (pass to land,
Item 42200ce4). Each break sends one alert and opens its P0 Issue ([speed budgets](speed-budgets.md#how-a-budget-breaks)),
so check the board for an open budget Issue before launching several builders.
Builders already checking or queued finish their work; never withdraw a landing
to make room.

### Queue health alarm

Before any wide launch (more than one new builder at once), read the queue health alarm:
`nforge metrics ROOT --text` lists `pass-to-land-p90` in its Speed budgets block, and a break
also opens the fixed-id P0 Issue "P0 speed budget broken: first passed check to commit p90
(landing queue health: first passed check to commit)"
and sends one message on the project's alert channels. It is the p90, over the last 20 landings,
of the time from a landing's first passed check to its commit ([rung 1](regression-ladder.md#rung-1-landing-speed-budgets);
incident 5e3c3a3c). While it is broken the Guard 6 rule above applies (863c85ab); its break
alert says so and names the next commands. Resume launches after the recovery message, or once
the Speed budgets block shows it passing.

Read the alarm narrowly: `nforge metrics ROOT --text --from <24 hours ago> --context-days 0.25`.
The p90 needs only the last 20 landings in the window, so a day that has 20 landings gives the same
value. The default window (7 days plus 2 days of context) cost 150 to 270 MB of database reads per
read on 2026-11-21/22, and about 40 such reads a day were the largest recurring reader (Item 411727ba).
Keep the default window for stage-close and weekly reports.

Prefer a builder with available capacity for specified implementation, and reserve
design judgment for the designated reviewer. Exact providers and machine budgets belong in the current brief, not a permanent phase assumption.

Write briefs in neutral, concrete language. Each brief uses the [standard block](briefings.md#standard-builder-block) and adds:

- the Issue, outcome, owned files and concepts, dependencies and non-goals;
- the invariant being fixed, not just one named instance, and the build-failing
  guard when the class repeats ([lint rules and guards](lint-rules.md));
- current data size and growth, calls per record and operation, total Convex calls
  and documents read/written, peak memory and wall-time budget;
- a time box and written acceptance bar: required cases, measurement repeats,
  improvement target, noise allowance and metrics that must not regress;
- targeted checks, review-before-acceptance when required, evidence per checklist
  line and the expected handoff.

For a docs-only slice, state that runtime calls, DB I/O and byte placement do not
change. Do not invent a benchmark or live run to supply irrelevant numbers.

Check shared concepts as well as files before parallel launches or resumes:
caches, stores, eviction, metrics and guards each have one owning slice. Name that
owner in every related brief. Compare saved Lane bytes (`show {laneId,path}`) and local files while builders run;
hosted `diff {laneId,paths?,byteBudget?}` pins base to saved head, while `peers {laneId,path?,detail?}` reads current saved overlap evidence. Two new
modules doing the same job are duplicate scope even without a file overlap.

For UI, provide approved direction, a spec and mockups first. Builders follow
those references. Review actual signed-in screenshots against them before
acceptance. Keep explanations and reassurance in docs, hover or first-run help;
permanent UI copy should help the current decision. Follow [DESIGN.md](../../DESIGN.md).

## The board is the work list

Leading from Forge's own records is the point of dogfooding. Keep no private
resume list, status file or scratch tracker of what has landed, what is pending or
what comes next; Forge planning is that list. Before every brief, relay, status
reply or "what next", read live state: `planning {"planningItemId":"ID"}` (the Issue,
every comment, and `work`: each of its Lanes in any state with its landing receipt;
`lanes {"planningItemId":"ID","state":"all"}` pages past 20), then `queue`.
For each [planning round](briefings.md#planning-round-brief), page
`planning {"kind":"issue","status":"active","waitingOn":"none","reconcile":false}`
for Items without a recorded wait. Read a specific waiting category with
`waitingOn` set to `owner`, `design`, `evidence` or `item`. Keep reasons on the Item.
Use the Item's `owner` field and the planning `owner` filter to see assignments before a Lane.
Verify current activity in the assigned thread. The `decisions` read covers owner decision
records across the project. Lead decisions made as Item comments (`decision:true`) are listed across Items by
`planning {"history":{"from":"YYYY-MM-DD"}}`: each row's `decisions` holds its `## Decisions` lines dated in the window.
`lane-history` gives one Lane's full record when you need it. A builder's last note,
an earlier read or a session handoff is history, not state: the queue can land a
parked Lane after its builder has stopped (2bf85ddf, 2026-11-17, landed
unobserved while notes still said "needs sync"). When a fact the lead needs is
missing from Forge's reads, record friction and get it fixed in the product rather than keeping a side
list. A Lane that needs review before acceptance stays out of the queue until the
review is recorded on its Issue.

## Verify builders and keep work alive

Before calling a builder running or stopped, inspect its actual thread/session,
Lane activity and latest handoff. Silence is unknown. Before relaunching, verify
there is no live original builder or command; duplicate ownership is an incident.
Resume from the last checkpoint and handoff, not from scratch. Before an expected
capacity reset, have live builders save and record their state.

Keep unattended work observable through the harness's supported completion and
milestone mechanism; do not depend on the lead waking spontaneously. Session
handoffs include observation time, current operation, saved head and next action.
They stay outside public source. Stay with work you depend on until it settles.
Use the CLI's live wait or printed continuation, not shell polling or a background
driver with a timeout shorter than its expected operation. After a killed wait,
run the receipt's `waitCommand` on the original operation id; keep the turn active
and repeat it on IN PROGRESS. Before admission, replay the full original request
and operation id. Do not create another landing to resume waiting.

Review the invariant and search for remaining instances, not only the builder's
handoff. Check scale cost before correctness review, then failure paths and
acceptance evidence. Risky concurrency and scheduler changes need an independent
review before the next dry round. Major architecture decisions also need a
critical review of alternatives, including improving our own baseline; name pivot
cost and diminishing returns. A passing test does not authorize a policy change.

Until Forge goes live, at least through the end of Phase 8, the owner and our agents
are the only users. For migration, upgrade, in-flight or other-user state concerns,
check live users, running agents and affected data with read-only evidence. Skip the
work only when the check shows no impact and record the evidence on the Item. Bring
uncertain cases to the owner.

Before reporting a landing, match the receipt and operation id to that builder's
Lane and verify its files on accepted main (a named symbol or file, not a receipt alone). A completed patch or a passing check
is not a landing. If `convex/` changed, also verify the deployment workflow is green
at that commit; report a pending deploy explicitly. The lead owns authorized
release/deployment work; builders do not deploy as a side effect of a code task.

Close an Issue only with evidence for every Done-when line (a comment per line, or a
named Issue that now owns a moved line). Tick a proven line and post its evidence in one call with
`tick-planning-item {planningItemId,line,evidence}`. A held close names the open lines; never close
with lines unmet, and never leave a fully evidenced Issue open. Merge duplicates and
close verified work yourself; scope drops and won't-do go to the owner.

Report in plain language: what landed, what is running with thread links, and
what the owner needs to decide. Include reconcilable done/in-progress/open counts
per Initiative, landing ids since the previous report and any changed denominator.
A speed or reliability question gets a number with its metric and window, or
"cannot measure yet". Say first when the metrics cannot observe the path.
Each check-in runs `nforge metrics ROOT --failures --from <previous check-in>` and
reports the top failure codes with counts, any code not seen in the previous report
and any landing failure an agent could not recover from (`--failures --checks` lists the failed
checks with their files or step and a `runner`/`budget`/`flake`/`real` tag in one read). A rising or new code gets a
planning search and a comment or new Issue, like a flaky file.
Before launching more than one test-heavy builder, a check-in also reads the
[queue health alarm](#queue-health-alarm) state (`pass-to-land-p90` in the narrow read that section gives);
if it is breaking, fix the queue first and launch after it recovers (Guard 6, 863c85ab).
At stage close, list evidence and every open acceptance line, including the Issue
that owns a moved line. Never silently carry incomplete work forward.

## Live work and cost

Before any live hosted step, list all preconditions and check them read-only
against actual data: source and runtime pins, authority, deployment compatibility,
queue/drain state, saved operations, layout, byte placement and cost as relevant.
Critical-path diagnosis starts from real data read-only; tests use synthetic
fixtures. Fix blockers together, then run once. A second distinct failure means
stop retrying, redesign the precondition list, preflight it all and only then retry.
Do not automatically trigger `projectWorkIndexActions.ensure` to hide missing
coverage; report it and plan an explicit authorized repair.

Before relying on hosted compute or a vendor, tell the owner who pays, estimated
monthly cost at real scale and alternatives. Prefer bounded hosted work over a
new operator-side source worker. No paid CI or runner without an owner-approved
spend limit. Projects bring their own check runners; do not make Forge fund them.
Any API-billed model path (the review script, credit runners, Pi or any other API-key
provider) may run only with a hard cap that stops at the remaining credit and never
spills into card auto-refill; uncapped paths such as Pi builders are forbidden unless
the owner explicitly says so.
When paid services are in use, include month-to-date billed spend in lead reports.

Idle clients make zero Convex calls. No polling, subscription churn, per-item
Convex calls, unbounded queries, whole-collection loads or repeated metadata reads
per step. Use bounded pages; bytes go to R2 and Convex holds records. Require
synthetic real-scale tests that assert call, I/O and relevant memory budgets for
paths that change them. See [data placement](../data-placement.md).

Done includes real billed usage: after runtime, storage or worker changes, inspect
calls, DB I/O, egress and actual byte placement, then compare like-for-like usage
deltas. Check again during heavy dogfooding. Distinguish cumulative invoices,
measured deltas, estimates and uncovered cost. Tests and call estimates alone do
not prove the cost target. An opt-in migration is not complete while the old
path or migration flag remains. Seek approval for any removal that needs it.

Before a one-off job (migration, backfill, rebuild, dry run, compaction or purge),
record the deployment, expected rows and bytes read and written, and a cumulative
stop in **Convex billed database I/O** (GB and dollars at $0.20/GB). Include index
I/O, retries and all pages. Run a dry run only if its answer changes the decision;
its reads count too. Start with a bounded batch, reconcile actual provider usage
([Convex spend](../operations/convex-spend.md)), and do not start another batch
unless its estimated billed I/O plus a reserve for the final page fits the
remaining budget. Function reply counters are not billing ceilings. Report the
actual total or where the run stopped.

Do not run ad-hoc dashboard, Convex MCP or CLI inline queries on shared
deployments. Use a bounded repository command with a stated budget. Some reviewed
operator commands, such as [storage inventory](../operations/storage-inventory.md),
use the inline transport and also log as `testQuery`; that label alone identifies
neither the client nor the operator.

## Runtime and release hygiene

Use one approved installed `nforge` for live work, tracking accepted main; the
lead adopts releases first. A Lane build tests that Lane's code and is not an
alternate live CLI. Report CLI friction instead of building a private workaround.
Before a live step or measurement, check the installed revision against main or
the measurement's explicit frozen pin.

After a runtime swap, identify and stop obsolete detached workers without
interrupting in-flight commands or check controllers pinned to their original
runtime. Inspect process IDs and executable names, never full secret-bearing
arguments or environments. Verify idle Convex usage returns to zero within five
minutes. Clear `FORGE_R2_MAINTENANCE` after its approved operation and confirm it
is absent. Never leave maintenance enabled.

Check free disk before launches, builds and tests. Use the shared heavy-command
limiter (`nforge heavy`) rather than competing unbounded builds. Heavy slot count,
disk reserve and parallel builder count come from local machine setup; put the
numbers in each brief, never in the repo.
Clean up your own regenerable temporary output. Do not delete pinned roots,
shared dependencies, active runtimes or non-regenerable data; ask the owner with
exact scope and commands when cleanup needs their decision.

[AGENTS.md](../../AGENTS.md#hard-rules) owns secret handling and owner decision
rights. Keep production, publishing and outside-user trials owner-gated; they are
not automatic phase gates. Secret rotation follows the owner's approved release
plan, not an unapproved side effect of a task.

## Benchmark discipline

Use [Baseline to beat](../research/p6-baseline.md) for the current real-agent reference, historical results and partial P6 evidence before comparing a new run.

Separate exploratory dry runs from scored results. Write the acceptance bar,
repeat count, noise rule, fair baseline, compute, prompts, cost coverage and void
criteria before measuring. Run dry qualification on the exact landed, reviewed
harness and runtime pins before scored work. Dry findings become generic
root-cause fixes for every project, never special cases for tasks or this repo.
Re-pin and repeat dry qualification after a fix.

Give each queue change its own temporary switch and a named A/B arm with only
that switch changed from the baseline. Include a combined arm only when each
switch also has an isolating arm. After the A/B decision, remove each switch
and its unused code path. See the [bench operator's switch arm setup](../../evals/bench-t3code/README.md#named-queue-switch-arms).

Compare only like with like: the same N, scenario set (name, version, tasks),
base and seed. The queue A/B report refuses any other comparison and names the
matching accepted cell. Run one cell per background command with the runner's
maximum timeout, through `scripts/bench-t3code/cell.mjs`. A cell stopped by a
runner limit is void-infrastructure, not a crash, and is rerun once
automatically. A second stop in a row is reported, not rerun.

When the bench operator asks the lead a question, it also posts that question as
a comment on the incident Item. Then the lead's self-check of that Item finds it,
even if the message to the lead is missed. A decision the lead gives goes on the
same Item.

Honor the benchmark driver's freeze or landing hold before every submission. Wait
until it is released; never remove or edit another operation's hold. Record and
compare source, CLI, deployment, harness and runner versions at both ends of a
measurement. Version drift invalidates affected comparisons.

Keep a scored run frozen. A change to its plan creates a new plan before scored
cells run. Do not add, omit or repeat scored samples because of their result.
Disclose every void and interruption, its reason and any replacement; do not score
invalid cells. Publish unfavorable results and coverage gaps as well as wins,
with comparable before/after methods and sample sizes. Dry qualification is not
scored proof. Follow the [registered benchmark plan](../research/b15d-bench-plan.md)
for the current experiment's exact commands and rules.
