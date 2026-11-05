// SPDX-License-Identifier: Apache-2.0
// Fail-closed guard for test selection. Selecting nothing for a change that touches code is
// a selector failure, never a pass: the check runs a safe default set or fails with
// ZERO_SELECTION. Pure and CI-neutral; every planner (local, owner, hosted) applies it.
export class ZeroSelectionError extends Error {
  code = 'ZERO_SELECTION';
  constructor(reason) {
    super(
      `ZERO_SELECTION: ${reason} No test file is selected for a change that touches code, so this check would pass without running any test. Add a tests/*.test.mjs file or fix the selection.`,
    );
  }
}

const testFile = path => /^tests\/[^/]+\.test\.mjs$/.test(path);

/** Returns `selection` unchanged when it can fail on a regression. Otherwise returns a corrected copy
 * (smoke set, or every test when no smoke file exists, or full for a docs scope that carries code)
 * or throws ZeroSelectionError when the source has no test file at all.
 * An explicit `partial` selection is exempt: it is retained as partial evidence and never lands.
 * `docs` scope is valid only while every known changed path is documentation; interaction
 * retries reuse earlier evidence and carry no paths. */
export function guardSelection(selection, { files, paths, interaction, documentation, smoke }) {
  // Explicit `partial` selections are caller-chosen partial evidence: they never satisfy a gate or land.
  if (selection.scope === 'partial') return selection;
  const all = [...files.keys()].filter(testFile).sort();
  const code =
    selection.scope === 'docs' && interaction === undefined && Array.isArray(paths)
      ? paths.filter(path => !documentation(path))
      : [];
  if (selection.scope === 'docs' ? !code.length : selection.tests.length) return selection;
  const present = smoke.filter(path => files.has(path));
  const tests = code.length || !present.length ? all : [...new Set(present)].sort();
  const why = code.length
    ? `docs scope covered code path ${code[0]}`
    : `scope ${selection.scope} selected zero tests`;
  if (!tests.length) throw new ZeroSelectionError(`${why}, and the source has no test file.`);
  const reason = `Zero-selection guard: ${why}; running ${code.length || !present.length ? 'every test file' : 'the fixed smoke set'}; ${selection.reason}`;
  const kind = code.length || !present.length ? 'full' : 'smoke';
  return {
    ...selection,
    scope: code.length ? 'full' : selection.scope === 'docs' ? 'scoped' : selection.scope,
    reason,
    tests,
    reasons: Object.fromEntries(tests.map(test => [test, { kind, detail: reason }])),
    guard: 'zero-selection',
  };
}

/** The test runner's own refusal: a pinned selection that names no file runs nothing, and must not pass.
 * Only the Actions static job (FORGE_ACTIONS_SHARD=static; tests run in shard jobs, and the supervisor sets it for every runner version) and docs or explicit partial scope may run without a test file. */
export function assertRunnableSelection(selection, files, staticJob = false) {
  if (selection && !files.length && !staticJob && !['docs', 'partial'].includes(selection.scope))
    throw new ZeroSelectionError(`the pinned ${selection.scope} selection names no test file.`);
}
