// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { getFunctionName } from 'convex/server';
import { saveHostedLane } from '../dist/hosted-save-client.js';
import { hostedAgentDirectory } from '../dist/hosted-agent-journal.js';
import { adoptNestedLaneCopy } from '../dist/hosted-lane-adopt.js';
import { recordLane } from '../dist/lane-registry.js';
import { laneHousekeeping } from '../dist/lane-prune.js';
import {
  forgeTempDir,
  forgeTempRoot,
  neverIndexName,
  sweepEntries,
  sweepHourly,
  tempEntryInUse,
  treeBytes,
} from '../dist/forge-disk.js';
import { digest } from '../dist/hash.js';

const blob = /^[0-9a-f]{64}$/;
const hour = 3_600_000;
function scratch(t, prefix = 'forge-client-store-') {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  return directory;
}
function registry(t) {
  const saved = process.env.XDG_STATE_HOME;
  process.env.XDG_STATE_HOME = scratch(t, 'forge-client-store-state-');
  t.after(() => {
    if (saved === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = saved;
  });
}
const selection = (laneId, head) => ({
  schema: 2,
  projectId: 'project',
  laneId,
  intentId: randomUUID(),
  head,
  version: 0,
  sourceVersion: 0,
  lifecycleVersion: 0,
  state: 'active',
  base: { head: 'a'.repeat(64), receiptId: 'base' },
  authority: { mode: 'server', epoch: 1 },
});
const stateOf = files => ({
  schema: 1,
  kind: 'forge-source-state',
  parents: [],
  files,
  message: 'synthetic',
  at: '2026-01-01T00:00:00Z',
});
/** A saved Lane checkout of COUNT files (marker baseline equals the working tree). */
function laneCheckout(t, count, size = 2048) {
  const directory = scratch(t),
    root = join(directory, 'lane');
  mkdirSync(join(root, '.forge'), { recursive: true });
  const files = [];
  for (let index = 0; index < count; index++) {
    const path = `src/d${index % 30}/f${String(index).padStart(4, '0')}.ts`,
      bytes = Buffer.from(`export const v${index} = '${'x'.repeat(size)}';\n`);
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), bytes);
    files.push({ path, blob: digest(bytes), mode: 'file' });
  }
  files.sort((a, b) => (a.path < b.path ? -1 : 1));
  const marker = {
    schema: 1,
    kind: 'forge-hosted-lane-checkout',
    url: 'https://fixture.invalid',
    operationId: randomUUID(),
    selection: selection(randomUUID(), 'b'.repeat(64)),
    state: stateOf(files),
    scope: null,
    materialized: files.map(file => file.path),
  };
  const writeMarker = () => writeFileSync(join(root, '.forge/hosted-lane.json'), JSON.stringify(marker));
  writeMarker();
  /** The server accepted the save: the baseline now holds the edited bytes. */
  const advance = (path, bytes) => {
    const file = marker.state.files.find(entry => entry.path === path);
    file.blob = digest(bytes);
    marker.selection.version++;
    writeMarker();
  };
  return { directory, root, files, advance, client: `${root}.forge-client` };
}
/** Fake exchange: lazy raw uploads, prepare answers or fails. Counts staged blobs at prepare. */
function exchange(root, prepare = () => ({ terminal: { outcome: { status: 'failed' } } })) {
  const calls = { prepare: 0, uploads: 0, uploadedBytes: 0, stagedAtPrepare: [] };
  return {
    calls,
    exchange: {
      projectId: 'project',
      client: {
        mutation: async (reference, args) => {
          const name = getFunctionName(reference);
          assert.equal(name, 'projectHostedSaves:prepare', `unexpected ${name}`);
          calls.prepare++;
          const operationId = JSON.parse(args.request).operationId;
          calls.stagedAtPrepare.push(
            readdirSync(join(`${root}.forge-client`, 'saves', operationId)).filter(name => blob.test(name)),
          );
          return JSON.stringify(await prepare(operationId));
        },
        query: async () => assert.fail('no query expected'),
      },
      uploadLazyBatch: async (items, options) => {
        for (const item of items) {
          calls.uploads++;
          calls.uploadedBytes += item.read().length;
          options.onRaw?.(item.pin.sha256);
        }
      },
      uploadFile: async () => assert.fail('no large files'),
      upload: async () => assert.fail('no direct uploads'),
      missing: async () => [],
    },
  };
}
const save = (root, fake, operationId = randomUUID()) =>
  saveHostedLane(root, { operationId, message: 'save' }, fake.exchange);
const stagedBlobs = (client, operationId) =>
  readdirSync(join(client, 'saves', operationId)).filter(name => blob.test(name));

