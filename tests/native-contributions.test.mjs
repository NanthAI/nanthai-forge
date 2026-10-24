// SPDX-License-Identifier: Apache-2.0
import { readWorkBytes } from './work-store-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  existsSync,
  readdirSync,
  chmodSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { z } from 'zod';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { LegacyWorkService as WorkService } from './autonomy-fixture.mjs';
import { initLegacyNative as initNative } from './autonomy-fixture.mjs';
import { NativeSource } from '../dist/native-source.js';
import { restoreNativeWork, exportNativeSource } from '../dist/native-backup.js';
import { withWorkArchive, packWorkArchive } from '../dist/work-backup-archive.js';
import { serveRepository } from '../dist/http.js';
import { digest } from '../dist/hash.js';
import { applyHostedEvent, parseWorkBytes, workBytes, metadataRequest } from '../dist/work-metadata.js';
import { code } from './helpers.mjs';

async function setup(t, schema = 1, binaryBytes = 0) {
  const dir = mkdtempSync(join(tmpdir(), 'forge-native-contribution-')),
    owner = join(dir, 'owner');
  mkdirSync(owner);
  writeFileSync(join(owner, 'a.ts'), 'export const a=1;\n');
  if (binaryBytes) writeFileSync(join(owner, 'fixture.bin'), randomBytes(binaryBytes));
  initNative(owner);
  const w = new WorkService(owner),
    data = () => w.store.load(),
    act = c => w.execute(c, data().revision).result;
  if (schema > 1) {
    const records = data();
    records.schema = schema;
    w.store.save(records);
  }
  const intent = act({ action: 'intent', outcome: 'Native contributor source' }),
    lane = act({ action: 'lane', intentId: intent.id, name: 'Keep owner edits' });
  const baseArchive = (await w.dispatch({ action: 'export-work', archive: true }, data().revision)).result;
  const contributor = join(dir, 'contributor');
  await restoreNativeWork(baseArchive.archive.path, contributor);
  const incoming = new WorkService(contributor),
    incomingData = () => incoming.store.load();
  const editLane = incoming.execute(
    { action: 'lane', intentId: intent.id, name: 'Contribution' },
    incomingData().revision,
  ).result;
  writeFileSync(join(incoming.store.path(editLane.id), 'a.ts'), 'export const a=2;\n');
  writeFileSync(join(incoming.store.path(editLane.id), 'run.sh'), '#!/bin/sh\necho retained\n');
  chmodSync(join(incoming.store.path(editLane.id), 'run.sh'), 0o700);
  const source = new NativeSource(contributor),
    checkpoint = incoming.execute(
      {
        action: 'checkpoint',
        laneId: editLane.id,
        expectedHead: editLane.head,
        expectedTree: source.tree(source.capture(incoming.store.path(editLane.id), false, editLane.head)),
        message: 'Contributor edits',
      },
      incomingData().revision,
    ).result;
  const view = incoming.execute(
    { action: 'compose', intentId: intent.id, inputs: [{ laneId: editLane.id, head: checkpoint.head }] },
    incomingData().revision,
  ).result;
  incoming.execute(
    {
      action: 'accept-channel',
      operationId: randomUUID(),
      channel: 'main',
      viewId: view.id,
      expectedHead: view.head,
      expectedPrevious: null,
    },
    incomingData().revision,
  );
  const proposal = (
    await incoming.dispatch({ action: 'export-work', archive: true }, incomingData().revision)
  ).result;
  const command = {
    action: 'import-native-contribution',
    operationId: randomUUID(),
    intentId: intent.id,
    expectedBase: intent.base,
    expectedHead: view.head,
    archivePath: proposal.archive.path,
    archiveSha256: proposal.archive.sha256,
    name: 'Received source',
    claim: {
      actor: 'claimed-contributor',
      projectKey: randomUUID(),
      proposalId: 'proposal',
      viewId: view.id,
    },
  };
  const bin = join(dir, 'bin'),
    marker = join(dir, 'git-used');
  mkdirSync(bin);
  writeFileSync(join(bin, 'git'), '#!/bin/sh\necho used > "' + marker + '"\nexit 99\n', { mode: 0o700 });
  const prior = process.env.PATH;
  process.env.PATH = bin + ':' + prior;
  t.after(() => {
    process.env.PATH = prior;
    assert.equal(existsSync(marker), false);
    rmSync(dir, { recursive: true, force: true });
  });
  return {
    dir,
    w,
    data,
    act,
    intent,
    lane,
    incoming,
    command,
    call: (c = command, revision = data().revision) => w.dispatch(c, revision),
  };
}

