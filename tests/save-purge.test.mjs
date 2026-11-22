// SPDX-License-Identifier: Apache-2.0
// Item 9d3c407d (owner decision Q83, journey J29-1 dead end): the project owner purges the stored
// bytes of a leaked save. Negative paths first: a non-owner is refused, and after the purge every
// read route (checkout, diff, the Git and GitHub mirror resolver) refuses PURGED.
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { moduleUrl } from './convex-module.mjs';
import { resolutionFixture } from './hosted-agent-resolution-fixture.mjs';
import { readHostedLaneCheckout } from '../dist/hosted-lane-checkout-marker.js';
import { parseNativeState } from '../dist/state/format.js';
import { digest } from '../dist/hash.js';
import { savePurgeSelection } from '../dist/save-purge.js';
import { defaultR2Config, defaultR2Objects } from './default-r2.mjs';

const store = await import(moduleUrl('../convex/projectSavePurgeStore.ts'));
const gitStore = await import(moduleUrl('../convex/gitServeLaneStore.ts'));
const downloads = await import(moduleUrl('../convex/projectObjectDownloads.ts'));
const r2 = await import(moduleUrl('../convex/r2Operations.ts'));
const find = await import(moduleUrl('../convex/projectObjectFind.ts'));
const catalog = await import(moduleUrl('../convex/projectObjectCatalogStore.ts'));

/** A Lane save that leaked a secret the scanner has no pattern for (a custom token format). */
async function leakedSave(t) {
  const s = await resolutionFixture(t);
  await s.transport().dispatch('open', { laneId: s.f.lane.laneId });
  const leaked = `internal-service-key: ${randomUUID()}${randomUUID()}\n`;
  writeFileSync(join(s.root, 'leak.txt'), leaked);
  await s.transport().dispatch('save', { operationId: randomUUID(), message: 'Add notes' });
  const head = readHostedLaneCheckout(s.root).selection.head;
  const state = parseNativeState(s.f.c.objects.get(head));
  const target = {
    projectId: s.f.projectId,
    laneId: s.f.lane.laneId,
    head,
    parent: state.parents[0],
  };
  return { s, target, blob: digest(leaked), leaked };
}
const tx = (s, name, fn, args, actor = 'owner') => s.f.tx(name, fn, args, actor);
const purgedCode = error => {
  assert.equal(error.data?.code ?? error.code, 'PURGED');
  assert.match(
    error.data?.message ?? error.message,
    /purged by the project owner at .*Save the Lane without that file/,
  );
  return true;
};

test('J29 purge: only the owner person can purge; a writer or a stranger is refused before anything is marked', async t => {
  const { s, target, blob } = await leakedSave(t);
  const operationId = randomUUID();
  for (const actor of ['writer', 'stranger']) {
    await assert.rejects(
      tx(s, 'purgeBegin', store.begin, { ...target, operationId, paths: ['leak.txt'] }, actor),
      error => /PROJECT_UNAVAILABLE|owner/.test(`${error.data?.code ?? error.code} ${error.message}`),
    );
    await assert.rejects(
      tx(
        s,
        'purgeMark',
        store.mark,
        { ...target, operationId, main: 'm'.repeat(64), files: [{ path: 'leak.txt', blob }] },
        actor,
      ),
      error => /PROJECT_UNAVAILABLE|owner/.test(`${error.data?.code ?? error.code} ${error.message}`),
    );
  }
  assert.equal([...s.f.tables.projectSavePurges.values()].length, 0, 'no receipt');
  const row = [...s.f.tables.projectObjects.values()].find(object => object.digest === blob);
  assert(row && !row.purged, 'bytes untouched');
});

