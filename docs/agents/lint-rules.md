# Product lint rules and guards

A bug class seen twice, or a fix that was reverted and retried, gets a guard that fails the
build ([fix the class](improvement-loop.md#fix-the-class)). A reminder in a brief is not a guard.
This page lists the guards and says where the next one goes.
The [code structure audit](#code-structure-audit) records proposed path conventions for idle and hot code.

## Pick the cheapest guard

1. **Lint rule** in [`scripts/lint/forge-plugin.mjs`](../../scripts/lint/forge-plugin.mjs) when
   one file's syntax shows the class (a call, an import, a chained method). oxlint loads the
   plugin through `jsPlugins` in `.oxlintrc.json`. `npm run lint` and the landing check's
   `verify` run it with the built-in rules, so it adds no extra file walk.
2. **Check script** in `npm run check` (`scripts/check-foundation.mjs`) when the guard reads
   files oxlint does not lint (scripts, docs, workflows, Markdown) or needs repo-wide state.
3. **Test budget** in `tests/` when only running code shows the class (calls, bytes, timing).

## Current guards

| Guard | Kind | Class and incident | Fixture test |
| --- | --- | --- | --- |
| `forge/no-convex-collect` | lint, `convex/` | `.collect()` reads every matching document at any scale (e32cb0e7: 3 unbounded metrics reads cost about $0.11; 1b66b35a: 149 KB pages) | `tests/lint-rules.test.mjs` |
| `forge/convex-bounded-query` | lint, `convex/` | `db.query()` with no index and no limit is a full-table scan (same incidents) | `tests/lint-rules.test.mjs` |
| `forge/no-readonly-fsync` | lint, `src/` | fsync through a read-only handle: a directory, or a file opened only to flush it. Windows refuses both with EPERM (89460350: `init-native` failed on windows-latest); use the `state/durability.ts` helpers | `tests/lint-rules.test.mjs` |
| `forge/native-path-separator` | lint, `src/` | a `/` appended to a `node:path` `join`/`resolve`/`dirname` or `realpathSync` result never matches on Windows (89460350: `save` refused every native Lane on windows-latest); use `sep`, or `posix` for repository paths | `tests/lint-rules.test.mjs` |
| `forge/no-raw-mode-bits` | lint, `src/` | `mode & 0o111` or `mode & 0o077` read straight from disk: Windows stores neither, so a save there recorded every executable file as plain and `import-native-git` refused every retained file (89460350); use `src/file-mode.ts` | `tests/lint-rules.test.mjs` |
| `forge/raw-symlink` | lint, `src/` | `symlinkSync`/`symlink` outside `src/source-links.ts`: Windows refuses links without Developer Mode or administrator rights (89460350); source links fall back to a target file, directory links become junctions | `tests/lint-rules.test.mjs` |
| `forge/rename-over-directory` | lint, `src/` | `mkdirSync(X)` to claim a name, then `renameSync(_, X)`: POSIX replaces the empty directory, Windows refuses (89460350: `import-native-git` failed on windows-latest); use `publishDirectory` | `tests/lint-rules.test.mjs` |
| `forge/test-no-fixed-sleep`, `forge/test-no-retries`, `forge/test-no-raised-timeout`, `forge/test-no-unsignaled-polling` | lint, `tests/`, frozen-count allowlist | tests that wait on the clock, retry, raise a timeout over 10 s or poll on a timer flake on a loaded runner (ffbec6ef; guard 7, Item 611a1795; the ideas follow the MIT-licensed landmines testing rules, rewritten, no text reused) | `tests/lint-rules.test.mjs` |
| Network boundary | check script `check-network-boundaries.mjs` | bare `fetch`, `AbortSignal.timeout` or network libraries bypass the shared deadline helper (06cfc7b7, aabe52a7) | `tests/network-boundaries-scripts.test.mjs` |
| Env print | check script `check-env-print.mjs` | scripts, workflows and docs print environment values or full process listings (df2ba360; a dev key leaked 2026-10-22) | `tests/check-env-print.test.mjs` |
| Idle queries | check script `check-idle-queries.mjs` | live query arguments derived from the clock, and `refreshKey`, re-run queries for idle tabs | `tests/idle-queries.test.mjs` |
| Local paths | check script `check-local-paths.mjs` | machine-specific home paths in tracked files | `tests/local-paths.test.mjs` |
| SPDX header | check script `check-spdx.mjs` | the licence line pushed below imports (f44ac5e0) | `tests/check-spdx.test.mjs` |
| Landing attempt forks | check script `check-landing-attempt-forks.mjs` | hand-built child ordinals outside `forkLandingAttempt`; a reserved finish must refresh its lineage from the current immutable attempt when installed (8c9b84fc) | `tests/landing-attempt-fork-guard.test.mjs`, `tests/hosted-landing-attempt-fork.test.mjs` |
| Recovery advice | check script `check-recovery-advice.mjs` | backend conflict evidence that guesses the caller's checkout | `tests/recovery-advice-guard.test.mjs` |
| Action pins | check script `check-action-pins.mjs` | workflow `uses:` lines not pinned to a commit SHA | `tests/action-pins.test.mjs` |
| Candidate steps | check script `check-candidate-steps.mjs` | in a check job: a step after the check step, an `id` or token on it, a cache save after it or off the default branch, an unbounded cache restore or `npm ci` | `tests/action-pins.test.mjs` |
| Test signal | check script `check-test-signal.mjs`, ratchet | new real sleeps or timer waits, elapsed-time asserts and reads of `docs/` text in tests: they flake on a loaded runner or fail on prose edits and guard no behaviour (ffbec6ef; t3code cut 43% of its tests as low-signal) | `tests/check-test-signal.test.mjs` |
| Convex index deployment contract | existing schema-index test | Unused table indexes and prefixes without a definition-local ordering reason add write/storage costs | `tests/convex-schema-indexes.test.mjs` |
| Growth guard | check script `check-growth.mjs`, ratchet | Convex tables, public error codes, agent actions, CLI commands, glossary terms and unreferenced exports piling up: friction became a slice and a guard, and nothing was removed (ed28fc6b; design review 2026-11-09) | `tests/check-growth.test.mjs` |
| Token permissions | test | a GitHub App token permission change broke one path class the mirror pushes (708b6943: contents-only token got 403 on a `.github/workflows/` tree). A permission change must be tested against every path class | `tests/hosted-github-mirror-retry.test.mjs`, `tests/github-token-permissions.test.mjs` |
| Forge-only rules | test | product code keys a fast path on Forge's own check, layout or npm lockfile (audit 1bb0d8e6: first-check reuse only for `scripts/forge-check.mjs`, 05df5aed). An ecosystem lockfile, folder or extension list outside the [ecosystem registry](ecosystems.md) fails too (9c0ece48). Hits are listed in [Forge-only rules](../forge-only-rules.md) | `tests/forge-only-rules.test.mjs` |
| BYOCI parity | test | a landing fast path that works for Forge's check but not for a project's own command on a pnpm tree with a link and a submodule (05df5aed) | `tests/byoci-parity.test.mjs` |
| Cross-head shared risk | test | identical-entry overlap removal also removed global/declared inputs and shared-folder risk (1018d0f8 review). Analysis and publication must judge the complete deltas; only an unchanged complete tree bypasses path risk | `tests/hosted-cross-head-reuse.test.mjs`, `tests/hosted-first-check-landing.test.mjs` |
| Message mirror | test | the finish message dropped from the mirror commit (eacfdb6e, b30284de) | `tests/landing-message-mirror.test.mjs` |

## Test hygiene allowlist

The `forge/test-no-*` rules run over `tests/` outside the raw fixture directory. Each test file may keep the count it had when
the rules landed and no more, in [`tests/test-hygiene-allowlist.json`](../../tests/test-hygiene-allowlist.json) (one line per
file, keys `sleep`, `retry`, `timeout`, `poll`, `date`). A new occurrence fails lint on the occurrence past the allowance. A file that
drops below its allowance fails lint too, so a deletion is recorded:

- `node scripts/lint-test-hygiene.mjs --update` lowers every entry to the current count and drops deleted files. It never raises one
  and exits 1 while any file is above its entry. `--init` writes the first list and refuses to overwrite one.
- A real exception: raise the entry by hand and say why in the landing note. The diff shows it to the reviewer.
- What counts: a `setTimeout` inside `new Promise` that settles it (and a `timers/promises` wait, `sleep(...)`-style helper,
  `Atomics.wait`, a spawned `sleep`) is a `sleep`; the same in a loop, a `setInterval`, and `poll(() => ...)` / `eventually(() => ...)` are a `poll`;
  `retry`/`retries` in a test's options or `retryTimes` is a `retry`; a `timeout` option over 10 s (or not a plain number) on a test
  or hook, `jest.setTimeout`, `testTimeout` is a `timeout`. `setTimeout(resolve, 0)` is a yield, not a sleep.
- `forge/test-no-implicit-date` counts `Date.now`, `Date(...)` and `new Date()` (incident 822fb3db). Pass a fixed instant to time-dependent helpers and freeze the clock where the code under test reads it internally. Use a monotonic clock to measure elapsed time. Existing explicit wall-clock checks, such as the storage exemption expiry guard, remain covered by their file's allowance.
- It overlaps the older [Test signal](#test-signal) ratchet below on sleeps; that ratchet stays until this one has covered every sleep it counts.

## Test signal

A test earns its place by naming the behaviour, contract or incident it guards. Do not write:

- tests of what TypeScript types or validators already guarantee at an internal boundary;
- mock-call mirrors (the test only repeats which mock the code calls);
- doc-text mirrors (the test asserts a sentence or heading in `docs/`; the documents check covers prose);
- wall-clock asserts or real sleeps (inject a clock, or wait on the event).

These stay wanted: validation at the outside boundary (user, network, file input), call-count and
byte budgets, incident replays, and golden contracts.

The ratchet `scripts/check-test-signal.mjs` runs in `npm run check` and counts, per test file:

| Pattern | Counts |
| --- | --- |
| `sleep` | `setTimeout(`, `setInterval(`, `Atomics.wait(`, `sleep(`/`delay(`/`pause(` calls (and `timers/promises` aliases), a spawned `sleep` |
| `elapsed` | an assert comparing `Date.now()`/`performance.now()` deltas, or a variable holding one |
| `docs` | a read of the repository's `docs/` (`new URL('../docs/…', import.meta.url)`, `readFileSync('docs/…')`, `join(repo, 'docs/…')`) |

It fails only when a file's count goes above its baseline in
[`tests/test-signal-baseline.json`](../../tests/test-signal-baseline.json) (a file not listed has
baseline 0). The standard check scans only the changed test files; a direct run, or a change to the
baseline or the script, scans all of them. Counting is per source line.

- Real exception: put `// test-signal: allow <reason>` on the line, or alone on the line above. A marker
  without a reason exempts nothing.
- After deleting or rewriting tests, run `node scripts/check-test-signal.mjs --update`: it lowers the
  baseline to the new counts and never raises it (it also drops deleted files). It exits 1 if a file is
  still above its baseline. `--init` writes the first baseline and refuses to overwrite one.
- Findings name file, lines and pattern only; they never echo source.

## Growth guard

The rule: every brief and every landing note names what the change removes or merges, or says why nothing can
go. The ratchet `scripts/check-growth.mjs` runs in `npm run check` (static, no project code, no Convex call,
under 3 s) and counts:

| Count | Counts |
| --- | --- |
| `tables` | Convex tables: `name: defineTable(` in `convex/` (generated code excluded) |
| `errorCodes` | public error codes: an UPPER_SNAKE literal (3+ characters, not a Node errno such as `ENOTDIR`) that reaches a caller as a structured error code, in `src/`, `convex/` and `netlify/` (tests excluded): the first argument of `new ForgeError(`, the code argument of `invariant(cond, 'CODE', …)`, and a `code: 'CODE'` property. A code counts once however often it appears. It also counts some result codes that are never thrown, so it is an upper bound; the same rule applies on every run |
| `agentActions` | agent action names in `src/agent-verbs.ts`: the lifecycle verbs, each mode flag's action, board modes, named reads and operator actions |
| `cliCommands` | top-level commands dispatched in `src/cli.ts` |
| `glossaryTerms` | public glossary terms: the distinct bold terms in `docs/concepts.md` |
| `machineDependencies` | entries in [`tests/machine-dependencies.json`](../../tests/machine-dependencies.json) `machineDependencies`: product paths (service, landing, checks, storage, mirror, deploys, release, backup) that need one specific machine. The target and today's count is 0. Where the lead session, builder sessions, the exit bench, the optional local check runner (`nforge worker`) and operator maintenance run is the user's own choice of machine; they are not counted. `hostedPaths` is the guarded list of the six paths that run hosted; one that moves back onto a machine is a rise: move its id to `machineDependencies` and run `--update --reason`. Each entry names an Issue that removes it (8-hex id) or a `staysBecause` reason. Public repo: no private paths or machine names |
| `unreferencedExports` | exported names (function, const, class, enum, type, interface) in `src/`, `web/src/`, `convex/` and `netlify/` that no other file mentions as a word (`src`, `web/src`, `convex`, `netlify`, `tests`, `scripts`, `evals`; a comment or string counts as a mention, so it undercounts). Public entry points are excluded: Convex `query`/`mutation`/`action`/`httpAction` functions and `src/index.ts`, `src/query.ts`, `src/cli-entry.ts`. Unused `internal*` Convex functions count |

The check fails when a count differs from its baseline: phase `start` in
[`tests/growth-baseline.json`](../../tests/growth-baseline.json) plus the sum of deltas in
`tests/growth-ledger/`. The header holds only version, phase and start. Each ledger file records
`kind`, `delta`, `reason` and `date`; its filename includes a unique update id and its content hash, so even equal deltas stay separate. Hand-edited counts,
invalid entries and mismatched hashes fail. A lower count also fails until `--update` claims the reduction, so removals cannot leave slack for a later unrecorded rise. The baseline moves through the update command:

- `node scripts/check-growth.mjs --update` lowers the baseline to the current counts. Run it after a change
  that removes something. It never raises a count.
- `node scripts/check-growth.mjs --update --reason "<what the change removes or merges, or why nothing can go>"`
  also raises a count that rose. Each rise or drop adds its own hashed JSON ledger file;
  concurrent Lanes add separate files instead of editing shared counts or a shared array. A reason shorter than 12 characters is refused.
  A rise of `unreferencedExports` also needs the 8-hex Forge Issue that deletes the extra exports in the reason
  (the same rule as a machine dependency); a reason without one is refused, and a ledger rise with no Issue fails the check.
  Lowering never needs a reason. After combining removals, re-run `--update` to reconcile any further fall;
  the check still refuses a count above the combined baseline.
- `node scripts/check-growth.mjs --print [--json]` prints the current, baseline and phase-start counts. A phase
  close records this table against the phase start (`start`). Add `--machines` to list every machine dependency with its
  Issue or reason and the hosted paths guarded; the P6 close report prints this block, which shows
  `Machine dependencies: N now, baseline N, start N`.
- Prefer removing or merging something to recording a rise. Renaming is neutral: names are counted, not lines.

## Add a lint rule

1. Add a rule object to `rules` in `scripts/lint/forge-plugin.mjs`. Use the ESLint rule shape:
   `meta` (with `docs.description` naming the incident Issue) and `create(context)` returning AST
   visitors. Report locations and a fix hint only; never echo source text that could hold secrets.
2. Turn it on as `"forge/RULE": "error"` in an `overrides` entry of `.oxlintrc.json` scoped to
   the paths the class lives in.
3. Add a row to the table above and a case to `tests/lint-rules.test.mjs` that fails on the
   incident's shape and passes on the bounded or approved shape. The last test there fails when
   a rule's description has no incident or the rule is missing from this page.
4. Run `npm run lint` on main. Fix each violation, or suppress it on its line with
   `// oxlint-disable-next-line forge/RULE -- reason`. A suppression without a reason is a
   review finding.

JS plugins are alpha in oxlint and not covered by semver; the fixture tests catch an upgrade
that changes the plugin API.

## Code structure audit

This audit describes the source at State `69d1a657049484239c1288b2869f2f9137a125629732099b11d6593c72e706ed`.
The naming and placement choices below are proposals for Issue `88a83b49`.
The idle and hot-path guard, including source moves and fixtures, belongs to Issue `70144f0c`.

### Module boundaries

| Boundary | What the code does today | Proposed placement |
| --- | --- | --- |
| Hosted agent client | [CLI](../../src/hosted-agent-cli.ts) and [MCP](../../src/mcp-hosted-agent.ts) share the hosted command surface. [Transport](../../src/hosted-agent-transport.ts) also coordinates local materialization and retry state. | Keep protocol validation and dispatch shared across the CLI and MCP. Use `hosted-<area>-client.ts` for remote calls and `local-<area>.ts` for machine-only state or I/O. Put orchestration at the entry point that owns the operation. |
| Native source and shared contracts | [Native source](../../src/native-source.ts) reads and materializes filesystem States. [State format](../../src/state/format.ts) and [physical manifest codec](../../src/physical-manifest-codec.ts) have runtime-neutral consumers. [Work schemas](../../src/work-types.ts) are used by Node, Convex and the browser. | Keep filesystem and process I/O in the local adapter. Keep portable codecs, validators and rules in shared modules with type-only imports where possible. Prefer a role such as `-schema`, `-codec`, `-selection` or `-runner` when it identifies a specific responsibility. |
| Hosted authority and storage | [Landing](../../convex/projectHostedLanding.ts) implements server-side authority. [Source storage](../../convex/projectConvexSourceStorage.ts) connects records to R2 data. [Browser](../../web/src/Hosted.tsx) and CLI are clients of that authority. | Keep access checks, current pins, operation replay and durable writes at the hosted boundary. Name adapters by what they select, store or execute. Use `native-` for Forge's native source representation or its existing implementation, and `local-` for the location of execution. An offline Lane remains a checkout of the hosted project. |
| Convex API and server internals | [Mirror read](../../convex/projectGithubMirrorRead.ts) registers a client-facing query with validators and an access check. [Mirror store](../../convex/projectGithubMirrorStore.ts) registers server-only mutations. [Mirror status](../../convex/projectGithubMirrorStatus.ts) exports a plain helper. | Keep new client-facing endpoints in clearly named feature entry modules. Give server-only registrations an `Internal` or narrow worker-role name, and data helpers names such as `Rows`, `Store` or `Status` according to their actual role. Visibility comes from the Convex registration builder. Preserve existing function addresses, scheduled references, authority checks and the [mutation wrappers](../../convex/server.ts) when moving helpers. |

A caller looking for a schema currently has to distinguish the shared [Work record schema](../../src/work-types.ts),
the deployed [Convex schema](../../convex/schema.ts), and the [hosted agent contract](../../src/hosted-agent-contract.ts).
Keep those responsibilities distinct. Use feature plus role in names, and preserve existing import paths
where callers rely on them. Consider a feature directory when a cohesive group has enough files that the
flat prefix is hard to scan. Keep the repository's 300-line aim as a review prompt and split at a
responsibility boundary.

### Path conventions for review

**Idle paths.** Use `*.idle.ts` or `*.idle.tsx` for modules on event-driven observation paths
that initiate zero Convex calls once quiescent. [Mirror status](../../convex/projectGithubMirrorStatus.ts)
is a candidate leaf. Its callers use the existing [authorized query](../../convex/projectGithubMirrorRead.ts),
which responds to server writes. [Import watch](../../web/src/import-watch.ts) is a browser candidate.
It attaches a stable invalidation subscription, refreshes on a changed result, focus or reconnection,
and removes its subscription and listeners on cleanup. Keep generated API paths stable by tagging or
moving eligible helpers, with registered handlers retaining their paths.

Start with direct timer and scheduler calls in tagged files. The guard fixture should fail on a
refresh timer and a scheduled poll and pass for event registration and cleanup. Keep the current
[idle query argument guard](../../scripts/check-idle-queries.mjs) for browser clock-driven resubscription
across the whole tree. [Live reads](../../web/src/live-reads.ts) uses a one-shot timeout to *detach*
subscriptions. [Mac worker](../../src/hosted-mac-worker.ts) starts deadline and lease timers for a
claimed run. Keep those mixed lifecycle modules outside the idle suffix as written. Measure opaque
helper calls through the existing call-budget evidence.

**Hot loops.** Use `*.hot.ts` for narrow primitives with a documented input scale. In a mixed
module, start with a `// hot-loop: <reason>` tag immediately above the specific loop. For example,
[physical manifest binary primitives](../../src/physical-manifest-binary.ts) are used by the
[digest bucket codec](../../src/physical-manifest-codec.ts) and [root codec](../../src/physical-manifest-root.ts).
`PhysicalReader.integer` touches each byte of a variable-length field with scalar state and no
per-byte object. `PhysicalWriter.hex` reserves capacity before walking character pairs. At manifest
scale those paths repeat across encoded entries. The codec allocates returned entries and
the writer grows its buffer on demand. Keep the initial check scoped to extra scratch objects,
arrays or copies in the flagged bodies. The guard fixture should fail on a per-iteration scratch
object and pass for scalar updates and a buffer reserved before the loop. Use
[physical manifest tests](../../tests/physical-manifest-v2.test.mjs) for exact bytes and malformed input,
and [manifest lookup budgets](../../tests/source-manifest-lookup-speed.test.mjs) for storage-call evidence.
Syntax checks cover visible operations. A measured budget can detect overhead hidden behind calls.

The suffixes make review and lint scope visible. The role names for hosted versus local and public versus
internal are for navigation. Prove authority boundaries through registrations and existing contract
tests. Keep guard timing and incident fixtures with `70144f0c`.

### Oversized modules

The Issue recorded seven files above 800 lines. The audited State has 2,222 TypeScript files in
`src/` and `convex/` excluding generated files. Of those, 259 exceed 300 lines and 13 exceed 800
lines. Counts include blank and comment lines and exclude browser code, tests and scripts.

```sh
rg --files src convex -g '*.ts' -g '!**/_generated/**' -0 |
  xargs -0 wc -l |
  awk '$2 != "total" && $1 > 800 { print $1, $2 }' |
  sort -nr
```

| Module | Lines | Responsibilities worth tracing before a split |
| --- | ---: | --- |
| [Hosted agent transport](../../src/hosted-agent-transport.ts) | 2,695 | Command routing, caller context, lifecycle orchestration and machine-local Lane bookkeeping share one class. |
| [Agent preflight](../../src/agent-preflight.ts) | 2,223 | Receipt schema, test selection and budget, execution and reporting. Several `agent-preflight-*` modules already have narrower roles. |
| [Hosted culprit](../../convex/projectHostedCulprit.ts) | 1,948 | Classifies failed shared checks, drives recovery and records evidence through internal handlers. |
| [Hosted agent actions](../../src/hosted-agent-actions.ts) | 1,425 | Routes commands, builds check selection and handles replies and materialization. |
| [Work types](../../src/work-types.ts) | 1,351 | Persisted Work records, check and playbook validators, and command unions. Intent, Planning and inputs already have sibling schema modules. |
| [Hosted agent planning](../../src/hosted-agent-planning.ts) | 1,246 | Resolves planning IDs, dispatches reads and writes, and reconciles Done-when status. |
| [Landing speed alerts](../../src/landing-speed-alerts.ts) | 1,223 | Budget schemas, ratchet math, sample grouping and alert decisions. |
| [Hosted save client](../../src/hosted-save-client.ts) | 1,172 | Captures local files, drives source preparation, publishes a save, and reconciles pending outcomes. |
| [Work run](../../src/work-run.ts) | 1,107 | Recovers processes, adopts remote runs, executes owned runs and exposes the CLI-side run orchestration. |
| [Work service](../../src/work.ts) | 1,048 | Materializes Work, runs transaction and command dispatch, recovers state and composes Views. |
| [Convex schema](../../convex/schema.ts) | 1,043 | Composes deployed tables and indexes, with some import and access validators still in the file. |
| [Hosted agent finish](../../src/hosted-agent-finish.ts) | 964 | Pre-admission, queued conflict and stack guidance, and durable landing orchestration. |
| [Hosted main audit state](../../convex/projectHostedMainAuditState.ts) | 877 | Audit freshness, wake scheduling, holds, main coverage and red-run evidence. |

`work-types.ts` has 237 matching import lines under `src/`, `convex/` and `web/src/`
(`rg -n 'from .*work-types' src convex web/src`). Its schemas are part of live and retained records, including old Work
formats. Keep `workSchema` composition, defaults, validation, serialized bytes and the existing
imports stable while moving one independent family. [Current format](../../tests/work-current-format.test.mjs),
[schema compatibility](../../tests/check-schema-compat.test.mjs), and
[V8 Work command](../../tests/work-command-v8.test.mjs) check different parts of that contract.

### Test placement

Keep behaviour tests discoverable as `tests/<area>-<behaviour>.test.mjs`, grouped by the feature
or boundary a caller uses. [Hosted planning](../../tests/hosted-planning.test.mjs) and
[hosted agent planning](../../tests/hosted-agent-planning.test.mjs) distinguish backend semantics
from command behaviour. [Live reads](../../tests/live-reads.test.mjs) covers browser subscription
lifecycle; [guard fixtures](../../tests/lint-rules.test.mjs) cover lint diagnostics. Keep supporting
fixtures beside the owning test family or in `tests/fixtures/` when shared. Test the same action
after a helper moves. Preserve incident fixture and ledger paths or update every actual consumer
in the same slice.

The [package test command](../../package.json) expands `tests/*.test.mjs` and the
[preflight selector](../../src/agent-preflight.ts) has special discovery for that layout.
Use flat test names for now. A directory move would need a separate tooling slice that proves
local discovery, scoped and full selection, shards, incident replays, and guard ledgers still see
the same tests. Add runtime tests when they guard observable behaviour or a budget.

### Refactor candidates for planning

Each row is one independently checkable first extraction. Sizes are estimates of lines moved,
plus import wiring in a small number of files. They are starting scopes for the lead's decision.
Preserve public entry points, persisted formats, order of side effects, and diagnostic output.

| Area | Proposed first slice and size | Done when |
| --- | --- | --- |
| Shared Work schemas | Extract check definition, evidence and run validators behind the existing exports (~175 lines, 2–3 files). | Existing records and inputs parse identically and current-format, schema compatibility and V8 fixtures pass. |
| Hosted agent transport and actions | Extract local Lane activity and cache bookkeeping from transport (~100–180 lines, 2–4 files). | CLI and MCP still resolve and open the same Lane, retry with the original operation ID and make the same hosted requests. |
| Agent preflight | Move local receipt and learned timing reads into their own module (~120–170 lines, 2–4 files). | Recorded receipt format, selected files, order and ceilings are unchanged in preflight fixtures. |
| Shared-check culprit recovery | Extract pure failing-test and revert-message derivation from the registration module (~100–160 lines, 2–4 files). | Single and batch culprit replays preserve classification, emitted evidence, and scheduled handler addresses. |
| Planning client | Extract Done-when parsing and status formatting (~80–150 lines, 2–3 files). | Completion and refusal cases preserve the same checklist, detail reply and reconciliation writes. |
| Landing speed alerts | Extract the pure ratchet update and status math (~175–210 lines, 2–3 files). | Existing alert traces produce the same outcomes and stored ratchet shape. |
| Save and source delivery | Extract observed save result application behind the current client entry point (~100–180 lines, 2–4 files). | Lost-reply and background-settle fixtures yield the same head, sync guidance and replay calls. |
| Run and Work service | Extract run-output path and recovery decisions from Work execution (~100–160 lines, 2–4 files). | Run recovery and Work lifecycle fixtures preserve retained output, interruption reporting and record writes. |
| Convex schema composition | Extract a cohesive import-job validator group (~80–120 lines, 2–4 files). | Deployed table IDs, validators and indexes match the existing schema, and index and compatibility checks pass. |
| Landing finish client | Extract queue-conflict advice composition (~100–170 lines, 2–4 files). | Finish and queued-conflict replay fixtures preserve advice, operation state and calls before and after submission. |
| Main audit state | Extract pure freshness and red-test summary derivation (~75–130 lines, 2–4 files). | Audit fixtures preserve holds, wakes and bounded read/write counts across fresh and red main. |

Use the relevant core-path review and queue checks for slices that touch landing, wakes or checks.
For each move, inspect the import graph and run the affected contracts and failure cases before landing.
The expected deltas are zero idle or per-operation Convex calls, zero DB reads or writes, and zero
bytes moved between stores. Compare peak memory and wall time at current and larger workloads where
an extraction changes code in a measured path. This audit changes documentation only. Its runtime
call, DB I/O, storage, memory and wall-time deltas are zero by construction, independent of workload.
