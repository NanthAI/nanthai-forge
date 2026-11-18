// SPDX-License-Identifier: Apache-2.0
// Scripted (no-model) queue scenarios for queue-change A/B arms (Items 854a069e, 0cba0afa).
// `smoke` is the unchanged dry run, so arm A stays comparable with earlier smoke cells. Each
// other scenario gives fixed roles to fixed positions of the cell's task order: no task, file
// or timing depends on a switch, and every arm runs the same actions. Roles only use moves any
// repository has: a test that fails once and is then fixed, a slow test, a withdrawal, a late
// arrival, and two edits of one existing file far apart (a clean same-file merge).

/** Existing text files of the base tree used for clean same-file edits (top and bottom). */
export const SHARED_DOCS = ['README.md', 'CONTRIBUTING.md'];
/** An existing source file of the tested package, for a clean same-file code merge (top and
 * bottom): a code overlap, so a check made before the other edit landed cannot carry across it. */
export const SHARED_SOURCE = 'packages/shared/src/Array.ts';
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
      'v2 (2026-11-18). Released at once so checks can share a cohort. Position 1 edits the top of one existing source file; position 4, released 45 s later, adds a test that reads that file and expects it unchanged. Each change passes alone, so position 4 passes its own (admission) check on main, then fails in the queue check once position 1 is under it, with position 4 the one likely culprit (a semantic conflict between two changes); it fixes the test and lands again.',
    roles: () => ({
      0: { doc: { path: SHARED_SOURCE, at: 'top' } },
      3: { failOnce: 'semantic', releaseMs: 45_000 },
    }),
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
      'v2 (2026-11-18). Position 1 lands first with a slow check (a test that takes 240 s in the landing check only) and edits the top of one existing source file; position 2 is the holder: it edits the bottom of that file (overlapping code, clean merge), so a check it passed before position 1 landed must run again on the new main. Positions 3-4 share a conflicting file with position 1 (dependent followers); positions 5-10 are independent. Followers start 20 s later. With pre-queue checks, independent followers pass on main while the head checks and wait behind the holder; the holder re-checks after the head lands (the N1 situation).',
    roles: () => ({
      0: { slowSeconds: 240, group: 'parked', doc: { path: SHARED_SOURCE, at: 'top' } },
      1: { group: '', doc: { path: SHARED_SOURCE, at: 'bottom' } },
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
 * slowness show only in the hosted landing check (CI: the hosted check keeps it in the project
 * command's env and .bench/ci.sh exports it; GITHUB_ACTIONS is not passed through):
 * `land --save` runs a Lane's changed tests locally first, and a failure it catches there never
 * reaches the queue. A CI-only failure is the case the cohort and parking paths exist for. */
/** The line a source-file docEdit adds; the semantic test of cohort-fail expects none. */
export const SOURCE_MARKER = '// bench scenario ';

/** The failure a land reply reports: its code, and whether it was the change's own admission
 * check (pre-queue) rather than the queue check. */
export function failureReading(response) {
  const error = response?.error ?? response?.result?.submission?.error ?? response?.result?.error ?? null;
  return { code: error?.code ?? null, admission: /admission check/i.test(error?.message ?? '') };
}

export function scenarioTest(task, kind, seconds = 0) {
  const name = `bench scenario ${task} ${kind}`;
  const hosted = 'process.env.CI === "true"';
  if (kind === 'fail')
    return `import { expect, it } from "@effect/vitest";\n\nit(${JSON.stringify(name)}, () => {\n  expect(${hosted} ? "fails once" : "fixed").toBe("fixed");\n});\n`;
  if (kind === 'semantic') {
    // Reads the shared source file next to it: passes on main, fails once another change has
    // edited that file (no path overlap, so only a check of both together sees it).
    const file = SHARED_SOURCE.slice(TEST_DIR.length + 1);
    return `import { readFileSync } from "node:fs";\nimport { expect, it } from "@effect/vitest";\n\nit(${JSON.stringify(name)}, () => {\n  const source = readFileSync(new URL(${JSON.stringify(`./${file}`)}, import.meta.url), "utf8");\n  expect(source).not.toContain(${JSON.stringify(SOURCE_MARKER)});\n});\n`;
  }
  if (kind === 'slow')
    return `import { expect, it } from "@effect/vitest";\n\nit(${JSON.stringify(name)}, async () => {\n  const ms = ${hosted} ? ${seconds * 1000} : 0;\n  await new Promise((done) => setTimeout(done, ms));\n  expect(true).toBe(true);\n}, ${(seconds + 60) * 1000});\n`;
  return `import { expect, it } from "@effect/vitest";\n\nit(${JSON.stringify(name)}, () => {\n  expect("fixed").toBe("fixed");\n});\n`;
}

export const scenarioTestPath = task => `${TEST_DIR}/benchScenario${task.replace(/[^a-z0-9]/gi, '')}.test.ts`;

/** Insert one line at the top or bottom of an existing file (far apart: a clean merge). In
 * Markdown the top marker is its own paragraph, as Markdown formatters keep it; in source files
 * it is a line comment. Either way the edit passes the repo's format check (land --save runs it
 * inline). */
export function docEdit(text, task, at, path = '') {
  const markdown = !/\.[cm]?[jt]sx?$/.test(path);
  const line = markdown ? `<!-- bench scenario ${task} -->` : `${SOURCE_MARKER}${task}`;
  const top = markdown ? `${line}\n\n${text}` : `${line}\n${text}`;
  return at === 'top' ? top : `${text.endsWith('\n') ? text : text + '\n'}${line}\n`;
}

/** Reading of a `landing {operationId}` reply for the withdraw role: the submission's identity,
 * whether its check is running (phase `checking`, or a reserved check), and whether it is over.
 * A landing that moved to a resolution Lane keeps its submissionId, so the role withdraws by it
 * (withdraw by Lane only reaches a landing still on the Lane). */
export function landingReading(reply) {
  const result = reply?.result ?? {};
  const submission = result.submission ?? result.submissions?.[0]?.submission ?? null;
  const phase = submission?.phase ?? null;
  return {
    submissionId: submission?.id ?? null,
    running:
      phase === 'checking' || Boolean(submission?.timing?.checkReservedAt && !submission?.timing?.ciEndedAt),
    over: ['landed', 'failed', 'cancelled', 'withdrawn', 'terminal-failed'].includes(phase),
  };
}

/** Withdraw request body: by submissionId when known (follows a resolution Lane), else by Lane.
 * The CLI records a reason only for a withdraw by Lane and refuses one with submissionId
 * (src/hosted-agent-contract.ts, withdraw: BAD_ARGUMENT). */
export const withdrawBody = (laneId, submissionId, reason) =>
  submissionId ? { submissionId } : { laneId, reason };