test('dogfood-size Lane: 20 saves stage only changed blobs and keep no staging after ack', async t => {
  const lane = laneCheckout(t, 3000),
    fake = exchange(lane.root),
    tree = treeBytes(join(lane.root, 'src'));
  const started = performance.now();
  for (let index = 0; index < 20; index++) {
    const path = lane.files[index * 7].path,
      bytes = Buffer.from(`changed ${index}\n`);
    writeFileSync(join(lane.root, path), bytes);
    const operationId = randomUUID();
    await save(lane.root, fake, operationId);
    lane.advance(path, bytes);
    // Staged at prepare: the one changed file, not the 3,000-file tree.
    assert.deepEqual(fake.calls.stagedAtPrepare.at(-1), [digest(bytes)]);
    assert.deepEqual(stagedBlobs(lane.client, operationId), []);
    // Settled: command, request and outcome answer a retry; the baseline capture is gone.
    assert.deepEqual(readdirSync(join(lane.client, 'saves', operationId)).sort(), [
      'acknowledged',
      'command.json',
      'request.json',
      'terminal.json',
    ]);
  }
  const elapsed = performance.now() - started,
    client = treeBytes(join(lane.client, 'saves'));
  assert.equal(fake.calls.uploads, 20);
  assert.equal(fake.calls.prepare, 20);
  // Before this change each save kept a full copy of the tree (20 saves = 20x the tree).
  // Each settled save holds a directory and four small files: at most five 4 KiB blocks.
  assert(client <= 20 * 5 * 4096, `saves ${client} B vs tree ${tree} B`);
  // A retry of a settled save answers from its receipt without another server call.
  const settled = readdirSync(join(lane.client, 'saves'))[0];
  assert.deepEqual(await save(lane.root, fake, settled), { outcome: { status: 'failed' } });
  assert.equal(fake.calls.prepare, 20);
  t.diagnostic(
    `tree ${tree} B (3000 files); 20 saves staging ${client} B (old layout ~${20 * tree} B); ` +
      `${Math.round(elapsed)} ms total, ${Math.round(elapsed / 20)} ms/save`,
  );
});

test('an unacknowledged save keeps its staged blobs until its retry is acknowledged', async t => {
  const lane = laneCheckout(t, 20),
    path = lane.files[0].path;
  writeFileSync(join(lane.root, path), 'edited\n');
  const lost = exchange(lane.root, () => {
    throw new Error('socket hang up');
  });
  const unacked = randomUUID();
  await assert.rejects(save(lane.root, lost, unacked), /socket hang up/);
  assert.deepEqual(stagedBlobs(lane.client, unacked), [digest('edited\n')]);
  assert.equal(existsSync(join(lane.client, 'saves', unacked, 'acknowledged')), false);
  // Later edits do not change the retry: it sends the exact captured bytes, then drops them on ack.
  writeFileSync(join(lane.root, path), 'newer\n');
  const fake = exchange(lane.root);
  await save(lane.root, fake, unacked);
  assert.deepEqual(fake.calls.stagedAtPrepare, [[digest('edited\n')]]);
  assert.deepEqual(stagedBlobs(lane.client, unacked), []);
});

test('older full-tree saves lose their blobs on the next save; unprepared ones keep them', async t => {
  const lane = laneCheckout(t, 5);
  const legacy = join(lane.client, 'saves', randomUUID()),
    unprepared = join(lane.client, 'saves', randomUUID());
  for (const directory of [legacy, unprepared]) {
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, 'c'.repeat(64)), 'old full tree copy');
    writeFileSync(join(directory, 'capture.json'), '{}');
  }
  writeFileSync(join(legacy, 'request.json'), '{}');
  writeFileSync(join(lane.root, lane.files[0].path), 'edited\n');
  await save(lane.root, exchange(lane.root));
  assert.deepEqual(readdirSync(legacy).sort(), ['capture.json', 'request.json']);
  assert(existsSync(join(unprepared, 'c'.repeat(64))));
});

test('Forge roots it creates carry the Spotlight never-index marker; Lane trees do not', async t => {
  const lane = laneCheckout(t, 3),
    directory = scratch(t);
  writeFileSync(join(lane.root, lane.files[0].path), 'edited\n');
  await save(lane.root, exchange(lane.root));
  hostedAgentDirectory(join(directory, 'agent-root'));
  const temp = forgeTempDir('client-store-test');
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  for (const path of [lane.client, `${join(directory, 'agent-root')}.forge-client`, forgeTempRoot()])
    assert(existsSync(join(path, neverIndexName)), path);
  // A Lane root stays exactly its source: a marker there would be an untracked file.
  assert.equal(existsSync(join(lane.root, neverIndexName)), false);
  assert.equal(dirname(temp), forgeTempRoot());
  assert.match(temp, new RegExp(`client-store-test-${process.pid}-`));
});

