### Preflight typechecks and browser tests

**Typechecks.** Preflight reads the project's own typecheck script (`typecheck`,
`type-check`, `check:types`, `check-types` or `types:check` in `package.json`),
so it typechecks the same TypeScript projects the landing check does without a
second list to keep in step. A script that is a plain `&&` list is split: npm's
own `pre<script>` and the commands before the first `tsc` (or `tsgo`) step are
setup and run once (code generation the compiler reads), and each compiler step
becomes its own static check, `typecheck <tsconfig>`, run in the Lane root with
the project's `node_modules/.bin` first on `PATH`. A step runs only when the
change touches its program: `tsc --listFilesOnly` (about 0.5 s per project)
names every file the compiler reads, so a `web/` change typechecks only
`web/tsconfig.json`, while a `src/` file that `convex/` imports also typechecks
`convex/`. A local config a project `extends`, whatever its name (a monorepo's
`base.json`), runs that project's step. Every step runs when the changed paths
are unknown, a `tsconfig`/`jsconfig` file, the manifest or a lockfile (as the
ecosystem registry names them) changes, setup fails, a source file was deleted,
or a program cannot be listed. A change with no TypeScript, JavaScript or JSON
path runs no typecheck. The steps not run are named with the static checks the
change did not trigger. In a project that declares its static checks
(`preflight.static` under `forge` in `package.json`, or in `forge.json`, as
Forge does), a failure is judged like any static
check: one in the change's own files, or new against the Lane's base, refuses
the landing; one already on main is advice. In any other project every
typecheck step is advice, since its typecheck may not be kept clean on main. A
script with any other shell syntax (pipes, `;`, `||`, newlines, variables,
unquoted globs), or with a `post<script>`, runs whole, as advice only. A
declared static check that already runs the script replaces all of this.

**Browser tests.** Preflight passes the agent's browser cache into its clean
environment the way the landing check's test jobs get it
(`PLAYWRIGHT_BROWSERS_PATH`, resolved from the agent's own `HOME` before
preflight replaces it, and `FORGE_UI_BROWSER`). Before it runs a selected
browser test (the landing check's browser policy,
`scripts/browser-test-policy.mjs`), it checks for the browser by the check's own
rule (`FORGE_UI_BROWSER`, else the project's Playwright Chromium). When it is
missing, those files are not run, for every runner, and preflight is NOT
COMPLETE with `incomplete.needs` (`runtime: "Chromium"`, the files, and
`npx playwright install chromium` as the way to run them here). A browser test
that skips a test anyway is the same: no pass, no reusable pass and no timing
sample. NOT COMPLETE never refuses a landing; the landing check runs them, and a
skipped browser test fails its shard there.
