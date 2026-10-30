import { currentOwnerDisplay } from './project-exchange-fixture.mjs';
// SPDX-License-Identifier: Apache-2.0
import { readWorkBytes } from './work-store-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { LegacyWorkService as WorkService } from './autonomy-fixture.mjs';
import { initLegacyNative as initNative } from './autonomy-fixture.mjs';
import { NativeSource } from '../dist/native-source.js';
import { restoreNativeWork } from '../dist/native-backup.js';
import { restoreWork } from '../dist/work-backup.js';
import { withWorkArchive } from '../dist/work-backup-archive.js';
import { parseWork } from '../dist/work-unified-types.js';
import { parseWorkBytes, workBytes } from '../dist/work-metadata.js';
import { digest } from '../dist/hash.js';
import { serveRepository } from '../dist/http.js';
import { fixture, git, code } from './helpers.mjs';
import { z } from 'zod';
import { execFileSync } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { metadataRequest } from '../dist/work-metadata.js';
import { readHosted } from './hosted-read.mjs';

async function setup(t, runCheck = true) {
  const original = fixture(t, { '.gitignore': '.forge/\n', 'a.ts': 'export const a=1;\n' });
  git(original, ['add', '.']);
  git(original, ['commit', '-qm', 'Original source']);
  const old = new WorkService(original),
    act = c => old.execute(c, old.store.load().revision).result;
  const intent = act({ action: 'intent', outcome: 'Original Git Intent' }),
    lane = act({ action: 'lane', intentId: intent.id, name: 'Original unfinished Lane' });
  const view = act({
      action: 'compose',
      intentId: intent.id,
      inputs: [{ laneId: lane.id, head: lane.head }],
    }),
    check = act({
      action: 'define-check',
      name: 'Historical observation',
      executable: process.execPath,
      args: ['-e', 'console.log("original bytes")'],
    });
  let run;
  if (runCheck) {
    run = (
      await old.dispatch(
        {
          action: 'run-check',
          operationId: randomUUID(),
          viewId: view.id,
          expectedHead: view.head,
          checkId: check.id,
          expectedDefinition: check.definition,
          expectedEnvironment: old.status().environment.fingerprint,
        },
        old.store.load().revision,
      )
    ).result;
    for (let n = 0; n < 1500; n++) {
      old.status();
      if (old.store.load().runs[0].endedAt) break;
      await new Promise(r => setTimeout(r, 20));
    }
    assert.equal(old.store.load().runs[0].status, 'passed');
  }
  act({
    action: 'review-view',
    viewId: view.id,
    expectedHead: view.head,
    reviewer: 'Original label',
    decision: 'approve',
  });
  const oldAccept = (
    await old.dispatch(
      {
        action: 'accept-channel',
        operationId: randomUUID(),
        channel: 'main',
        viewId: view.id,
        expectedHead: view.head,
        expectedPrevious: null,
      },
      old.store.load().revision,
    )
  ).result;
  const originalData = old.store.load(),
    at = new Date().toISOString(),
    projectKey = randomUUID(),
    eventCommand = {
      action: 'note',
      intentId: intent.id,
      kind: 'comment',
      text: 'Original hosted provenance',
    };
  originalData.publications.push({
    id: randomUUID(),
    viewId: view.id,
    head: view.head,
    repository: 'example/original',
    base: 'main',
    title: 'Original provider record',
    draft: false,
    at,
    status: 'published',
    number: 7,
    url: 'https://github.com/example/original/pull/7',
  });
  originalData.mirrors.push({
    id: randomUUID(),
    request: 'a'.repeat(64),
    acceptance: oldAccept,
    repository: 'example/original',
    repositoryId: 1,
    ref: 'refs/heads/original',
    at,
    observationSequence: 1,
  });
  originalData.hostedEvents.push({
    id: randomUUID(),
    projectKey,
    archiveSha256: 'b'.repeat(64),
    actor: 'original-owner',
    at,
    request: metadataRequest(eventCommand),
    previousRevision: originalData.revision,
    command: eventCommand,
  });
  originalData.hostedChannelMoves = [
    {
      id: randomUUID(),
      projectKey,
      actor: 'original-owner',
      at,
      provenance: 'signed-in-owner-selection',
      channel: 'main',
      acceptanceId: oldAccept.id,
      viewId: view.id,
      head: view.head,
      previousId: null,
      archiveSha256: 'b'.repeat(64),
    },
  ];
  old.store.save(originalData);
  writeFileSync(join(old.store.path(lane.id), 'a.ts'), 'unfinished original edit\n');
  const exported = (await old.dispatch({ action: 'export-work', archive: true }, old.store.load().revision))
      .result,
    archive = readFileSync(exported.archive.path),
    originalWork = readWorkBytes(join(old.store.directory, 'work.json'));
  const dir = mkdtempSync(join(tmpdir(), 'forge-historical-'));
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  const root = join(dir, 'native');
  mkdirSync(root);
  writeFileSync(join(root, 'a.ts'), 'export const a=2;\n');
  initNative(root);
  const w = new WorkService(root),
    data = () => w.store.load(),
    doIt = c => w.execute(c, data().revision).result,
    call = (c, revision = data().revision) => w.dispatch(c, revision),
    i = doIt({ action: 'intent', outcome: 'Native continuation' }),
    l = doIt({ action: 'lane', intentId: i.id, name: 'Native candidate' }),
    v = doIt({ action: 'compose', intentId: i.id, inputs: [{ laneId: l.id, head: l.head }] }),
    accepted = (
      await call({
        action: 'accept-channel',
        operationId: randomUUID(),
        channel: 'main',
        viewId: v.id,
        expectedHead: v.head,
        expectedPrevious: null,
      })
    ).result;
  const command = {
    action: 'import-work-history',
    operationId: randomUUID(),
    path: exported.archive.path,
    sha256: digest(archive),
    name: 'Original Git Work',
    acceptanceId: accepted.id,
    expectedHead: accepted.head,
  };
  return {
    original,
    old,
    intent,
    lane,
    view,
    check,
    run,
    oldAccept,
    archive,
    originalWork,
    dir,
    root,
    w,
    data,
    doIt,
    call,
    accepted,
    command,
  };
}

