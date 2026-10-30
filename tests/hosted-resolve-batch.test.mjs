// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { syncFixture } from './hosted-sync-fixture.mjs';
import { buildHostedSourceState } from '../dist/hosted-source-worker.js';
import { saveBytes } from '../dist/hosted-save.js';
test('distinct edited conflict blobs use one batched descriptor page rather than a call per file', async t => {
  const s = await syncFixture();
  const paths = Array.from({ length: 50 }, (_, i) => `file-${i}.txt`);
  const original = s.state(
    paths.map(path => s.file(path, 'base\n')),
    [s.baseline.sha256],
  );
  const left = await s.lane(
    s.state(
      paths.map(path => s.file(path, 'left\n')),
      [original.sha256],
    ),
  );
  const right = await s.lane(
    s.state(
      paths.map(path => s.file(path, 'right\n')),
      [original.sha256],
    ),
  );
  const x = s.selection([left, right]);
  await s.prepare(x);
  await s.stage(x);
  await s.submit(x);
  const candidate = (await s.publish(await s.work(x))).outcome.result;
  const draft = (
    await s.execute(
      s.request('resolution', { candidateId: candidate.id, conflicts: candidate.result.conflicts }),
    )
  ).terminal.outcome.result;
  const saved = await s.save(
    (await s.readLane(draft.lane.laneId)).entry,
    paths.map((path, i) => s.file(path, `chosen ${i}\n`)),
  );
  const request = s.request('resolve', { laneId: saved.laneId, expected: s.pins(saved) });
  await s.prepareSync(request);
  await s.submitSync(request);
  const plan = (await s.progressSync(request)).input,
    windows = [],
    reads = [];
  const output = await buildHostedSourceState(s.put(saveBytes(plan)), {
    async describeBatch(ids) {
      windows.push([...ids]);
      return ids.map(id => ({ object: { sha256: id, size: s.objects.get(id).length }, recipe: null }));
    },
    async read(pin) {
      reads.push(pin.sha256);
      return [s.objects.get(pin.sha256)];
    },
    async upload(pin, stream) {
      const chunks = [];
      for await (const chunk of stream) chunks.push(chunk);
      assert.deepEqual(s.put(Buffer.concat(chunks)), pin);
    },
  });
  const result = JSON.parse(s.objects.get(output.output.sha256)).result;
  assert.equal(result.status, 'resolved');
  assert.equal(windows.filter(ids => ids.length === 50).length, 1);
  assert(windows.length <= 3, JSON.stringify(windows.map(ids => ids.length)));
  assert(reads.length <= paths.length + 5);
  t.diagnostic(
    JSON.stringify({
      conflictedFiles: paths.length,
      descriptorCalls: windows.length,
      descriptorWindows: windows.map(ids => ids.length),
      objectReads: reads.length,
    }),
  );
});
