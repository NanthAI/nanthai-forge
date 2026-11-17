// SPDX-License-Identifier: Apache-2.0
// Item c63c2171: the GitHub mirror in one sentence, the same on the web Mirror screen and in `nforge github
// status`, including an honest "no mirror", and a next action only when a person must act.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mirrorSummary } from '../dist/github-mirror-sentence.js';
import { lanesFixture } from './hosted-lanes-fixture.mjs';
import { moduleUrl } from './convex-module.mjs';
const read = (await import(moduleUrl('../convex/projectGithubMirrorRead.ts'))).read;

const repo = 'example/repo';
const status = (fields = {}) => ({
  repository: repo,
  status: 'synced',
  targetHead: 'a'.repeat(64),
  mirroredHead: 'a'.repeat(64),
  gitHead: 'b'.repeat(40),
  lagging: false,
  pendingSince: null,
  mirroredAt: 1,
  failures: 0,
  nextAttemptAt: null,
  error: null,
  detail: null,
  jobId: null,
  nextStep: null,
  ...fields,
});
const twoWay = { repo, autoPush: true, inbound: true };

test('each recorded mirror state reads as one sentence; only states that wait on a person carry a next step', () => {
  const cases = [
    [null, null, 'off', 'reference'],
    [{ repo, autoPush: false }, null, 'paused', 'reference'],
    [twoWay, status(), 'level', 'reference'],
    [{ ...twoWay, inbound: false }, status(), 'level', 'reference'],
    [twoWay, status({ status: 'syncing', lagging: true }), 'behind', 'watch'],
    [twoWay, status({ status: 'retrying', lagging: true, nextAttemptAt: 2 }), 'retrying', 'watch'],
    [twoWay, status({ status: 'failed', error: 'GITHUB_SYNC_CHANGED', nextStep: 'resume' }), 'moved', 'act'],
    [twoWay, status({ status: 'failed', error: 'GITHUB_SYNC_API', nextStep: 'resume' }), 'refused', 'act'],
    [twoWay, status({ status: 'failed', error: 'GITHUB_INBOUND_FAILED' }), 'inbound-failed', 'act'],
    [twoWay, status({ status: 'unknown', lagging: true, mirroredHead: null }), 'not-pushed', 'reference'],
    [twoWay, null, 'unknown', 'reference'],
  ];
  for (const [policy, recorded, state, weight] of cases) {
    const summary = mirrorSummary(policy, recorded);
    assert.deepEqual([summary.state, summary.weight], [state, weight], JSON.stringify([policy, recorded]));
    assert.equal(summary.sentence.split(/(?<=\.) (?=[A-Z])/).length <= 2, true, summary.sentence);
    assert.equal(summary.next !== null, weight === 'act' || state === 'off', summary.sentence);
  }
  // One-way says pushes made on GitHub are not taken in; two-way says they come back.
  assert.match(mirrorSummary({ ...twoWay, inbound: false }, status()).sentence, /not taken in/);
  assert.match(mirrorSummary(twoWay, status()).sentence, /come back as landings/);
  assert.match(
    mirrorSummary(null, null, './harbor').next,
    /^nforge github connect \.\/harbor --repo OWNER\/NAME/,
  );
});

test('members read an honest no-mirror when the mirror was never configured; strangers read nothing', async () => {
  const s = lanesFixture();
  const plain = s.insert('hostedProjects', {
    owner: 'owner',
    name: 'Synthetic',
    key: randomUUID(),
    currentBackup: null,
    revision: 0,
  });
  const off = await s.call('mirror-off', read, { projectId: plain });
  assert.deepEqual([off.state, off.direction, off.ends, off.owner], ['off', 'off', null, true]);
  assert.match(off.sentence, /^No mirror\./);
  await assert.rejects(s.call('mirror-stranger', read, { projectId: plain }, 'stranger'));
});
