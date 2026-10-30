// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  utimesSync,
  lutimesSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import { clientSettingsCli, heavySlots, readClientSettings } from '../dist/client-settings.js';
import { listLanes, readLaneEntry, recordLane } from '../dist/lane-registry.js';
import { housekeepingLines, laneHousekeeping } from '../dist/lane-prune.js';
import { acquireHeavySlot, heavyCli, tryHeavySlot } from '../dist/heavy-slots.js';
import { dependencyKey, shareDependencies } from '../dist/shared-dependencies.js';
import { landSummary } from '../dist/hosted-land-cli.js';

const hour = 3_600_000;
const address = { url: 'https://fixture.invalid', projectId: 'project' };
function isolated(t) {
  const directory = mkdtempSync(join(tmpdir(), 'forge-defaults-'));
  const saved = {
    XDG_STATE_HOME: process.env.XDG_STATE_HOME,
    FORGE_CLIENT_SETTINGS: process.env.FORGE_CLIENT_SETTINGS,
    FORGE_HEAVY_DIR: process.env.FORGE_HEAVY_DIR,
  };
  process.env.XDG_STATE_HOME = join(directory, 'state');
  process.env.FORGE_CLIENT_SETTINGS = join(directory, 'client.json');
  process.env.FORGE_HEAVY_DIR = join(directory, 'heavy');
  t.after(() => {
    for (const [key, value] of Object.entries(saved))
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    rmSync(directory, { recursive: true, force: true });
  });
  return directory;
}
/** A hosted Lane checkout: marker, a file, client cache and metrics siblings. */
function checkout(directory, name, laneId, old = true) {
  const root = join(directory, name);
  mkdirSync(join(root, '.forge'), { recursive: true });
  writeFileSync(
    join(root, '.forge', 'hosted-lane.json'),
    JSON.stringify({ url: address.url, selection: { laneId, projectId: address.projectId } }),
  );
  writeFileSync(join(root, 'file.txt'), 'x'.repeat(4096));
  mkdirSync(`${root}.forge-client/agent`, { recursive: true });
  writeFileSync(`${root}.forge-metrics.jsonl`, '{}\n');
  if (old)
    age([root, join(root, '.forge'), join(root, '.forge', 'hosted-lane.json'), join(root, 'file.txt')], 10);
  if (old) age([`${root}.forge-client`, `${root}.forge-client/agent`, `${root}.forge-metrics.jsonl`], 10);
  return root;
}
function age(paths, hours) {
  const when = new Date(Date.now() - hours * hour);
  for (const path of paths) utimesSync(path, when, when);
}

test('client settings default on, persist per machine and explain their source', t => {
  isolated(t);
  assert.deepEqual(readClientSettings(), {
    autoPruneHours: 3,
    idleLaneHours: 1,
    localHeavySlots: 'auto',
    shareDependencies: true,
    landWait: true,
  });
  assert.equal(clientSettingsCli([]).settings.landWait.source, 'default');
  assert.equal(clientSettingsCli(['landWait', 'false']).settings.landWait.value, false);
  assert.equal(clientSettingsCli(['localHeavySlots', '0']).settings.localHeavySlots.slots, 0);
  assert.equal(readClientSettings().landWait, false);
  assert.equal(clientSettingsCli(['landWait', '--reset']).settings.landWait.source, 'default');
  assert.throws(() => clientSettingsCli(['unknown', '1']), { code: 'BAD_ARGUMENT' });
  assert.throws(() => clientSettingsCli(['autoPruneHours', '-1']), { code: 'BAD_ARGUMENT' });
  // Auto slots: 16 GB / 8 cores -> 3 (the measured limit for the shared MacBook Air); never below 1.
  assert.equal(heavySlots('auto', 16 * 2 ** 30, 8), 3);
  assert.equal(heavySlots('auto', 4 * 2 ** 30, 2), 1);
  assert.equal(heavySlots('auto', 64 * 2 ** 30, 8), 4);
  assert.equal(heavySlots(5), 5);
});

