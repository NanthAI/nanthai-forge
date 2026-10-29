// SPDX-License-Identifier: Apache-2.0
import { readWorkBytes } from './work-store-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  rmSync,
  chmodSync,
  symlinkSync,
  existsSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { initNative } from '../dist/native-work.js';
import { NativeSource } from '../dist/native-source.js';
import { nativeDiff } from '../dist/native-diff.js';
import { WorkService } from '../dist/work.js';
import { ForgeError } from '../dist/errors.js';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'forge-native-review-'));
  t.after(() => rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  const root = join(directory, 'owner');
  mkdirSync(root);
  writeFileSync(join(root, 'a.ts'), 'export const value = 1;\n');
  writeFileSync(join(root, 'delete.txt'), 'original deletion\n');
  writeFileSync(join(root, 'mode.txt'), 'unchanged bytes\n');
  writeFileSync(join(root, 'binary.bin'), Buffer.from([0, 255, 10]));
  writeFileSync(join(root, 'invalid.bin'), Buffer.from([0xc3, 0x28]));
  initNative(root);
  const work = new WorkService(root);
  const act = command => work.execute(command, work.status().revision).result;
  const intent = act({ action: 'intent', outcome: 'Synthetic source review' });
  const lane = act({ action: 'lane', intentId: intent.id, name: 'Review' }),
    path = work.store.path(lane.id);
  const checkpoint = () => {
    const current = work.status().lanes[0];
    return act({
      action: 'checkpoint',
      laneId: lane.id,
      expectedHead: current.actualHead,
      expectedTree: current.indexTree,
      message: 'Synthetic checkpoint',
    });
  };
  const compose = () =>
    act({
      action: 'compose',
      operationId: randomUUID(),
      intentId: intent.id,
      inputs: [{ laneId: lane.id, head: work.status().lanes[0].head }],
    });
  return { directory, root, work, act, intent, lane, path, checkpoint, compose };
}
test('native content reviews preserve live and immutable baselines without mutating source or Work', t => {
  const f = fixture(t),
    { root, work, path, checkpoint, compose } = f;
  writeFileSync(join(path, 'a.ts'), 'export const value = 2;');
  writeFileSync(join(path, 'add.txt'), 'added Unicode é\n');
  rmSync(join(path, 'delete.txt'));
  writeFileSync(join(path, 'binary.bin'), Buffer.from([0, 128]));
  writeFileSync(join(path, 'invalid.bin'), Buffer.from([0xc3, 0x29]));
  chmodSync(join(path, 'mode.txt'), 0o700);
  const first = work.status().lanes[0];
  assert.equal(first.changes, 'M a.ts\nA add.txt\nM binary.bin\nD delete.txt\nM invalid.bin\nM mode.txt');
  assert.equal(first.staged, first.changes);
  assert.match(first.diff, /Whole-file before\/after review \(not a minimal hunk diff\)/);
  assert.match(
    first.diff,
    /-export const value = 1;\n\+export const value = 2;\n\\ No newline at end of file/,
  );
  assert.match(first.diff, /\+added Unicode é/);
  assert.match(first.diff, /-original deletion/);
  assert.match(
    first.diff,
    /mode file · 3 bytes · SHA-256 [a-f0-9]{64}\n\+\+\+ b\/binary.bin · mode file · 2 bytes/,
  );
  assert.equal((first.diff.match(/Binary or non-UTF-8 content/g) ?? []).length, 2);
  assert.match(first.diff, new RegExp(hash(Buffer.from([0xc3, 0x29]))));
  assert.match(first.diff, /a\/mode.txt · mode file[\s\S]*b\/mode.txt · mode executable/);
  assert.equal(first.diff.includes('\ufffd'), false);
  const pinned = checkpoint();
  const view = compose();
  assert.equal(view.status, 'clean');
  assert.equal(view.details, first.diff);
  // New and historical Views remain compact in persistence; their reviewed bytes come from their exact States.
  assert.equal(work.store.load().views[0].details, first.changes);
  writeFileSync(join(path, 'a.ts'), 'live third version\n');
  writeFileSync(join(root, 'a.ts'), 'owner dirty source\n');
  const source = new NativeSource(root),
    objects = readdirSync(source.directory).sort();
  const journal = readWorkBytes(join(work.store.directory, 'work.json'));
  const bytes = readFileSync(join(path, 'a.ts'));
  const status = work.status(),
    live = status.lanes[0];
  assert.equal(live.head, pinned.head);
  assert.equal(live.changes, 'M a.ts');
  assert.equal(live.staged, 'M a.ts');
  assert.match(live.diff, /-export const value = 1;/);
  assert.match(live.diff, /\+live third version/);
  assert.equal(status.views[0].details, view.details);
  assert.equal(status.views[0].details.includes('live third'), false);
  assert.deepEqual(readdirSync(source.directory).sort(), objects);
  assert.deepEqual(readWorkBytes(join(work.store.directory, 'work.json')), journal);
  assert.deepEqual(readFileSync(join(path, 'a.ts')), bytes);
  assert.equal(readFileSync(join(root, 'a.ts'), 'utf8'), 'owner dirty source\n');
});
test('native live review diagnoses changed captures and races without substituting text or saving records', t => {
  const { root, work, path } = fixture(t),
    source = new NativeSource(root);
  writeFileSync(join(path, 'a.ts'), 'captured replacement\n');
  const before = source.state(work.status().lanes[0].base).files,
    captured = source.capture(path);
  writeFileSync(join(path, 'a.ts'), 'later unpinned replacement\n');
  const diff = nativeDiff(source, before, captured, path);
  assert.match(diff, /Preview unavailable: live source changed/);
  assert.equal(diff.includes('captured replacement'), false);
  assert.equal(diff.includes('later unpinned'), false);
  rmSync(join(path, 'delete.txt'));
  const deleted = source.capture(path);
  writeFileSync(join(path, 'delete.txt'), 'reappeared after capture');
  assert.match(nativeDiff(source, before, deleted, path), /deleted live path reappeared/);
  const journal = readWorkBytes(join(work.store.directory, 'work.json'));
  const capture = NativeSource.prototype.captureReport;
  NativeSource.prototype.captureReport = function (input, ...args) {
    if (input === path) throw new ForgeError('SOURCE_CHANGED', 'Synthetic capture race');
    return capture.call(this, input, ...args);
  };
  try {
    const result = work.status();
    assert.match(result.lanes[0].diff, /Preview unavailable/);
    assert.equal(result.lanes[0].indexTree, null);
    assert.equal(result.intents.length, 1);
  } finally {
    NativeSource.prototype.captureReport = capture;
  }
  assert.deepEqual(readWorkBytes(join(work.store.directory, 'work.json')), journal);
});
test(
  'opt-in SDK MCP exports and restores actual native source and Work without Git',
  { timeout: 120000 },
  async t => {
    const { root, work, path, directory, act, intent, checkpoint, compose } = fixture(t);
    writeFileSync(join(path, 'a.ts'), 'export const value = 7;\n');
    checkpoint();
    const view = compose();
    act({ action: 'note', intentId: intent.id, kind: 'comment', text: 'Synthetic private Work preserved' });
    act({
      action: 'accept-channel',
      operationId: randomUUID(),
      channel: 'main',
      viewId: view.id,
      expectedHead: view.head,
      expectedPrevious: null,
    });
    writeFileSync(join(path, 'a.ts'), 'original dirty Lane remains private\n');
    const bin = join(directory, 'bin');
    mkdirSync(bin);
    const called = join(directory, 'git-called');
    writeFileSync(join(bin, 'git'), `#!/bin/sh\n/usr/bin/touch '${called}'\nexit 91\n`);
    chmodSync(join(bin, 'git'), 0o700);
    for (const tool of ['tar', 'gzip']) symlinkSync(`/usr/bin/${tool}`, join(bin, tool));
    const env = { ...process.env, PATH: bin };
    const cli = resolve('dist/cli.js');
    const open = async enabled => {
      const client = new Client({ name: 'native-export-test', version: '1.0.0' });
      const transport = new StdioClientTransport({
        command: process.execPath,
        args: [cli, 'mcp', root, ...(enabled ? ['--work'] : [])],
        env,
        stderr: 'pipe',
      });
      let stderr = '';
      transport.stderr?.on('data', chunk => {
        stderr += chunk;
      });
      t.after(() => client.close());
      await client.connect(transport);
      return { client, stderr: () => stderr };
    };
    const ordinary = await open(false);
    assert.equal((await ordinary.client.listTools()).tools.length, 8);
    await ordinary.client.close();
    const { client, stderr } = await open(true);
    assert.equal((await client.listTools()).tools.length, 10);
    const call = async (name, args = {}) => {
      const result = await client.callTool({ name, arguments: args });
      return { result, body: JSON.parse(result.content[0].text) };
    };
    const status = (await call('forge_work_status')).body;
    assert.match(status.lanes[0].diff, /original dirty Lane/);
    assert.equal(status.views[0].details, view.details);
    const journal = readWorkBytes(join(work.store.directory, 'work.json'));
    const stale = await call('forge_work_command', {
      revision: 0,
      command: { action: 'export-work', archive: true },
    });
    assert.equal(stale.body.error.code, 'WORK_STALE');
    const invalid = await client.callTool({
      name: 'forge_work_command',
      arguments: { revision: status.revision, command: { action: 'export-work', archive: 'true' } },
    });
    assert.equal(invalid.isError, true);
    const exported = await call('forge_work_command', {
      revision: status.revision,
      command: { action: 'export-work', archive: true },
    });
    assert.equal(exported.result.isError, undefined);
    const backup = exported.body.result;
    assert.equal(JSON.parse(backup.json).kind, 'forge-native-work-backup');
    assert.equal(hash(readFileSync(backup.archive.path)), backup.archive.sha256);
    const target = join(directory, 'restored');
    const restored = JSON.parse(
      execFileSync(process.execPath, [cli, 'restore-native', backup.archive.path, target], {
        env,
        encoding: 'utf8',
      }),
    );
    assert.equal(restored.restored, true);
    const restoredWork = new WorkService(target).status();
    assert.equal(restoredWork.channels[0].head, view.head);
    assert.equal(restoredWork.intents[0].notes[0].text, 'Synthetic private Work preserved');
    assert.equal(readFileSync(join(restoredWork.lanes[0].path, 'a.ts'), 'utf8'), 'export const value = 7;\n');
    assert.equal(readFileSync(join(path, 'a.ts'), 'utf8'), 'original dirty Lane remains private\n');
    assert.deepEqual(readWorkBytes(join(work.store.directory, 'work.json')), journal);
    assert.equal(existsSync(join(target, '.git')), false);
    assert.equal(existsSync(called), false);
    await client.close();
    assert.equal(stderr(), '');
    assert.equal(ordinary.stderr(), '');
  },
);