test('historical import retains exact original Git owner and reconciles lost replies without source/execution changes', async t => {
  const f = await setup(t),
    before = f.data(),
    save = f.w.store.save.bind(f.w.store);
  f.w.store.save = data => {
    save(data);
    throw Error('Lost attachment reply');
  };
  await assert.rejects(f.call(f.command), /Lost attachment reply/);
  f.w.store.save = save;
  const record = (await f.call(f.command, 0)).result;
  assert.equal(f.data().schema, 24);
  assert.equal(f.data().historicalWork.length, 1);
  assert.equal(record.archive.sha256, digest(f.archive));
  assert.equal(f.data().runs.length, 0);
  assert.deepEqual(f.data().channelMoves, before.channelMoves);
  assert.deepEqual(readWorkBytes(join(f.old.store.directory, 'work.json')), f.originalWork);
  assert.equal(readFileSync(join(f.old.store.path(f.lane.id), 'a.ts'), 'utf8'), 'unfinished original edit\n');
  await assert.rejects(
    f.call({ ...f.command, name: 'Different mapping' }, 0),
    code('WORK_OPERATION_CHANGED'),
  );
  f.doIt({
    action: 'note',
    intentId: f.data().intents[0].id,
    kind: 'decision',
    text: 'Continue native Work',
  });
  assert.equal(f.data().schema, 24);
  assert.equal((await f.call(f.command, 0)).result.id, record.id);
  const bytes = readWorkBytes(join(f.w.store.directory, 'work.json'));
  const legacy = z.object({ schema: z.literal(1) });
  assert.equal(legacy.safeParse(JSON.parse(bytes)).success, false);
  assert.deepEqual(readWorkBytes(join(f.w.store.directory, 'work.json')), bytes);
  await assert.rejects(
    f.call({ ...f.command, operationId: randomUUID(), sha256: '0'.repeat(64) }),
    code('INVALID_WORK_BACKUP'),
  );
  assert.equal(f.data().historicalWork.length, 1);
  const second = { ...f.command, operationId: randomUUID(), name: 'Explicit second attachment' },
    revision = f.data().revision,
    beforeSave = readWorkBytes(join(f.w.store.directory, 'work.json'));
  f.w.store.save = () => {
    throw Error('Interrupted before metadata commit');
  };
  await assert.rejects(f.call(second), /Interrupted before/);
  f.w.store.save = save;
  assert.deepEqual(readWorkBytes(join(f.w.store.directory, 'work.json')), beforeSave);
  const retried = (await f.call(second, revision)).result;
  assert.equal(retried.id, second.operationId);
  assert.equal(f.data().historicalWork.length, 2);
});

