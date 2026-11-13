// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { saveFixture, api as saves } from './hosted-saves-fixture.mjs';
import { composeFixture, api as compose } from './hosted-compose-fixture.mjs';
import { syncFixture, api as sync } from './hosted-sync-fixture.mjs';

for (const kind of ['save', 'compose', 'sync']) {
  test(`83e6d0d3: ${kind} progress delivers a current conflict in its existing query and rejects revoked access`, async () => {
    let s, operationId, api;
    if (kind === 'save') {
      s = await saveFixture();
      const x = await s.prepare([s.change()]);
      await s.stage(x);
      await s.submit(x);
      operationId = x.request.operationId;
      api = saves;
    } else if (kind === 'compose') {
      s = await composeFixture();
      const lane = await s.lane(s.state([s.file('a.txt', 'chosen\n'), s.hidden], [s.baseline.sha256]));
      const x = s.selection([lane]);
      await s.prepare(x);
      await s.stage(x);
      await s.submit(x);
      operationId = x.request.operationId;
      api = compose;
    } else {
      s = await syncFixture();
      const lane = await s.lane(s.baseline, { base: { head: s.baseline.sha256, receiptId: 'main-earlier' } });
      const request = s.request('sync', {
        laneId: lane.laneId,
        expected: s.pins(lane),
        target: { kind: 'main', head: s.main.head, receiptId: s.main.receipt.id },
      });
      await s.prepareSync(request);
      await s.submitSync(request);
      operationId = request.operationId;
      api = sync;
    }
    const lane = [...s.tables.projectHostedOverlapLanes.values()].find(row => row.open);
    const peer = randomUUID(),
      at = Date.now();
    s.insert('projectHostedConflictNotices', {
      projectId: s.projectId,
      laneId: lane.laneId,
      peer,
      open: true,
      laneHead: lane.head,
      peerHead: 'peer',
      peerGoal: 'Synthetic peer',
      flaggedAt: at,
      updatedAt: at,
      laneStartedAt: at,
      paths: [{ path: 'src/service.ts', mine: [[1, 1]], theirs: [[1, 1]], reason: 'text' }],
    });
    s.insert('projectBoardInboxes', {
      projectId: s.projectId,
      key: `lane:${lane.laneId}`,
      latestAt: at,
      count: 0,
    });
    const args = { projectId: s.projectId, operationId };
    const plain = JSON.parse(await s.call('plainProgress', api.progress, args));
    assert.equal(plain.board, undefined, 'older clients retain their exact reply');
    const before = s.counts.length;
    const delivered = JSON.parse(
      await s.call('inboxProgress', api.progress, { ...args, board: { laneId: lane.laneId, after: 0 } }),
    );
    assert.equal(s.counts.length - before, 1);
    assert.equal(delivered.board.conflicts[0].with, peer);
    const { board, ...rest } = delivered;
    assert.deepEqual(rest, plain, 'delivery leaves the source operation outcome unchanged');
    assert.equal(
      JSON.parse(
        await s.call('readCursor', api.progress, { ...args, board: { laneId: lane.laneId, after: at } }),
      ).board,
      undefined,
    );
    await assert.rejects(
      s.call(
        'revokedInboxProgress',
        api.progress,
        { ...args, board: { laneId: lane.laneId, after: 0 } },
        null,
      ),
      error => error.data?.code === 'PROJECT_UNAVAILABLE',
    );
  });
}
