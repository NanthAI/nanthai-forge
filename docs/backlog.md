# Backlog

Open work and friction, one line per problem. S is a small focused change, M spans several modules or needs qualification, and L changes a cross-cutting contract. The [roadmap](roadmap.md) sets order and scope. Remove items when fixed; performance observations need matched measurements.

## Product bugs and behaviour

- M: Add compact Lane/dependency lookup and watch with acceptance pins, name/outcome filters and compact records; make status a pure read with explicit separate orphan-run recovery.
- L: Start/status/review/sync/accept/cleanup/abandonment still share long owner critical sections; move immutable preparation and pure observations outside publication locks with guarded snapshots and stable queue age.
- M: Reconcile every nonterminal batch member after leader acceptance/failure and expose terminal receipts even when its finish driver exited or land-ready has no waiting journal.
- M: Cancel superseded Actions executions immediately when a newer View is dispatched and qualify sharded full-check wall time on matched runners.
- M: Record cancellation/signal actor, reason and initiator in run receipts and failure summaries without losing original output.
- M: Detect duplicate identical import additions after text merge or present them as conflicts; preserve valid distinct imports and source semantics.
- M: Short-form finish retries can re-resolve source/default pins after a lost reply; reconcile the retained operation before resolving mutable defaults and test observation-timeout changes.
- M: Restart briefs omit active command/validation IDs and superseded queued heads; reconcile live ownership and present pending runs before an agent resumes a Lane.
- M: Detached finish controllers need durable liveness/terminal diagnostics and a nonzero exit on uncaught failure; retain resumable operation/run IDs after process loss.
- L: Independent approved Intents cannot be composed into one explicitly requested cohort landing/check; finish.with handles siblings only.
- S: Make WorkService.execute/dispatch policy support explicit or consistent so library fixtures do not discover it through UNSUPPORTED errors.
- S: Expose pinned-head sync through CLI with existing operation identity, provenance and undo semantics for authorized stacked work.
- S: Work transaction whole-collection enumeration and indexed equality lookup are easy to confuse; make the API distinction explicit.
- M: Sync conflict handoffs need per-side intent/change summaries, delete/edit resolution choices and policy/retry-state context; reduce shared lifecycle extension-point overlaps.
- M: Distinguish named failed/flaky/quarantined outcomes accurately and account for changes touching asserted output; do not equate quarantine with a fixed regression.
- M: Hosted Intent migration has no CLI command and can exceed the five-minute client timeout.
- S: Hosted screenshot capture reports only “not indexed” when the Work index is rebuilding; expose that state.
- M: Public imports as personal mirrors with a verified claim are decided but not built.
- M: Owner-handle URLs require account handles rather than raw identity IDs.
- M: Remaining UI work includes a shared Lane/Intent timeline layout, Planning/Initiative status transitions, a Code file-tree entry, duplicate Lane-on-file facts and the shared Secrets disclosure menu.

## Performance and qualification

- S: Agent test selection classifies deleted modules as unknown and selects the full suite; preserve the base import graph for deleted paths so removal work can use conservative affected tests. A Lane started before main deletes a module hits this even when none of its own edits delete files; expose its pinned base-to-head selection separately from the main comparison.

- M: Measure owner-sized one-landing source return and diffstats after delta/batched derivation; preparation/full fallback still scales with retained Work and production savings remain unverified.
- M: Check timing receipts lack install/build cache evidence and machine/child-worker pressure, making preparation and execution costs hard to distinguish.
- M: Qualify verify/checkpoint latency on a quiet machine and under matched contention; suite fanout, concurrent installs and other applications can invalidate performance comparisons.
- M: Reduce cold/contended peer-index I/O with incremental changed-page inventories; keep incomplete coverage and matched latency measurements explicit.
- M: Profile full owner Work load/save and cleanup test phases; improve fixture construction without bypassing durability or safety assertions.
- M: Measure and reduce record/catalog change-descriptor overhead for small deltas; select a cheaper representation only with identical pinned-byte semantics.
- M: Concurrent rebuild/test publication can expose partial dist modules; stage build output atomically or coordinate readers and writers.
- M: Qualify remaining Git HTTP/native-Git remote timing races with retained per-file logs and matched runner conditions; quarantine does not prove a race fixed.
- M: Long focused and full test runs need current file/subtest and elapsed progress, with partial per-file output retained on interruption.
- M: Stream full TAP failure diagnostic blocks immediately and persist partial per-file output during local verification, including external termination before child close.
- M: Provide a durable bulk writer or verified reusable owner-sized fixture seed, excluding setup from matched measurements without weakening fixture validation.
- M: Snapshot running check output safely during native exchange without requiring a concurrently appended log to stay byte-stable; retain immutable pinned retry bytes.
- M: Add tree-only State materialization/export, incremental Git-export reuse and progress instead of per-object subprocess ancestry export for head-only consumers.
- M: Measure Now/Work readiness against 1.5 s and first Lane diff against 1 s on the live app; then assess one-round-trip bootstrap, indexed changed paths and newest-first summary pages.
- M: Audit remaining eager history loads, chunked payload budgets, duplicate cold-open index builds and Git HTTP projection rebuilds with realistic contention.

