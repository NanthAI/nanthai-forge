// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { agentFixture } from './hosted-agent-fixture.mjs';
import { initNative } from '../dist/native-work.js';
import { NativeSource } from '../dist/native-source.js';
import { WorkStore } from '../dist/work-store.js';
import { updateHostState } from '../dist/host-binding.js';
import { ownerDrainBlockers, requireOwnerDrained } from '../dist/hosted-agent-owner-drain.js';

const native = { mode: 'native-owner', epoch: 0 };
const code = c => e => e.code === c;
function fixture(t, mode = 'server') {
  const f = agentFixture(t);
  mkdirSync(f.root);
  initNative(f.root);
  const store = new WorkStore(f.root),
    source = new NativeSource(f.root);
  for (const file of f.laneFiles) source.put(f.objects.get(file.blob));
  source.put(f.objects.get(f.lane.head));
  source.materialize(f.lane.head, store.path(f.lane.laneId));
  store.locked(() => {
    const data = store.load();
    data.intents.push({
      id: f.lane.intentId,
      outcome: 'Bound submission',
      constraints: '',
      base: f.lane.head,
      status: 'active',
      notes: [],
      createdAt: '2026-01-01T00:00:00.000Z',
    });
    data.lanes.push({
      id: f.lane.laneId,
      intentId: f.lane.intentId,
      name: 'Bound',
      base: f.lane.head,
      head: f.lane.head,
      assignment: '',
      target: '',
      state: 'active',
      checkpoints: [],
    });
    data.revision++;
    store.save(data);
  });
  updateHostState(store, state => {
    state.binding = {
      projectId: f.address.projectId,
      operationId: randomUUID(),
      deployment: f.address.url,
      projectUrl: 'https://fixture.invalid/project',
      name: 'Fixture',
      visibility: 'private',
      backupId: 'fixture-backup',
      autoSync: false,
      sourceAuthority: mode === 'server' ? f.main.authority : native,
    };
  });
  const command = {
    action: 'finish',
    operationId: randomUUID(),
    laneId: f.lane.laneId,
    message: 'Bound change',
    accept: true,
    wait: false,
  };
  return { ...f, store, source, command };
}

test('owner drain includes journal-only waits, unsettled batches and missing acceptance receipts', t => {
  const f = fixture(t, 'native-owner');
  for (const [kind, value] of [
    [
      'agent-finish',
      { command: { accept: true }, attempts: [], result: { status: 'awaiting-review', terminal: false } },
    ],
    ['agent-land', { entries: [{ result: { status: 'waiting' } }] }],
  ]) {
    mkdirSync(join(f.store.directory, kind));
    writeFileSync(join(f.store.directory, kind, `${randomUUID()}.json`), JSON.stringify(value));
  }
  assert.deepEqual(
    ownerDrainBlockers(f.store)
      .map(b => b.kind)
      .sort(),
    ['agent-finish', 'agent-land'],
  );
  assert.throws(() => requireOwnerDrained(f.store), code('SOURCE_AUTHORITY_DRAIN_REQUIRED'));
});
