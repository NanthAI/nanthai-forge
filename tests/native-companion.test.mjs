// SPDX-License-Identifier: Apache-2.0
import { currentOwnerDisplay } from './project-exchange-fixture.mjs';
import { readWorkBytes } from './work-store-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  existsSync,
  readdirSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { z } from 'zod';
import { getFunctionName } from 'convex/server';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { LegacyWorkService as WorkService } from './autonomy-fixture.mjs';
import { initLegacyNative as initNative } from './autonomy-fixture.mjs';
import { NativeSource } from '../dist/native-source.js';
import { restoreNativeWork } from '../dist/native-backup.js';
import { workArchiveMetadata } from '../dist/work-archive-metadata.js';
import { withWorkArchive, packWorkArchive } from '../dist/work-backup-archive.js';
import { digest } from '../dist/hash.js';
import { applyHostedEvent, parseWorkBytes, workBytes } from '../dist/work-metadata.js';
import { serveRepository } from '../dist/http.js';
import { moduleUrl } from './convex-module.mjs';
import { state } from './hosted-fixture.mjs';
import { code } from './helpers.mjs';
import { readHosted } from './hosted-read.mjs';

const actions = await import(moduleUrl('../convex/projectWorkActions.ts'));
const work = await import(moduleUrl('../convex/projectWork.ts'));
const backups = await import(moduleUrl('../convex/projectBackups.ts'));

async function setup(t) {
  const dir = mkdtempSync(join(tmpdir(), 'forge-companion-test-'));
  const resources = [];
  t.after(async () => {
    for (const resource of resources.toReversed()) await resource.close();
    for (const run of data().runs.filter(r => ['preparing', 'running'].includes(r.status)))
      await call({ action: 'cancel-check', operationId: run.id });
    for (let n = 0; n < 200 && data().runs.some(r => ['preparing', 'running'].includes(r.status)); n++)
      await new Promise(r => setTimeout(r, 20));
    process.env.PATH = prior;
    assert.equal(existsSync(marker), false, 'native companion never invokes Git');
    rmSync(dir, { recursive: true, force: true });
  });
  const root = join(dir, 'owner');
  mkdirSync(root);
  writeFileSync(join(root, 'a.ts'), 'export const a=1;\n');
  initNative(root);
  const w = new WorkService(root),
    data = () => w.store.load();
  const act = command => w.execute(command, data().revision).result;
  const call = (command, revision = data().revision) => w.dispatch(command, revision);
  const intent = act({ action: 'intent', outcome: 'Keep local and hosted Work' });
  const lane = act({ action: 'lane', intentId: intent.id, name: 'Ongoing source' });
  const view = act({
    action: 'compose',
    intentId: intent.id,
    inputs: [{ laneId: lane.id, head: lane.head }],
  });
  const acceptance = (
    await call({
      action: 'accept-channel',
      operationId: randomUUID(),
      channel: 'main',
      viewId: view.id,
      expectedHead: view.head,
      expectedPrevious: null,
    })
  ).result;
  const s = state([]),
    native = s.ctx.runQuery,
    projectId = 'project',
    projectKey = randomUUID();
  s.tables.hostedProjects = new Map();
  s.tables.projectBackups = new Map();
  s.tables.projectWorkEvents = new Map();
  s.ctx.runQuery = s.ctx.runMutation = (ref, args) => {
    const [module, name] = getFunctionName(ref).split(':');
    return (
      { projectWork: work, projectBackups: backups }[module]?.[name]?._handler(s.ctx, args) ??
      native(ref, args)
    );
  };
  s.tables.hostedProjects.set(projectId, {
    _id: projectId,
    _creationTime: 1,
    owner: 'owner',
    key: projectKey,
    name: 'Synthetic companion',
    revision: 1,
  });
  async function upload() {
    const exported = (await call({ action: 'export-work', archive: true })).result;
    const bytes = readFileSync(exported.archive.path),
      id = randomUUID();
    // Exact owner/source metadata, using the same bounded archive reader as
    // hosted source. Browser format-3 preview is covered by the GC integration.
    const metadata = await workArchiveMetadata(new Blob([bytes]));
    const manifest = JSON.parse(Buffer.from(metadata.manifest)),
      records = JSON.parse(Buffer.from(metadata.work));
    const preview = {
      manifestDigest: digest(metadata.manifest),
      head: manifest.head,
      format: 'native',
      revision: records.revision,
      intents: records.intents.length,
      lanes: records.lanes.length,
      views: records.views.length,
      runs: records.runs.length,
      files: manifest.files.length,
      unavailable: manifest.unavailable.length,
      channels: [],
    };
    s.tables.projectBackups.set(id, {
      _id: id,
      _creationTime: 1,
      projectId,
      operationId: randomUUID(),
      request: 'a'.repeat(64),
      nonce: randomUUID(),
      previous: null,
      digest: digest(bytes),
      size: bytes.length,
      preview,
      status: 'stored',
      ...(await currentOwnerDisplay(s, w.store, records, projectId)),
      storageId: id,
    });
    s.files.set(id, { blob: new Blob([bytes], { type: 'application/gzip' }) });
    return { id, exported, bytes };
  }
  const base = await upload();
  s.tables.hostedProjects.get(projectId).currentBackup = base.id;
  await actions.initialize._handler(s.ctx, { projectId, backupId: base.id, operationId: randomUUID() });
  const hosted = async command =>
    actions.command._handler(s.ctx, {
      projectId,
      operationId: randomUUID(),
      revision: JSON.parse(await readHosted(s.ctx, { projectId })).data.revision,
      command: JSON.stringify(command),
    });
  const remote = async () => JSON.parse(await readHosted(s.ctx, { projectId })).data;
  async function command(archive = base) {
    const bytes = await actions.exportJournal._handler(s.ctx, { projectId }),
      journalPath = join(dir, randomUUID() + '.json');
    writeFileSync(journalPath, bytes, { mode: 0o600 });
    return {
      action: 'reconcile-hosted-work',
      operationId: randomUUID(),
      projectKey,
      archivePath: archive.exported.archive.path,
      archiveSha256: digest(archive.bytes),
      journalPath,
      journalSha256: digest(bytes),
    };
  }
  const bin = join(dir, 'bin'),
    marker = join(dir, 'git-used');
  mkdirSync(bin);
  writeFileSync(join(bin, 'git'), '#!/bin/sh\necho used > "' + marker + '"\nexit 99\n', { mode: 0o700 });
  const prior = process.env.PATH;
  process.env.PATH = bin + ':' + prior;

  return {
    resources,
    dir,
    root,
    w,
    data,
    act,
    call,
    intent,
    lane,
    view,
    acceptance,
    s,
    projectId,
    base,
    upload,
    hosted,
    remote,
    command,
  };
}

