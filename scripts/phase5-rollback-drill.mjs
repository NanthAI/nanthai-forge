// SPDX-License-Identifier: Apache-2.0
// Offline qualification only. Existing owners are read only by APFS clone.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { getFunctionName } from 'convex/server';
import { WorkStore } from '../dist/work-store.js';
import { NativeSource } from '../dist/native-source.js';
import { NativeMaterialization } from '../dist/native-materialization.js';
import { initNative, nativeExecute } from '../dist/native-work.js';
import { exportNativeWork, restoreNativeWork } from '../dist/native-backup.js';
import { updateHostState, readHostState } from '../dist/host-binding.js';
import { transitionBoundSourceAuthority } from '../dist/source-authority-client.js';
import { policyPreset } from '../dist/autonomy-policy.js';
import { lanesFixture } from '../tests/hosted-lanes-fixture.mjs';
import { moduleUrl } from '../tests/convex-module.mjs';
import { cloneRollbackOwner, scrubRollbackCopy } from './phase5-rollback-copy.mjs';

const backend = await import(moduleUrl('../convex/projectSourceAuthority.ts'));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const timings = {};
async function timed(name, action) {
  console.error(`rollback drill: ${name}`);
  const start = performance.now();
  const result = await action();
  timings[name] = Number(((performance.now() - start) / 1000).toFixed(3));
  console.error(`rollback drill: ${name} ${timings[name]}s`);
  return result;
}
const [option, input] = process.argv.slice(2);
assert(
  !option || (['--clone-owner', '--prepared-copy'].includes(option) && input && process.argv.length === 4),
  'Use --clone-owner SOURCE or no arguments for synthetic qualification',
);
const directory =
  option === '--prepared-copy'
    ? realpathSync(input)
    : realpathSync(mkdtempSync(join(tmpdir(), 'forge-b1-dogfood-')));
if (option === '--prepared-copy') {
  assert(
    dirname(directory) === realpathSync(tmpdir()) && basename(directory).startsWith('forge-b1-dogfood-'),
  );
  assert.equal(JSON.parse(readFileSync(join(directory, 'clone.json'))).kind, 'forge-b1-sanitized-apfs-clone');
}
const owner = join(directory, 'owner'),
  target = join(directory, 'restored');