test('fresh Git-free native restore reads original records/evidence and exports byte-identical history; source release omits it', async t => {
  const f = await setup(t),
    record = (await f.call(f.command)).result,
    source = new NativeSource(f.root);
  const backup = (await f.call({ action: 'export-work', archive: true })).result;
  const release = (
    await f.call({
      action: 'create-release',
      operationId: randomUUID(),
      name: 'Source only',
      acceptanceId: f.accepted.id,
      expectedHead: f.accepted.head,
    })
  ).result;
  const publicSource = (await f.call({ action: 'export-release', id: release.id })).result;
  await withWorkArchive(publicSource.bundle.path, async directory => {
    const publicManifest = JSON.parse(readFileSync(join(directory, 'manifest.json')));
    assert.equal(
      publicManifest.files.some(x => x.path === 'objects/' + record.archive.sha256),
      false,
    );
  });
  const shim = join(f.dir, 'bin'),
    marker = join(f.dir, 'git-used');
  mkdirSync(shim);
  writeFileSync(join(shim, 'git'), `#!/bin/sh\necho used > '${marker}'\nexit 97\n`, { mode: 0o700 });
  const previous = process.env.PATH;
  process.env.PATH = shim + ':' + previous;
  t.after(() => {
    process.env.PATH = previous;
    assert.equal(existsSync(marker), false);
  });
  const target = join(f.dir, 'restored');
  await restoreNativeWork(backup.archive.path, target);
  const restored = new WorkService(target),
    call = c => restored.dispatch(c, 0);
  for (const [collection, id] of [
    ['intents', f.intent.id],
    ['lanes', f.lane.id],
    ['views', f.view.id],
    ['runs', f.run.id],
    ['reviews', f.old.store.load().reviews[0].id],
    ['channelMoves', f.oldAccept.id],
  ]) {
    const result = (
      await call({ action: 'read-work-history-record', id: record.id, collection, recordId: id })
    ).result;
    assert.equal(result.record.id, id);
    assert.equal(result.provenance.original.workSha256, digest(f.originalWork));
  }
  for (const collection of ['publications', 'mirrors', 'hostedEvents', 'hostedChannelMoves']) {
    const original = f.old.store.load()[collection][0];
    assert.deepEqual(
      (await call({ action: 'read-work-history-record', id: record.id, collection, recordId: original.id }))
        .result.record,
      original,
    );
  }
  await withWorkArchive(backup.archive.path, async directory => {
    const manifestPath = join(directory, 'manifest.json'),
      manifest = JSON.parse(readFileSync(manifestPath));
    manifest.files = manifest.files.filter(file => file.path !== 'objects/' + record.archive.sha256);
    rmSync(join(directory, 'objects', record.archive.sha256));
    writeFileSync(manifestPath, JSON.stringify(manifest));
    const target = join(f.dir, 'missing-history');
    await assert.rejects(restoreNativeWork(directory, target), code('INVALID_NATIVE_SOURCE'));
    assert.equal(existsSync(target), false);
  });
  const path = 'check-' + f.run.id + '/stdout.log',
    file = (await call({ action: 'read-work-history-file', id: record.id, path })).result;
  const first = (await call({ action: 'list-work-history-files', id: record.id, limit: 1 })).result,
    remaining = (
      await call({ action: 'list-work-history-files', id: record.id, offset: first.nextOffset, limit: 200 })
    ).result;
  assert.equal(first.files.length, 1);
  assert.equal(first.files.length + remaining.files.length, first.total);
  assert.equal(
    [...first.files, ...remaining.files].some(item => item.path === path),
    false,
  );
  assert.equal(file.status, 'local-only');
  const resultPath = 'check-' + f.run.id + '/result.json';
  const result = (await call({ action: 'read-work-history-file', id: record.id, path: resultPath })).result;
  assert.deepEqual(Buffer.from(result.data, 'base64'), readFileSync(join(f.old.store.directory, resultPath)));
  const exported = (await call({ action: 'export-work-history', id: record.id })).result;
  assert.deepEqual(readFileSync(exported.path), f.archive);
  assert.equal(restored.store.load().runs.length, 0);
  const stored = join(source.directory, record.archive.sha256);
  writeFileSync(stored, Buffer.from('changed'));
  await assert.rejects(f.call({ action: 'export-work', archive: true }), code('INVALID_NATIVE_SOURCE'));
  writeFileSync(stored, f.archive, { mode: 0o600 });
  await assert.rejects(
    call({ action: 'read-work-history-file', id: record.id, path: '../../outside' }),
    code('NOT_FOUND'),
  );
  // Explicit legacy restoration is a separate Git boundary.
  process.env.PATH = previous;
  const gitTarget = join(f.dir, 'original-restored');
  await restoreWork(exported.path, gitTarget);
  const original = new WorkService(gitTarget);
  assert.deepEqual(readWorkBytes(join(original.store.directory, 'work.json')), f.originalWork);
});

