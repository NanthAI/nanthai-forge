// SPDX-License-Identifier: Apache-2.0
import { readWorkBytes } from './work-store-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  renameSync,
  rmSync,
  symlinkSync,
  chmodSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { gunzipSync } from 'node:zlib';
import { initNative } from '../dist/native-work.js';
import { NativeSource } from '../dist/native-source.js';
import { restoreNativeWork } from '../dist/native-backup.js';
import { WorkStore } from '../dist/work-store.js';
import { WorkService } from '../dist/work.js';
import { capture } from '../dist/snapshot.js';
import { serveRepository } from '../dist/http.js';

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'forge-native-test-')),
    bin = join(dir, 'bin');
  mkdirSync(bin);
  const called = join(dir, 'git-called');
  writeFileSync(join(bin, 'git'), `#!/bin/sh\n/usr/bin/touch '${called}'\nexit 91\n`);
  chmodSync(join(bin, 'git'), 0o700);
  for (const tool of ['tar', 'gzip']) symlinkSync(`/usr/bin/${tool}`, join(bin, tool));
  const previous = process.env.PATH;
  process.env.PATH = bin;
  t.after(() => {
    process.env.PATH = previous;
    rmSync(dir, { recursive: true, force: true });
  });
  const root = join(dir, 'project');
  mkdirSync(root);
  writeFileSync(join(root, 'a.ts'), 'export const a=1;\n');
  writeFileSync(join(root, 'README.md'), '# Native source\n');
  writeFileSync(join(root, '.gitignore'), 'ignored/\n*.scratch\n');
  mkdirSync(join(root, 'ignored'));
  writeFileSync(join(root, 'ignored', 'x.ts'), 'private');
  writeFileSync(join(root, '.env'), 'PRIVATE_VALUE=never-copy');
  const initialized = initNative(root),
    w = new WorkService(root);
  const act = command => w.execute(command, w.status().revision).result;
  const intent = act({ action: 'intent', outcome: 'Native development' });
  const lane = act({ action: 'lane', intentId: intent.id, name: 'One' }),
    path = w.store.path(lane.id);
  const checkpoint = (id, message) => {
    const l = w.status().lanes.find(x => x.id === id);
    return act({
      action: 'checkpoint',
      laneId: id,
      expectedHead: l.actualHead,
      expectedTree: l.indexTree,
      message,
    });
  };
  const compose = (inputs, operationId = randomUUID()) =>
    act({
      action: 'compose',
      operationId,
      intentId: intent.id,
      inputs: inputs.map(id => ({ laneId: id, head: w.status().lanes.find(x => x.id === id).head })),
    });
  return { dir, root, w, act, intent, lane, path, checkpoint, compose, called, initialized };
}
test(
  'native source, Work, checks and portable restore work without invoking Git',
  { timeout: 120000 },
  async t => {
    const f = fixture(t),
      { w, act, lane, path, checkpoint, compose, root, called } = f;
    assert.equal(w.store.native, true);
    assert.equal(w.status().capabilities.nativeSource, true);
    assert.equal(capture(path).source.gitHead, null);
    assert.equal(capture(path).source.files.length, 1);
    writeFileSync(join(path, 'a.ts'), 'export const a=2;\n');
    mkdirSync(join(path, 'nested'));
    writeFileSync(join(path, 'nested', 'bytes.bin'), Buffer.from([0, 255, 128, 10]));
    writeFileSync(join(path, 'execute.sh'), '#!/bin/sh\nexit 0\n');
    chmodSync(join(path, 'execute.sh'), 0o700);
    const stale = w.status().lanes[0];
    writeFileSync(join(path, 'later.ts'), 'export const later=1;');
    assert.throws(
      () =>
        act({
          action: 'checkpoint',
          laneId: lane.id,
          expectedHead: stale.head,
          expectedTree: stale.indexTree,
          message: 'stale',
        }),
      e => e.code === 'LANE_STALE',
    );
    const first = checkpoint(lane.id, 'Source edit and binary'),
      second = act({ action: 'lane', intentId: f.intent.id, name: 'Two' });
    const secondPath = w.store.path(second.id);
    writeFileSync(join(secondPath, 'README.md'), '# Other Lane\n');
    checkpoint(second.id, 'Independent edit');
    const view = compose([lane.id, second.id]);
    assert.equal(view.status, 'clean');
    const source = new NativeSource(root),
      files = source.state(view.head).files;
    assert.equal(files.length, 6);
    assert.ok(files.some(x => x.path === 'execute.sh' && x.mode === 'executable'));
    assert.ok(!files.some(x => x.path.includes('.env') || x.path.startsWith('ignored/')));
    const statePath = join(f.dir, 'clean-view');
    source.materialize(view.head, statePath, false);
    assert.deepEqual(readFileSync(join(statePath, 'nested', 'bytes.bin')), Buffer.from([0, 255, 128, 10]));
    assert.equal(readFileSync(join(statePath, 'a.ts'), 'utf8'), 'export const a=2;\n');
    assert.equal(readFileSync(join(statePath, 'README.md'), 'utf8'), '# Other Lane\n');
    const check = act({
      action: 'define-check',
      name: 'Actual Node source check',
      executable: process.execPath,
      artifactPaths: ['result.bin'],
      args: [
        '-e',
        "const fs=require('node:fs');if(!fs.readFileSync('a.ts','utf8').includes('a=2'))process.exit(3);fs.writeFileSync('result.bin',Buffer.from([0,255]));console.log('actual native command')",
      ],
    });
    const environment = w.status().environment;
    const command = {
      action: 'run-check',
      operationId: randomUUID(),
      viewId: view.id,
      expectedHead: view.head,
      checkId: check.id,
      expectedDefinition: check.definition,
      expectedEnvironment: environment.fingerprint,
    };
    await w.dispatch(command, w.status().revision);
    for (let attempt = 0; attempt < 300 && w.status().runs[0].status !== 'passed'; attempt++)
      await new Promise(r => setTimeout(r, 20));
    assert.equal(w.status().runs[0].status, 'passed');
    await w.dispatch(command, 0);
    assert.equal(w.status().runs.length, 1);
    const acceptance = {
      action: 'accept-channel',
      operationId: randomUUID(),
      channel: 'main',
      viewId: view.id,
      expectedHead: view.head,
      expectedPrevious: null,
    };
    const accepted = act(acceptance);
    assert.equal(accepted.status, 'accepted');
    const started = act({
      action: 'intent',
      outcome: 'Start from accepted native State',
      baseChannel: { name: 'main', head: view.head, acceptanceId: accepted.id },
    });
    assert.equal(started.base, view.head);
    renameSync(join(path, 'later.ts'), join(path, 'renamed.ts'));
    rmSync(join(path, 'execute.sh'));
    checkpoint(lane.id, 'Rename and delete');
    // A View of only this Lane would drop the other Lane's accepted README.
    const partial = compose([lane.id]);
    assert.throws(
      () =>
        act({
          ...acceptance,
          operationId: randomUUID(),
          viewId: partial.id,
          expectedHead: partial.head,
          expectedPrevious: view.head,
        }),
      e => e.code === 'CHANNEL_DIVERGED',
    );
    const newer = act({
      action: 'compose',
      operationId: randomUUID(),
      intentId: f.intent.id,
      inputs: [{ laneId: lane.id, head: w.status().lanes.find(x => x.id === lane.id).head }],
      dependencies: [{ kind: 'view', viewId: view.id, head: view.head }],
    });
    const advanced = act({
      ...acceptance,
      operationId: randomUUID(),
      viewId: newer.id,
      expectedHead: newer.head,
      expectedPrevious: view.head,
    });
    assert.equal(w.execute(acceptance, 0).result.id, accepted.id);
    assert.equal(w.status().channels[0].moveId, advanced.id);
    assert.throws(
      () => act({ ...acceptance, operationId: randomUUID() }),
      e => e.code === 'CHANNEL_CHANGED',
    );
    const rollback = act({ ...acceptance, operationId: randomUUID(), expectedPrevious: newer.head });
    assert.equal(w.status().channels[0].moveId, rollback.id);
    const backup = (await w.dispatch({ action: 'export-work', archive: true }, w.status().revision)).result;
    const target = join(f.dir, 'restored');
    await restoreNativeWork(backup.archive.path, target);
    const restored = new WorkService(target);
    assert.equal(restored.status().channels[0].moveId, rollback.id);
    assert.equal(restored.status().runs[0].status, 'passed');
    assert.equal(restored.status().intents.length, 2);
    assert.ok(existsSync(join(restored.store.path(lane.id), 'renamed.ts')));
    assert.equal(existsSync(join(restored.store.path(lane.id), 'execute.sh')), false);
    assert.equal(existsSync(join(target, '.env')), false);
    assert.equal(existsSync(join(target, '.git')), false);
    await assert.rejects(
      restoreNativeWork(backup.archive.path, target),
      e => e.code === 'RESTORE_TARGET_EXISTS',
    );
    assert.equal(new NativeSource(target).state(first.head).message, 'Source edit and binary');
    const originalArtifact = join(
      w.store.directory,
      'check-' + w.status().runs[0].id,
      'artifacts',
      'artifact-0.bin',
    );
    writeFileSync(originalArtifact, 'changed');
    const incomplete = (await w.dispatch({ action: 'export-work', archive: true }, w.status().revision))
      .result;
    assert.equal(incomplete.unavailable.length, 1);
    const incompleteRestore = await restoreNativeWork(
      incomplete.archive.path,
      join(f.dir, 'missing-artifact-restored'),
    );
    assert.equal(incompleteRestore.unavailable.length, 1);
    const server = await serveRepository(restored.store.path(lane.id), 0);
    t.after(() => server.close());
    const url = new URL(server.url),
      token = new URLSearchParams(url.hash.slice(1)).get('token');
    const response = await fetch(url.origin + '/api/work', { headers: { Authorization: `Bearer ${token}` } });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).capabilities.nativeSource, true);
    assert.equal((await fetch(url.origin + '/api/work')).status, 401);
    const cli = JSON.parse(
      execFileSync(process.execPath, ['dist/cli.js', 'work', target], { encoding: 'utf8' }),
    );
    assert.equal(cli.head, f.initialized.head);
    assert.equal(cli.counts.lanes, restored.store.load().lanes.length);
    assert.equal(existsSync(called), false);
  },
);
test('native conflicts, undo, invalid source and interrupted metadata retain original work', t => {
  const f = fixture(t),
    { w, act, path, checkpoint, compose } = f;
  writeFileSync(join(path, 'a.ts'), 'export const a=2;');
  checkpoint(f.lane.id, 'Two');
  const other = act({ action: 'lane', intentId: f.intent.id, name: 'Conflict' });
  writeFileSync(join(w.store.path(other.id), 'a.ts'), 'export const a=3;');
  checkpoint(other.id, 'Three');
  const conflict = compose([f.lane.id, other.id]);
  assert.equal(conflict.status, 'conflict');
  assert.equal(conflict.head, undefined);
  assert.match(conflict.details, /a.ts/);
  const resolved = act({
    action: 'resolve-native-view',
    operationId: randomUUID(),
    viewId: conflict.id,
    laneId: f.lane.id,
    expectedHead: w.status().lanes[0].head,
  });
  assert.equal(resolved.status, 'clean');
  assert.equal(
    new NativeSource(f.root).ancestors(resolved.head).has(w.status().lanes.find(x => x.id === other.id).head),
    true,
  );
  const undo = act({ action: 'undo', laneId: f.lane.id, expectedHead: w.status().lanes[0].head });
  assert.equal(readFileSync(join(w.store.path(undo.id), 'a.ts'), 'utf8'), 'export const a=1;\n');
  assert.equal(readFileSync(join(path, 'a.ts'), 'utf8'), 'export const a=2;');
  symlinkSync('/etc/passwd', join(path, 'link'));
  assert.match(w.status().lanes.find(lane => lane.id === f.lane.id).changes, /link/);
  assert.equal(new NativeSource(f.root).capture(path).find(file => file.path === 'link').mode, 'symlink');
  rmSync(join(path, 'link'));
  const source = new NativeSource(f.root),
    head = w.status().lanes[0].head;
  writeFileSync(join(source.directory, head), 'changed');
  assert.throws(
    () => source.state(head),
    e => e.code === 'INVALID_NATIVE_SOURCE',
  );
  assert.equal(readFileSync(join(path, 'a.ts'), 'utf8'), 'export const a=2;');
  assert.equal(existsSync(f.called), false);
});
test('interrupted native initialization and checkpoint save reconcile without changing original States', t => {
  const dir = mkdtempSync(join(tmpdir(), 'forge-native-crash-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const wroot = join(dir, 'owner');
  mkdirSync(wroot);
  writeFileSync(join(wroot, 'a.ts'), 'export const a=1;');
  const storePrototype = WorkStore.prototype,
    save = storePrototype.save;
  storePrototype.save = function () {
    throw Error('lost initial save');
  };
  try {
    assert.throws(() => initNative(wroot), /lost initial save/);
  } finally {
    storePrototype.save = save;
  }
  const initial = initNative(wroot);
  assert.equal(initNative(wroot).head, initial.head);
  const w = new WorkService(wroot),
    intent = w.execute({ action: 'intent', outcome: 'Recover native work' }, w.status().revision).result,
    lane = w.execute({ action: 'lane', intentId: intent.id, name: 'Edit' }, w.status().revision).result;
  writeFileSync(join(w.store.path(lane.id), 'a.ts'), 'export const a=2;');
  const selected = w.status().lanes[0],
    command = {
      action: 'checkpoint',
      laneId: lane.id,
      expectedHead: selected.head,
      expectedTree: selected.indexTree,
      message: 'Checkpoint recovery',
    };
  const commit = storePrototype.commitRecords;
  storePrototype.commitRecords = function (data) {
    commit.call(this, data);
    throw Error('lost committed save');
  };
  try {
    assert.throws(() => w.execute(command, w.status().revision), /lost committed save/);
  } finally {
    storePrototype.commitRecords = commit;
  }
  assert.equal(new WorkService(wroot).status().lanes[0].checkpoints.length, 1);
  assert.throws(
    () => w.execute(command, w.status().revision),
    e => e.code === 'LANE_STALE',
  );
  assert.equal(new NativeSource(wroot).state(initial.head).parents.length, 0);
});
test('native restore preserves original journal bytes when no command outcome changes', async t => {
  const { w, dir, called } = fixture(t),
    path = join(w.store.directory, 'work.json');
  const raw = JSON.parse(readWorkBytes(path, 'utf8'));
  raw.intents[0] = { notes: raw.intents[0].notes, ...raw.intents[0] };
  raw.futureEvidence = { provenance: 'Uninterpreted retained metadata' };
  const bytes = Buffer.from(JSON.stringify(raw, null, 2) + '\n');
  writeFileSync(path, bytes);
  const archive = (await w.dispatch({ action: 'export-work', archive: true }, w.store.load().revision))
    .result;
  const target = join(dir, 'byte-exact-restored');
  await restoreNativeWork(archive.archive.path, target);
  assert.deepEqual(readWorkBytes(join(target, '.forge/work/work.json')), bytes);
  assert.equal(new WorkService(target).status().intents[0].outcome, raw.intents[0].outcome);
  assert.equal(existsSync(called), false);
});

test('native linked planning reconciles versions and survives private export/restore without Git', async t => {
  const { w, act, root, dir, intent, lane, path, called } = fixture(t);
  writeFileSync(join(path, 'a.ts'), 'unfinished native Lane');
  const before = w.status(),
    dispatch = (command, revision = w.store.load().revision) => w.dispatch(command, revision);
  const item = patch => ({
    action: 'put-planning-item',
    operationId: randomUUID(),
    itemId: randomUUID(),
    kind: 'issue',
    title: 'Native planning',
    intentIds: [intent.id],
    ...patch,
  });
  assert.equal(before.capabilities.planning, true);
  const parent = (await dispatch(item({ kind: 'initiative' }))).result,
    command = item({ initiativeId: parent.id, body: 'Original Unicode details é' });
  const save = w.store.commitRecords.bind(w.store);
  w.store.commitRecords = data => {
    save(data);
    throw Error('Lost planning reply');
  };
  await assert.rejects(dispatch(command), /Lost planning reply/);
  w.store.commitRecords = save;
  const first = (await dispatch(command, 0)).result;
  const update = {
    ...command,
    operationId: randomUUID(),
    expectedVersion: 1,
    status: 'closed',
    body: 'Retained later version',
  };
  await dispatch(update);
  assert.equal((await dispatch(command, 0)).result.version, 1);
  await assert.rejects(
    dispatch({ ...update, operationId: randomUUID() }),
    e => e.code === 'PLANNING_CHANGED',
  );
  await assert.rejects(
    dispatch({ ...command, body: 'Different original request' }, 0),
    e => e.code === 'WORK_OPERATION_CHANGED',
  );
  await assert.rejects(dispatch(item({ intentIds: [randomUUID()] })), e => e.code === 'NOT_FOUND');
  await assert.rejects(dispatch(item({ initiativeId: first.id })), e => e.code === 'NOT_FOUND');
  const comment = {
    action: 'comment-planning-item',
    operationId: randomUUID(),
    itemId: first.id,
    text: 'Closed items retain discussion',
  };
  await dispatch(comment);
  await dispatch(comment, 0);
  assert.equal(w.store.load().planningComments.length, 1);
  const exported = (await dispatch({ action: 'export-planning' }, 0)).result,
    manifest = JSON.parse(exported.json);
  assert.equal(manifest.items.length, 3);
  assert.equal(manifest.items[1].body, command.body);
  assert.equal(manifest.comments[0].text, comment.text);
  assert.equal(manifest.linkedIntents[0].id, intent.id);
  assert.match(manifest.coverage, /no source objects/);
  const after = w.status();
  assert.deepEqual(after.channels, before.channels);
  assert.deepEqual(after.runs, before.runs);
  assert.equal(after.nativeHead, before.nativeHead);
  assert.equal(after.lanes[0].head, lane.head);
  assert.equal(readFileSync(join(path, 'a.ts'), 'utf8'), 'unfinished native Lane');
  const server = await serveRepository(root, 0);
  t.after(() => server.close());
  const url = new URL(server.url),
    token = new URLSearchParams(url.hash.slice(1)).get('token');
  assert.equal(
    (
      await fetch(url.origin + '/api/work', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ command: { action: 'export-planning' }, revision: 0 }),
      })
    ).status,
    401,
  );
  const response = await fetch(url.origin + '/api/work', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ command: { action: 'export-planning' }, revision: 0 }),
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).result.sha256, exported.sha256);
  const archive = (await dispatch({ action: 'export-work', archive: true })).result,
    target = join(dir, 'planning-restored');
  await restoreNativeWork(archive.archive.path, target);
  const restored = new WorkService(target);
  assert.equal((await restored.dispatch({ action: 'export-planning' }, 0)).result.sha256, exported.sha256);
  assert.equal(restored.status().capabilities.planning, true);
  assert.equal(existsSync(join(target, '.git')), false);
  assert.equal(existsSync(called), false);
  assert.equal(
    act({ action: 'intent', outcome: 'Planning did not block native source work' }).base,
    before.nativeHead,
  );
});