test('source-only import preserves owner Work/dirty files, ancestry/modes and archive digest facts through earlier-format recovery and format5 no-downgrade', async t => {
  for (const schema of [1, 2, 3, 5]) {
    const f = await setup(t, schema),
      path = f.w.store.path(f.lane.id);
    writeFileSync(join(path, 'a.ts'), 'owner dirty edits stay\n');
    const before = f.data(),
      raw = { ...before, unknownOwnerRecord: { exact: true } };
    f.w.store.save(raw);
    const result = await f.call(),
      data = f.data(),
      lane = result.result;
    assert.equal(data.schema, Math.max(schema, 4));
    assert.equal(lane.nativeContributionId, f.command.operationId);
    assert.deepEqual(data.lanes.slice(0, -1), before.lanes);
    assert.deepEqual(data.intents, before.intents);
    assert.deepEqual(data.views, before.views);
    assert.deepEqual(data.channelMoves, before.channelMoves);
    assert.equal(
      JSON.parse(readWorkBytes(join(f.w.store.directory, 'work.json'))).unknownOwnerRecord.exact,
      true,
    );
    assert.equal(readFileSync(join(path, 'a.ts'), 'utf8'), 'owner dirty edits stay\n');
    assert.equal(readFileSync(join(f.w.store.path(lane.id), 'a.ts'), 'utf8'), 'export const a=2;\n');
    const native = new NativeSource(f.w.store.root),
      receipt = data.nativeContributionReceipts[0];
    assert.equal(receipt.provenance, 'unverified-native-archive');
    assert.equal(receipt.archiveSha256, digest(readFileSync(f.command.archivePath)));
    assert.equal(receipt.size, readFileSync(f.command.archivePath).length);
    assert.equal(existsSync(join(native.directory, receipt.archiveSha256)), false);
    assert.equal(native.state(lane.head).files.find(file => file.path === 'run.sh').mode, 'executable');
    assert.ok(native.ancestors(lane.head).has(f.intent.base));
    const composed = f.act({
      action: 'compose',
      intentId: f.intent.id,
      inputs: [{ laneId: lane.id, head: lane.head }],
    });
    assert.equal(composed.head, f.command.expectedHead);
    const exported = (await f.w.dispatch({ action: 'export-work', archive: true }, f.data().revision)).result;
    const fresh = join(f.dir, 'fresh');
    await restoreNativeWork(exported.archive.path, fresh);
    assert.deepEqual(new WorkService(fresh).store.load(), f.data());
    assert.equal(existsSync(join(new NativeSource(fresh).directory, receipt.archiveSha256)), false);
    assert.equal(
      z.object({ schema: z.union([z.literal(1), z.literal(2), z.literal(3)]) }).safeParse(data).success,
      false,
      'previous format schema rejects4; real previous compiled CLI acceptance is separately selected',
    );
    const sourceOnly = (await exportNativeSource(f.w.store, f.data().revision, lane.head)).result;
    await withWorkArchive(sourceOnly.archive.path, async directory => {
      const empty = JSON.parse(readWorkBytes(join(directory, 'work.json'))),
        manifest = JSON.parse(readFileSync(join(directory, 'manifest.json')));
      assert.equal(empty.nativeContributionReceipts, undefined);
      assert.deepEqual(empty.lanes, []);
      assert.equal(
        manifest.files.some(file => file.path === 'objects/' + receipt.archiveSha256),
        false,
      );
    });
    if (process.env.FORGE_NATIVE_CONTRIBUTION_LEGACY_CLI) {
      const retainedWork = readWorkBytes(join(f.w.store.directory, 'work.json'));
      assert.throws(
        () =>
          execFileSync(
            process.execPath,
            [process.env.FORGE_NATIVE_CONTRIBUTION_LEGACY_CLI, 'work', f.w.store.root],
            { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
          ),
        error => error.status !== 0 && /INVALID_WORK_STORE/.test(String(error.stdout) + String(error.stderr)),
      );
      assert.deepEqual(readWorkBytes(join(f.w.store.directory, 'work.json')), retainedWork);
    }
    const inspected = await f.call({ action: 'inspect-native-objects' });
    assert.equal(inspected.result.format, Math.max(schema, 4));
    await f.call({ action: 'collect-native-objects' });
    assert.equal(f.data().schema, Math.max(schema, 4));
    assert.equal(existsSync(join(native.directory, receipt.archiveSha256)), false);
    assert.equal(digest(readFileSync(f.command.archivePath)), receipt.archiveSha256);
  }
});

test('three full native proposal round trips retain source/provenance without nesting archive bodies in owner backups', async t => {
  const payload = 256 * 1024,
    f = await setup(t, 1, payload),
    bytes = () =>
      readdirSync(new NativeSource(f.w.store.root).directory)
        .filter(name => /^[0-9a-f]{64}$/.test(name))
        .reduce(
          (sum, name) => sum + readFileSync(join(new NativeSource(f.w.store.root).directory, name)).length,
          0,
        );
  const initialCas = bytes(),
    archives = [];
  let command = f.command;
  for (let round = 1; round <= 3; round++) {
    const input = readFileSync(command.archivePath),
      imported = (await f.call(command)).result,
      receipt = f.data().nativeContributionReceipts.at(-1);
    assert.equal(receipt.archiveSha256, digest(input));
    assert.equal(receipt.size, input.length);
    assert.deepEqual(
      readFileSync(command.archivePath),
      input,
      'original contributor archive remains untouched',
    );
    const backup = (await f.call({ action: 'export-work', archive: true })).result;
    archives.push(backup.archive.size);
    assert.equal(existsSync(join(new NativeSource(f.w.store.root).directory, receipt.archiveSha256)), false);
    const target = join(f.dir, 'round-' + round);
    await restoreNativeWork(backup.archive.path, target);
    const c = new WorkService(target),
      cd = () => c.store.load();
    assert.deepEqual(cd(), f.data());
    assert.equal(readFileSync(join(c.store.path(imported.id), 'fixture.bin')).length, payload);
    if (round === 3) break;
    const lane = c.execute(
      {
        action: 'child-lane',
        parentLaneId: imported.id,
        expectedHead: imported.head,
        name: 'Continue contribution ' + round,
      },
      cd().revision,
    ).result;
    writeFileSync(join(c.store.path(lane.id), 'a.ts'), 'export const round=' + round + ';\n');
    const source = new NativeSource(target),
      checkpoint = c.execute(
        {
          action: 'checkpoint',
          laneId: lane.id,
          expectedHead: lane.head,
          expectedTree: source.tree(source.capture(c.store.path(lane.id), false, lane.head)),
          message: 'Continue source',
        },
        cd().revision,
      ).result;
    const view = c.execute(
      { action: 'compose', intentId: f.intent.id, inputs: [{ laneId: lane.id, head: checkpoint.head }] },
      cd().revision,
    ).result;
    const proposal = (await c.dispatch({ action: 'export-work', archive: true }, cd().revision)).result;
    command = {
      ...f.command,
      operationId: randomUUID(),
      expectedHead: view.head,
      archivePath: proposal.archive.path,
      archiveSha256: proposal.archive.sha256,
      claim: { ...f.command.claim, viewId: view.id },
      name: 'Round ' + round,
    };
  }
  assert.equal(f.data().nativeContributionReceipts.length, 3);
  assert.ok(
    bytes() < initialCas + 64 * 1024,
    'source CAS grows by small State/source deltas, without proposal archive bodies',
  );
  assert.ok(
    archives.every(size => size < payload + 64 * 1024),
    'full backups contain one incompressible source payload plus bounded metadata',
  );
  assert.ok(
    Math.max(...archives) - Math.min(...archives) < 32 * 1024,
    'successive backups do not double the previous archive',
  );
});

test('retry precedes stale revision/missing transport path; original semantic pins and creating recovery retained', async t => {
  const f = await setup(t),
    save = f.w.store.save.bind(f.w.store);
  f.w.store.save = data => {
    save(data);
    throw Error('lost creating receipt');
  };
  await assert.rejects(f.call(), /lost creating receipt/);
  f.w.store.save = save;
  assert.equal(f.data().lanes.at(-1).state, 'creating');
  const result = await f.call({ ...f.command, archivePath: '/missing' }, 0);
  assert.equal(result.result.state, 'active');
  assert.equal(f.data().nativeContributionReceipts.length, 1);
  await f.call({ ...f.command, archivePath: '/still-missing' }, 0);
  await assert.rejects(f.call({ ...f.command, name: 'changed request' }, 0), code('WORK_OPERATION_CHANGED'));
  await assert.rejects(
    f.call({ ...f.command, claim: { ...f.command.claim, actor: 'other' } }, 0),
    code('WORK_OPERATION_CHANGED'),
  );
  const second = { ...f.command, operationId: randomUUID() };
  let saves = 0;
  f.w.store.save = data => {
    saves++;
    if (saves === 2) throw Error('lost active registration before save');
    save(data);
  };
  await assert.rejects(f.call(second), /lost active registration/);
  f.w.store.save = save;
  assert.equal(f.data().lanes.at(-1).state, 'creating');
  assert.equal((await f.call({ ...second, archivePath: '/missing' }, 0)).result.state, 'active');
  const third = { ...f.command, operationId: randomUUID() };
  saves = 0;
  f.w.store.save = data => {
    saves++;
    if (saves === 2) throw Error('lost active receipt with later edit');
    save(data);
  };
  await assert.rejects(f.call(third), /lost active receipt/);
  f.w.store.save = save;
  const dirtyPath = join(f.w.store.path(third.operationId), 'a.ts');
  writeFileSync(dirtyPath, 'preserve edited interrupted workspace');
  const original = readWorkBytes(join(f.w.store.directory, 'work.json'));
  await assert.rejects(f.call({ ...third, archivePath: '/missing' }, 0), code('LANE_UNAVAILABLE'));
  assert.equal(readFileSync(dirtyPath, 'utf8'), 'preserve edited interrupted workspace');
  assert.deepEqual(readWorkBytes(join(f.w.store.directory, 'work.json')), original);
});

test('wrong digest, base, candidate/View and incomplete or altered closure preserve canonical bytes and objects', async t => {
  const f = await setup(t),
    path = join(f.w.store.directory, 'work.json'),
    original = readFileSync(path),
    source = new NativeSource(f.w.store.root),
    objects = readdirSync(source.directory);
  await assert.rejects(f.call({ ...f.command, archiveSha256: '0'.repeat(64) }), code('INVALID_CONTRIBUTION'));
  await assert.rejects(f.call({ ...f.command, expectedBase: '0'.repeat(64) }), code('CONTRIBUTION_CHANGED'));
  await assert.rejects(
    f.call({ ...f.command, expectedHead: f.intent.base, claim: f.command.claim }),
    code('CONTRIBUTION_CHANGED'),
  );
  await assert.rejects(
    f.call({ ...f.command, claim: { ...f.command.claim, viewId: randomUUID() } }),
    code('CONTRIBUTION_CHANGED'),
  );
  const unrelated = join(f.dir, 'unrelated');
  mkdirSync(unrelated);
  writeFileSync(join(unrelated, 'other.ts'), 'unrelated source');
  initNative(unrelated);
  const other = new WorkService(unrelated),
    archive = (await other.dispatch({ action: 'export-work', archive: true }, other.store.load().revision))
      .result;
  await assert.rejects(
    f.call({
      ...f.command,
      claim: undefined,
      expectedHead: other.store.load().nativeHead,
      archivePath: archive.archive.path,
      archiveSha256: archive.archive.sha256,
    }),
    code('CONTRIBUTION_CHANGED'),
  );
  await withWorkArchive(f.command.archivePath, async directory => {
    const manifest = JSON.parse(readFileSync(join(directory, 'manifest.json'))),
      object = manifest.files.find(file => file.path === 'objects/' + f.command.expectedHead);
    writeFileSync(join(directory, object.path), 'malformed selected State');
    object.size = Buffer.byteLength('malformed selected State');
    object.sha256 = digest('malformed selected State');
    writeFileSync(join(directory, 'manifest.json'), JSON.stringify(manifest));
    const archive = await packWorkArchive(
      directory,
      manifest.files.map(file => file.path),
    );
    await assert.rejects(
      f.call({ ...f.command, archivePath: archive.path, archiveSha256: archive.sha256 }),
      error => ['INVALID_WORK_BACKUP', 'INVALID_NATIVE_SOURCE'].includes(error.code),
    );
  });
  assert.deepEqual(readFileSync(path), original);
  assert.deepEqual(readdirSync(source.directory), objects);
});

test('concurrent raw Work changes during validation cannot be overwritten and original format stays unchanged', async t => {
  const f = await setup(t),
    revision = f.data().revision,
    pending = f.call(f.command, revision);
  const data = f.data();
  data.concurrentUnknown = 'preserve exact bytes';
  f.w.store.save(data);
  const before = readWorkBytes(join(f.w.store.directory, 'work.json'));
  await assert.rejects(pending, code('WORK_STALE'));
  assert.deepEqual(readWorkBytes(join(f.w.store.directory, 'work.json')), before);
  assert.equal(f.data().schema, 1);
});

test('format4 owner receives hosted companion metadata without downgrading or losing contribution receipt/archive digest facts', async t => {
  const f = await setup(t);
  await f.call();
  const receipt = f.data().nativeContributionReceipts[0];
  const exported = (await f.call({ action: 'export-work', archive: true })).result,
    projectKey = randomUUID();
  const journal = await withWorkArchive(exported.archive.path, async directory => {
    const manifest = readFileSync(join(directory, 'manifest.json')),
      original = readWorkBytes(join(directory, 'work.json')),
      records = parseWorkBytes(original);
    const command = {
      action: 'note',
      intentId: f.intent.id,
      kind: 'comment',
      text: 'Original hosted contributor round trip',
    };
    const event = {
      id: randomUUID(),
      projectKey,
      archiveSha256: exported.archive.sha256,
      actor: 'synthetic-owner',
      at: new Date().toISOString(),
      request: metadataRequest(command),
      previousRevision: records.revision,
      command,
    };
    applyHostedEvent(records, event);
    return {
      schema: 1,
      kind: 'forge-hosted-work-journal',
      projectKey,
      name: 'Synthetic project',
      base: {
        archiveSha256: exported.archive.sha256,
        manifestSha256: digest(manifest),
        workSha256: digest(original),
      },
      events: [event],
      revision: records.revision,
      workSha256: digest(workBytes(records)),
      coverage: 'Synthetic hosted metadata',
    };
  });
  const journalPath = join(f.dir, 'hosted-journal.json'),
    bytes = JSON.stringify(journal);
  writeFileSync(journalPath, bytes, { mode: 0o600 });
  const received = await f.call({
    action: 'reconcile-hosted-work',
    operationId: randomUUID(),
    projectKey,
    archivePath: exported.archive.path,
    archiveSha256: exported.archive.sha256,
    journalPath,
    journalSha256: digest(bytes),
  });
  assert.equal(received.result.status, 'reconciled');
  assert.equal(f.data().schema, 4);
  assert.deepEqual(f.data().nativeContributionReceipts, [receipt]);
  assert.equal(f.data().nativeCompanionReceipts.length, 1);
  assert.equal(f.data().intents[0].notes[0].text, 'Original hosted contributor round trip');
  assert.equal(digest(readFileSync(f.command.archivePath)), receipt.archiveSha256);
  assert.equal(existsSync(join(new NativeSource(f.w.store.root).directory, receipt.archiveSha256)), false);
  const final = (await f.call({ action: 'export-work', archive: true })).result,
    target = join(f.dir, 'recovered-four');
  await restoreNativeWork(final.archive.path, target);
  assert.deepEqual(new WorkService(target).store.load(), f.data());
});

test('CLI, protected HTTP and actual SDK MCP share import and original-operation retry with Git unavailable', async t => {
  const f = await setup(t),
    revision = f.data().revision;
  const expected = JSON.parse(
    execFileSync(
      process.execPath,
      [resolve('dist/cli.js'), 'work', f.w.store.root, JSON.stringify(f.command), String(revision)],
      { encoding: 'utf8' },
    ),
  );
  const server = await serveRepository(f.w.store.root, 0);
  t.after(() => server.close());
  const url = new URL(server.url),
    token = new URLSearchParams(url.hash.slice(1)).get('token'),
    body = JSON.stringify({ command: f.command, revision: 0 });
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
  const client = new Client({ name: 'native-contribution', version: '1' }),
    transport = new StdioClientTransport({
      command: process.execPath,
      args: [resolve('dist/cli.js'), 'mcp', f.w.store.root, '--work'],
      env: Object.fromEntries(Object.entries(process.env).filter(([, value]) => value !== undefined)),
      stderr: 'pipe',
    });
  await client.connect(transport);
  t.after(() => client.close());
  const result = await client.callTool({
    name: 'forge_work_command',
    arguments: { command: f.command, revision: 0 },
  });
  assert.equal(result.isError, undefined);
  assert.deepEqual(JSON.parse(result.content[0].text), expected);
});
