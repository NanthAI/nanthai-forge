// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { measureSync, syncHistory, syncInput, resolveInput } from './measure-sync-ancestry.mjs';
import { syncApplyFixture } from './measure-sync-apply.mjs';
import speedBudgets from '../src/speed-budgets.json' with { type: 'json' };
import { scaleFixture } from './convex-source-scale-fixture.mjs';

// Guard the selected source job, independently of deployment latency. Flat State bytes are
// unavoidable under today's identity; unchanged file bodies and per-file descriptor RPCs are not.
for (const files of [4000, 29000]) {
  test(`sync and resolve at ${files} files pay only the flat-State floor plus changed paths, and idle stays zero`, async t => {
    const clean = await measureSync({ files, changed: 1, distance: 1, conflict: false });
    const wider = await measureSync({ files, changed: 8, distance: 1, conflict: false });
    const conflict = await measureSync({ files, changed: 1, distance: 1, conflict: true });
    assert(
      conflict.sync.steps <=
        speedBudgets.budgets.find(value => value.id === 'source-conflict-sync-actions').max,
      'small conflict sync reuses its verified and parsed merge inputs',
    );
    assert(
      conflict.resolve.steps <= speedBudgets.budgets.find(value => value.id === 'source-resolve-actions').max,
      'small conflict resolution validates its edited page without reloading both full States',
    );
    for (const [run, stateReads] of [
      [clean.sync, 3],
      [wider.sync, 3],
      [conflict.sync, 6],
      [conflict.resolve, 4],
    ]) {
      assert(run.functionCalls <= 7 * run.steps, 'bounded control calls per source action');
      assert(run.descriptorCalls <= 4 * run.steps, 'batch metadata, never one call per repository file');
      assert(run.steps <= 2, 'small changes need at most two bounded source actions on these shapes');
      assert(
        run.readBytes <= stateReads * clean.manifestBytes + 32 * 1024,
        'flat manifests plus small changed content',
      );
      assert(
        run.putBytes <= 2 * clean.manifestBytes + 64 * 1024,
        'State, bounded continuation and result, not unchanged file bodies',
      );
      assert(run.dbReadBytes < 160 * 1024, 'control metadata does not scan the repository inventory');
      assert(run.dbWriteBytes < 96 * 1024, 'control writes stay independent of the file count');
    }
    assert.equal(
      wider.sync.functionCalls,
      clean.sync.functionCalls,
      'eight changed paths share the same control-call window',
    );
    assert.equal(wider.sync.readObjects, clean.sync.readObjects, 'clean metadata merges read no file bodies');
    assert.equal(clean.idleCalls + wider.idleCalls + conflict.idleCalls, 0);
    t.diagnostic(
      JSON.stringify({ files, clean: clean.sync, conflict: conflict.sync, resolve: conflict.resolve }),
    );
  });

  test(`live sync apply at ${files} files transfers only the changed path; fallback keeps the exact State`, async t => {
    const apply = await syncApplyFixture(t, files);
    const ordinary = await apply('fallback', false);
    const live = await apply('live', true);
    assert.equal(ordinary.downloadedState, true, 'a result without a delta still verifies its pinned State');
    assert.equal(live.downloadedState, false, 'the live delta reconstructs the exact State locally');
    assert(live.downloads <= 1, 'a verified machine-cache hit needs no transfer');
    assert(live.downloadedBytes <= live.changedBytes);
    assert.equal(live.selects, live.downloads ? 1 : 0, 'a transfer keeps its final current-access fence');
    assert(live.descriptors <= 1, 'at most one changed-object window for either repository size');
    t.diagnostic(JSON.stringify({ files, ordinary, live }));
  });
}

for (const padding of [0, 1200 * 1024])
  test(`resolve rejects remaining conflict markers through ${padding ? 'continued' : 'inline'} page validation`, async () => {
    const s = await scaleFixture();
    try {
      const h = await syncHistory(s, { files: 4000, changed: 1, distance: 1, conflict: true }),
        id = await s.enqueue(await syncInput(s, h));
      await s.drain();
      const job = await s.job(id),
        output = JSON.parse((await s.bytes(job.output)).toString()),
        input = await resolveInput(
          s,
          h,
          output,
          () => 'x'.repeat(padding) + '\n<<<<<<< lane\nleft\n=======\nright\n>>>>>>> main\n',
        ),
        resolveId = await s.enqueue(input);
      await s.drain();
      const resolved = await s.job(resolveId);
      assert.equal(resolved.status, 'failed');
      assert.equal(resolved.control.failureCode, 'CONFLICT_MARKERS');
    } finally {
      s.restore();
    }
  });
