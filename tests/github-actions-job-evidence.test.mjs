// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { actionsJobLogEvidence } from '../dist/github-actions-job-evidence.js';

const summary = '# tests 1\n# pass 1\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n';
const marker = report => `__FORGE_TESTS__${JSON.stringify(report)}\n`;
const report = { file: 'a', complete: true, results: [{ name: 'one', passed: true }] };

test('all file markers must be complete, unique, selected and well formed', () => {
  for (const text of [
    marker(report),
    marker(report) + marker(report),
    marker({ ...report, file: 'c' }),
    marker({ ...report, complete: false }),
    marker({ ...report, results: [{ name: 'one', passed: 'true' }] }),
    marker({ ...report, results: null }),
    marker(null),
    '__FORGE_TESTS__{',
  ])
    assert.equal(actionsJobLogEvidence(text + summary, ['a', 'b']).status, 'incomplete');
  assert.equal(actionsJobLogEvidence(marker(report), ['a']).status, 'passed');
  assert.equal(actionsJobLogEvidence(marker(report) + '# cancelled 1\n', ['a']).status, 'incomplete');
});

test('a failure anywhere in the log overrides passing markers and summaries', () => {
  for (const failure of [
    'not ok 1 - assertion',
    '# fail 2',
    '##[error]command failed',
    '# Failed test file: a',
    '__FORGE_TEST_FAILURE__{}',
    marker({ ...report, results: [{ name: 'one', passed: false }] }),
  ])
    assert.equal(actionsJobLogEvidence(`${failure}\n${marker(report)}${summary}`, ['a']).status, 'failed');
  assert.equal(actionsJobLogEvidence('ok 1 - rejects SIGKILL\n' + summary, ['a']).status, 'passed');
});

test('node summaries require all counts, consistent totals and no cancellations', () => {
  assert.equal(actionsJobLogEvidence(summary, ['a']).status, 'passed');
  for (const text of [
    '',
    '# tests 1\n# pass 1\n# fail 0\n',
    summary.replace('# tests 1', '# tests 2'),
    summary.replace('# cancelled 0', '# cancelled 1'),
    summary.replaceAll('1', '0'),
    summary + '# tests 1\n',
  ])
    assert.equal(actionsJobLogEvidence(text, ['a']).status, 'incomplete');
});
