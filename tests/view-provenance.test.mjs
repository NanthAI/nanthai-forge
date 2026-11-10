// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileProvenance } from '../dist/view-provenance.js';
import { alignment } from '../dist/view-line-attribution.js';
test('line attribution aligns insertion/deletion, final newline, repeated lines and bounded files', async () => {
  const diff = alignment(Buffer.from('x\nx\ny\n'), Buffer.from('x\ny\n'));
  assert.equal(
    diff.edits.reduce((n, e) => n + e.end - e.start, 0),
    1,
  );
  assert.equal(alignment(Buffer.from('x'), Buffer.from('x\n')).edits.length, 1);
  const plan = {
    path: 'huge',
    status: 'added',
    before: null,
    after: { blob: 'huge', path: 'huge', mode: 'file' },
    contributors: [],
  };
  const result = await readFileProvenance(
    plan,
    async () => assert.fail('oversized files are not loaded'),
    true,
    () => 2 * 1024 * 1024,
  );
  assert.equal(result.lines.status, 'unavailable');
  assert.match(result.lines.reason, /Too large/);
  const binary = await readFileProvenance(plan, async () => Buffer.from([0, 255]), true);
  assert.equal(binary.lines.status, 'unavailable');
});

test('successive insertion and deletion diffs preserve surviving attribution', async () => {
  const { advanceAttribution, attributionRanges } = await import('../dist/view-line-attribution.js');
  const first = { laneId: 'lane', saveIndex: 0, head: 'first' },
    second = { laneId: 'lane', saveIndex: 1, head: 'second' };
  const initial = Buffer.from('a\nb\nc\n'),
    saved = Buffer.from('a\nx\nb\nc\n'),
    final = Buffer.from('x\nb\nZ\n');
  const one = advanceAttribution(initial, saved, [null, null, null], first);
  assert.deepEqual(one, [null, first, null, null]);
  const two = advanceAttribution(saved, final, one, second);
  assert.deepEqual(two, [first, null, second]);
  assert.deepEqual(
    attributionRanges(
      two.map(tag => (tag ? [tag] : [])),
      [false, true, false],
    ).map(range => range.source),
    ['save', 'base', 'save'],
  );
});