test('start lists idle open Lanes and prunes finished roots after one batched read per 100 Lanes', async t => {
  const directory = isolated(t);
  const lanes = Array.from({ length: 250 }, () => randomUUID());
  const roots = lanes.map((laneId, index) => checkout(directory, `lane-${index}`, laneId));
  const now = Date.now();
  for (const [index, laneId] of lanes.entries())
    recordLane(
      { laneId, root: roots[index], ...address, outcome: `Outcome ${index}`, lastActionAt: now - 5 * hour },
      now,
    );
  // A recent Lane is neither read nor listed.
  const fresh = randomUUID();
  recordLane({ laneId: fresh, root: checkout(directory, 'fresh', fresh, false), ...address }, now);
  const state = index => (index < 3 ? 'completed' : index < 5 ? 'abandoned' : 'active');
  const reads = [];
  const readStates = async (selected, laneIds) => {
    assert.deepEqual(selected, address);
    reads.push(laneIds.length);
    return new Map(laneIds.map(laneId => [laneId, state(lanes.indexOf(laneId))]));
  };
  const memory = process.memoryUsage().heapUsed;
  const result = await laneHousekeeping({ readStates, address, apply: true, now });
  // Dogfood budget: 250 due Lanes -> 3 calls, never one per Lane.
  assert.deepEqual(reads, [100, 100, 50]);
  assert(process.memoryUsage().heapUsed - memory < 64 * 2 ** 20);
  assert.equal(result.pruned.length, 5);
  for (const index of [0, 1, 2, 3, 4]) {
    assert(!existsSync(roots[index]));
    assert(!existsSync(`${roots[index]}.forge-client`));
    assert(!existsSync(`${roots[index]}.forge-metrics.jsonl`));
    assert.equal(readLaneEntry(lanes[index]), null);
  }
  assert.equal(result.idle.length, 245);
  assert.equal(result.idle[0].idleHours, 5);
  assert(existsSync(roots[5]));
  const lines = housekeepingLines('/root', result.idle, { count: 5, bytes: 5e9 });
  assert.equal(lines[0], 'Idle Lanes (yours, no Forge action): 245. Land or abandon them:');
  assert.equal(lines.length, 13);
  assert.match(lines.at(-1), /^Pruned 5 finished Lane root\(s\), 5\.00 GB\.$/);
  // Settings 0 turn each behaviour off; nothing is read when nothing is due.
  reads.length = 0;
  const off = await laneHousekeeping({
    readStates,
    address,
    apply: true,
    now,
    settings: { autoPruneHours: 0, idleLaneHours: 0 },
  });
  assert.deepEqual([reads, off.idle, off.pruned], [[], [], []]);
});

test('prune keeps unknown, recent, in-use and parent roots, and an old server prunes nothing', async t => {
  const directory = isolated(t);
  const now = Date.now();
  const make = name => {
    const laneId = randomUUID(),
      root = checkout(directory, name, laneId);
    recordLane({ laneId, root, ...address, lastActionAt: now - 5 * hour }, now);
    return { laneId, root };
  };
  const recent = make('recent'),
    parent = make('parent'),
    used = make('used'),
    other = make('other'),
    gone = make('gone');
  writeFileSync(join(recent.root, 'new.txt'), 'edited after landing');
  mkdirSync(`${parent.root}.forge-client/lanes/${randomUUID()}`, { recursive: true });
  rmSync(gone.root, { recursive: true });
  // A node_modules symlink is removed as a link; its target survives.
  const shared = join(directory, 'shared-node-modules');
  mkdirSync(shared);
  symlinkSync(shared, join(other.root, 'node_modules'));
  const when = new Date(Date.now() - 10 * hour);
  lutimesSync(join(other.root, 'node_modules'), when, when);
  age([other.root], 10);
  const completed = async (_address, laneIds) => new Map(laneIds.map(laneId => [laneId, 'completed']));
  const result = await laneHousekeeping({
    readStates: completed,
    address,
    apply: true,
    now,
    exclude: { roots: [used.root] },
  });
  const kept = Object.fromEntries(result.kept.map(item => [item.laneId, item.reason]));
  assert.equal(kept[recent.laneId], 'modified within 3h');
  assert.equal(kept[parent.laneId], 'contains other Lane roots');
  assert.equal(kept[used.laneId], 'in use by this command');
  assert.deepEqual(
    result.pruned.map(item => item.laneId),
    [other.laneId],
  );
  assert(existsSync(shared));
  assert.equal(readLaneEntry(gone.laneId), null);
  // A deployment without the batched read: state unknown, nothing removed.
  const next = make('next');
  const old = await laneHousekeeping({ readStates: async () => null, address, apply: true, now });
  assert.equal(old.pruned.length, 0);
  assert(existsSync(next.root));
});