process.env.FORGE_AUTO_EXCHANGE_WORKER = '1';
process.env.FORGE_CHECK_QUEUE_DIR = join(directory, 'check-queue');
process.env.XDG_CONFIG_HOME = join(directory, 'config');
const restoreProfile = { workLoadSeconds: 0, materializeSeconds: 0, materializations: 0 };
let summary;
try {
  if (option === '--clone-owner')
    await timed('clone-and-scrub', () => {
      cloneRollbackOwner(input, owner);
      writeFileSync(join(directory, 'clone.json'), JSON.stringify({ kind: 'forge-b1-sanitized-apfs-clone' }));
    });
  else if (!option) {
    mkdirSync(owner);
    writeFileSync(join(owner, 'main.txt'), 'synthetic initial main\n');
    initNative(owner);
  }
  // Scrub before constructing any owner service.
  scrubRollbackCopy(owner);
  for (const name of ['lock', 'lock-queue', 'lane-locks'])
    rmSync(join(owner, '.forge/work', name), { recursive: true, force: true });
  const store = new WorkStore(owner);
  await timed('isolate-copy-policy', () =>
    store.locked(() => {
      const data = store.load();
      // The drill must never execute retained automations or contact real providers.
      // Only the throwaway copy's policy is changed; all source/history stays retained.
      data.autonomyPolicy = policyPreset('supervised');
      for (const automation of data.automations) automation.enabled = false;
      store.save(data);
    }),
  );
  const act = (command, selected = store) =>
    nativeExecute(selected, { operationId: randomUUID(), ...command }, selected.revision(), { compact: true })
      .result;
  const checkpoint = (selected, head, message, laneId = lane.id) => {
    const source = new NativeSource(selected.root);
    return act(
      {
        action: 'checkpoint',
        laneId,
        expectedHead: head,
        expectedTree: source.tree(source.capture(selected.path(laneId), false, head)),
        message,
      },
      selected,
    );
  };
  if (!option) {
    const intent = act({ action: 'intent', outcome: 'Synthetic accepted main differs from bootstrap' });
    const seed = act({ action: 'lane', intentId: intent.id, name: 'Accepted main seed' });
    writeFileSync(join(store.path(seed.id), 'main.txt'), 'accepted main before the drill\n');
    const saved = checkpoint(store, seed.head, 'Seed accepted main', seed.id);
    const view = act({
      action: 'compose',
      intentId: intent.id,
      inputs: [{ laneId: seed.id, head: saved.head }],
    });
    act({
      action: 'accept-channel',
      channel: 'main',
      viewId: view.id,
      expectedHead: view.head,
      expectedPrevious: null,
    });
  }
  const lane = await timed('prepare-edit-lane', () => {
    const moves = store.readRecords()?.all('channelMoves', 'main', 'channel') ?? store.load().channelMoves;
    const main = moves
      .slice()
      .reverse()
      .find(move => move.channel === 'main' && move.status === 'accepted');
    const intent = act({
      action: 'intent',
      outcome: 'Offline authority rollback qualification',
      ...(main ? { baseChannel: { name: 'main', head: main.head, acceptanceId: main.id } } : {}),
    });
    if (main)
      assert.equal(intent.base, main.head, 'Drill must start from accepted main, not native bootstrap');
    return act({ action: 'lane', intentId: intent.id, name: 'Rollback drill change' });
  });
  const fake = lanesFixture();
  const projectId = fake.insert('hostedProjects', {
    name: 'Synthetic rollback',
    owner: 'owner',
    key: randomUUID(),
    currentBackup: null,
    revision: 0,
  });
  const client = {
    mutation: (ref, args) => {
      assert.equal(getFunctionName(ref), 'projectSourceAuthority:transition');
      return fake.call('transition', backend.transition, args);
    },
  };
  function bind(selected, authority) {
    updateHostState(selected, state => {
      state.binding = {
        projectId,
        operationId: randomUUID(),
        deployment: 'http://127.0.0.1:1',
        projectUrl: 'https://example.invalid/offline-drill',
        name: 'Offline fake',
        visibility: 'private',
        backupId: 'local-only',
        acceptanceOwner: true,
        autoSync: false,
        sourceAuthority: authority,
      };
    });
  }
  const native = { mode: 'native-owner', epoch: 0 },
    server = { mode: 'server', epoch: 1 };
  bind(store, native);
  const forward = { operationId: randomUUID(), expected: native, mode: 'server' };
  assert.deepEqual(
    await timed('forward-transition', () => transitionBoundSourceAuthority(store, forward, client)),
    server,
  );
  const saved = await timed('edit-and-checkpoint', () => {
    writeFileSync(
      join(store.path(lane.id), 'rollback-drill.txt'),
      'saved while local hosted authority is selected\n',
    );
    return checkpoint(store, lane.head, 'Rollback drill saved change');
  });
  const backup = await timed(
    'archive-export',
    async () => (await exportNativeWork(store, store.revision(), true)).result,
  );
  const portable = readFileSync(join(backup.path, 'work.json'));
  const before = JSON.parse(portable);
  const originalLoad = WorkStore.prototype.load,
    originalMaterialize = NativeMaterialization.prototype.materialize;
  WorkStore.prototype.load = function (...args) {
    const start = performance.now();
    try {
      return originalLoad.apply(this, args);
    } finally {
      restoreProfile.workLoadSeconds += (performance.now() - start) / 1000;
    }
  };
  NativeMaterialization.prototype.materialize = function (...args) {
    const start = performance.now();
    try {
      return originalMaterialize.apply(this, args);
    } finally {
      restoreProfile.materializeSeconds += (performance.now() - start) / 1000;
      restoreProfile.materializations++;
    }
  };
  let restored;
  try {
    restored = await timed('archive-restore', () => restoreNativeWork(backup.archive.path, target));
  } finally {
    WorkStore.prototype.load = originalLoad;
    NativeMaterialization.prototype.materialize = originalMaterialize;
  }
  const recovered = new WorkStore(target);
  await timed('compare-source-lanes-and-records', () => {
    const actual = recovered.load();
    let interrupted = false;
    for (const collection of ['runs', 'playbookRuns'])
      for (const run of before[collection]) {
        if (!['queued', 'preparing', 'running'].includes(run.status)) continue;
        const after = actual[collection].find(item => item.id === run.id);
        assert.equal(after.status, 'interrupted');
        assert(after.endedAt);
        run.status = 'interrupted';
        run.endedAt = after.endedAt;
        run.details += ' Native snapshot restored without restarting commands.';
        interrupted = true;
      }
    if (interrupted) before.revision++;
    assert.deepEqual(actual, before, 'Logical Work records, Lanes and acceptance receipts must round trip');
    assert.equal(restored.revision, before.revision);
    const source = new NativeSource(owner),
      recoveredSource = new NativeSource(target);
    for (const head of new Set([
      before.nativeHead,
      ...before.lanes.flatMap(item => [item.base, item.head]),
      ...before.channelMoves.map(item => item.head),
    ]))
      assert.deepEqual(recoveredSource.object(head), source.object(head), 'Retained source State changed');
    assert.equal(
      readFileSync(join(recovered.path(lane.id), 'rollback-drill.txt'), 'utf8'),
      'saved while local hosted authority is selected\n',
    );
  });
  bind(recovered, server);
  const reverse = { operationId: randomUUID(), expected: server, mode: 'native-owner' };
  const authority = await timed('reverse-transition', () =>
    transitionBoundSourceAuthority(recovered, reverse, client),
  );
  assert.deepEqual(authority, { mode: 'native-owner', epoch: 2 });
  assert.deepEqual(readHostState(recovered).binding.sourceAuthority, authority);
  assert.deepEqual(await transitionBoundSourceAuthority(recovered, reverse, client), authority);
  await timed('checkpoint-and-land-locally', () => {
    writeFileSync(
      join(recovered.path(lane.id), 'rollback-drill.txt'),
      'checkpointed and landed after rollback\n',
    );
    const localSave = checkpoint(recovered, saved.head, 'Local write after rollback');
    const view = act(
      { action: 'compose', intentId: lane.intentId, inputs: [{ laneId: lane.id, head: localSave.head }] },
      recovered,
    );
    const previous =
      [...before.channelMoves].reverse().find(move => move.channel === 'main' && move.status === 'accepted')
        ?.head ?? null;
    const accepted = act(
      {
        action: 'accept-channel',
        channel: 'main',
        viewId: view.id,
        expectedHead: view.head,
        expectedPrevious: previous,
      },
      recovered,
    );
    assert.equal(accepted.status, 'accepted');
    assert.equal(accepted.head, view.head);
    const source = new NativeSource(target),
      file = source.state(accepted.head).files.find(file => file.path === 'rollback-drill.txt');
    assert.equal(source.object(file.blob).toString(), 'checkpointed and landed after rollback\n');
  });
  summary = {
    kind: option ? 'dogfood-copy' : 'synthetic',
    timings,
    restoreProfile,
    archive: { bytes: backup.archive.size, files: backup.files, sha256: backup.archive.sha256 },
    portableWorkSha256: hash(portable),
    lanes: before.lanes.length,
    forward: server,
    reverse: authority,
    byteIdenticalSourceStates: true,
    logicalRecordsMatch: true,
    restoreInterruptedUnfinishedRuns: true,
    localCheckpointAndLanding: true,
    unrun: [
      'real hosted accounts and deployment',
      'hosted-only recovery folding (B1.5a)',
      'production Route A/Route B and drain concurrency',
    ],
  };
} catch (error) {
  console.error('rollback drill failed:', error.code ?? error.name, error.message);
  throw error;
} finally {
  await timed('cleanup', () => rmSync(directory, { recursive: true, force: true }));
  assert(!existsSync(directory));
}
console.log(JSON.stringify({ ...summary, copyDeleted: true }, null, 2));
