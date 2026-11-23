// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// Issue 7a0ccbef: one report name the result schema refuses must never void a whole result.
import test from 'node:test';
import assert from 'node:assert/strict';
import { ContractTimingReader, unstoredReportsNote } from '../dist/contract-test-timings.js';
import { semanticReportsSchema } from '../dist/intent-semantic-conflict.js';

const line = report => `__FORGE_TESTS__${JSON.stringify(report)}\n`;

test('reports keep only storable test paths; refused names are counted once with their verdict', () => {
  const reader = new ContractTimingReader();
  reader.accept(
    line({
      file: 'tests/a.test.mjs',
      complete: true,
      durationMs: 5,
      results: [{ name: 'x', passed: false }],
    }),
  );
  reader.accept(
    line({ file: 'lib/widget.py', complete: true, durationMs: 5, results: [{ name: 'x', passed: true }] }),
  );
  reader.accept(
    line({ file: 'lib/widget.py', complete: true, durationMs: 5, results: [{ name: 'x', passed: false }] }),
  );
  reader.accept('# Failed test file: junit\n# Failed test file: junit\n');
  reader.report({ file: '../outside_test.go', complete: false });
  assert.deepEqual(Object.keys(reader.reports), ['tests/a.test.mjs']);
  assert.equal(semanticReportsSchema.safeParse(reader.reports).success, true);
  assert.deepEqual(reader.unstored, {
    files: 3,
    failed: 3,
    names: ['lib/widget.py', 'junit', '../outside_test.go'],
  });
  const note = unstoredReportsNote(reader, new ContractTimingReader());
  assert.equal(note.failed, true);
  assert.match(
    note.line,
    /^Forge: 3 test reports named a file Forge cannot store as a test path \("lib\/widget\.py", "junit", "\.\.\/outside_test\.go"\); 3 failed, so this run fails\./,
  );
});

test('passing refused names do not fail the run, and a clean reader has no note', () => {
  const reader = new ContractTimingReader();
  reader.accept(
    line({ file: 'README.md', complete: true, durationMs: 5, results: [{ name: 'x', passed: true }] }),
  );
  assert.deepEqual(reader.reports, {});
  assert.equal(unstoredReportsNote(reader).failed, false);
  assert.match(unstoredReportsNote(reader).line, /they passed and are not retained\.$/);
  assert.equal(unstoredReportsNote(new ContractTimingReader()), null);
});

test('687d1eda: a file whose every test skipped is recorded as skipped, never as a pass or a timing', async () => {
  const { skippedReportsNote } = await import('../dist/contract-test-timings.js');
  const { isBrowserTest } = await import('../scripts/browser-test-policy.mjs');
  const reader = new ContractTimingReader();
  const browser = 'tests/lane-review-browser.test.mjs';
  // Incident 687d1eda: the browser test skipped in 354 ms and its report read as a pass.
  reader.accept(
    line({
      file: browser,
      complete: true,
      durationMs: 354,
      results: [],
      counts: { total: 2, failed: 0 },
      skipped: true,
    }),
  );
  // An older Candidate's marker has no flag: tests counted with no result line.
  reader.accept(
    line({
      file: 'tests/old-browser.test.mjs',
      complete: true,
      durationMs: 300,
      results: [],
      counts: { total: 1, failed: 0 },
    }),
  );
  reader.accept(
    line({
      file: 'tests/server.test.mjs',
      complete: true,
      durationMs: 900,
      results: [{ name: 'x', passed: true }],
      counts: { total: 1, failed: 0 },
    }),
  );
  assert.deepEqual(reader.reports[browser], { failed: false, attempts: [] });
  assert.deepEqual(reader.reports['tests/old-browser.test.mjs'], { failed: false, attempts: [] });
  assert.deepEqual(reader.reports['tests/server.test.mjs'], { durationMs: 900, failed: false });
  assert.deepEqual(Object.keys(reader.timings), ['tests/server.test.mjs'], 'a skip gives no timing');
  assert.equal(
    semanticReportsSchema.safeParse(reader.reports).success,
    true,
    'the stored shape is unchanged',
  );
  const selected = skippedReportsNote(reader, true, isBrowserTest);
  assert.equal(selected.browser, true, 'a skipped browser test fails a shard that selected browser coverage');
  assert.match(
    selected.line,
    /^Forge: 2 test files skipped every test \("tests\/lane-review-browser\.test\.mjs", "tests\/old-browser\.test\.mjs"\); browser coverage was selected/,
  );
  const unselected = skippedReportsNote(reader, false, isBrowserTest);
  assert.equal(unselected.browser, false);
  assert.match(unselected.line, /recorded as skipped, not as passes\.$/);
  assert.equal(skippedReportsNote(new ContractTimingReader(), true, isBrowserTest), null);
});