test('prune --scan adopts existing checkouts, including nested Lane roots and resolve symlinks', async t => {
  const directory = isolated(t);
  const hosted = join(directory, 'hosted');
  mkdirSync(hosted);
  const top = randomUUID(),
    nested = randomUUID();
  checkout(hosted, 'lane-aaaaaaaa', top);
  const nestedRoot = checkout(join(hosted, 'lane-bbbbbbbb.forge-client', 'lanes'), nested, nested);
  mkdirSync(join(hosted, 'lane-bbbbbbbb'));
  symlinkSync(nestedRoot, join(hosted, 'lane-cccccccc'));
  const result = await laneHousekeeping({
    readStates: async (_address, laneIds) => new Map(laneIds.map(laneId => [laneId, 'abandoned'])),
    apply: false,
    scan: hosted,
  });
  assert.deepEqual(new Set(listLanes().map(entry => entry.laneId)), new Set([top, nested]));
  assert.equal(result.pruned.length, 2);
  assert(existsSync(nestedRoot), 'dry run removes nothing');
  await laneHousekeeping({
    readStates: async (_address, laneIds) => new Map(laneIds.map(laneId => [laneId, 'abandoned'])),
    apply: true,
    scan: hosted,
  });
  assert.deepEqual(readdirSync(hosted).sort(), ['lane-bbbbbbbb', 'lane-bbbbbbbb.forge-client']);
});

test('heavy slots are machine-wide, reclaim dead holders and run the command with its exit code', async t => {
  const directory = isolated(t),
    slots = join(directory, 'slots');
  const first = tryHeavySlot(slots, 2),
    second = tryHeavySlot(slots, 2);
  assert(first && second);
  assert.equal(tryHeavySlot(slots, 2), null);
  // A holder that died without releasing its slot.
  writeFileSync(join(first, 'pid'), '999999');
  assert.equal(tryHeavySlot(slots, 2), first);
  // A waiter wakes when a slot is released.
  const waiting = acquireHeavySlot(slots, 2);
  rmSync(second, { recursive: true });
  assert.equal(await waiting, second);
  writeFileSync(process.env.FORGE_CLIENT_SETTINGS, JSON.stringify({ localHeavySlots: 1 }));
  assert.equal(await heavyCli([process.execPath, '-e', 'process.exit(7)']), 7);
  assert.deepEqual(readdirSync(process.env.FORGE_HEAVY_DIR), []);
  writeFileSync(process.env.FORGE_CLIENT_SETTINGS, JSON.stringify({ localHeavySlots: 0 }));
  assert.equal(await heavyCli([process.execPath, '-e', '']), 0);
});

