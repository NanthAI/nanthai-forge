// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { getFunctionName } from 'convex/server';
import { randomUUID } from 'node:crypto';
import { writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { HostedAgentTransport } from '../dist/hosted-agent-transport.js';
import { resolutionFixture } from './hosted-agent-resolution-fixture.mjs';

const preparations = s =>
  s.calls.filter(c => c.name === 'projectHostedSync:prepare').map(c => JSON.parse(c.args.request));

test('automatic recovery and the advertised exact sync continuation share one operation; explicit second draft remains independent', async t => {
  const s = await resolutionFixture(t, { overlap: true });
  s.f.moveMain({ overlap: true });
  const command = { laneId: s.f.lane.laneId };
  const first = await s.transport().dispatch('finish', command);
  const recovery = first.result.recovery;
  const conflict = recovery.conflict;
  writeFileSync(join(conflict.root, 'a.txt'), 'retain my draft\n');
  const candidateId = first.result.candidateId;
  // Dogfood-sized retained recovery history is irrelevant to this exact operation.
  for (let i = 0; i < 575; i++)
    s.f.tables.projectHostedSyncs.set(`unselected-${i}`, {
      _id: `unselected-${i}`,
      projectId: s.f.projectId,
      actor: 'owner',
      operationId: randomUUID(),
      jobId: randomUUID(),
      value: '{}',
    });
  const before = s.calls.length,
    beforeCounts = s.f.counts.length,
    start = performance.now();
  const replay = await s.transport().dispatch('sync', { candidateId, operationId: recovery.operationId });
  const calls = s.calls.length - before;
  const counts = s.f.counts.slice(beforeCounts);
  const documents = counts.reduce((sum, row) => sum + row.documents, 0),
    writes = counts.reduce((sum, row) => sum + row.writes, 0);
  assert(calls <= 5, `exact recovery uses bounded calls: ${calls}`);
  assert(documents < 100, `no retained-history scan: ${documents}`);
  t.diagnostic(
    `575 retained recoveries: calls=${calls}, documents=${documents}, writes=${writes}, elapsedMs=${Math.round(performance.now() - start)}, processPeakRssKiB=${process.resourceUsage().maxRSS}`,
  );
  assert.equal(replay.operationId, recovery.operationId);
  assert.equal(replay.result.conflict.root, conflict.root);
  assert.equal(readFileSync(join(conflict.root, 'a.txt'), 'utf8'), 'retain my draft\n');
  const implicit = await s.transport().dispatch('sync', { candidateId });
  assert.equal(
    implicit.operationId,
    recovery.operationId,
    'old generic sync advice also resumes the retained operation',
  );
  assert.equal(new Set(preparations(s).map(r => r.operationId)).size, 1);
  const second = await s.transport().dispatch('sync', { candidateId, operationId: randomUUID() });
  assert.notEqual(second.operationId, recovery.operationId);
  assert.notEqual(second.result.conflict.root, conflict.root);
  assert.equal(new Set(preparations(s).map(r => r.operationId)).size, 2);
});

test('terminal conflict returns promptly when recovery source is incomplete, retaining exact continuation and no source wait', async t => {
  const s = await resolutionFixture(t, { overlap: true });
  s.f.moveMain({ overlap: true });
  const original = s.exchange.client.mutation;
  // Compose can complete immediately; recovery deliberately remains asynchronous.
  s.exchange.client.mutation = async (ref, args) => {
    if (getFunctionName(ref) === 'projectHostedSyncJobs:submit') s.eagerSource(false);
    return original(ref, args);
  };
  const transport = new HostedAgentTransport(s.root, s.address, s.exchange, () => {
    assert.fail('automatic recovery must not subscribe or wait for source');
  });
  const first = await transport.dispatch('finish', { laneId: s.f.lane.laneId });
  assert.equal(first.result.phase, 'conflict');
  const recovery = first.result.recovery;
  assert.equal(recovery.source.status, 'submitted');
  assert.equal(recovery.next.action, 'sync');
  assert.equal(recovery.next.operationId, recovery.operationId);
  assert(recovery.command.includes(recovery.operationId));
  assert.equal(
    first.result.status,
    undefined,
    'pending recovery does not replace canonical conflict with submitted',
  );
  s.eagerSource(true);
  s.exchange.client.mutation = original;
  const { action, ...next } = recovery.next;
  const resumed = await s.transport().dispatch(action, next);
  assert.equal(resumed.operationId, recovery.operationId);
  assert(resumed.result.conflict.root);
  assert.equal(new Set(preparations(s).map(r => r.operationId)).size, 1);
});
