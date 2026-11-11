// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { getFunctionName, makeFunctionReference } from 'convex/server';
import { setup } from './host-cli-fixture.mjs';
import { moduleUrl } from './convex-module.mjs';
import { hostCli, hostProject } from '../dist/host-cli.js';
import { cloneHostedProject } from '../dist/hosted-clone-cli.js';
import { HostedCheckoutDownloads } from '../dist/hosted-checkout-downloads.js';
import { checkoutHostedLane } from '../dist/hosted-lane-checkout.js';
import { ConvexLaneTransport } from '../dist/hosted-lane-transport.js';
import { readHostedLaneCheckout } from '../dist/hosted-lane-checkout-marker.js';
import { saveHostedLane } from '../dist/hosted-save-client.js';
import { initNative } from '../dist/native-work.js';

const call = (exchange, kind, name, args) => exchange.client[kind](makeFunctionReference(name), args);
function inventory(root) {
  const files = [];
  function walk(path = '') {
    for (const name of readdirSync(join(root, path)).sort()) {
      if (!path && name === '.forge') continue;
      const relative = path ? `${path}/${name}` : name,
        absolute = join(root, relative),
        stat = lstatSync(absolute);
      if (stat.isDirectory()) walk(relative);
      else
        files.push({
          path: relative,
          executable: Boolean(stat.mode & 0o111),
          bytes: readFileSync(absolute).toString('base64'),
        });
    }
  }
  walk();
  return files;
}
function plain(t) {
  const f = setup(t, false, true);
  rmSync(join(f.root, '.forge'), { recursive: true });
  mkdirSync(join(f.root, 'nested'));
  writeFileSync(join(f.root, 'nested/empty'), Buffer.alloc(0));
  writeFileSync(join(f.root, 'nested/binary'), Buffer.from([0, 1, 255, 0, 42]));
  writeFileSync(join(f.root, 'run.sh'), '#!/bin/sh\nexit 0\n');
  chmodSync(join(f.root, 'run.sh'), 0o700);
  return f;
}
function noGit(t, f) {
  const before = process.env.PATH,
    directory = join(f.directory, 'no-git');
  mkdirSync(directory);
  process.env.PATH = directory;
  t.after(() => {
    if (before === undefined) delete process.env.PATH;
    else process.env.PATH = before;
  });
}
function allHandlers(f) {
  const calls = [];
  // All public and nested operations use their real handlers, including the
  // save's inline V8 source worker. Only the database and R2 are synthetic.
  f.s.ctx.runQuery =
    f.s.ctx.runMutation =
    f.s.ctx.runAction =
      async (ref, args) => {
        const name = getFunctionName(ref),
          [file, method] = name.split(':');
        calls.push(name);
        const module = await import(moduleUrl(`../convex/${file}.ts`));
        return module[method]._handler(f.s.ctx, args);
      };
  return calls;
}
async function host(f) {
  return hostCli(
    [f.root, '--deployment', 'https://fixture.convex.cloud', '--wait', '--json'],
    (root, options) => hostProject(root, options, f.dependencies),
  );
}
function mainTransport(exchange) {
  const downloads = new HostedCheckoutDownloads(exchange);
  return { current: expected => exchange.current(expected), ...downloads.transport() };
}

