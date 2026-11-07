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
| Network boundary | check script `check-network-boundaries.mjs` | bare `fetch`, `AbortSignal.timeout` or network libraries bypass the shared deadline helper (06cfc7b7, aabe52a7) | `tests/network-boundaries-scripts.test.mjs` |
| Env print | check script `check-env-print.mjs` | scripts, workflows and docs print environment values or full process listings (df2ba360; a dev key leaked 2026-10-22) | `tests/check-env-print.test.mjs` |
| Idle queries | check script `check-idle-queries.mjs` | live query arguments derived from the clock, and `refreshKey`, re-run queries for idle tabs | `tests/idle-queries.test.mjs` |
| Local paths | check script `check-local-paths.mjs` | machine-specific home paths in tracked files | `tests/local-paths.test.mjs` |
| SPDX header | check script `check-spdx.mjs` | the licence line pushed below imports (f44ac5e0) | `tests/check-spdx.test.mjs` |
| Recovery advice | check script `check-recovery-advice.mjs` | backend conflict evidence that guesses the caller's checkout | `tests/recovery-advice-guard.test.mjs` |
| Action pins | check script `check-action-pins.mjs` | workflow `uses:` lines not pinned to a commit SHA | `tests/action-pins.test.mjs` |
| Token permissions | test | a GitHub App token permission change broke one path class the mirror pushes (708b6943: contents-only token got 403 on a `.github/workflows/` tree). A permission change must be tested against every path class | `tests/hosted-github-mirror-retry.test.mjs`, `tests/github-token-permissions.test.mjs` |
| Message mirror | test | the finish message dropped from the mirror commit (eacfdb6e, b30284de) | `tests/landing-message-mirror.test.mjs` |

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
