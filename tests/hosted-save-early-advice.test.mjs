// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { conflictTrio, resolveEarly, drainReady, totals } from './early-resolution-replay.mjs';
import { synthetic } from './hosted-landing-batches-fixture.mjs';
import { moduleUrl } from './convex-module.mjs';
import { exactConflictNotice } from '../dist/hosted-conflict-notice.js';
const conflicts = await import(moduleUrl('../convex/projectHostedConflicts.ts'));
const prior = Object.fromEntries(Object.keys(synthetic).map(k => [k, process.env[k]]));
test.before(() => Object.assign(process.env, synthetic));
test.after(() => {
  for (const [k, v] of Object.entries(prior)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});
for (const earlyResolve of [undefined, 'off'])
  test(`8c9b84fc: save-time exact peer conflict offers the checked fixed prefix (${earlyResolve ?? 'on'})`, async t => {
    const { f, advice } = await conflictTrio(t, { earlyResolve });
    const author = f.entries[2].lane,
      peer = f.entries[1].lane;
    // A retained save-time exact conflict, before a cohort's advice is consumed.
    // The trial-merge suite separately proves this record comes from verified source bytes.
    await f.transaction('record-save-time-exact-conflict', conflicts.record, {
      projectId: f.projectId,
      laneId: author.laneId,
      head: author.head,
      peers: [{ laneId: peer.laneId, head: peer.head }],
      conflicts: [
        {
          peer: peer.laneId,
          path: 'shared.txt',
          mine: [[1, 1]],
          theirs: [[1, 1]],
          reason: 'both changed the same lines',
        },
      ],
    });
    const recorded = f.counts.at(-1);
    t.diagnostic(
      JSON.stringify({
        recordAdvice: earlyResolve ?? 'on',
        calls: 1,
        reads: recorded.documents,
        writes: recorded.writes,
        readBytes: recorded.readBytes,
        writeBytes: recorded.writeBytes,
      }),
    );
    const found = await f.transaction(
      'read-save-time-conflict-advice',
      { _handler: ctx => conflicts.laneConflicts(ctx, f.projectId, author.laneId, author.head) },
      {},
    );
    const read = f.counts.at(-1);
    t.diagnostic(
      JSON.stringify({
        saveAdvice: earlyResolve ?? 'on',
        calls: 1,
        reads: read.documents,
        writes: read.writes,
        readBytes: read.readBytes,
      }),
    );
    const notice = exactConflictNotice(author.laneId, found);
    if (earlyResolve === 'off') {
      assert.equal(notice.continuation, undefined);
      return;
    }
    assert(notice.continuation, 'the save notice already offers pinned sync');
    assert.equal(notice.continuation.next.action, 'sync');
    assert.equal(notice.continuation.next.predecessor.head, advice.predecessor.head);
    assert.equal(notice.continuation.next.predecessor.receiptId, advice.predecessor.receiptId);
    assert(!/change your edit/.test(notice.next));
    // A new generation must never inherit the old notice's early target.
    const peerRow = [...f.tables.projectHostedOverlapLanes.values()].find(r => r.laneId === peer.laneId);
    f.patch('projectHostedOverlapLanes', peerRow._id, { head: randomUUID().replaceAll('-', '').repeat(2) });
    const stale = await f.transaction(
      'read-stale-save-target',
      { _handler: ctx => conflicts.laneConflicts(ctx, f.projectId, author.laneId, author.head) },
      {},
    );
    assert.equal(exactConflictNotice(author.laneId, stale).continuation, undefined);
  });

for (const delayMs of [40000, 76000])
  test(`8c9b84fc: save-time sync saves the ${delayMs / 1000}s measured delivery gap in the fake-clock trio`, async t => {
    const replay = async saveTime => {
      const trio = await conflictTrio(t);
      const { f } = trio;
      const started = Date.now(),
        due = new Map();
      const reserve = async () => {
        for (const run of f.runs().filter(r => r.status === 'queued' && !due.has(r.id))) {
          due.set(run.id, Date.now() + 180000);
          await f.rawChecks.activate(run.id);
        }
      };
      await reserve();
      // Fixed arrival/service schedule. Prior advice arrived after cohort compose;
      // the save notice now exposes the same exact sync before that delivery gap.
      if (!saveTime) f.advanceClock(delayMs);
      const resolved = await resolveEarly(trio);
      for (let n = 0; n < 20; n++) {
        await reserve();
        const state = (await f.current(resolved.state.id)).submission;
        if (state.phase === 'landed')
          return {
            lateTaskMs: Date.now() - started,
            checks: f.runs().length,
            idle: f.pending().length,
            ...totals(f),
          };
        assert.notEqual(state.phase, 'terminal-failed');
        const running = f.runs().filter(r => r.status === 'running');
        const next = Math.min(...running.map(r => due.get(r.id)));
        assert(Number.isFinite(next), 'the trio stays event-owned');
        f.advanceClock(Math.max(0, next - Date.now()));
        for (const run of running.filter(r => due.get(r.id) <= Date.now())) await f.rawChecks.pass(run);
        await drainReady(f);
      }
      assert.fail('finite save-time latency replay');
    };
    const before = await replay(false),
      after = await replay(true);
    assert.equal(before.lateTaskMs - after.lateTaskMs, delayMs);
    assert.equal(after.checks, before.checks);
    assert.equal(after.idle, 0);
    for (const metric of ['calls', 'reads', 'writes']) assert(after[metric] <= before[metric], metric);
    t.diagnostic(JSON.stringify({ delayMs, before, after }));
  });
