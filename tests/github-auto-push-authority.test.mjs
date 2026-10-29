// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { initNative } from '../dist/native-work.js';
import { WorkStore } from '../dist/work-store.js';
import { updateHostState } from '../dist/host-binding.js';
import { githubSync } from '../dist/github-sync.js';
import { wakeGithubPush, drainGithubPush } from '../dist/github-auto-push.js';
test('server-authority Mac mirror never starts a worker or waits on native pushes', async t => {
  const root = mkdtempSync(join(tmpdir(), 'forge-mirror-authority-'));
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  writeFileSync(join(root, 'fixture.txt'), 'synthetic');
  initNative(root);
  const store = new WorkStore(root),
    before = store.load().revision;
  updateHostState(store, state => {
    state.binding = {
      projectId: 'synthetic-project',
      deployment: 'https://fixture.convex.cloud',
      projectUrl: 'https://fixture.invalid',
      operationId: randomUUID(),
      name: 'fixture',
      visibility: 'private',
      backupId: 'synthetic-backup',
      sourceAuthority: { mode: 'server', epoch: 1 },
    };
  });
  wakeGithubPush(store);
  await drainGithubPush(store, {
    sleep: async () => assert.fail('server mirror must return before sleeping'),
  });
  await assert.rejects(
    githubSync(root, { autoPush: true, push: true }),
    error => error.code === 'SOURCE_AUTHORITY_CHANGED',
  );
  assert.equal(store.load().revision, before);
  assert.equal(store.load().githubAutoPush, undefined);
});