test('plain-directory host without Git clones exact paths, modes, empty/binary bytes and saves/reopens its first Lane (8eccaf03)', async t => {
  const f = plain(t),
    expected = inventory(f.root);
  noGit(t, f);
  allHandlers(f);
  assert.equal(existsSync(join(f.root, '.git')), false);
  assert.equal(existsSync(join(f.root, '.forge')), false);
  const hosted = await host(f);
  assert.deepEqual(hosted.sourceAuthority, { mode: 'server', epoch: 1 });
  const exchange = f.dependencies.exchange(hosted.projectId, randomUUID());
  const clone = join(f.directory, 'clone');
  await cloneHostedProject(
    clone,
    { url: hosted.deployment, projectId: hosted.projectId },
    mainTransport(exchange),
  );
  assert.deepEqual(inventory(clone), expected);
  const main = await exchange.current();
  assert.deepEqual(main.authority, hosted.sourceAuthority);
  const started = JSON.parse(
    await call(exchange, 'mutation', 'projectHostedStart:start', {
      projectId: hosted.projectId,
      operationId: randomUUID(),
      authorityEpoch: main.authority.epoch,
      expectedMain: { head: main.head, receiptId: main.receipt.id },
      intent: { kind: 'new', outcome: 'First synthetic Lane' },
    }),
  );
  const lane = join(f.directory, 'lane');
  const open = root =>
    checkoutHostedLane(
      root,
      {
        operationId: randomUUID(),
        url: hosted.deployment,
        projectId: hosted.projectId,
        laneId: started.lane.laneId,
      },
      new ConvexLaneTransport(exchange),
    );
  await open(lane);
  assert.deepEqual(inventory(lane), expected);
  writeFileSync(join(lane, 'nested/binary'), Buffer.from([255, 0, 42, 1]));
  const saved = await saveHostedLane(
    lane,
    { operationId: randomUUID(), message: 'First binary edit' },
    exchange,
    { overlapEvidence: false, submitPage: true, submitRun: true, runPublish: true },
  );
  assert.equal(saved.outcome.status, 'completed');
  assert.notEqual(readHostedLaneCheckout(lane).selection.head, main.head);
  const reopened = join(f.directory, 'reopened');
  await open(reopened);
  assert.deepEqual(inventory(reopened), inventory(lane));
  assert.deepEqual(inventory(clone), expected, 'saving a Lane preserves accepted main');
  assert.equal(existsSync(join(f.root, '.git')), false);
  const marker = readFileSync(join(clone, '.forge/hosted-main.json'));
  const rehosted = await hostProject(clone, { deployment: hosted.deployment }, f.dependencies);
  assert.notEqual(rehosted.projectId, hosted.projectId);
  assert.deepEqual(
    readFileSync(join(clone, '.forge/hosted-main.json')),
    marker,
    'hosting a clone preserves its existing source binding',
  );
  assert.deepEqual((await exchange.current()).authority, main.authority);
  assert.deepEqual(inventory(clone), expected);
});

test('fresh host authority publication uses the same Convex calls as a pinned legacy seed; idle makes none', async t => {
  const legacy = plain(t),
    fresh = plain(t);
  for (const f of [legacy, fresh])
    for (let index = 0; index < 3996; index++)
      writeFileSync(join(f.root, `nested/file-${index}.txt`), 'shared synthetic bytes\n');
  initNative(legacy.root);
  const a = allHandlers(legacy),
    b = allHandlers(fresh);
  // A pre-upgrade pending operation retains its original seed authority.
  const { updateHostState } = await import('../dist/host-binding.js');
  updateHostState(legacy.store, state => {
    state.hosting = {
      operationId: randomUUID(),
      pushId: randomUUID(),
      initializeId: randomUUID(),
      deployment: 'https://fixture.convex.cloud',
      name: 'Legacy pending host',
      visibility: 'private',
      revision: 0,
    };
  });
  await hostProject(legacy.root, {}, legacy.dependencies);
  await host(fresh);
  assert.deepEqual(b, a, 'server birth adds no public or nested Convex execution');
  // Existing storage-accounting shards depend on random object digests; their
  // occupied shard count is unrelated to server birth. Compare source/control
  // rows and bytes, without turning that random distribution into a test gate.
  const tables = f => Object.entries(f.s.tables).filter(([name]) => name !== 'projectStorageUsage');
  const stored = f => Object.fromEntries(tables(f).map(([name, rows]) => [name, rows.size]));
  assert.deepEqual(stored(fresh), stored(legacy), 'server birth adds no rows or per-file database records');
  const bytes = f =>
    tables(f).reduce(
      (sum, [, rows]) =>
        sum + [...rows.values()].reduce((total, row) => total + Buffer.byteLength(JSON.stringify(row)), 0),
      0,
    );
  assert(
    Math.abs(bytes(fresh) - bytes(legacy)) < 1024,
    'authority metadata adds less than 1 KiB at 4000 files',
  );
  const calls = b.length;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(b.length, calls, 'hosting leaves no idle observer or timer');
  assert.equal(inventory(fresh.root).length, 4000);
  t.diagnostic(
    `4000 files: ${calls} Convex executions per host, including nested calls; idle 0; process peak RSS ${process.resourceUsage().maxRSS} KiB`,
  );
});

