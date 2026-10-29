// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { lanesFixture } from './hosted-lanes-fixture.mjs';
import { moduleUrl } from './convex-module.mjs';
import { digest } from '../dist/hash.js';
const { saveObject, saveObjects } = await import(moduleUrl('../convex/projectHostedSaveStore.ts'));
const { projectGuard } = await import(moduleUrl('../convex/projectCheckLogCleanupGuard.ts'));

function fixture() {
  const s = lanesFixture();
  const projectId = s.insert('hostedProjects', {
    owner: 'owner',
    key: 'synthetic',
    name: 'Synthetic',
    currentBackup: null,
    revision: 0,
    sourceAuthority: { mode: 'server', epoch: 1 },
  });
  const files = Array.from({ length: 3000 }, (_, i) => {
    const bytes = Buffer.from(`file ${i}`),
      sha256 = digest(bytes);
    s.insert('projectObjects', {
      projectId,
      digest: sha256,
      size: bytes.length,
      nonce: 'synthetic',
      removed: false,
      storageId: `blob-${i}`,
    });
    return { path: `f${i}`, blob: sha256, mode: 'file' };
  });
  const state = Buffer.from(JSON.stringify({ schema: 1, kind: 'forge-source-state', parents: [], files }));
  s.insert('projectObjects', {
    projectId,
    digest: digest(state),
    size: state.length,
    nonce: 'synthetic',
    removed: false,
    storageId: 'state',
  });
  for (let i = 0; i < 600; i++)
    s.insert('projectHostedRecordHeads', {
      projectId,
      kind: 'intent',
      key: `intent-${i}`,
      version: 0,
      parent: '',
      status: 'active',
      recordId: `unselected-${i}`,
    });
  const pins = files
    .slice(0, 12)
    .map(file => ({ sha256: file.blob, size: Buffer.byteLength(`file ${files.indexOf(file)}`) }));
  const call = (name, fn) => s.call(name, { _handler: ctx => fn(ctx) }, {});
  return { ...s, projectId, pins, call, stateBytes: state.length };
}

test('save stages and finish publications append one cleanup fence per object batch, with zero retry writes', async t => {
  for (const count of [11, 2, 3]) {
    const measured = [];
    for (const batched of [false, true]) {
      const s = fixture(),
        pins = s.pins.slice(0, count);
      const started = performance.now();
      const result = await s.call('protect', async ctx => {
        const project = await ctx.db.get(s.projectId);
        const before = await projectGuard(ctx, project);
        const values = batched
          ? await saveObjects(ctx, s.projectId, pins)
          : await Promise.all(pins.map(pin => saveObject(ctx, s.projectId, pin)));
        const after = await projectGuard(ctx, project);
        assert.notEqual(before, after, 'an older cleanup plan is fenced');
        return values;
      });
      assert.deepEqual(
        result.map(value => value.object),
        pins,
      );
      const stats = s.counts.at(-1);
      measured.push({
        functionCalls: 1,
        documents: stats.documents,
        writes: stats.writes,
        wallMs: performance.now() - started,
      });
      assert.equal(stats.writes, batched ? count + 1 : count * 2);
      assert(
        stats.documents <= count + 4,
        'indexed reads depend on selected pins, not 600 Intents/3000 files',
      );
      assert.equal(s.tables.projectCheckLogSourcePins.size, batched ? 1 : count);
      const retry = await s.call('retry', ctx => saveObjects(ctx, s.projectId, pins));
      assert.deepEqual(retry, result);
      assert.equal(s.counts.at(-1).writes, 0);
      assert([...s.tables.projectObjects.values()].filter(row => row.sourceReferenced).length === count);
      await s.call('next-batch', async ctx => {
        const project = await ctx.db.get(s.projectId),
          before = await projectGuard(ctx, project);
        await saveObjects(ctx, s.projectId, [s.pins[count]]);
        assert.notEqual(await projectGuard(ctx, project), before, 'each later batch advances the guard');
      });
    }
    t.diagnostic(
      JSON.stringify({
        objects: count,
        before: measured[0],
        after: measured[1],
        maxRssBytes: process.resourceUsage().maxRSS * 1024,
      }),
    );
  }
});

test('invalid source batches roll back every protection mark and cleanup fence', async () => {
  const s = fixture();
  for (const bad of [
    { sha256: s.pins[1].sha256, size: 999 },
    { sha256: 'f'.repeat(64), size: 1 },
  ]) {
    await assert.rejects(
      s.call('invalid', ctx => saveObjects(ctx, s.projectId, [s.pins[0], bad])),
      /exact project source object/,
    );
    assert.equal(s.tables.projectCheckLogSourcePins.size, 0);
    assert([...s.tables.projectObjects.values()].every(row => !row.sourceReferenced));
  }
  const duplicate = await s.call('duplicate', ctx => saveObjects(ctx, s.projectId, [s.pins[0], s.pins[0]]));
  assert.equal(duplicate.length, 2);
  assert.equal(s.counts.at(-1).writes, 2, 'duplicate pins share the exact read and mark');
});