test('J29 purge: marked bytes refuse PURGED on checkout, diff and the Git/GitHub mirror resolver; retry replays one receipt and one tombstone', async t => {
  const { s, target, blob, leaked } = await leakedSave(t);
  const operationId = randomUUID();
  const begun = await tx(s, 'purgeBegin', store.begin, { ...target, operationId, paths: ['leak.txt'] });
  assert.equal(begun.row, null);
  assert.match(begun.main, /^[0-9a-f]{64}$/, 'main head named');
  const files = savePurgeSelection(
    { ...target, paths: ['leak.txt'] },
    {
      head: parseNativeState(s.f.c.objects.get(target.head)),
      parent: parseNativeState(s.f.c.objects.get(target.parent)),
      main: parseNativeState(s.f.c.objects.get(begun.main)),
    },
  );
  assert.deepEqual(files, [{ path: 'leak.txt', blob }]);
  const main = begun.main;
  const physical = { projectId: target.projectId, statePhysical: { manifest: 'x' } };
  const probe = { isQuery: true, _handler: ctx => find.readablePhysical(ctx, physical) };
  assert.deepEqual(await tx(s, 'readablePhysical', probe, {}), physical.statePhysical, 'before: fast path');
  const row = await tx(s, 'purgeMark', store.mark, { ...target, operationId, main, files });
  assert.equal(row.state, 'marked');
  assert.equal(row.actor, 'owner');
  assert.deepEqual(
    row.files.map(({ path, blob: id }) => ({ path, blob: id })),
    files,
  );
  assert(
    row.deletes.some(key => key.endsWith(`/o/${blob}`)) || row.zero.length === 1,
    'its R2 bytes are queued',
  );

  // Checkout: a second machine opens the Lane and needs the purged blob.
  const other = join(dirname(s.root), 'second-machine');
  await assert.rejects(s.transport(other).dispatch('open', { laneId: target.laneId }), purgedCode);
  // Diff (the web reads both sides of a save through describe) and show.
  await assert.rejects(
    tx(s, 'describe', downloads.describe, { projectId: target.projectId, digests: [blob], signed: true }),
    purgedCode,
  );
  // Lane Git serve and the GitHub mirror resolve objects through the same lookup.
  await assert.rejects(
    tx(s, 'gitResolve', gitStore.resolve, { projectId: target.projectId, digests: [blob] }),
    purgedCode,
  );

  // The Lane's history keeps a tombstone: what, when and by whom, never the bytes.
  const tombstones = () =>
    [...s.f.tables.projectCoordinationEvents.values()].filter(event => event.operationId === operationId);
  const [tombstone] = tombstones();
  assert.equal(tombstone.actor, 'owner');
  assert.equal(tombstone.laneId, target.laneId);
  assert.match(tombstone.command.text, /Purged the stored bytes of 1 file\(s\) .*leak\.txt/);
  assert(!JSON.stringify(tombstone).includes(leaked.trim()), 'value-free');

  // Retry-safe: the same operation replays its receipt; another selection under it is refused.
  const again = await tx(s, 'purgeBegin', store.begin, { ...target, operationId, paths: ['leak.txt'] });
  assert.equal(again.row.operationId, operationId);
  const replay = await tx(s, 'purgeMark', store.mark, { ...target, operationId, main, files });
  assert.equal(replay._id, row._id);
  assert.equal(tombstones().length, 1, 'one tombstone');
  await assert.rejects(
    tx(s, 'purgeBegin', store.begin, { ...target, operationId, paths: ['other.txt'] }),
    /WORK_OPERATION_CHANGED|another selection/,
  );
  // One purge at a time per project until the bytes are gone.
  await assert.rejects(
    tx(s, 'purgeBegin', store.begin, { ...target, operationId: randomUUID(), paths: ['leak.txt'] }),
    /WORK_BUSY|still deleting/,
  );
  await assert.rejects(
    tx(s, 'purgeMark', store.mark, { ...target, operationId: randomUUID(), main, files }),
    /WORK_BUSY|still deleting/,
    'the mark re-checks, not only begin',
  );
  // A physical manifest would skip the PURGED lookup: once the project has a purge, none is handed out.
  assert.equal(await tx(s, 'readablePhysical', probe, {}), undefined);
  // Compaction keeps the purged row: a catalog entry would lose the tombstone.
  const purgedRow = [...s.f.tables.projectObjects.values()].find(object => object.digest === blob);
  assert(purgedRow.purged, 'row marked');
  assert.equal(catalog.catalogEligible({ ...purgedRow, sourceReferenced: true }), false);
  // A Git build of this Lane that started before the purge is not cached.
  const lane = [...s.f.tables.projectHostedOverlapLanes.values()].find(
    entry => entry.projectId === target.projectId && entry.laneId === target.laneId,
  );
  const built = await tx(s, 'gitRecord', gitStore.record, {
    projectId: target.projectId,
    laneId: target.laneId,
    head: lane.head,
    baseReceiptId: lane.baseReceiptId,
    commit: 'c'.repeat(40),
    parent: 'd'.repeat(40),
    builtFrom: row.at - 1,
  });
  assert.equal(built.recorded, false, 'a build from before the purge is discarded');
  const done = await tx(s, 'purgeFinish', store.finish, { projectId: target.projectId, operationId });
  assert.equal(done.state, 'done');
  assert.equal(store.purgeReceipt(done).files[0].path, 'leak.txt');
  assert.equal(
    (await tx(s, 'purgeFinish', store.finish, { projectId: target.projectId, operationId })).doneAt,
    done.doneAt,
  );
});