test('lost replies retry before stale revision or missing paths; changed pins reject; concurrent digest changes are not overwritten', async t => {
  const f = await setup(t);
  await f.hosted({ action: 'note', intentId: f.intent.id, kind: 'comment', text: 'Original server record' });
  const command = await f.command(),
    save = f.w.store.save.bind(f.w.store);
  f.w.store.save = data => {
    save(data);
    throw Error('Lost reply after atomic save');
  };
  await assert.rejects(f.call(command), /Lost reply/);
  f.w.store.save = save;
  const receipt = f.data().nativeCompanionReceipts[0];
  f.act({ action: 'note', intentId: f.intent.id, kind: 'comment', text: 'Later local progress' });
  const retried = await f.call(
    { ...command, archivePath: '/missing/archive', journalPath: '/missing/journal' },
    0,
  );
  assert.deepEqual(retried.result.receipt, receipt);
  assert.equal(f.data().nativeCompanionReceipts.length, 1);
  await assert.rejects(
    f.call({ ...command, journalSha256: '0'.repeat(64) }, 0),
    code('WORK_OPERATION_CHANGED'),
  );
  const next = { ...command, operationId: randomUUID() },
    revision = f.data().revision;
  const pending = f.call(next, revision);
  const changed = f.data();
  changed.changedWithoutRevision = 'preserve concurrent bytes';
  save(changed);
  const original = readWorkBytes(join(f.w.store.directory, 'work.json'));
  await assert.rejects(pending, code('WORK_STALE'));
  assert.deepEqual(readWorkBytes(join(f.w.store.directory, 'work.json')), original);
  f.w.store.save = () => {
    throw Error('Interrupted before metadata save');
  };
  await assert.rejects(f.call(next), /Interrupted before/);
  f.w.store.save = save;
  assert.deepEqual(readWorkBytes(join(f.w.store.directory, 'work.json')), original);
  assert.equal((await f.call(next)).result.status, 'reconciled');
});

