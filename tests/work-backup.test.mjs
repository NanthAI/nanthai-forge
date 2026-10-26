// SPDX-License-Identifier: Apache-2.0
import { readWorkBytes } from './work-store-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, existsSync, rmSync, statSync, symlinkSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { WorkService } from '../dist/work.js';
import { restoreWork } from '../dist/work-backup.js';
import { serveRepository } from '../dist/http.js';
import { fixture, git, write, code } from './helpers.mjs';
import { moduleUrl } from './convex-module.mjs';
import { gunzipSync, gzipSync } from 'node:zlib';
const { previewWorkArchive, archiveDigest } = await import(moduleUrl('../web/src/work-archive.ts'));

test('source/Work recovery retains original history, undo pins, evidence, Channels and independent portable Lanes', async t => {
  for (const format of ['sha1', 'sha256']) {
    const root = fixture(t, { 'a.ts': 'export const a = 1;\n', '.gitignore': '.env\n' });
    if (format === 'sha256') {
      rmSync(join(root, '.git'), { recursive: true });
      git(root, ['init', '-q', '--object-format=sha256']);
    }
    git(root, ['add', '.']);
    git(root, ['commit', '-qm', 'Original history']);
    const work = new WorkService(root),
      command = c => work.dispatch(c, work.status().revision);
    const policyData = work.store.load();
    const { policyPreset } = await import('../dist/autonomy-policy.js');
    policyData.autonomyPolicy = {
      ...policyPreset('trusted'),
      checkLogs: { uploadLocal: true, retentionDays: 90 },
    };
    work.store.save(policyData);
    const intent = (await command({ action: 'intent', outcome: 'Restore real work' })).result;
    const lane = (await command({ action: 'lane', intentId: intent.id, name: 'Portable Lane' })).result;
    const lanePath = work.store.path(lane.id);
    write(lanePath, 'a.ts', 'export const a = 2;\n');
    git(lanePath, ['add', '.']);
    const current = work.status().lanes[0];
    const checkpoint = (
      await command({
        action: 'checkpoint',
        laneId: lane.id,
        expectedHead: current.actualHead,
        expectedTree: current.indexTree,
        message: 'Retained even after undo',
      })
    ).result;
    const view = (
      await command({
        action: 'compose',
        intentId: intent.id,
        inputs: [{ laneId: lane.id, head: checkpoint.head }],
      })
    ).result;
    const acceptance = (
      await command({
        action: 'accept-channel',
        operationId: randomUUID(),
        channel: 'main',
        viewId: view.id,
        expectedHead: view.head,
        expectedPrevious: null,
      })
    ).result;
    const undo = (await command({ action: 'undo', laneId: lane.id, expectedHead: checkpoint.head })).result;
    const check = (
      await command({
        action: 'define-check',
        name: 'Actual retained output',
        executable: process.execPath,
        args: [
          '-e',
          'require("node:fs").writeFileSync("output.txt", "retained output"); console.log("retained log")',
        ],
        artifactPaths: ['output.txt'],
      })
    ).result;
    const status = work.status(),
      runId = randomUUID();
    await work.dispatch(
      {
        action: 'run-check',
        operationId: runId,
        viewId: view.id,
        expectedHead: view.head,
        checkId: check.id,
        expectedDefinition: check.definition,
        expectedEnvironment: status.environment.fingerprint,
      },
      status.revision,
    );
    for (let i = 0; i < 200 && ['preparing', 'running'].includes(work.status().runs[0].status); i++)
      await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(work.status().runs[0].status, 'passed');
    write(root, '.env', 'PRIVATE_NOT_EXPORTED');
    write(root, 'a.ts', 'unfinished root');
    git(root, ['add', 'a.ts']);
    write(lanePath, 'a.ts', 'unfinished Lane');
    const originalBytes = readWorkBytes(join(work.store.directory, 'work.json')),
      refs = git(root, ['show-ref']),
      rootStatus = git(root, ['status', '--porcelain']);
    const exported = (await command({ action: 'export-work', archive: true })).result;
    assert.equal(statSync(exported.path).mode & 0o777, 0o700);
    assert.deepEqual(readWorkBytes(join(exported.path, 'work.json')), originalBytes);
    const manifest = JSON.parse(readFileSync(join(exported.path, 'manifest.json')));
    assert.equal(statSync(exported.archive.path).mode & 0o777, 0o600);
    const downloaded = join(root, 'downloaded.tar.gz');
    writeFileSync(downloaded, readFileSync(exported.archive.path));
    chmodSync(downloaded, 0o644);
    const file = new File([readFileSync(downloaded)], 'downloaded.tar.gz'),
      preview = await previewWorkArchive(file);
    assert.equal(await archiveDigest(file), exported.archive.sha256);
    assert.equal(preview.manifestDigest, exported.sha256);
    assert.equal(preview.format, format);
    assert.equal(preview.head, manifest.head);
    assert.equal(preview.revision, manifest.revision);
    assert.deepEqual(preview.channels, [{ name: 'main', head: view.head }]);
    const archiveTarget = join(root, 'archive-restored');
    await restoreWork(downloaded, archiveTarget);
    assert.deepEqual(
      readWorkBytes(join(new WorkService(archiveTarget).store.directory, 'work.json')),
      originalBytes,
    );
    assert.equal(new WorkService(archiveTarget).status().channels[0].head, view.head);
    for (const file of manifest.files)
      assert.equal(statSync(join(exported.path, file.path)).mode & 0o777, 0o600);
    assert.equal(
      manifest.files.some(file => file.path.includes('.env') || file.path.includes('workspace')),
      false,
    );
    const target = join(root, 'restored');
    const restored = JSON.parse(
      execFileSync(process.execPath, ['dist/cli.js', 'restore-work', exported.path, target], {
        encoding: 'utf8',
      }),
    );
    assert.equal(restored.sha256, exported.sha256);
    assert.equal(git(target, ['rev-parse', '--show-object-format']).trim(), format);
    const recovered = new WorkService(target),
      recoveredStatus = recovered.status();
    assert.equal(recoveredStatus.channels[0].head, view.head);
    assert.equal(recoveredStatus.channels[0].moveId, acceptance.id);
    assert.equal(recoveredStatus.runs[0].status, 'passed');
    assert.deepEqual(recoveredStatus.intents, work.status().intents);
    assert.deepEqual(readWorkBytes(join(recovered.store.directory, 'work.json')), originalBytes);
    assert.equal(git(target, ['show', `${checkpoint.head}:a.ts`]), 'export const a = 2;\n');
    assert.equal(readFileSync(join(recovered.store.path(lane.id), 'a.ts'), 'utf8'), 'export const a = 2;\n');
    assert.equal(readFileSync(join(recovered.store.path(undo.id), 'a.ts'), 'utf8'), 'export const a = 1;\n');
    assert.equal(readFileSync(join(target, 'a.ts'), 'utf8'), 'export const a = 1;\n');
    assert.equal(existsSync(join(target, '.env')), false);
    const evidence = (
      await recovered.dispatch({ action: 'export-check', id: runId }, recoveredStatus.revision)
    ).result;
    assert.equal(readFileSync(evidence.artifacts[0].path, 'utf8'), 'retained output');
    assert.match(readFileSync(evidence.logs[0].path, 'utf8'), /retained log/);
    await recovered.dispatch(
      { action: 'note', intentId: intent.id, kind: 'decision', text: 'Independent restored owner' },
      recovered.status().revision,
    );
    const laterBytes = readWorkBytes(join(recovered.store.directory, 'work.json'));
    assert.equal((await restoreWork(exported.path, target)).original, true);
    assert.deepEqual(readWorkBytes(join(recovered.store.directory, 'work.json')), laterBytes);
    assert.deepEqual(readWorkBytes(join(work.store.directory, 'work.json')), originalBytes);
    assert.equal(git(root, ['show-ref']), refs);
    assert.equal(readFileSync(join(lanePath, 'a.ts'), 'utf8'), 'unfinished Lane');
    assert.ok(git(root, ['status', '--porcelain']).startsWith(rootStatus));
    // Changed bytes, traversal and linked evidence never produce a restored destination.
    const log = manifest.files.find(file => file.path.endsWith('/stdout.log')),
      saved = readFileSync(join(exported.path, log.path));
    writeFileSync(join(exported.path, log.path), 'tampered');
    await assert.rejects(restoreWork(exported.path, join(root, 'invalid')), code('INVALID_WORK_BACKUP'));
    assert.equal(existsSync(join(root, 'invalid')), false);
    writeFileSync(join(exported.path, log.path), saved);
    const manifestBytes = readFileSync(join(exported.path, 'manifest.json'));
    manifest.files.push({ path: '../escape', size: 0, sha256: '0'.repeat(64) });
    writeFileSync(join(exported.path, 'manifest.json'), JSON.stringify(manifest));
    await assert.rejects(restoreWork(exported.path, join(root, 'traversal')), code('INVALID_WORK_BACKUP'));
    writeFileSync(join(exported.path, 'manifest.json'), manifestBytes);
    rmSync(join(exported.path, log.path));
    symlinkSync(join(work.store.directory, log.path), join(exported.path, log.path));
    await assert.rejects(restoreWork(exported.path, join(root, 'linked')), code('INVALID_WORK_BACKUP'));
    await assert.rejects(restoreWork(exported.path, root), code('RESTORE_TARGET_EXISTS'));
    // A completed native receipt survives interruption before its metadata publication.
    const pending = work.store.load();
    pending.runs[0].status = 'running';
    pending.revision++;
    work.store.save(pending);
    const pendingBytes = readWorkBytes(join(work.store.directory, 'work.json'));
    const pendingBackup = (await work.dispatch({ action: 'export-work' }, pending.revision)).result;
    const completedTarget = join(root, 'completed-receipt');
    await restoreWork(pendingBackup.path, completedTarget);
    assert.equal(new WorkService(completedTarget).status().runs[0].status, 'passed');
    assert.deepEqual(readWorkBytes(join(work.store.directory, 'work.json')), pendingBytes);
  }
});

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
  const server = await serveRepository(root, 0);
  t.after(() => server.close());
  const url = new URL(server.url),
    token = new URLSearchParams(url.hash.slice(1)).get('token');
  const endpoint = new URL('/api/work', url),
    body = JSON.stringify({ command: { action: 'export-work' }, revision: data.revision });
  assert.equal(
    (await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body })).status,
    401,
  );
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body,
  });
  assert.equal(response.status, 200);
  const backup = (await response.json()).result;
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
