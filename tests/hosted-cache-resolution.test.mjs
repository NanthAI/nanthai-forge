// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { getFunctionName } from 'convex/server';
import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { resolutionFixture } from './hosted-agent-resolution-fixture.mjs';

for (const legacy of [false, true])
  test(`parent housekeeping cannot obstruct a completed nested resolution (legacy=${legacy})`, async t => {
    const s = await resolutionFixture(t, { overlap: true });
    const root = join(dirname(s.root), 'arbitrary project.with spaces');
    const parent = () => s.transport(root);
    s.f.moveMain({ overlap: true });
    await parent().dispatch('open', { laneId: s.f.lane.laneId });
    const conflict = (await parent().dispatch('sync', { laneId: s.f.lane.laneId })).result.conflict;
    const legacyFile = join(conflict.root, '.forge', 'cache-use.json');
    if (legacy) {
      rmSync(join(`${conflict.root}.forge-client`, 'cache-use.json'));
      writeFileSync(legacyFile, JSON.stringify({ bytes: 12345 }));
    }
    await parent().dispatch('save', { operationId: randomUUID(), message: 'Parent mutation' });
    t.diagnostic(
      `nested metadata after parent mutation: ${readdirSync(join(conflict.root, '.forge')).join(', ')}`,
    );
    writeFileSync(join(conflict.root, 'a.txt'), 'chosen\nb\nc\n');
    const command = { ...conflict.next };
    delete command.action;
    let result;
    try {
      result = await s.transport(conflict.root).dispatch('resolve', command);
    } catch (error) {
      t.diagnostic(
        `server resolution after local failure: ${(await s.f.readLane(conflict.laneId)).resolution.status}`,
      );
      throw error;
    }
    assert.equal(result.result.source.outcome.result.status, 'resolved');
    assert.equal(readFileSync(join(conflict.root, 'a.txt'), 'utf8'), 'chosen\nb\nc\n');
    assert(!existsSync(legacyFile));
    const usage = JSON.parse(readFileSync(join(`${conflict.root}.forge-client`, 'cache-use.json')));
    assert(usage.bytes >= 0);
    if (legacy) assert.equal(usage.bytes, 12345);
    const replay = await s.transport(conflict.root).dispatch('resolve', command);
    assert.equal(replay.result.applied.replayed, true);
    const resolves = s.calls
      .filter(call => call.name === 'projectHostedSync:prepare')
      .map(call => JSON.parse(call.args.request))
      .filter(request => request.kind === 'resolve');
    assert.equal(new Set(resolves.map(request => request.operationId)).size, 1);
  });

for (const obstruction of ['unknown metadata', 'unsaved edit'])
  test(`completed resolution reports and preserves ${obstruction}; original resolve replay recovers`, async t => {
    const s = await resolutionFixture(t, { overlap: true });
    s.f.moveMain({ overlap: true });
    await s.transport().dispatch('open', { laneId: s.f.lane.laneId });
    const conflict = (await s.transport().dispatch('sync', { laneId: s.f.lane.laneId })).result.conflict;
    await s.transport().dispatch('save', { operationId: randomUUID(), message: 'Parent mutation' });
    writeFileSync(join(conflict.root, 'a.txt'), 'chosen\nb\nc\n');
    const relative = obstruction === 'unknown metadata' ? '.forge/private-note.json' : 'a.txt';
    const path = join(conflict.root, relative);
    const command = { ...conflict.next };
    delete command.action;
    // Interleave after server publication, before the real local installer validates.
    const mutation = s.exchange.client.mutation;
    let inserted = false;
    s.exchange.client.mutation = async (ref, args) => {
      const result = await mutation(ref, args);
      if (!inserted && getFunctionName(ref) === 'projectHostedSyncJobs:submit') {
        inserted = true;
        writeFileSync(path, 'preserve these local bytes');
      }
      return result;
    };
    await assert.rejects(s.transport(conflict.root).dispatch('resolve', command), error => {
      assert.equal(error.code, 'WORK_CONFLICT');
      assert(error.message.includes(relative), error.message);
      assert.match(error.message, /Source already completed; only local apply is pending/);
      return true;
    });
    const resolved = await s.f.readLane(conflict.laneId);
    assert.equal(resolved.resolution.status, 'resolved');
    assert.equal(readFileSync(path, 'utf8'), 'preserve these local bytes');
    const jobs = s.calls.filter(call => call.name === 'projectHostedSyncJobs:submit').length;
    if (obstruction === 'unknown metadata') rmSync(path); // caller resolves its own obstruction
    else writeFileSync(path, 'chosen\nb\nc\n');
    const replay = await s.transport(conflict.root).dispatch('resolve', command);
    assert.equal(replay.result.applied.head, resolved.head);
    assert.equal(s.calls.filter(call => call.name === 'projectHostedSyncJobs:submit').length, jobs);
    assert.equal(readFileSync(join(conflict.root, 'a.txt'), 'utf8'), 'chosen\nb\nc\n');
  });
