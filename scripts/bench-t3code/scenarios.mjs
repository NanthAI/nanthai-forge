// SPDX-License-Identifier: Apache-2.0
// Scripted (no-model) queue scenarios for queue-change A/B arms (Items 854a069e, 0cba0afa).
// `smoke` is the unchanged dry run, so arm A stays comparable with earlier smoke cells. Each
// other scenario gives fixed roles to fixed positions of the cell's task order: no task, file
// or timing depends on a switch, and every arm runs the same actions. Roles only use moves any
// repository has: a test that fails once and is then fixed, a slow test, a withdrawal, a late
// arrival, and two edits of one existing file far apart (a clean same-file merge).

/** Existing text files of the base tree used for clean same-file edits (top and bottom). */
export const SHARED_DOCS = ['README.md', 'CONTRIBUTING.md'];
/** A package the bench check tests, where a scenario test file is picked up. */
export const TEST_DIR = 'packages/shared/src';

export const SCENARIOS = Object.freeze({
  smoke: {
    paths: [],
    about: 'Unchanged dry run: every task released at once, overlap groups from tasks.json.',
    roles: () => ({}),
  },
  'cohort-fail': {
    paths: ['O3'],
    about:
      'All ten released at once so checks can share a cohort; position 4 adds a test that passes locally and fails in the landing check (CI only), then fixes it and lands again.',
    roles: () => ({ 3: { failOnce: true } }),
  },
  'withdraw-join': {
    paths: ['O3'],
    about:
      'Position 3 withdraws its landing once its check is running, then lands again after 30 s; position 10 joins 90 s late.',
    roles: () => ({ 2: { withdrawOnce: true, relandAfterMs: 30_000 }, 9: { releaseMs: 90_000 } }),
  },
  'main-move': {
    paths: ['O4'],
    about:
      'Releases 20 s apart, so main moves during running checks. Positions 1+2 and 5+6 each edit one existing file at its top and bottom (overlapping paths, clean merge); the others keep their overlap groups (overlapping paths that conflict).',
    roles: () => ({
      0: { doc: { path: SHARED_DOCS[0], at: 'top' } },
      1: { doc: { path: SHARED_DOCS[0], at: 'bottom' } },
      4: { doc: { path: SHARED_DOCS[1], at: 'top' } },
      5: { doc: { path: SHARED_DOCS[1], at: 'bottom' } },
    }),
    releaseMs: index => index * 20_000,
  },
  'parked-head': {
    paths: ['N1'],
    about:
      'Position 1 lands first with a slow check (a test that takes 240 s in the landing check only) and a shared file; positions 2-4 share that file (dependent followers), positions 5-10 are independent. Followers start 20 s later, pass first and wait behind the head; independent landings move main under it.',
    roles: () => ({
      0: { slowSeconds: 240, group: 'parked' },
      1: { group: 'parked' },
      2: { group: 'parked' },
      3: { group: 'parked' },
      4: { group: '' },
      5: { group: '' },
      6: { group: '' },
      7: { group: '' },
      8: { group: '' },
      9: { group: '' },
    }),
    releaseMs: index => (index === 0 ? 0 : 20_000),
  },
});

/** The role of the task at `index` of the cell order: release delay plus the scenario's moves. */
export function scenarioRole(name, index) {
  const scenario = SCENARIOS[name];
  if (!scenario) throw Error(`unknown scenario ${name}; known: ${Object.keys(SCENARIOS).join(', ')}`);
  const role = { ...(scenario.roles()[index] ?? {}) };
  const releaseMs = role.releaseMs ?? scenario.releaseMs?.(index) ?? 0;
  return releaseMs ? { ...role, releaseMs } : role;
}

/** Text of a scenario test file: failing, passing (after the fix) or slow. The failure and the
 * slowness show only in the hosted landing check (GITHUB_ACTIONS, set on every Actions runner):
 * `land --save` runs a Lane's changed tests locally first, and a failure it catches there never
 * reaches the queue. A CI-only failure is the case the cohort and parking paths exist for. */
export function scenarioTest(task, kind, seconds = 0) {
  const name = `bench scenario ${task} ${kind}`;
  const hosted = 'process.env.GITHUB_ACTIONS === "true"';
  if (kind === 'fail')
    return `import { expect, it } from "@effect/vitest";\n\nit(${JSON.stringify(name)}, () => {\n  expect(${hosted} ? "fails once" : "fixed").toBe("fixed");\n});\n`;
  if (kind === 'slow')
    return `import { expect, it } from "@effect/vitest";\n\nit(${JSON.stringify(name)}, async () => {\n  const ms = ${hosted} ? ${seconds * 1000} : 0;\n  await new Promise((done) => setTimeout(done, ms));\n  expect(true).toBe(true);\n}, ${(seconds + 60) * 1000});\n`;
  return `import { expect, it } from "@effect/vitest";\n\nit(${JSON.stringify(name)}, () => {\n  expect("fixed").toBe("fixed");\n});\n`;
}

export const scenarioTestPath = task => `${TEST_DIR}/benchScenario${task.replace(/[^a-z0-9]/gi, '')}.test.ts`;

/** Insert one line at the top or bottom of an existing file (far apart: a clean merge). The top
 * marker is its own paragraph, as Markdown formatters keep it, so the edit passes the repo's
 * format check (land --save runs it inline). */
export function docEdit(text, task, at) {
  const line = `<!-- bench scenario ${task} -->`;
  return at === 'top' ? `${line}\n\n${text}` : `${text.endsWith('\n') ? text : text + '\n'}${line}\n`;
}
