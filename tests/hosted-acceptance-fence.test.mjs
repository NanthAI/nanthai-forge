// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

import { initNative, nativeExecute } from '../dist/native-work.js';
import { WorkService } from '../dist/work.js';
import { updateHostState } from '../dist/host-binding.js';
import { cleanupOwner } from './owner-cleanup.mjs';

const binding = {
  projectId: 'synthetic-project',
  deployment: 'http://127.0.0.1:1',
  projectUrl: 'https://example.invalid/owner/project',
  operationId: randomUUID(),
  name: 'Synthetic',
  visibility: 'private',
  backupId: 'synthetic-backup',
  autoSync: false,
};
const server = { mode: 'server', epoch: 4 };
function bind(store, extra = { sourceAuthority: server }) {
  updateHostState(store, state => {
    state.binding = { ...binding, ...extra };
  });
}
function hosted(error) {
  assert.equal(error.code, 'HOSTED_AUTHORITY');
  assert.ok(error.message.includes(binding.projectUrl));
  assert.match(error.message, /projectHostedLanding \/ projectHostedAcceptance/);
  const command = JSON.parse(error.message.match(/finish '([^']+)'/)[1]);
  assert.equal(command.url, binding.deployment);
  assert.equal(command.projectId, binding.projectId);
  assert.equal(command.accept, true);
  assert.match(error.message, /editing can continue/);
  return true;
}
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'forge-hosted-acceptance-fence-'));
  t.after(() => cleanupOwner(root));
  writeFileSync(join(root, 'source.txt'), 'synthetic\n');
  initNative(root);
  const work = new WorkService(root);
  const intent = work.execute(
    { action: 'intent', outcome: 'Synthetic acceptance' },
    work.store.revision(),
  ).result;
  const lane = work.execute(
    { action: 'lane', intentId: intent.id, name: 'Synthetic' },
    work.store.revision(),
  ).result;
  const view = work.execute(
    {
      action: 'compose',
      operationId: randomUUID(),
      intentId: intent.id,
      inputs: [{ laneId: lane.id, head: lane.head }],
    },
    work.store.revision(),
  ).result;
  const command = {
    action: 'accept-channel',
    operationId: randomUUID(),
    channel: 'main',
    viewId: view.id,
    expectedHead: view.head,
    expectedPrevious: null,
  };
  return { root, work, store: work.store, command, lane };
}

for (const acceptanceOwner of [undefined, false, true]) {
  test(`server authority refuses local accept, owner=${acceptanceOwner ?? 'legacy'}, before any source mutation`, t => {
    const f = fixture(t);
    bind(f.store, { acceptanceOwner, sourceAuthority: server });
    const before = f.store.load();
    for (const channel of ['main', 'release'])
      for (const ownerRequest of [false, true])
        assert.throws(
          () =>
            nativeExecute(f.store, { ...f.command, channel, authorityEpoch: 4 }, before.revision, {
              ownerRequest,
            }),
          hosted,
        );
    assert.deepEqual(f.store.load(), before);
  });
  test(`a pending switch to server refuses local accept, owner=${acceptanceOwner ?? 'legacy'}`, t => {
    const f = fixture(t);
    bind(f.store, { acceptanceOwner });
    updateHostState(f.store, state => {
      state.authorityTransition = {
        projectId: binding.projectId,
        deployment: binding.deployment,
        operationId: randomUUID(),
        expected: { mode: 'native-owner', epoch: 0 },
        mode: 'server',
      };
    });
    const before = f.store.load();
    assert.throws(() => nativeExecute(f.store, f.command, before.revision), hosted);
    assert.deepEqual(f.store.load(), before);
  });
  // Before the cutover and after a rollback the native owner is still the writer.
  for (const sourceAuthority of [undefined, { mode: 'native-owner', epoch: 0 }])
    test(`native-owner authority keeps local accept, owner=${acceptanceOwner ?? 'legacy'}, pin=${sourceAuthority ? 'explicit' : 'legacy'}`, t => {
      const f = fixture(t);
      bind(f.store, { acceptanceOwner, ...(sourceAuthority ? { sourceAuthority } : {}) });
      assert.equal(nativeExecute(f.store, f.command, f.store.revision()).result.status, 'accepted');
    });
  test(`server-shadow keeps the stale-pin fence, owner=${acceptanceOwner ?? 'legacy'}`, t => {
    const f = fixture(t);
    bind(f.store, { acceptanceOwner, sourceAuthority: { mode: 'server-shadow', epoch: 4 } });
    const before = f.store.load();
    assert.throws(
      () => nativeExecute(f.store, { ...f.command, authorityEpoch: 4 }, before.revision),
      error => error.code === 'SOURCE_AUTHORITY_STALE',
    );
    assert.deepEqual(f.store.load(), before);
  });
}
