# Leading work on Forge

Read [AGENTS.md](../../AGENTS.md), [principles](../principles.md),
[status](../status.md), [roadmap](../roadmap.md), the [Phase 6 plan](../phase6-plan.md) and its
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

For this project's current work, builders and independent reviewers use GPT through Codex, model `gpt-6.1-sol`, reasoning effort `high`. There is no Claude fallback. This is the current project instruction, not a generic Forge product default; capacity does not authorize a silent provider switch.

The approval design on Issue 7f085ec9 treats AI and human approvals equally, binds approval to exact heads and classifies the change rather than its author. Mandatory human or multiple-human approval is not the selected design. Implementation/enablement remains tracked there; this instruction does not change an existing gate.

Now has no user-facing money or ledger; operator Convex costs stay internal (Issue 50f2e809). Public mirroring follows [Sync identity](../workflows.md#sync-identity), preserving personal Git identity.

## Delegate finite slices

Give each builder one finite task, its own Lane and a compact handoff. Follow-ups
use a fresh agent; recovery of an interrupted task resumes from its saved head.
Builders start, finish and fix their own Lanes. Do not ferry scratch patches or
land a builder's unverified work for them. The builder rules replace older
instructions to stop before landing, unless the brief explicitly requires review
before acceptance.

Run independent ready slices in parallel within the authorized delegation scope.
Serialize real dependencies and name them. Before launch, check shared model
usage, memory pressure, swap and disk; all projects share these resources. Pace
usage to avoid exhausting a short window in one burst. Use the owner's chosen
models and approved fallback policy; retry transient capacity failures on the
same provider up to three times before an authorized fallback. Never silently
switch models.
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

Before reporting a landing, match the receipt and operation id to that builder's
Lane and verify its files on accepted main (a named symbol or file, not a receipt alone). A completed patch or a passing check
is not a landing. If `convex/` changed, also verify the deployment workflow is green
at that commit; report a pending deploy explicitly. The lead owns authorized
release/deployment work; builders do not deploy as a side effect of a code task.

Close an Issue only with evidence for every Done-when line (a comment per line, or a
named Issue that now owns a moved line). A held close names the open lines; never close
with lines unmet, and never leave a fully evidenced Issue open. Merge duplicates and
close verified work yourself; scope drops and won't-do go to the owner.

Report in plain language: what landed, what is running with thread links, and
what the owner needs to decide. Include reconcilable done/in-progress/open counts
per Initiative, landing ids since the previous report and any changed denominator.
A speed or reliability question gets a number with its metric and window, or
"cannot measure yet". Say first when the metrics cannot observe the path.
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

Separate exploratory dry runs from scored results. Write the acceptance bar,
repeat count, noise rule, fair baseline, compute, prompts, cost coverage and void
criteria before measuring. Run dry qualification on the exact landed, reviewed
harness and runtime pins before scored work. Dry findings become generic
root-cause fixes for every project, never special cases for tasks or this repo.
Re-pin and repeat dry qualification after a fix.

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
