// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { initNative } from '../dist/native-work.js';
import { AgentWorkflow } from '../dist/agent-workflow.js';
import { policyPreset } from '../dist/autonomy-policy.js';
import { convertWork15To16, convertWorkTo18 } from '../dist/work-intent-converter.js';
import { WorkStore } from '../dist/work-store.js';
import { ForgeError } from '../dist/errors.js';
import { overlapNotifications } from '../dist/mcp-overlap-notifications.js';
import { watcherRuntime } from '../dist/local-watcher.js';
import { latestWorkFormat } from '../dist/work-format.js';
import { parseWork } from '../dist/work-unified-types.js';
import { callTool, mcpTestEnvironment } from './mcp-runtime.mjs';

// Exercise the real CLI/MCP and low-level writer entry points as a format-aware
// reader capped at 14. This is a compatibility probe, not a historical binary:
// pre-guard binaries cannot acquire a new error message retroactively.
async function fixture(t, format = 15, readerFormat = 14) {
  const root = mkdtempSync(join(tmpdir(), 'forge-format15-compat-'));
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  writeFileSync(join(root, 'source.txt'), 'retained evidence\n');
  initNative(root);
  const agent = new AgentWorkflow(root),
    store = new WorkStore(root);
  const lane = (await agent.dispatch({ action: 'start', outcome: 'Format compatibility' })).result;
  store.locked(() => {
    const data = store.load();
    if ([17, 18, 19, 20].includes(format)) {
      data.landingBatches = [
        {
          id: randomUUID(),
          channel: 'main',
          base: data.nativeHead,
          previous: null,
          arrivedAt: 'synthetic',
          entryIds: Array.from({ length: format >= 19 ? 8 : 4 }, () => randomUUID()),
          mode: 'parallel',
          status: 'composing',
          prefixes: [],
          conflicts: [],
        },
      ];
    }
    if ([16, 18, 20, 22].includes(format)) {
      data.schema = format === 22 ? 21 : format === 20 ? 19 : format === 18 ? 17 : 15;
      Object.assign(data, format === 16 ? convertWork15To16(data) : convertWorkTo18(data));
    } else data.schema = format;
    data.autonomyPolicy = policyPreset('trusted');
    data.autonomyPolicy.acceptance.disjointFastPath = true;
    data.revision++;
    store.save(data);
  });
  const loader = join(root, 'format14-loader.mjs'),
    preload = join(root, 'format14-preload.mjs');
  writeFileSync(
    loader,
    `export async function load(url, context, next) {
    const result = await next(url, context);
    if (url === ${JSON.stringify(pathToFileURL(resolve('dist/work-format.js')).href)}) {
      const source = result.source.toString();
      if (!source.includes('latestWorkFormat = ${latestWorkFormat}')) throw new Error('Update compatibility probe');
      return { ...result, source: source.replace('latestWorkFormat = ${latestWorkFormat}', 'latestWorkFormat = ${readerFormat}') };
    }
    return result;
  }`,
  );
  writeFileSync(
    preload,
    `import { register } from 'node:module'; register(${JSON.stringify(pathToFileURL(loader).href)});`,
  );
  const retained = () => {
    const files = [];
    const walk = directory => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) walk(path);
        else if (!/queue|lock/.test(path)) files.push([path, readFileSync(path).toString('base64')]);
      }
    };
    walk(store.directory);
    return files.sort(([a], [b]) => a.localeCompare(b));
  };
  return { root, store, lane, preload, retained };
}