test('J29 purge selection: only bytes the save changed, never main bytes, links or the empty file', () => {
  const file = (path, text, mode = 'file') => ({ path, mode, blob: digest(text) });
  const parent = { parents: [], files: [file('a.txt', 'old'), file('same.txt', 'same')] };
  const head = {
    parents: ['p'.repeat(64)],
    files: [
      file('a.txt', 'leak'),
      file('same.txt', 'same'),
      file('link', 'a.txt', 'symlink'),
      file('empty', ''),
    ],
  };
  const main = { parents: [], files: [file('shared.txt', 'leak2')] };
  const input = paths => ({ head: 'h'.repeat(64), parent: 'p'.repeat(64), paths });
  assert.deepEqual(savePurgeSelection(input(['a.txt']), { head, parent, main }), [
    { path: 'a.txt', blob: digest('leak') },
  ]);
  const refuses = (paths, pattern, states = { head, parent, main }) =>
    assert.throws(() => savePurgeSelection(input(paths), states), pattern);
  refuses(['same.txt'], /did not change/);
  refuses(['link'], /not a file/);
  refuses(['missing'], /not a file/);
  refuses(['empty'], /empty/);
  refuses(['a.txt'], /would break main/, { head, parent, main: { parents: [], files: [file('x', 'leak')] } });
  refuses(['a.txt'], /Select a save/, { head: { ...head, parents: ['q'.repeat(64)] }, parent, main });
});

test('J29 purge R2 step: whole objects are deleted, a packed member is zeroed in place, a retry writes nothing', async () => {
  const at = key => `${defaultR2Config.bucket}/${key}`;
  const raw = 'v1/p/purge-test/o/raw',
    pack = 'v1/p/purge-test/o/pack';
  defaultR2Objects.set(at(raw), Buffer.from('leaked'));
  defaultR2Objects.set(at(pack), Buffer.from('keep:LEAK:keep'));
  const work = { deletes: [raw], zero: [{ key: pack, offset: 5, size: 4 }] };
  assert.deepEqual(await r2.purgeR2Bytes(defaultR2Config, work), { deletes: 1, writes: 1 });
  assert(!defaultR2Objects.has(at(raw)), 'raw object deleted');
  assert.deepEqual(
    defaultR2Objects.get(at(pack)),
    Buffer.from('keep:\0\0\0\0:keep'),
    'only the member range zeroed',
  );
  assert.deepEqual(
    await r2.purgeR2Bytes(defaultR2Config, work),
    { deletes: 1, writes: 0 },
    'retry: no rewrite',
  );
  defaultR2Objects.delete(at(pack));
});

test('J29 purge fences: an unknown Lane, a moved main and a missing save are refused before anything is marked', async t => {
  const { s, target, blob } = await leakedSave(t);
  const files = [{ path: 'leak.txt', blob }];
  await assert.rejects(
    tx(s, 'purgeBegin', store.begin, {
      ...target,
      laneId: randomUUID(),
      operationId: randomUUID(),
      paths: ['leak.txt'],
    }),
    /BAD_ARGUMENT/,
  );
  const begun = await tx(s, 'purgeBegin', store.begin, {
    ...target,
    operationId: randomUUID(),
    paths: ['leak.txt'],
  });
  assert.match(begun.base, /^[0-9a-f]{64}$/, 'the Lane base is named');
  await assert.rejects(
    tx(s, 'purgeMark', store.mark, { ...target, operationId: randomUUID(), main: 'f'.repeat(64), files }),
    /WORK_STALE/,
    'main moved while the action checked',
  );
  await assert.rejects(
    tx(s, 'purgeMark', store.mark, {
      ...target,
      laneId: randomUUID(),
      operationId: randomUUID(),
      main: begun.main,
      files,
    }),
    /BAD_ARGUMENT/,
  );
  assert.equal([...s.f.tables.projectSavePurges.values()].length, 0, 'no receipt');
  assert(![...s.f.tables.projectObjects.values()].find(object => object.digest === blob).purged);
});

test('J29 purge selection: the Lane head against its base (the Lane page) is accepted', () => {
  const file = (path, text) => ({ path, mode: 'file', blob: digest(text) });
  const base = 'b'.repeat(64);
  const parent = { parents: [], files: [] };
  const head = { parents: ['p'.repeat(64)], files: [file('a.txt', 'leak')] };
  const input = { head: 'h'.repeat(64), parent: base, paths: ['a.txt'] };
  const states = { head, parent, main: { parents: [], files: [] } };
  assert.deepEqual(savePurgeSelection(input, states, base), [{ path: 'a.txt', blob: digest('leak') }]);
  assert.throws(() => savePurgeSelection(input, states), /Select a save/);
});
