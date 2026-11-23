// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { conflictTrio } from './early-resolution-replay.mjs';
import { synthetic } from './hosted-landing-batches-fixture.mjs';
import { moduleUrl } from './convex-module.mjs';
import { boardWaitOption, boardWakeEnvelope, freshBoardDelivery } from '../dist/hosted-board-wait.js';

const conflicts = await import(moduleUrl('../convex/projectHostedConflicts.ts'));
const prior = Object.fromEntries(Object.keys(synthetic).map(key => [key, process.env[key]]));
test.before(() => Object.assign(process.env, synthetic));
test.after(() => {
  for (const [key, value] of Object.entries(prior)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

async function adviceFixture(t, failTable = 'projectHostedLandingAttempts') {
  const { f, advice, lateEntry: mine } = await conflictTrio(t);
  const peer = f.entries.find(entry => entry.state.id === advice.predecessor.submissionId);
  assert(peer);
  for (const entry of [mine, peer]) {
    if (![...f.tables.projectHostedOverlapLanes.values()].some(row => row.laneId === entry.lane.laneId))
      f.insert('projectHostedOverlapLanes', {
        projectId: f.projectId,
        laneId: entry.lane.laneId,
        intentId: entry.lane.intentId,
        actor: 'owner',
        intent: 'Synthetic source',
        head: entry.lane.head,
        baseHead: f.c.baseline.sha256,
        baseReceiptId: 'main-0',
        baseSequence: 0,
        recordVersion: 0,
        open: true,
        changes: '[]',
        complete: true,
      });
  }
  const input = {
    projectId: f.projectId,
    laneId: mine.lane.laneId,
    head: mine.lane.head,
    peers: [{ laneId: peer.lane.laneId, head: peer.lane.head }],
    conflicts: [
      { peer: peer.lane.laneId, path: 'shared.txt', mine: [[3, 3]], theirs: [[3, 3]], reason: 'text' },
    ],
  };
  const record = () => f.transaction('recordAdviceNotice', conflicts.record, input);
  const projection = async () =>
    (
      await f.transaction(
        'readAdviceNotice',
        {
          _handler: ctx => conflicts.laneConflicts(ctx, f.projectId, mine.lane.laneId, mine.lane.head),
        },
        {},
      )
    )[0];
  await record();
  const first = await projection();
  assert(first.earlyResolution, 'a real queued predecessor supplies stored advice');
  let unavailable = true,
    failures = 0;
  f.extendContext(ctx => {
    const query = ctx.db.query.bind(ctx.db);
    ctx.db.query = table => {
      if (unavailable && table === failTable) {
        failures++;
        throw Error('Synthetic predecessor read unavailable');
      }
      return query(table);
    };
  });
  return {
    f,
    mine,
    peer,
    input,
    record,
    projection,
    first,
    recover: () => {
      unavailable = false;
    },
    failures: () => failures,
  };
}

test('11c07518: an unavailable predecessor read keeps stored advice and never wakes again to remove then restore it', async t => {
  const { mine, record, projection, first, recover, failures } = await adviceFixture(t);
  const root = mkdtempSync(join(tmpdir(), 'forge-advice-read-failure-'));
  t.after(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(`${root}.forge-client`, { recursive: true, force: true });
  });
  const payload = notice => ({
    board: { messages: [], more: 0, cursor: notice.generation, conflicts: [notice] },
  });
  boardWakeEnvelope(
    root,
    mine.lane.laneId,
    freshBoardDelivery(boardWaitOption(root, mine.lane.laneId), payload(first)),
  );
  await record();
  assert(failures() > 0, 'the actual predecessor lookup failed');
  assert.deepEqual(await projection(), first, 'failed reads retain both advice and publication generation');
  recover();
  await record();
  const recovered = await projection();
  assert.deepEqual(recovered, first, 'the restored read cannot manufacture a second notice');
  assert.equal(freshBoardDelivery(boardWaitOption(root, mine.lane.laneId), payload(recovered)), undefined);
});

for (const changed of ['mine', 'peer']) {
  test(`11c07518 M2: a failed predecessor read cannot reuse advice after the ${changed} head changes`, async t => {
    const { f, mine, peer, input, record, projection, first, failures } = await adviceFixture(
      t,
      'projectHostedComposeSelections',
    );
    const source = changed === 'mine' ? mine : peer;
    const overlap = [...f.tables.projectHostedOverlapLanes.values()].find(
      row => row.laneId === source.lane.laneId,
    );
    overlap.head = 'f'.repeat(64);
    source.lane.head = overlap.head;
    if (changed === 'mine') input.head = overlap.head;
    else input.peers[0].head = overlap.head;
    await record();
    assert(failures() > 0, 'the actual predecessor lookup failed for the new pair');
    const updated = await projection();
    assert(updated.generation > first.generation, 'a changed source pair publishes a new generation');
    assert.equal(updated.earlyResolution, undefined, 'advice for the previous pair is absent');
    const stored = [...f.tables.projectHostedConflictNotices.values()].find(
      row => row.laneId === mine.lane.laneId,
    );
    assert.equal(stored.earlyResolution, undefined, 'old advice is also removed from storage');
  });
}
