import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { workSchema } from '../dist/work-types.js';
import { applyIntentMetadata } from '../dist/work-metadata.js';
import { initLegacyNative as initNative } from './autonomy-fixture.mjs';
import { LegacyWorkService as WorkService } from './autonomy-fixture.mjs';
import { restoreNativeWork } from '../dist/native-backup.js';
import { fixture, git } from './helpers.mjs';

test('historical status replay retains exact old schema and fields; completion and reopen retain transitions in version8', () => {
  const id = randomUUID(),
    data = workSchema.parse({
      schema: 1,
      revision: 0,
      intents: [
        {
          id,
          outcome: 'Feature',
          constraints: '',
          base: 'a'.repeat(40),
          status: 'active',
          notes: [],
          createdAt: 'before',
        },
      ],
      lanes: [],
      views: [],
    });
  applyIntentMetadata(
    data,
    { action: 'intent-status', intentId: id, status: 'ready' },
    { id: randomUUID(), at: 'ready-at' },
  );
  assert.equal(data.schema, 1);
  assert.equal(data.intents[0].lifecycle, undefined);
  applyIntentMetadata(
    data,
    { action: 'intent-status', intentId: id, status: 'completed' },
    { id: randomUUID(), at: 'done-at' },
  );
  assert.equal(data.schema, 8);
  assert.deepEqual(data.intents[0].lifecycle, [{ from: 'ready', to: 'completed', at: 'done-at' }]);
  applyIntentMetadata(
    data,
    { action: 'intent-status', intentId: id, status: 'completed' },
    { id: randomUUID(), at: 'again' },
  );
  assert.equal(data.intents[0].lifecycle.length, 1);
  applyIntentMetadata(
    data,
    { action: 'intent-status', intentId: id, status: 'active' },
    { id: randomUUID(), at: 'reopen-at' },
  );
  assert.deepEqual(data.intents[0].lifecycle.at(-1), { from: 'completed', to: 'active', at: 'reopen-at' });
  assert.equal(workSchema.safeParse({ ...data, schema: 7 }).success, false);
  assert.equal(workSchema.safeParse(data).success, true);
});
test('native Intent and Lane completion preserve source, dirty files, pins and recoverable lifecycle; reopening is explicit', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'forge-lifecycle-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const root = join(dir, 'owner');
  mkdirSync(root);
  writeFileSync(join(root, 'source.ts'), 'export const value=1;\n');
  initNative(root);
  const work = new WorkService(root),
    act = command => work.execute(command, work.status().revision).result;
  const intent = act({ action: 'intent', outcome: 'Implement source' }),
    lane = act({ action: 'lane', intentId: intent.id, name: 'Worker' }),
    path = work.store.path(lane.id);
  writeFileSync(join(path, 'dirty.ts'), 'uncheckpointed content');
  act({ action: 'intent-status', intentId: intent.id, status: 'completed' });
  act({ action: 'lane-status', laneId: lane.id, state: 'completed' });
  let data = work.store.load();
  assert.equal(data.schema, 8);
  assert.equal(data.intents[0].status, 'completed');
  assert.equal(data.lanes[0].state, 'completed');
  assert.equal(data.lanes[0].head, lane.head);
  assert.equal(readFileSync(join(path, 'dirty.ts'), 'utf8'), 'uncheckpointed content');
  assert.equal(data.channelMoves.length, 0);
  assert.equal(data.views.length, 0);
  const backup = (await work.dispatch({ action: 'export-work', archive: true }, work.status().revision))
    .result;
  const target = join(dir, 'restored');
  await restoreNativeWork(backup.archive.path, target);
  const restored = new WorkService(target);
  assert.equal(restored.store.load().intents[0].status, 'completed');
  assert.equal(restored.store.load().lanes[0].lifecycle[0].to, 'completed');
  assert.ok(existsSync(join(restored.store.path(lane.id), 'source.ts')));
  act({ action: 'intent-status', intentId: intent.id, status: 'active' });
  act({ action: 'lane-status', laneId: lane.id, state: 'active' });
  data = work.store.load();
  assert.equal(data.intents[0].status, 'active');
  assert.equal(data.lanes[0].state, 'active');
  assert.equal(data.intents[0].lifecycle.length, 2);
  assert.equal(data.lanes[0].lifecycle.length, 2);
  assert.equal(data.lanes[0].head, lane.head);
  // An existing older mutation assigning schema7 cannot downgrade persisted lifecycle.
  work.store.locked(() => {
    const latest = work.store.load();
    latest.schema = 7;
    work.store.save(latest);
  });
  assert.equal(work.store.load().schema, 8);
});
test('Git-backed lifecycle uses the same explicit completion and reopening without removing its worktree', t => {
  const root = fixture(t, { 'source.ts': 'export const value=1;' });
  git(root, ['add', '.']);
  git(root, ['commit', '-qm', 'Fixture']);
  const work = new WorkService(root),
    act = command => work.execute(command, work.status().revision).result;
  const intent = act({ action: 'intent', outcome: 'Git feature' }),
    lane = act({ action: 'lane', intentId: intent.id, name: 'Git worker' });
  act({ action: 'lane-status', laneId: lane.id, state: 'completed' });
  assert.ok(existsSync(work.store.path(lane.id)));
  act({ action: 'lane-status', laneId: lane.id, state: 'active' });
  assert.deepEqual(
    work.store.load().lanes[0].lifecycle.map(x => x.to),
    ['completed', 'active'],
  );
});

test('ordinary indexed writes preserve minimal portable formats1 through7 and a stored8 owner cannot be downgraded', t => {
  const dir = mkdtempSync(join(tmpdir(), 'forge-format-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const root = join(dir, 'owner');
  mkdirSync(root);
  writeFileSync(join(root, 'source.ts'), 'export const value=1;');
  initNative(root);
  const work = new WorkService(root);
  assert.equal(work.store.load().schema, 1);
  for (let schema = 1; schema <= 7; schema++) {
    const data = work.store.load();
    data.schema = schema;
    data.revision++;
    work.store.save(data);
    assert.equal(work.store.load().schema, schema);
  }
  const before = work.store.load();
  before.schema = 8;
  work.store.save(before);
  const legacyWriter = work.store.load();
  legacyWriter.schema = 7;
  work.store.save(legacyWriter);
  assert.equal(work.store.load().schema, 8);
});