test(
  'native releases restore exact accepted source and ancestry without private Work or Git',
  { timeout: 120000 },
  async t => {
    const { w, act, root, dir, intent, lane, path, checkpoint, compose, called, initialized } = fixture(t);
    const dispatch = (command, revision = w.status().revision) => w.dispatch(command, revision);
    const privateNote = 'PRIVATE_INTENT_NOTE_NOT_RELEASE_SOURCE',
      privatePlan = 'PRIVATE_PLANNING_NOT_RELEASE_SOURCE',
      privateLog = 'PRIVATE_RUN_LOG_NOT_RELEASE_SOURCE';
    writeFileSync(join(path, 'a.ts'), 'export const a=2;\n');
    mkdirSync(join(path, 'nested'));
    const binary = Buffer.from([0, 255, 128, 10]);
    writeFileSync(join(path, 'nested', 'payload.bin'), binary);
    writeFileSync(join(path, 'execute.sh'), '#!/bin/sh\nexit 0\n');
    chmodSync(join(path, 'execute.sh'), 0o700);
    const checkpointed = checkpoint(lane.id, 'Accepted source bytes'),
      view = compose([lane.id]);
    assert.equal(view.status, 'clean');
    assert.equal(view.head, checkpointed.head);
    act({ action: 'note', intentId: intent.id, kind: 'decision', text: privateNote });
    await dispatch({
      action: 'put-planning-item',
      operationId: randomUUID(),
      itemId: randomUUID(),
      kind: 'issue',
      title: privatePlan,
      body: privatePlan,
      intentIds: [intent.id],
    });
    const check = act({
      action: 'define-check',
      name: 'Private release preparation',
      executable: process.execPath,
      args: ['-e', `console.log('${privateLog}');`],
    });
    const runId = randomUUID();
    await dispatch({
      action: 'run-check',
      operationId: runId,
      viewId: view.id,
      expectedHead: view.head,
      checkId: check.id,
      expectedDefinition: check.definition,
      expectedEnvironment: w.status().environment.fingerprint,
    });
    for (let attempt = 0; attempt < 300 && w.status().runs[0].status !== 'passed'; attempt++)
      await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(w.status().runs[0].status, 'passed');
    assert.match(
      readFileSync(join(w.store.directory, `check-${runId}`, 'stdout.log'), 'utf8'),
      new RegExp(privateLog),
    );
    const acceptance = act({
      action: 'accept-channel',
      operationId: randomUUID(),
      channel: 'main',
      viewId: view.id,
      expectedHead: view.head,
      expectedPrevious: null,
    });
    assert.equal(w.status().capabilities.releases, true);
    const command = {
      action: 'create-release',
      operationId: randomUUID(),
      acceptanceId: acceptance.id,
      expectedHead: view.head,
      name: 'Original native source',
      notes: 'Selected release notes',
    };
    const release = (await dispatch(command)).result;
    assert.equal(release.acceptance.head, view.head);
    assert.equal(release.acceptance.id, acceptance.id);
    assert.equal(release.buildRuns, undefined);

    writeFileSync(join(path, 'a.ts'), 'export const a=999;\n');
    writeFileSync(join(path, 'later-only.ts'), 'export const later=true;\n');
    checkpoint(lane.id, 'Later source is independent');
    const later = compose([lane.id]);
    const current = act({
      action: 'accept-channel',
      operationId: randomUUID(),
      channel: 'main',
      viewId: later.id,
      expectedHead: later.head,
      expectedPrevious: view.head,
    });
    assert.equal(w.status().channels[0].moveId, current.id);
    assert.deepEqual((await dispatch(command, 0)).result, release);
    assert.equal(w.status().releases.length, 1);
    await assert.rejects(
      dispatch({ ...command, notes: 'Changed original release' }, 0),
      error => error.code === 'WORK_OPERATION_CHANGED',
    );
    await assert.rejects(
      dispatch({ ...command, operationId: randomUUID(), expectedHead: later.head }),
      error => error.code === 'NOT_FOUND',
    );

    const before = w.store.load(),
      exported = (await dispatch({ action: 'export-release', id: release.id }, 0)).result;
    assert.equal(exported.bundle.kind, 'forge-native-work-backup');
    assert.equal(exported.bundle.head, view.head);
    assert.equal(exported.bundle.viewId, view.id);
    assert.equal(exported.bundle.channel, 'main');
    const portable = JSON.parse(exported.json);
    assert.equal(portable.artifact.kind, 'forge-native-work-backup');
    assert.equal(portable.artifact.head, view.head);
    assert.equal(portable.release.acceptance.id, acceptance.id);
    assert.equal(portable.buildArtifacts, undefined);
    const archiveBytes = gunzipSync(readFileSync(exported.bundle.path));
    for (const marker of [privateNote, privatePlan, privateLog])
      assert.equal(
        archiveBytes.includes(Buffer.from(marker)),
        false,
        `${marker} must remain outside the source archive`,
      );
    const manifest = JSON.parse(
      execFileSync('tar', ['-xzOf', exported.bundle.path, '--', 'manifest.json'], { encoding: 'utf8' }),
    );
    assert.equal(manifest.head, view.head);
    assert.equal(manifest.revision, 0);
    assert.deepEqual(manifest.unavailable, []);
    assert.ok(
      manifest.files.every(file => file.path === 'work.json' || /^objects\/[0-9a-f]{64}$/.test(file.path)),
    );
    const archivedWork = JSON.parse(
      execFileSync('tar', ['-xzOf', exported.bundle.path, '--', 'work.json'], { encoding: 'utf8' }),
    );
    assert.equal(archivedWork.nativeHead, view.head);
    assert.equal(archivedWork.revision, 0);
    for (const [name, value] of Object.entries(archivedWork))
      if (Array.isArray(value)) assert.deepEqual(value, [], `${name} must restore empty`);

    const target = join(dir, 'native-source-release-restored');
    await restoreNativeWork(exported.bundle.path, target);
    const restored = new WorkService(target),
      source = new NativeSource(root),
      restoredSource = new NativeSource(target),
      state = source.state(view.head);
    assert.equal(restored.status().nativeHead, view.head);
    assert.equal(restored.status().intents.length, 0);
    assert.equal(restored.status().lanes.length, 0);
    assert.equal(restored.status().runs.length, 0);
    assert.equal(restored.status().planningItems.length, 0);
    assert.equal(restored.status().channels.length, 0);
    assert.deepEqual(
      [...restoredSource.ancestors(view.head)].sort(),
      [...source.ancestors(view.head)].sort(),
    );
    assert.ok(restoredSource.ancestors(view.head).has(initialized.head));
    for (const id of source.ancestors(view.head)) {
      assert.deepEqual(restoredSource.object(id), source.object(id));
      for (const file of source.state(id).files)
        assert.deepEqual(restoredSource.object(file.blob), source.object(file.blob));
    }
    assert.deepEqual(restoredSource.capture(target, false, view.head), state.files);
    assert.equal(readFileSync(join(target, 'a.ts'), 'utf8'), 'export const a=2;\n');
    assert.deepEqual(readFileSync(join(target, 'nested', 'payload.bin')), binary);
    assert.equal(existsSync(join(target, 'later-only.ts')), false);
    assert.equal(existsSync(join(restoredSource.directory, later.head)), false);
    assert.equal(existsSync(join(target, '.env')), false);
    assert.equal(existsSync(join(target, '.git')), false);
    assert.deepEqual(w.store.load(), before);
    assert.equal(w.status().channels[0].moveId, current.id);
    assert.equal(readFileSync(join(path, 'a.ts'), 'utf8'), 'export const a=999;\n');
    assert.equal(existsSync(called), false);
  },
);