test('format-14 compatibility probe rejects format15 CLI reads/writes and bare commits with upgrade nforge', async t => {
  const f = await fixture(t),
    before = f.retained();
  for (const args of [
    ['agent', f.root, 'status', '{}'],
    ['agent', f.root, 'start', JSON.stringify({ outcome: 'must not write' })],
    ['agent', f.root, 'checkpoint', JSON.stringify({ laneId: f.lane.laneId, message: 'must not write' })],
    [
      'work',
      f.root,
      JSON.stringify({ action: 'note', intentId: f.lane.intentId, kind: 'comment', text: 'must not write' }),
      String(f.store.revision()),
    ],
    ['agent', f.root, 'set-policy', JSON.stringify({ operationId: randomUUID(), preset: 'trusted' })],
  ]) {
    const result = spawnSync(process.execPath, ['--import', f.preload, resolve('dist/cli.js'), ...args], {
      encoding: 'utf8',
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr + result.stdout, /WORK_UPGRADE_REQUIRED/);
    assert.match(result.stderr + result.stdout, /upgrade nforge/);
    assert.deepEqual(f.retained(), before);
  }
  const result = spawnSync(
    process.execPath,
    [
      '--import',
      f.preload,
      '--input-type=module',
      '-e',
      `
    import { WorkStore } from ${JSON.stringify(pathToFileURL(resolve('dist/work-store.js')).href)};
    const store = new WorkStore(${JSON.stringify(f.root)});
    store.locked(() => store.commitRecords(store.records()));
  `,
    ],
    { encoding: 'utf8' },
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /upgrade nforge/);
  assert.deepEqual(f.retained(), before);
});

test('unsupported Work never schedules an overlap watcher or writes its control directory', async t => {
  const f = await fixture(t),
    before = readdirSync(f.store.directory, { recursive: true }).sort();
  t.mock.method(f.store, 'revision', () => {
    throw new ForgeError('WORK_UPGRADE_REQUIRED', 'upgrade nforge');
  });
  const create = t.mock.method(watcherRuntime, 'createWorker', () => {
    throw new Error('Unsupported Work must not start a helper');
  });
  const notifications = overlapNotifications({ server: { registerCapabilities() {} } }, f.store);
  notifications.close();
  assert.equal(create.mock.callCount(), 0);
  assert.deepEqual(readdirSync(f.store.directory, { recursive: true }).sort(), before);
});

test('format-14 compatibility probe rejects format15 MCP mutation without changing retained bytes', async t => {
  const f = await fixture(t),
    before = f.retained();
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['--import', f.preload, resolve('dist/cli.js'), 'mcp', f.root, '--agent'],
    stderr: 'pipe',
    env: mcpTestEnvironment(t),
  });
  let stderr = '';
  transport.stderr?.on('data', bytes => {
    stderr += bytes.toString();
  });
  const client = new Client({ name: 'format14-probe', version: '1' });
  try {
    await client.connect(transport);
    const result = await callTool(client, {
      name: 'forge_task',
      arguments: {
        command: { action: 'start', operationId: randomUUID(), outcome: 'must not write' },
      },
    });
    assert.ok(result.isError);
    assert.match(JSON.stringify(result), /WORK_UPGRADE_REQUIRED/);
    assert.match(JSON.stringify(result), /upgrade nforge/);
  } catch (error) {
    // A server refusing format15 during startup is equally loud and write-free.
    assert.match(stderr + error.message, /upgrade nforge/);
  } finally {
    await client.close();
  }
  assert.deepEqual(f.retained(), before);
});

for (const [format, reader] of [
  [16, 15],
  [17, 15],
  [18, 17],
  [19, 18],
  [20, 18],
  [21, 20],
  [22, 20],
])
  test(`format-${reader} compatibility probe rejects format${format} before writer preparation and preserves retained bytes`, async t => {
    const f = await fixture(t, format, reader),
      before = f.retained();
    for (const action of ['status', 'start']) {
      const result = spawnSync(
        process.execPath,
        [
          '--import',
          f.preload,
          resolve('dist/cli.js'),
          'agent',
          f.root,
          action,
          JSON.stringify(action === 'start' ? { outcome: 'Must not write newer batches' } : {}),
        ],
        { encoding: 'utf8' },
      );
      assert.notEqual(result.status, 0);
      assert.match(result.stderr + result.stdout, /WORK_UPGRADE_REQUIRED/);
      assert.match(result.stderr + result.stdout, /upgrade nforge/);
      assert.deepEqual(f.retained(), before);
    }
  });

for (const format of [17, 18, 19, 20])
  test(`current reader retains ${format >= 19 ? 'eight' : 'four'}-entry format${format} batches in full, selected and portable reads`, async t => {
    const f = await fixture(t, format);
    const data = f.store.load();
    const batch = data.landingBatches[0];
    assert.equal(data.schema, format);
    assert.equal(batch.entryIds.length, format >= 19 ? 8 : 4);
    assert.deepEqual(f.store.select('landingBatches', batch.id), batch);
    assert.deepEqual(parseWork(JSON.parse(f.store.snapshotBytes())).landingBatches, [batch]);
    f.store.locked(() => f.store.commitRecords(f.store.records()));
    assert.equal(f.store.load().schema, format);
    assert.deepEqual(f.store.load().landingBatches, [batch]);
  });