test('shared dependencies install once per lockfile hash and never share a different lockfile', async t => {
  const directory = isolated(t),
    cache = join(directory, 'deps');
  const lane = (name, lock) => {
    const root = join(directory, name);
    mkdirSync(root);
    writeFileSync(join(root, 'package.json'), '{"name":"x"}');
    writeFileSync(join(root, 'package-lock.json'), lock);
    return root;
  };
  let installs = 0;
  const install = async stage => {
    installs++;
    await new Promise(resolve => setTimeout(resolve, 20));
    mkdirSync(join(stage, 'node_modules', 'dep'), { recursive: true });
    writeFileSync(
      join(stage, 'node_modules', 'dep', 'lock.txt'),
      readFileSync(join(stage, 'package-lock.json')),
    );
  };
  const options = { install, enabled: true, cache };
  const [a, b] = [lane('a', '{"v":1}'), lane('b', '{"v":1}')];
  const [first, second] = await Promise.all([shareDependencies(a, options), shareDependencies(b, options)]);
  assert.equal(installs, 1, 'concurrent opens of one lockfile install once');
  assert.deepEqual(new Set([first.status, second.status]), new Set(['installed', 'linked']));
  assert(lstatSync(join(a, 'node_modules')).isSymbolicLink());
  assert.equal(readFileSync(join(b, 'node_modules', 'dep', 'lock.txt'), 'utf8'), '{"v":1}');
  const c = lane('c', '{"v":2}');
  assert.notEqual(dependencyKey(c), dependencyKey(a));
  assert.equal((await shareDependencies(c, options)).status, 'installed');
  assert.equal(readFileSync(join(c, 'node_modules', 'dep', 'lock.txt'), 'utf8'), '{"v":2}');
  assert.equal(installs, 2);
  assert.equal((await shareDependencies(c, options)).status, 'present');
  assert.equal((await shareDependencies(lane('d', '{"v":1}'), { ...options, enabled: false })).status, 'off');
  assert.equal((await shareDependencies(directory, options)).status, 'none');
  const failed = await shareDependencies(lane('e', '{"v":3}'), {
    ...options,
    install: async () => {
      throw new Error('registry down');
    },
  });
  assert.equal(failed.status, 'failed');
  assert(!existsSync(join(directory, 'e', 'node_modules')));
  assert.equal(
    readdirSync(cache).filter(name => name.includes('.tmp-')).length,
    0,
    'a failed install leaves no partial cache',
  );
});

test('land summary names the outcome, each failing file and its first error', () => {
  const response = (phase, extra = {}) => ({ result: { phase: 'finish', submission: { phase, ...extra } } });
  assert.deepEqual(landSummary(response('landed', { acceptance: { receiptId: 'r1', head: 'h' } })), [
    'LANDED receipt r1',
  ]);
  assert.deepEqual(landSummary(response('ready')), ['CHECK PASSED (not landed)']);
  const failed = Array.from({ length: 22 }, (_, index) => ({
    file: `tests/f${index}.test.mjs`,
    report: index === 0 ? { firstError: 'AssertionError:\n  expected 1' } : {},
  }));
  assert.deepEqual(
    landSummary(
      response('terminal-failed', {
        error: { code: 'CHECK_FAILED', message: 'Landing check failed.' },
        testFiles: { counts: { total: 30, failed: 22, flaky: 0 }, failed, flaky: [] },
      }),
    ).slice(0, 3),
    [
      'FAILED CHECK_FAILED: Landing check failed.',
      '  tests/f0.test.mjs :: AssertionError: expected 1',
      '  tests/f1.test.mjs',
    ],
  );
  assert.equal(
    landSummary(
      response('terminal-failed', {
        error: null,
        testFiles: { counts: { total: 30, failed: 22, flaky: 0 }, failed, flaky: [] },
      }),
    ).at(-1),
    '  ... 2 more failing files',
  );
});

test('a closed stdout reader never crashes the CLI, and messages arrive verbatim from stdin', async t => {
  const directory = isolated(t);
  const cli = new URL('../dist/cli-entry.js', import.meta.url).pathname;
  // Simulate `| head`: the reader goes away before the CLI writes its receipt.
  const child = spawn(process.execPath, [cli, 'settings'], { stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.destroy();
  let stderr = '';
  child.stderr.on('data', chunk => (stderr += chunk));
  const status = await new Promise(resolve => child.once('exit', code => resolve(code)));
  assert.equal(status, 0);
  assert.doesNotMatch(stderr, /EPIPE|Unhandled|Error/);
  const message = 'It\'s done\nsecond line with "quotes"\n';
  // Native ROOT does not exist: the message is read before the root is opened.
  const result = spawnSync(
    process.execPath,
    [cli, 'agent', join(directory, 'missing'), 'save', '--message-file', '-', '{"laneId":"x"}'],
    { input: message, encoding: 'utf8' },
  );
  assert.notEqual(result.status, 0);
  assert.doesNotMatch(result.stderr, /could not be read|BAD_ARGUMENT/);
  const unreadable = spawnSync(
    process.execPath,
    [cli, 'agent', join(directory, 'missing'), 'save', '--message-file', join(directory, 'none.txt'), '{}'],
    { encoding: 'utf8' },
  );
  assert.match(unreadable.stderr, /Message file could not be read/);
});