test('historical Work remains absent from ordinary current-format serialization and protected HTTP reads use the same owner', async t => {
  const f = await setup(t, false),
    legacy = workBytes(parseWorkBytes(f.originalWork));
  assert.equal('historicalWork' in JSON.parse(legacy), false);
  assert.equal(parseWork(JSON.parse(legacy)).schema, 24);
  const record = (await f.call(f.command)).result,
    server = await serveRepository(f.root, 0);
  t.after(() => server.close());
  const url = new URL(server.url),
    token = new URLSearchParams(url.hash.slice(1)).get('token'),
    command = {
      action: 'read-work-history-record',
      id: record.id,
      collection: 'intents',
      recordId: f.intent.id,
    };
  assert.equal(
    (
      await fetch(url.origin + '/api/work', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ revision: 0, command }),
      })
    ).status,
    401,
  );
  const response = await fetch(url.origin + '/api/work', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ revision: 0, command }),
  });
  assert.equal(response.status, 200);
  const expected = await response.json();
  assert.equal(expected.result.record.id, f.intent.id);
  assert.deepEqual(
    JSON.parse(
      execFileSync(process.execPath, [resolve('dist/cli.js'), 'work', f.root, JSON.stringify(command), '0'], {
        encoding: 'utf8',
      }),
    ),
    expected,
  );
  const transport = new StdioClientTransport({
      command: process.execPath,
      args: [resolve('dist/cli.js'), 'mcp', f.root, '--work'],
      env: Object.fromEntries(Object.entries(process.env).filter(([, value]) => value !== undefined)),
      stderr: 'pipe',
    }),
    client = new Client({ name: 'historical-acceptance', version: '1' });
  await client.connect(transport);
  t.after(() => client.close());
  const mcp = await client.callTool({ name: 'forge_work_command', arguments: { command, revision: 0 } });
  assert.deepEqual(JSON.parse(mcp.content[0].text), expected);
});