test('legacy native-owner and existing server projects retain their original authority and exact main on seed replay', async t => {
  for (const server of [false, true]) {
    const f = setup(t, false, true);
    allHandlers(f);
    const { updateHostState } = await import('../dist/host-binding.js');
    if (!server)
      updateHostState(f.store, state => {
        state.hosting = {
          operationId: randomUUID(),
          pushId: randomUUID(),
          initializeId: randomUUID(),
          deployment: 'https://fixture.convex.cloud',
          name: 'Legacy native owner',
          visibility: 'private',
          revision: 0,
        };
      });
    const hosted = await hostProject(f.root, { deployment: 'https://fixture.convex.cloud' }, f.dependencies);
    const project = f.s.tables.hostedProjects.get(hosted.projectId);
    const before = JSON.stringify(project);
    const seed = [...f.s.tables.projectHostedSeeds.values()][0];
    const selection = [...f.s.tables.projectHostedChannels.values()][0].selection;
    const exchange = f.dependencies.exchange(hosted.projectId, randomUUID());
    const request = JSON.parse(seed.request);
    await call(exchange, 'mutation', 'projectHostedSeed:begin', {
      projectId: hosted.projectId,
      request: seed.request,
    });
    if (server) delete request.serverAuthority;
    else request.serverAuthority = true;
    await assert.rejects(
      call(exchange, 'mutation', 'projectHostedSeed:begin', {
        projectId: hosted.projectId,
        request: JSON.stringify(request),
      }),
      error => (error.data?.code ?? error.code) === 'WORK_OPERATION_CHANGED',
    );
    assert.equal(JSON.stringify(project), before);
    assert.equal([...f.s.tables.projectHostedChannels.values()][0].selection, selection);
    assert.deepEqual(project.sourceAuthority, {
      mode: server ? 'server' : 'native-owner',
      epoch: server ? 1 : 0,
    });
    if (server) assert.equal((await exchange.current()).head, JSON.parse(selection).head);
    else
      await assert.rejects(
        call(exchange, 'query', 'projectHostedChannels:current', { projectId: hosted.projectId }),
        error => (error.data?.code ?? error.code) === 'SOURCE_AUTHORITY_CHANGED',
      );
  }
});

test('an interrupted fresh seed never exposes server authority without its validated schema-2 main; resume selects both', async t => {
  const f = plain(t);
  allHandlers(f);
  const action = f.dependencies.client.action;
  f.dependencies.client.action = (ref, args) => {
    if (getFunctionName(ref) === 'projectHostedSeedActions:finish')
      throw new Error('Synthetic interruption before publication');
    return action(ref, args);
  };
  await assert.rejects(host(f), /Synthetic interruption/);
  const project = [...f.s.tables.hostedProjects.values()][0];
  assert.deepEqual(project.sourceAuthority, { mode: 'native-owner', epoch: 0 });
  assert.equal(f.s.tables.projectHostedChannels.size, 0);
  assert.equal(f.s.tables.projectBackups.size, 0);
  f.dependencies.client.action = action;
  const result = await hostCli([f.root, '--resume', '--json'], (root, options) =>
    hostProject(root, options, f.dependencies),
  );
  const main = await f.dependencies.exchange(result.projectId, randomUUID()).current();
  assert.deepEqual(project.sourceAuthority, main.authority);
  assert.deepEqual(main.authority, { mode: 'server', epoch: 1 });
});
