// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  KINDS,
  agentActionNames,
  cliCommandNames,
  countErrorCodes,
  countTables,
  errorCodes,
  glossaryTerms,
  formatMacDependencies,
  growthFindings,
  initialBaseline,
  macDependencyFindings,
  unreferencedExportNames,
  updateBaseline,
} from '../scripts/check-growth.mjs';

// Growth guard (ed28fc6b): one row per counted kind, then fail-on-rise and pass-with-reason.

test('tables: counts distinct defineTable keys, also when split over lines; ignores comments', () => {
  const schema = ['  a: defineTable({', '  }),', '  // old: defineTable({', '  c:', '    defineTable({'].join(
    '\n',
  );
  assert.equal(countTables([schema]), 2);
  assert.equal(countTables([schema, '  a: defineTable({})']), 2, 'a table name counts once');
});

test('errorCodes: ForgeError, invariant and code: properties count; errno names and test-only strings do not', () => {
  const source = [
    "throw new ForgeError('WORK_STALE', 'x');",
    "invariant(ok, 'BAD_ARGUMENT', 'x');",
    "invariant(\n  a && b,\n  'LANE_GONE',\n  'x',\n);",
    "return { code: 'HOSTED_CONFLICT', message: 'x' };",
    "if (error.code === 'ENOTDIR' || error.code === 'WORK_STALE') return;",
    "const e = { code: 'EEXIST' };",
    "// throw new ForgeError('COMMENTED_OUT', 'x');",
    "const label = 'NOT_A_CODE';",
  ].join('\n');
  assert.deepEqual(errorCodes(source).sort(), ['BAD_ARGUMENT', 'HOSTED_CONFLICT', 'LANE_GONE', 'WORK_STALE']);
  assert.equal(
    countErrorCodes([source, "new ForgeError('WORK_STALE', 'y')"]),
    4,
    'a code counts once across files',
  );
});

test('agentActions: verbs, mode-flag actions, board modes, named reads and operator actions, once each', () => {
  const source = `
export const lifecycleVerbs = ['start', 'save', 'land'] as const;
export const verbModes = {
  start: { '--open': 'open' },
  save: { '--sync': 'sync', '--friction': 'friction' },
  land: { '--save': 'finish' },
};
export const boardModes = { '--post': 'board-post' };
export const operatorActions = ['accept', 'friction-triage'] as const;
export const namedReads = ['status', 'board', 'friction'] as const;
`;
  assert.deepEqual([...agentActionNames(source)].sort(), [
    'accept',
    'board',
    'board-post',
    'finish',
    'friction',
    'friction-triage',
    'land',
    'open',
    'save',
    'start',
    'status',
    'sync',
  ]);
});

test('cliCommands: args[0] tests, includes lists and switch cases count; typeof tests do not', () => {
  const source = `
  if (args[0] === 'pull') return 1;
  if (args[0] === 'policy' || args[0] === 'set-policy') return 2;
  if (['login', 'logout'].includes(args[0]!)) return 3;
  if (typeof command === 'object') return 4;
  if (command === 'doctor') return 5;
  switch (command) {
    case 'status':
      return 6;
    case 'refs':
      return 7;
  }
`;
  assert.deepEqual([...cliCommandNames(source)].sort(), [
    'doctor',
    'login',
    'logout',
    'policy',
    'pull',
    'refs',
    'set-policy',
    'status',
  ]);
});

test('glossaryTerms: distinct bold terms of docs/concepts.md, case-folded', () => {
  const doc =
    '| **State** | a snapshot |\n- **Lane** — a place; see **state** and **Lane**.\nPlain *emphasis* does not count.';
  assert.deepEqual([...glossaryTerms(doc)].sort(), ['lane', 'state']);
});

test('unreferencedExports: an export no other file mentions counts; entry points and Convex public functions do not', () => {
  const lib = {
    path: 'src/lib.ts',
    text: [
      'export function used() {}',
      'export type Orphan = string;',
      'export const alsoDead = 1;',
      'export const twice = 1;',
    ].join('\n'),
  };
  const convex = {
    path: 'convex/f.ts',
    text: [
      'export const entry = mutation({',
      '  args: {},',
      '});',
      'export const helper = internalQuery({',
    ].join('\n'),
  };
  const entry = { path: 'src/index.ts', text: 'export const publicApi = 1;' };
  const user = { path: 'src/user.ts', text: "import { used } from './lib'; use(used);" };
  const test = { path: 'tests/x.test.mjs', text: 'twice();' };
  assert.deepEqual([...unreferencedExportNames([lib, convex, entry, user], [test])].sort(), [
    'Orphan',
    'alsoDead',
    'helper',
  ]);
});

const start = {
  tables: 10,
  errorCodes: 20,
  agentActions: 30,
  cliCommands: 40,
  glossaryTerms: 5,
  macDependencies: 6,
  unreferencedExports: 7,
};

