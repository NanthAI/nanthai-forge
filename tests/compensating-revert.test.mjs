// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { NativeSource } from '../dist/native-source.js';
import { compensatingState } from '../dist/compensating-revert.js';
import { reverseLandings } from '../dist/optimistic-bisect.js';
import { syncInputSchema } from '../dist/hosted-sync.js';
import { composeFixture } from './hosted-compose-fixture.mjs';
const at = '2026-01-01T00:00:00.000Z';
for (const variant of ['binary', 'mode', 'symlink', 'delete', 'add']) {
  test(`hosted ${variant} compensation is byte-identical to native actual-delta reversal`, async t => {
    const f = await composeFixture(),
      old = f.file('changed', variant === 'binary' ? Buffer.from([0, 1, 2]) : 'old\n'),
      next = f.file(
        'changed',
        variant === 'binary' ? Buffer.from([0, 3, 4]) : variant === 'mode' ? 'old\n' : 'new\n',
        variant === 'mode' ? 'executable' : variant === 'symlink' ? 'symlink' : 'file',
      ),
      previous = f.state([f.hidden, ...(variant === 'add' ? [] : [old])]),
      accepted = f.state([f.hidden, ...(variant === 'delete' ? [] : [next])], [previous.sha256]),
      later = f.state(
        [f.hidden, ...(variant === 'delete' ? [] : [next]), f.file('later', 'later\n')],
        [accepted.sha256],
      );
    const root = mkdtempSync(join(tmpdir(), 'forge-compensation-parity-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const source = new NativeSource(root);
    for (const bytes of f.objects.values()) source.put(bytes);
    const expected = compensatingState(source, previous.sha256, accepted.sha256, at),
      output = await f.compute(
        syncInputSchema.parse({
          schema: 1,
          kind: 'forge-hosted-sync-input',
          algorithm: 'forge-native-sync-v1',
          at,
          message: 'Retained original revert message',
          work: {
            mode: 'revert',
            receiptId: randomUUID(),
            previous: { object: previous, recipe: null },
            accepted: { object: accepted, recipe: null },
          },
        }),
      );
    assert.equal(output.head, expected);
    assert.deepEqual(source.object(expected), f.objects.get(output.head));
    assert(!output.reads.some(p => p.sha256 === f.hidden.blob), 'reversal needs metadata only');
    const merged = reverseLandings(
      source,
      later.sha256,
      [{ previous: previous.sha256, head: accepted.sha256 }],
      at,
    );
    assert(merged);
    const files = source.state(merged).files;
    assert(files.some(x => x.path === 'later'));
    assert.deepEqual(
      files.filter(x => x.path !== 'later'),
      source.state(previous.sha256).files,
    );
  });
}

test('native compensation still surfaces later overlap as conflict', t => {
  const root = mkdtempSync(join(tmpdir(), 'forge-compensation-conflict-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = new NativeSource(root),
    file = text => ({ path: 'f', blob: source.put(Buffer.from(text)), mode: 'file' });
  const previous = source.writeState([file('base\n')], [], 'base', at),
    accepted = source.writeState([file('accepted\n')], [previous], 'accepted', at),
    later = source.writeState([file('later\n')], [accepted], 'later', at),
    reverse = compensatingState(source, previous, accepted, at);
  assert.equal(source.compose(later, reverse, 'revert', at).head, undefined);
  assert.equal(reverseLandings(source, later, [{ previous, head: accepted }], at), undefined);
});
