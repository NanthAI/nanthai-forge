// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { buildComposePages } from '../dist/hosted-compose.js';
import { scaleFixture, at } from './convex-source-scale-fixture.mjs';

// Incident replay (2026-10-30, batch compose 3e2ce7b1): a batch compose merges
// several Lanes in one job. The first Lane produces an intermediate State that
// the second Lane needs; the second Lane needs text calculations, so the step
// forks a fan-out. The intermediate State used to be dropped when the step
// forked, so the step after the join failed "Exact source object is absent".
async function scenario(s) {
  {
    const middle = 'unchanged '.repeat(6000) + '\n',
      basePin = await s.putSpec(Buffer.from('start\n' + middle + 'end\n')),
      original = [],
      left = [],
      right = [],
      expected = [];
    for (let i = 0; i < 200; i++) {
      const path = `dir/${String(i).padStart(4, '0')}.txt`,
        l = await s.putSpec(Buffer.from(`left ${i}\n` + middle + 'end\n')),
        r = await s.putSpec(Buffer.from('start\n' + middle + `right ${i}\n`)),
        merged = createHash('sha256')
          .update(`left ${i}\n` + middle + `right ${i}\n`)
          .digest('hex');
      original.push({ path, mode: 'file', blob: basePin.sha256 });
      left.push({ path, mode: 'file', blob: l.sha256 });
      right.push({ path, mode: 'file', blob: r.sha256 });
      expected.push({ path, mode: 'file', blob: merged });
    }
    const extra = await s.putSpec(Buffer.from('a disjoint file\n')),
      added = { path: 'extra/new.txt', mode: 'file', blob: extra.sha256 };
    const state = (files, parents = []) =>
      s.json({ schema: 1, kind: 'forge-source-state', files, parents, message: 'seed', at });
    const base = await state(original),
      main = await state(left, [base.sha256]),
      first = await state([...original, added], [base.sha256]),
      second = await state(right, [base.sha256]);
    const lane = pin => ({
      laneId: randomUUID(),
      head: pin.sha256,
      version: 0,
      sourceVersion: 0,
      lifecycleVersion: 0,
      state: { object: pin, recipe: null },
    });
    const inputs = buildComposePages([lane(first), lane(second)]),
      dependencies = buildComposePages([]);
    for (const page of [...inputs.pages, ...dependencies.pages]) await s.json(page.value);
    const id = await s.enqueue(
      await s.json({
        schema: 1,
        kind: 'forge-hosted-compose-input',
        base: { head: main.sha256, receiptId: 'main' },
        main: { object: main, recipe: null },
        inputs: inputs.manifest,
        dependencies: dependencies.manifest,
        algorithm: 'forge-native-compose-v1',
        message: 'merge',
        at,
      }),
    );
    return { id, first, expected, added };
  }
}

test('a compose that forks after publishing an intermediate State keeps that State for the next step', async () => {
  const s = await scaleFixture();
  try {
    const { id, expected, added } = await scenario(s);
    const report = await s.drain();
    const job = await s.job(id);
    assert.equal(job.status, 'completed', JSON.stringify(job));
    assert(report.peakWork > 1, 'the compose must fork calculation tasks');
    const result = JSON.parse(await s.bytes(job.output)),
      files = JSON.parse(await s.bytes(result.result.state)).files;
    assert.deepEqual(
      files.map(f => f.path),
      [...expected.map(f => f.path), added.path].sort(),
    );
  } finally {
    s.restore();
  }
});

// A ForgeError thrown inside a nested mutation reaches the action without its
// code. The step must still settle the job as failed with that code, not leave
// it running for the stall alarm (2026-10-30 13:07 incident).
test('an absent source object fails the job with its code instead of leaving it running', async () => {
  const s = await scaleFixture();
  try {
    const { id, first } = await scenario(s);
    const row = [...s.tables.projectObjects.values()].find(r => r.digest === first.sha256);
    await s.ctx.db.patch(row._id, { removed: true });
    await s.drain();
    const job = await s.job(id);
    assert.equal(job.status, 'failed', JSON.stringify(job));
    assert.match(JSON.stringify(job), /SOURCE_UNAVAILABLE/);
    assert.equal(s.ready.length, 0, 'nothing is left to retry');
  } finally {
    s.restore();
  }
});
