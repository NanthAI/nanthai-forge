// SPDX-License-Identifier: Apache-2.0
// Item c63c2171: before an inbound-failure repair changes GitHub's main, its author is told on the commit.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { moduleUrl } from './convex-module.mjs';
import { mirrorControlsFixture as fixture } from './github-mirror-controls-fixture.mjs';
import { mirrorFixture } from './hosted-github-mirror-fixture.mjs';
import { acceptMirrorReceipt as accept } from './github-mirror-catchup-fixture.mjs';
import { pusherNotice } from '../dist/github-inbound-job.js';
const store = await import(moduleUrl('../convex/projectGithubMirrorStore.ts'));

test('the repair publish pins a notice with the refusal code, the Lane and its link, never the detail', async t => {
  const prior = [process.env.FORGE_GITHUB_SYNC_NAME, process.env.FORGE_GITHUB_SYNC_EMAIL];
  t.after(() => {
    for (const [name, value] of [
      ['FORGE_GITHUB_SYNC_NAME', prior[0]],
      ['FORGE_GITHUB_SYNC_EMAIL', prior[1]],
    ])
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
  });
  for (const failed of [true, false]) {
    const f = fixture(true, 'synthetic/mirror'),
      github = mirrorFixture();
    process.env.FORGE_GITHUB_SYNC_NAME = github.seed.identity.name;
    process.env.FORGE_GITHUB_SYNC_EMAIL = github.seed.identity.email;
    const base = accept(f, github.root.state, github.root.state, 0);
    const dropped = 'b'.repeat(40),
      laneId = randomUUID();
    f.patch('projectGithubMirrors', f.mirrorId, {
      mapping: JSON.stringify({ ...github.root, acceptanceId: base.id }),
      inbound: JSON.stringify({
        commit: dropped,
        laneId,
        outcome: failed ? 'terminal-failed' : 'landed',
        ...(failed ? { note: true, error: 'CHECK_NOT_PASSED: tests/secret-path.test.mjs failed' } : {}),
      }),
    });
    const receipt = accept(f, github.head, github.root.state, 1);
    const jobId = f.insert('projectGithubMirrorJobs', {
      projectId: f.projectId,
      repository: 'synthetic/mirror',
      receiptId: receipt.id,
      sequence: 1,
      authorityEpoch: 1,
      state: github.head,
      status: 'queued',
      step: 0,
      cursor: null,
    });
    f.patch('projectGithubMirrors', f.mirrorId, { activeId: jobId });
    const { seed } = JSON.parse(await f.call('begin', store.begin, { jobId, step: 0 }));
    if (!failed) {
      assert.equal(seed.notice, undefined, 'a landed inbound commit needs no notice');
      continue;
    }
    assert.equal(seed.notice.commit, dropped);
    assert.match(seed.notice.text, /^This commit did not land on Forge \(CHECK_NOT_PASSED\)/);
    assert(seed.notice.text.includes(`Lane ${laneId.slice(0, 8)}`));
    assert(!seed.notice.text.includes('secret-path'), 'the refusal detail stays on Forge');
    assert.match(seed.message, /takes GitHub commit b{12} out of main/);
    // Pinned with the seed: a replayed begin returns the same notice without rebuilding it.
    const again = JSON.parse(await f.call('begin-replay', store.begin, { jobId, step: 0 })).seed;
    assert.deepEqual(again.notice, seed.notice);
  }
});

test('the notice says what happened, why, and how to keep the change', () => {
  const text = pusherNotice(
    'c'.repeat(40),
    'd'.repeat(8) + '-0000',
    'MERGE_CONFLICT: details',
    'https://forge.test/a/b/lanes/x',
  );
  assert.match(text, /did not land on Forge \(MERGE_CONFLICT\)/);
  assert.match(text, /next push takes it out of main/);
  assert.match(text, /never rewrites history/);
  assert.match(text, /Lane dddddddd on Forge and land it: https:\/\/forge\.test\/a\/b\/lanes\/x$/);
  assert(!text.includes('details'));
  assert.match(pusherNotice('c'.repeat(40), 'd'.repeat(8), null, null), /did not land on Forge, so/);
});