test('a count above the baseline with no recorded reason fails and names the update command', () => {
  const baseline = initialBaseline(start, '2026-11-09');
  assert.deepEqual(growthFindings(start, baseline), [], 'equal counts pass');
  assert.deepEqual(growthFindings({ ...start, tables: 9 }, baseline), [], 'a lower count passes');
  for (const kind of KINDS) {
    const findings = growthFindings({ ...start, [kind]: start[kind] + 1 }, baseline);
    assert.equal(findings.length, 1, kind);
    assert.match(findings[0], /--update --reason/);
  }
});

test('--update refuses a rise without a real reason and raises it with one, recorded in the ledger', () => {
  const baseline = initialBaseline(start, '2026-11-09');
  const grown = { ...start, tables: 11 };
  for (const reason of [undefined, '', '   ', 'ok'])
    assert.deepEqual(updateBaseline(grown, baseline, reason, '2026-11-10').refused, ['tables']);
  const { baseline: next, refused } = updateBaseline(
    grown,
    baseline,
    'adds the board table; merges the old notes table into it',
    '2026-11-10',
  );
  assert.deepEqual(refused, []);
  assert.equal(next.counts.tables, 11);
  assert.deepEqual(next.reasons, [
    {
      kind: 'tables',
      from: 10,
      to: 11,
      reason: 'adds the board table; merges the old notes table into it',
      at: '2026-11-10',
    },
  ]);
  assert.deepEqual(growthFindings(grown, next), [], 'the recorded rise now passes');
  assert.equal(next.start.tables, 10, 'the phase start never moves');
});

test('--update lowers counts that fell and never raises one without a reason', () => {
  const baseline = initialBaseline(start, '2026-11-09');
  const { baseline: next, refused } = updateBaseline(
    { ...start, errorCodes: 15, cliCommands: 41 },
    baseline,
    undefined,
    'x',
  );
  assert.deepEqual(refused, ['cliCommands']);
  assert.equal(next.counts.errorCodes, 15);
  assert.equal(next.counts.cliCommands, 40);
  assert.deepEqual(next.reasons, []);
});

test('a hand-raised baseline with no ledger entry fails', () => {
  const baseline = initialBaseline(start, '2026-11-09');
  baseline.counts.tables = 12;
  const findings = growthFindings({ ...start, tables: 12 }, baseline);
  assert.equal(findings.length, 1);
  assert.match(findings[0], /above its start 10 plus recorded rises/);
});

// Mac dependency list (56cf99cc): a count that may only fall, and no entry without a way out.

const macList = () => ({
  version: 1,
  needsMac: [
    { id: 'lead-session', what: 'The lead agent session on the owner machine.', issue: 'd65c423c' },
    {
      id: 'mac-runner',
      what: 'The optional machine check runner.',
      staysBecause: 'a product feature that stays',
    },
  ],
  offMac: [{ id: 'dogfood-checks', how: 'GitHub-hosted runners run the landing check.' }],
});

test('a Mac dependency needs an Issue that removes it or a staysBecause reason; ids are unique and not both on and off', () => {
  assert.deepEqual(macDependencyFindings(macList()), []);
  const bare = macList();
  bare.needsMac[0] = { id: 'lead-session', what: 'The lead agent session on the owner machine.' };
  assert.match(macDependencyFindings(bare).join('\n'), /lead-session needs what, and an 8-hex Issue/);
  const longIssue = macList();
  longIssue.needsMac[0].issue = 'd65c423c-84fb-4db5-b6af-106c4ed418b1';
  assert.match(macDependencyFindings(longIssue).join('\n'), /8-character Forge Issue id/);
  const repeated = macList();
  repeated.offMac.push({ id: 'lead-session', how: 'claims it moved while still listed' });
  assert.match(macDependencyFindings(repeated).join('\n'), /repeated|cannot also be in needsMac/);
  assert.match(macDependencyFindings({ version: 2 }).join('\n'), /not a version 1/);
});

test('the Mac dependency count is a growth kind: adding an entry fails until a reason is recorded', () => {
  const baseline = initialBaseline(start, '2026-11-10');
  const grown = { ...start, macDependencies: start.macDependencies + 1 };
  assert.match(growthFindings(grown, baseline).join('\n'), /Mac dependencies: 7 now, baseline 6/);
  assert.deepEqual(growthFindings({ ...start, macDependencies: 5 }, baseline), [], 'removing one passes');
  const { baseline: lowered } = updateBaseline({ ...start, macDependencies: 5 }, baseline, undefined, 'x');
  assert.equal(lowered.counts.macDependencies, 5, '--update lowers it');
});

test('the phase-close print lists the Mac dependencies against the start', () => {
  const baseline = initialBaseline({ ...start, macDependencies: 2 }, '2026-11-10');
  const text = formatMacDependencies(macList(), { macDependencies: 2 }, baseline);
  assert.match(text, /Mac dependencies: 2 now, baseline 2, start 2/);
  assert.match(text, /lead-session\s+Issue d65c423c/);
  assert.match(text, /mac-runner\s+stays/);
  assert.match(text, /Already off the Mac \(1\): dogfood-checks/);
});
