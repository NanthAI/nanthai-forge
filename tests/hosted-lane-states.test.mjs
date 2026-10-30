// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { moduleUrl } from './convex-module.mjs';
import { lanesFixture } from './hosted-lanes-fixture.mjs';
const start = await import(moduleUrl('../convex/projectHostedStart.ts'));
const reads = await import(moduleUrl('../convex/projectHostedLanes.ts'));
const channels = await import(moduleUrl('../convex/projectHostedChannels.ts'));
const head = 'a'.repeat(64);

test('Lane states: one call reads 100 Lane heads without bodies, bounded per Lane', async () => {
  const s = lanesFixture();
  const projectId = s.insert('hostedProjects', {
    key: 'synthetic',
    name: 'Synthetic',
    currentBackup: null,
    revision: 0,
    owner: 'owner',
    visibility: 'private',
    sourceAuthority: { mode: 'server', epoch: 1 },
  });
  const main = {
    schema: 2,
    projectId,
    snapshotId: randomUUID(),
    sourceRevision: 0,
    channel: 'main',
    head,
    authority: { mode: 'server', epoch: 1 },
    receipt: { id: 'main-0', kind: 'server', previousHead: null, previousReceiptId: null },
  };
  await s.call('seed', channels.seed, {
    projectId,
    actor: 'owner',
    operationId: randomUUID(),
    selection: JSON.stringify(main),
  });
  const laneIds = [];
  for (let index = 0; index < 99; index++) {
    const started = JSON.parse(
      await s.call('start', start.start, {
        projectId,
        operationId: randomUUID(),
        authorityEpoch: 1,
        expectedMain: { head, receiptId: 'main-0' },
        intent: { kind: 'new', outcome: `Lane ${index}` },
      }),
    );
    laneIds.push(started.lane.laneId);
  }
  const missing = randomUUID();
  const result = await s.call('states', reads.states, { projectId, laneIds: [...laneIds, missing] });
  assert.equal(result.length, 100);
  assert(result.slice(0, 99).every(row => row.state === 'active' && row.version === 0));
  assert.deepEqual(result.at(-1), { laneId: missing, state: 'missing', version: 0 });
  // Budget: project access plus head, record and lifecycle overlay per Lane; never record bodies.
  const count = s.counts.at(-1);
  assert(count.documents <= 4 * 100 + 5, `documents ${count.documents}`);
  await assert.rejects(
    s.call('states', reads.states, { projectId, laneIds: [...laneIds, missing, randomUUID()] }),
    error => (error.data?.code ?? error.code) === 'BAD_ARGUMENT',
  );
});