test('altered project, journal lineage, receipt and source closure fail before metadata commit', async t => {
  const f = await setup(t);
  await f.hosted({ action: 'note', intentId: f.intent.id, kind: 'comment', text: 'Original' });
  const command = await f.command(),
    path = join(f.w.store.directory, 'work.json'),
    before = readFileSync(path);
  await assert.rejects(f.call({ ...command, projectKey: randomUUID() }), code('INVALID_WORK_JOURNAL'));
  await assert.rejects(f.call({ ...command, journalSha256: '0'.repeat(64) }), code('INVALID_WORK_JOURNAL'));
  const journal = JSON.parse(readFileSync(command.journalPath));
  journal.events[0].previousRevision++;
  writeFileSync(command.journalPath, JSON.stringify(journal));
  await assert.rejects(
    f.call({ ...command, journalSha256: digest(JSON.stringify(journal)) }),
    code('INVALID_WORK_JOURNAL'),
  );
  assert.deepEqual(readFileSync(path), before);
  const otherRoot = join(f.dir, 'unrelated-owner');
  mkdirSync(otherRoot);
  writeFileSync(join(otherRoot, 'other.ts'), 'unrelated source');
  initNative(otherRoot);
  const other = new WorkService(otherRoot),
    otherPath = join(other.store.directory, 'work.json'),
    otherBefore = readFileSync(otherPath);
  const wrongBase = await other.dispatch(await f.command(), other.store.load().revision);
  assert.equal(wrongBase.result.status, 'conflict');
  assert.equal(wrongBase.result.conflicts[0].field, 'nativeHead');
  assert.deepEqual(readFileSync(otherPath), otherBefore);
  await withWorkArchive(f.base.exported.archive.path, async directory => {
    const manifest = JSON.parse(readFileSync(join(directory, 'manifest.json')));
    const blob = manifest.files.find(
      file => file.path.startsWith('objects/') && file.path !== 'objects/' + manifest.head,
    );
    const original = readFileSync(join(directory, blob.path));
    writeFileSync(join(directory, blob.path), 'altered source');
    // Even a self-consistent modified file manifest cannot replace digest-bound source.
    blob.sha256 = digest('altered source');
    blob.size = Buffer.byteLength('altered source');
    writeFileSync(join(directory, 'manifest.json'), JSON.stringify(manifest));
    const archive = await packWorkArchive(
      directory,
      manifest.files.map(file => file.path),
    );
    const goodJournal = JSON.parse(await actions.exportJournal._handler(f.s.ctx, { projectId: f.projectId }));
    goodJournal.base.archiveSha256 = archive.sha256;
    goodJournal.base.manifestSha256 = digest(readFileSync(join(directory, 'manifest.json')));
    goodJournal.events.forEach(event => {
      event.archiveSha256 = archive.sha256;
    });
    const replay = parseWorkBytes(readWorkBytes(join(directory, 'work.json')));
    for (const event of goodJournal.events) applyHostedEvent(replay, event);
    goodJournal.workSha256 = digest(workBytes(replay));
    const text = JSON.stringify(goodJournal);
    writeFileSync(command.journalPath, text);
    await assert.rejects(
      f.call({
        ...command,
        archivePath: archive.path,
        archiveSha256: archive.sha256,
        journalSha256: digest(text),
      }),
      error => ['INVALID_NATIVE_SOURCE', 'INVALID_WORK_BACKUP'].includes(error.code),
    );
    writeFileSync(join(directory, blob.path), original);
  });
  const local = f.data();
  local.hostedChannelMoves = [
    {
      id: randomUUID(),
      actor: 'altered',
      projectKey: command.projectKey,
      at: 'original',
      provenance: 'signed-in-owner-selection',
      channel: 'main',
      acceptanceId: f.acceptance.id,
      viewId: f.view.id,
      head: f.view.head,
      previousId: null,
      archiveSha256: command.archiveSha256,
    },
  ];
  f.w.store.save(local);
  const pinned = readFileSync(path),
    fresh = await f.command();
  const conflict = await f.call(fresh);
  assert.equal(conflict.result.status, 'conflict');
  assert.equal(conflict.result.conflicts[0].collection, 'hostedChannelMoves');
  assert.deepEqual(readFileSync(path), pinned);
});

test('CLI, protected HTTP and actual opt-in MCP command share operation reconciliation without Git', async t => {
  const f = await setup(t);
  await f.hosted({ action: 'note', intentId: f.intent.id, kind: 'comment', text: 'Transport parity' });
  const command = await f.command(),
    revision = f.data().revision;
  const expected = JSON.parse(
    execFileSync(
      process.execPath,
      [resolve('dist/cli.js'), 'work', f.root, JSON.stringify(command), String(revision)],
      { encoding: 'utf8' },
    ),
  );
  const server = await serveRepository(f.root, 0);
  f.resources.push(server);
  const url = new URL(server.url),
    token = new URLSearchParams(url.hash.slice(1)).get('token');
  const body = JSON.stringify({ command, revision: 0 });
  assert.equal(
    (
      await fetch(url.origin + '/api/work', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
      })
    ).status,
    401,
  );
  const response = await fetch(url.origin + '/api/work', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body,
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), expected);
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [resolve('dist/cli.js'), 'mcp', f.root, '--work'],
    env: Object.fromEntries(Object.entries(process.env).filter(([, value]) => value !== undefined)),
    stderr: 'pipe',
  });
  const client = new Client({ name: 'native-companion-acceptance', version: '1' });
  f.resources.push(client);
  await client.connect(transport);
  const result = await client.callTool({ name: 'forge_work_command', arguments: { command, revision: 0 } });
  assert.equal(result.isError, undefined);
  assert.deepEqual(JSON.parse(result.content[0].text), expected);
});
