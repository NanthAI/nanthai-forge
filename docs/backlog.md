# Backlog

Open work and friction, one line each, grouped. Order and scope for the big items are in the [roadmap](roadmap.md). When Forge gets in the way while building Forge, add a line here (what happened, what it cost, the fix); delete the line when it is fixed. Last updated: 2026-10-19.

## Product bugs and behaviour

- `agent status` with a Lane selector ignores it and returns owner-wide history (very large output). Return the selected Lane first; add a compact Lane lookup, `agent diff` and a State file reader.
- Lane start, checkpoint, sync and status queue behind owner compose and finish locks (7 s to 100 s). Reads still join the writer queue.
- Batch members stay "waiting to land" after the batch leader lands them; an orphan batch entry is invisible to `land-ready`; a finish process can vanish without terminal JSON.
- Superseded GitHub Actions check runs are not cancelled when a newer Candidate is dispatched, which wastes runner minutes.
- Cancellation records no actor or reason.
- The merge keeps an import line added by two Lanes, which produces a syntax error.
- Hosted Intent migration has no CLI command and exceeds the 5 minute client timeout.
- A machine-wide check queue directory is required; sandboxed agents and CI containers fail. Error mapping landed; documentation and an owner-local fallback did not.
- The Work batch schema maximum (4, raised to 8) needs a format bump for older binaries; Lane records lack a start time; agent actor names are missing in Lanes unless passed.
- A hosted push can fail with a work-changed error when a post-accept audit writes Work.
- The receipt verdict "quarantined" is emitted for any named failure, even when nothing is quarantined. Relabel it.
- Fast-path acceptance evidence needs Work format 14. Keep the option off until every owner writer is reinstalled.
- The hosted screenshot capture can hit a project with no selected Work index and reports only "not indexed". Expose the rebuilding state.
- Agent validation errors are generic (a review request missing a pin says only "Invalid agent action"). Return field paths; explain mutually exclusive selectors; show usage in `agent link --help`.
- Help text and the dispatcher disagree for `agent review` and `inspect`.
- Public imports as personal mirrors with a verified claim: decided, not built.
- Owner handles in URLs (instead of raw identity ids) need account handles.
- Planned UI work: one Lane and Intent detail layout with a merged timeline; Planning list and Initiative page with explicit status transitions; Code opens as a file tree; "Accepted today" as a full-width history section; equal-height Now cards; duplicate "Lane on this file" in the Code header; the Secrets disclosure should use the shared menu.

## Performance

- Hosted source return took hours at scale on the last real push. The egress fix is deployed but unmeasured: make one measured push.
- Prepare loads two complete Work snapshots per push. No live number exists for a one-landing push after the delta format.
- `export-native-git` for deploys takes 15 to 45 minutes with no progress output; needs a tree-only materialise or incremental export.
- Full `verify` takes 11 to 12 minutes (target under 6). A single checkpoint takes 2.9 to 4.6 s (target 1 s). Cold or contended presence reads reach about 2 s at p95.
- Shared core imports keep check scope broad; measure module boundaries before promising faster core checks.
- Ten concurrent checks on a laptop push load very high: share immutable dependencies, move cleanup outside the owner lock, build check offload.
- The slot wrapper for machine-wide build limits has no queue order or position.
- Transpiled Convex test modules are not cached across targeted runs; a fixture writer for owner-sized stores is missing.
- Page-load budgets (Now and Work 1.5 s, first Lane diff 1 s) need live measurement; then: authenticated bootstrap in one round trip, an indexed changed-path envelope for Lane heads, newest-first summary pages.
- Audit leftovers: eager Work history load, chunked payload budget, duplicate cold-open index build, a real contention test, Lane reads of whole history, Git HTTP projection rebuild.
- Tests that cost a full re-check when they flake (concurrent writers under zero lock wait in the Git HTTP, lock queue, local reliability, native exchange and landing batch suites). Some are fixed; the flake classifier once mislabelled a real regression.

## Docs

- New `docs/**` files must be added to the packaged document list (`scripts/package-documents.mjs`); the failure message should name that file.
- Queued notes not yet merged into architecture, workflows, operations and status; measured throughput and cost numbers are missing from [status](status.md).
- Stale pointers in builder briefs; the briefing says checkpoint, sync, checkpoint where one is enough; `ui-shots` needs a fixture mode; offline codegen for generated Convex API types; per-suite build prerequisites should be stated.
- `llms.txt` and `llms-full.txt` agent docs.
- Glossary entry for Channel (outside developers found it and View confusing).

## Operations and retention

- Check directories and exchange directories under `.forge/work` grow without bound. Planned rule: keep the result and log tails, drop trees after 7 days, automatically.
- Old installed runtimes and leftover scratch Lanes and scratch folders need cleaning, with owner approval.
- The installed CLI carries the runner code, so every runner or batch fix needs a deploy and reinstall; deploys are slow.
- Detached finishes die at a two hour background limit; watcher scripts are fragile.
- Machine load from other applications contaminates benchmark timings; run benchmarks on a quiet machine, one at a time.
- Backups: a weekly export job with four copies and an off-site copy, a monthly restore drill, and the approved first drill on a throwaway deployment.
- Verify no leftover benchmark repositories or hosted benchmark projects remain after each run.
- Presence workers can leak when throwaway owners are abandoned; reap them and auto-unbind after 30 minutes without local activity.
- Spend: watch the hosted database bill until the idle-tab and egress fixes are verified.

## Later (see the roadmap)

- Hosted Lanes, hosted accept, server-side landing queue, hosted two-way GitHub sync, offline qualification.
- Self-hosted worker (`nforge worker`), runner picker, Modal with the project's own key, contributor first-click rule.
- Git serving, Lane refs; Lane-scoped undo.
- Making-of in the browser; timeline and flow views; Intent discussions with per-item visibility; Markdown and images on Intents; a real dependency graph in Code.
- Open-source mode (configurable proposal limits, anonymous visibility, optional CLA, hidden paths, stars, forks with upstream); extension model; scale-mode cockpit features (ownership areas, batch actions, saved filters); inline line comments; change-type approval rules.
- Slack needs-you notifications; WebMCP; previews of Candidates.
- Not wanted: estimates, sprints, custom fields, workflow builders.
