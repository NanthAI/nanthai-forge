// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import test from 'node:test';
import assert from 'node:assert/strict';
import { moduleUrl } from './convex-module.mjs';
import { mirrorControlsFixture as fixture } from './github-mirror-controls-fixture.mjs';
import { acceptMirrorReceipt as accept } from './github-mirror-catchup-fixture.mjs';
import { mirrorFixture } from './hosted-github-mirror-fixture.mjs';
const queue = await import(moduleUrl('../convex/projectGithubMirrorQueue.ts'));
const store = await import(moduleUrl('../convex/projectGithubMirrorStore.ts'));

for (const [count, nativeBase] of [
  [1, false],
  [2, false],
  [25, false],
  [25, true],
])
  test(`a ${count}-landing publish ${nativeBase ? 'from a native mapping' : 'from a hosted mapping'} has bounded subject-only evidence and a pinned replay`, async t => {
    const f = fixture(true, 'synthetic/mirror'),
      github = mirrorFixture();
    const base = accept(f, github.root.state, github.root.state, 500);
    if (nativeBase) f.tables.projectHostedAcceptances.clear();
    f.patch('projectGithubMirrors', f.mirrorId, {
      mapping: JSON.stringify({ ...github.root, acceptanceId: base.id }),
    });
    const covered = [];
    let previous = github.root.state;
    for (let i = 1; i <= count; i++) {
      const state = i === count ? github.head : i.toString(16).padStart(64, '0');
      const receipt = accept(f, state, previous, 500 + i);
      covered.push(receipt);
      previous = state;
    }
    const last = covered.at(-1);
    const job = await f.call(
      'enqueue',
      {
        _handler: async ctx => queue.enqueueGithubMirror(ctx, await ctx.db.get(f.projectId), last),
      },
      {},
    );
    const seed = JSON.parse(await f.call('begin', store.begin, { jobId: job.jobId, step: 0 })).seed;
    const reads = f.counts.at(-1).readDocumentsByTable.projectHostedAcceptances;
    assert.equal(
      reads,
      count === 1 ? 1 : 2 + Math.min(count, 21),
      'one existing current-receipt read; adjacent publishes add zero; skipped publishes add at most 22',
    );
    if (count === 1) assert.match(seed.message, /^Paused landing 501\n/);
    else {
      assert(seed.message.startsWith(`Catch up ${count} Forge landings\n`));
      for (const receipt of covered.slice(0, 20))
        assert(seed.message.includes(`${receipt.message} (${receipt.id.slice(0, 8)})`));
      assert.equal(seed.message.includes('…and 5 more'), count === 25);
      assert(!seed.message.includes(last.actor.id), 'no actor metadata enters the public summary');
      assert(
        !seed.message.includes('Paused landing 521'),
        'the 21st row is lookahead, not an unbounded list',
      );
    }
    assert(seed.message.includes(`Forge-State: ${last.candidate.head}`));
    assert(seed.message.includes(`Forge-Acceptance: ${last.id}`));
    assert(seed.message.includes(`Forge-View: ${last.candidate.id}`));
    const row = [...f.tables.projectHostedAcceptances.values()].find(row => row.receiptId === last.id);
    f.patch('projectHostedAcceptances', row._id, {
      value: JSON.stringify({ ...last, message: 'Changed later' }),
    });
    const replay = JSON.parse(await f.call('replay', store.begin, { jobId: job.jobId, step: 0 })).seed;
    assert.equal(replay.message, seed.message, 'lost replies replay the already-pinned bytes');
    assert.equal(f.counts.at(-1).readDocumentsByTable.projectHostedAcceptances ?? 0, 0);
    t.diagnostic(JSON.stringify({ count, nativeBase, acceptanceReads: reads }));
  });
