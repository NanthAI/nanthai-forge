// SPDX-License-Identifier: Apache-2.0
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
