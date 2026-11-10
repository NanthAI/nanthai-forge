# Product lint rules and guards

A bug class seen twice, or a fix that was reverted and retried, gets a guard that fails the
build ([fix the class](improvement-loop.md#fix-the-class)). A reminder in a brief is not a guard.
This page lists the guards and says where the next one goes.

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
| `forge/no-readonly-fsync` | lint, `src/` | fsync through a read-only handle: a directory, or a file opened only to flush it. Windows refuses both with EPERM (89460350: `init-native` failed on windows-latest); use the `native-durability.ts` helpers | `tests/lint-rules.test.mjs` |
| `forge/native-path-separator` | lint, `src/` | a `/` appended to a `node:path` `join`/`resolve`/`dirname` or `realpathSync` result never matches on Windows (89460350: `save` refused every native Lane on windows-latest); use `sep`, or `posix` for repository paths | `tests/lint-rules.test.mjs` |
| `forge/no-raw-mode-bits` | lint, `src/` | `mode & 0o111` or `mode & 0o077` read straight from disk: Windows stores neither, so a save there recorded every executable file as plain and `import-native-git` refused every retained file (89460350); use `src/file-mode.ts` | `tests/lint-rules.test.mjs` |
| `forge/raw-symlink` | lint, `src/` | `symlinkSync`/`symlink` outside `src/source-links.ts`: Windows refuses links without Developer Mode or administrator rights (89460350); source links fall back to a target file, directory links become junctions | `tests/lint-rules.test.mjs` |
| `forge/rename-over-directory` | lint, `src/` | `mkdirSync(X)` to claim a name, then `renameSync(_, X)`: POSIX replaces the empty directory, Windows refuses (89460350: `import-native-git` failed on windows-latest); use `publishDirectory` | `tests/lint-rules.test.mjs` |
| Network boundary | check script `check-network-boundaries.mjs` | bare `fetch`, `AbortSignal.timeout` or network libraries bypass the shared deadline helper (06cfc7b7, aabe52a7) | `tests/network-boundaries-scripts.test.mjs` |
| Env print | check script `check-env-print.mjs` | scripts, workflows and docs print environment values or full process listings (df2ba360; a dev key leaked 2026-10-22) | `tests/check-env-print.test.mjs` |
| Idle queries | check script `check-idle-queries.mjs` | live query arguments derived from the clock, and `refreshKey`, re-run queries for idle tabs | `tests/idle-queries.test.mjs` |
| Local paths | check script `check-local-paths.mjs` | machine-specific home paths in tracked files | `tests/local-paths.test.mjs` |
| SPDX header | check script `check-spdx.mjs` | the licence line pushed below imports (f44ac5e0) | `tests/check-spdx.test.mjs` |
| Recovery advice | check script `check-recovery-advice.mjs` | backend conflict evidence that guesses the caller's checkout | `tests/recovery-advice-guard.test.mjs` |
| Action pins | check script `check-action-pins.mjs` | workflow `uses:` lines not pinned to a commit SHA | `tests/action-pins.test.mjs` |
| Candidate steps | check script `check-candidate-steps.mjs` | in a check job: a step after the check step, an `id` or token on it, a cache save after it or off the default branch, an unbounded cache restore or `npm ci` | `tests/action-pins.test.mjs` |
| Test signal | check script `check-test-signal.mjs`, ratchet | new real sleeps or timer waits, elapsed-time asserts and reads of `docs/` text in tests: they flake on a loaded runner or fail on prose edits and guard no behaviour (ffbec6ef; t3code cut 43% of its tests as low-signal) | `tests/check-test-signal.test.mjs` |
| Growth guard | check script `check-growth.mjs`, ratchet | Convex tables, public error codes, agent actions, CLI commands, glossary terms and unreferenced exports piling up: friction became a slice and a guard, and nothing was removed (ed28fc6b; design review 2026-11-09) | `tests/check-growth.test.mjs` |
| Token permissions | test | a GitHub App token permission change broke one path class the mirror pushes (708b6943: contents-only token got 403 on a `.github/workflows/` tree). A permission change must be tested against every path class | `tests/hosted-github-mirror-retry.test.mjs`, `tests/github-token-permissions.test.mjs` |
| Forge-only rules | test | product code keys a fast path on Forge's own check, layout or npm lockfile (audit 1bb0d8e6: first-check reuse only for `scripts/forge-check.mjs`, 05df5aed). An ecosystem lockfile, folder or extension list outside the [ecosystem registry](ecosystems.md) fails too (9c0ece48). Hits are listed in [Forge-only rules](../forge-only-rules.md) | `tests/forge-only-rules.test.mjs` |
| BYOCI parity | test | a landing fast path that works for Forge's check but not for a project's own command on a pnpm tree with a link and a submodule (05df5aed) | `tests/byoci-parity.test.mjs` |
| Message mirror | test | the finish message dropped from the mirror commit (eacfdb6e, b30284de) | `tests/landing-message-mirror.test.mjs` |

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
