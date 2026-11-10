// SPDX-License-Identifier: Apache-2.0
import { readWorkBytes } from './work-store-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

import { WorkService } from '../dist/work.js';
import { restoreWork } from '../dist/work-backup.js';
import { fixture, git, write, code } from './helpers.mjs';
import { moduleUrl } from './convex-module.mjs';
import { gunzipSync, gzipSync } from 'node:zlib';
const { previewWorkArchive, archiveDigest } = await import(moduleUrl('../web/src/work-archive.ts'));

test('native archive restoration rejects traversal, symlink headers, duplicate entries and changed Work bytes without writing a target', async t => {
  const root = fixture(t, { 'a.ts': 'export const a = 1;' });
  git(root, ['add', '.']);
  git(root, ['commit', '-qm', 'Original']);
  const work = new WorkService(root),
    exported = (await work.dispatch({ action: 'export-work', archive: true }, work.status().revision)).result;
  const original = gunzipSync(readFileSync(exported.archive.path));
  function checksum(bytes, start = 0) {
    bytes.fill(32, start + 148, start + 156);
    const sum = bytes.subarray(start, start + 512).reduce((sum, byte) => sum + byte, 0);
    bytes.write(sum.toString(8).padStart(6, '0') + '\0 ', start + 148);
  }
  const headerSize = parseInt(original.toString('utf8', 124, 136).replace(/\0.*$/, '').trim(), 8),
    next = 512 + Math.ceil(headerSize / 512) * 512;
  const traversal = Buffer.from(original);
  traversal.fill(0, 0, 100);
  traversal.write('../escape');
  checksum(traversal);
  const linked = Buffer.from(original);
  linked[156] = 50;
  linked.write('/tmp/never-followed', 157);
  checksum(linked);
  const duplicate = Buffer.concat([original.subarray(0, next), original]);
  const changed = Buffer.from(original);
  changed[next + 512] = changed[next + 512] === 32 ? 9 : 32;
  for (const [name, bytes] of [
    ['traversal', traversal],
    ['linked', linked],
    ['duplicate', duplicate],
    ['changed', changed],
  ]) {
    const archive = join(root, name + '.tar.gz'),
      target = join(root, name + '-target');
    writeFileSync(archive, gzipSync(bytes));
    await assert.rejects(restoreWork(archive, target), code('INVALID_WORK_BACKUP'));
    assert.equal(existsSync(target), false);
  }
  await assert.rejects(previewWorkArchive(new File([gzipSync(changed)], 'changed.tar.gz')), /Work bytes/);
});

test('protected web export and restore never restart unfinished commands or overwrite current authority', async t => {
  const root = fixture(t, { 'a.ts': 'export const a = 1;' });
  git(root, ['add', '.']);
  git(root, ['commit', '-qm', 'Original']);
  const work = new WorkService(root),
    c = input => work.dispatch(input, work.status().revision);
  const intent = (await c({ action: 'intent', outcome: 'Recover interruption' })).result;
  const lane = (await c({ action: 'lane', intentId: intent.id, name: 'Original source' })).result;
  const view = (
    await c({ action: 'compose', intentId: intent.id, inputs: [{ laneId: lane.id, head: lane.head }] })
  ).result;
  const marker = join(root, 'never-executed'),
    check = (
      await c({
        action: 'define-check',
        name: 'Not executed on restore',
        executable: process.execPath,
        args: ['-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'wrong')`],
      })
    ).result;
  const data = work.store.load(),
    environment = work.status().environment;
  data.runs.push({
    id: randomUUID(),
    viewId: view.id,
    head: view.head,
    base: view.base,
    inputs: [],
    dependencies: [],
    check,
    environment,
    status: 'running',
    startedAt: new Date().toISOString(),
    runner: { pid: process.pid, host: 'different-host' },
    details: 'Original pending process',
  });
  data.revision++;
  work.store.save(data);
  const before = readWorkBytes(join(work.store.directory, 'work.json'));

  const body = JSON.stringify({ command: { action: 'export-work' }, revision: data.revision });

  const response = await new WorkService(root).dispatch(JSON.parse(body).command, JSON.parse(body).revision);

  const backup = (await response).result;
  const target = join(root, 'independent');
  await restoreWork(backup.path, target);
  const restored = new WorkService(target);
  assert.equal(restored.status().runs[0].status, 'interrupted');
  assert.equal(existsSync(marker), false);
  assert.deepEqual(readWorkBytes(join(work.store.directory, 'work.json')), before);
  const replay = await restored.dispatch(
    {
      action: 'run-check',
      operationId: data.runs[0].id,
      viewId: view.id,
      expectedHead: view.head,
      checkId: check.id,
      expectedDefinition: check.definition,
      expectedEnvironment: environment.fingerprint,
    },
    0,
  );
  assert.equal(replay.result.status, 'interrupted');
  assert.equal(existsSync(marker), false);
});