## Agent tools, fixtures and documentation

- S: Lane affected-tests selection falls back to the full suite for dependency manifests and generated third-party notices; expose a pinned implementation scope plus separate package/notice checks for agents whose brief forbids full-suite execution.

- M: Installed CLI/plugin packages can lag accepted main; route plugin execution through the nforge wrapper and expose installed source/version pins in lifecycle receipts.
- M: External build-slot admission lacks FIFO tickets, holder/elapsed progress, install admission and separation of remote orchestration from local CPU work. Document argv arrays or full Node/npm invocation for zsh.
- S: Abbreviate transpiled data-URL stack frames in fixture diagnostics while retaining error name, message and source location.
- S: Expose read-only affected-tests output from the existing impact selector (an agent command naming the tests a Lane's change affects) so agents run only those and never the full suite; the landing check is the one full run on the combined work of concurrent Lanes.
- M: Cache check results by exact tree and check definition so identical work is never tested twice, across Lanes and retries.
- S: Provide a pinned snapshot-read/drain helper for direct library/export callers racing post-accept workers, preserving original source and operation IDs.
- M: Add an explicit fixture/local-build mode to ui-shots while retaining real signed-in integration captures for hosted review.
- S: Provide or document offline generated Convex API type maintenance without connecting to a deployment.
- S: Extract a reusable allowed/denied caller-matrix fixture so new hosted public functions get explicit authorization coverage.
- M: Hosted fixture dispatch lacks complete production handler and wire-return validation, allowing benchmark unknown counts and invalid return shapes to pass synthetic tests.
- S: Complete the hosted-tree ConvexReactClient class double with the actual client surface; hook-level stubs alone do not cover wrappers around constructed clients.
- S: Parse or anchor fixture import/export rewriting so JSX or string copy containing from is not treated as a module dependency.
- S: Generate builder file/Lane pointers from current records, include explicit actor/tool names and report active dependencies rather than copying stale paths or UUIDs.
- S: Offer optional structured progress events with phase start, operation/run IDs and queue/run timing for benchmark tooling.
- S: Add a reusable web entry-point reachability and unused-CSS diagnostic for large UI deletions.
- S: Provide an explicit generated-workflow export/registration setup command for Actions runners without silently writing the default branch.
- S: Detect/report runner Git capabilities before native operations and retain sanitized WORK_GIT_FAILED stderr/signal details; old Git can reject --no-lazy-fetch.
- M: Handoffs need agent diff against head/base, own-save changes excluding synced main, pinned State/file reads and a tree-only materialize/export command.
- M: Record Lane startedAt at the next coordinated Work-format change so sibling Lane timelines do not inherit the Intent date.
- S: Task launchers need an explicit offline presence mode and must not require hosted announcements for no-touch/dry-only work.
- S: Provide llms.txt and llms-full.txt entry points for agent documentation.

## Operations and privacy

- S: Summarize skipped cleanup copies by count/reason in finish receipts and expose full detail on request.
- L: Define a separate redacted full-Work/evidence transport contract preserving digest lineage and retry identity; projections alone do not redact original archives.
- M: External runner/API fakes can miss real behavior; qualify on throwaway live fixtures and retain exact runner/runtime evidence.
- M / owner decision required: Check/exchange outputs accumulate; decide any result/log/tree retention and deletion behavior explicitly before implementing an automatic age rule.
- M: Identify and explicitly disable the unexpected managed/cloud MCP client in benchmark cells; failed auth does not establish a tool-isolation guarantee.
- S / owner decision required: Clean old installed runtimes and leftover scratch Lanes/folders only within the agreed cleanup scope.
- M: Installed runner/batch fixes still require a CLI reinstall; shorten the deployment/install path without claiming an unmeasured speedup.
- M: Complete the approved throwaway backup/restore drill and the planned weekly export/four-copy/off-site and monthly restore workflow.
- S: Verify benchmark fixtures leave no hosted projects or benchmark repositories after each authorized run.
- S: Observe hosted database spend after the idle-tab/egress changes; production savings remain unverified.

## Later (see the roadmap)

- L: Hosted Lanes, hosted accept, server-side landing queue, hosted two-way GitHub sync and offline qualification.
- L: Self-hosted worker (`nforge worker`), runner picker and contributor first-click rule.
- M: Git serving and Lane refs; Lane-scoped undo.
- M: Optional remote pre-check an agent can request before finishing: its affected tests run on the project runner, nothing heavy on the agent's machine.
- L: Making-of browser timeline/flows, Intent discussions with per-item visibility, Markdown/images on Intents and a real dependency graph in Code.
- L / owner decision required for restrictions: Open-source proposal limits, anonymous visibility, optional CLA, hidden paths, stars and forks with upstream; extension model; ownership areas, batch actions, saved filters, inline comments and change-type approval rules.
- M: Slack needs-you notifications, WebMCP and Candidate previews.
- Not wanted: estimates, sprints, custom fields and workflow builders.