test('forge-tmp sweep: entries older than 2 h go; a live writer or a recent write keeps them', t => {
  const directory = scratch(t),
    now = Date.now();
  const entry = (name, ageMs) => {
    mkdirSync(join(directory, name));
    writeFileSync(join(directory, name, 'data'), Buffer.alloc(4096));
    const at = (now - ageMs) / 1000;
    utimesSync(join(directory, name), at, at);
  };
  const dead = 2 ** 22 + 12345;
  entry(`old-${dead}-aaaaaa`, 3 * hour);
  entry(`held-${process.pid}-bbbbbb`, 3 * hour);
  entry(`recent-${dead}-cccccc`, 90 * 60_000);
  assert.equal(tempEntryInUse(`held-${process.pid}-bbbbbb`), true);
  assert.equal(tempEntryInUse(`old-${dead}-aaaaaa`), false);
  const policy = { maxAgeMs: 2 * hour, inUse: name => tempEntryInUse(name) };
  const result = sweepEntries(directory, policy, now);
  assert.deepEqual(readdirSync(directory).sort(), [`held-${process.pid}-bbbbbb`, `recent-${dead}-cccccc`]);
  assert.deepEqual(
    { removed: result.removed, kept: result.kept, finished: result.finished },
    {
      removed: 1,
      kept: 2,
      finished: true,
    },
  );
  // Hourly: a second pass inside the hour does nothing.
  assert(sweepHourly(directory, policy, now));
  entry(`late-${dead}-ffffff`, 3 * hour);
  assert.equal(sweepHourly(directory, policy, now + 60_000), null);
  assert(existsSync(join(directory, `late-${dead}-ffffff`)));
  assert(sweepHourly(directory, policy, now + hour + 1));
  assert.equal(existsSync(join(directory, `late-${dead}-ffffff`)), false);
});

test('open moves the nested copy start made instead of downloading a second root', async t => {
  registry(t);
  const directory = scratch(t),
    laneId = randomUUID(),
    address = { url: 'https://fixture.invalid', projectId: 'project' };
  const nested = join(directory, 'lead.forge-client', 'lanes', laneId),
    target = join(directory, `lane-${laneId.slice(0, 8)}`);
  mkdirSync(join(nested, '.forge'), { recursive: true });
  writeFileSync(
    join(nested, '.forge/hosted-lane.json'),
    JSON.stringify({ url: address.url, selection: { laneId, projectId: 'project' } }),
  );
  writeFileSync(join(nested, 'kept.txt'), 'kept');
  symlinkSync(directory, join(nested, 'node_modules'));
  mkdirSync(`${nested}.forge-client`);
  recordLane({ laneId, root: nested, ...address });
  // Another project or a held lock leaves the copy alone.
  assert.equal(adoptNestedLaneCopy(target, laneId, { ...address, projectId: 'other' }), null);
  mkdirSync(`${nested}.forge-client/lock`);
  assert.equal(adoptNestedLaneCopy(target, laneId, address), null);
  rmSync(`${nested}.forge-client/lock`, { recursive: true });
  assert.equal(adoptNestedLaneCopy(target, laneId, address), nested);
  assert.equal(existsSync(nested), false);
  assert.equal(existsSync(`${nested}.forge-client`), false);
  assert.equal(readFileSync(join(target, 'kept.txt'), 'utf8'), 'kept');
  assert.equal(existsSync(join(target, 'node_modules')), false);
  // An existing target is never replaced.
  assert.equal(adoptNestedLaneCopy(target, laneId, address), null);
});

test('prune --scan removes links whose nested Lane copy is gone, keeps live links', async t => {
  registry(t);
  const directory = scratch(t);
  const live = join(directory, 'lead.forge-client', 'lanes', randomUUID());
  mkdirSync(live, { recursive: true });
  symlinkSync(live, join(directory, 'lane-live'));
  symlinkSync(join(directory, 'lead.forge-client', 'lanes', randomUUID()), join(directory, 'lane-gone'));
  symlinkSync(join(directory, 'elsewhere'), join(directory, 'user-link'));
  const options = {
    readStates: async () => new Map(),
    settings: { autoPruneHours: 3, idleLaneHours: 0 },
    scan: directory,
  };
  await laneHousekeeping({ ...options, apply: false });
  assert(lstatSync(join(directory, 'lane-gone')).isSymbolicLink());
  await laneHousekeeping({ ...options, apply: true });
  assert.deepEqual(readdirSync(directory).sort(), ['lane-live', 'lead.forge-client', 'user-link']);
});

test('a save writes its changed blobs, and only those, through to the machine object store', async t => {
  const store = join(scratch(t, 'forge-client-store-machine-'), 'objects'),
    saved = process.env.FORGE_OBJECT_CACHE;
  process.env.FORGE_OBJECT_CACHE = store;
  t.after(() => {
    if (saved === undefined) delete process.env.FORGE_OBJECT_CACHE;
    else process.env.FORGE_OBJECT_CACHE = saved;
  });
  const lane = laneCheckout(t, 50);
  writeFileSync(join(lane.root, lane.files[3].path), 'machine\n');
  await save(lane.root, exchange(lane.root));
  assert.deepEqual(
    readdirSync(store).filter(name => blob.test(name)),
    [digest('machine\n')],
  );
  assert.equal(readFileSync(join(store, digest('machine\n')), 'utf8'), 'machine\n');
  assert.equal(lstatSync(join(store, digest('machine\n'))).nlink, 1);
  assert(existsSync(join(store, neverIndexName)));
});
