// SPDX-License-Identifier: Apache-2.0
// Exit plan "Quiet rule and deploys" (lead 2026-11-09): only a Convex deploy in flight holds a
// batch start; main and the deploy head moving during a batch are recorded, not voids; a
// deployed convex/ change still voids. Synthetic readings only; no network.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  differences,
  moved,
  snapshotProblems,
  forgeInFlight,
  deployInFlight,
  deploysDuring,
  overlapping,
  RECORDED_KEYS,
  LIVE_MAIN_KEYS,
} from '../scripts/bench-t3code/versions.mjs';

const snap = (over = {}) => ({
  cli: { build: 'b', commit: 'c', git: null },
  githubMain: 'c',
  deploy: { headSha: 'd' },
  convexTree: { cli: 't', deploy: 't' },
  checkWorkflow: { forge: 'f', github: 'g' },
  harness: { commit: 'h', filesSha256: 'x' },
  agent: 'claude claude-sonnet-5-5 cli-default 2.1.318',
  freeze: true,
  ...over,
});

test('recorded keys are main and the deploy head; the live-main set adds convex/ and the check', () => {
  assert.deepEqual(RECORDED_KEYS, ['githubMain', 'deploy.headSha']);
  assert.deepEqual(LIVE_MAIN_KEYS, [
    'githubMain',
    'deploy.headSha',
    'convexTree.deploy',
    'checkWorkflow.forge',
  ]);
});

test('main moving is reported by moved(), never by differences()', () => {
  const a = snap(),
    b = snap({ githubMain: 'c2', deploy: { headSha: 'd2' } });
  assert.deepEqual(differences(a, b), []);
  assert.deepEqual(moved(a, b), ['githubMain: c -> c2', 'deploy.headSha: d -> d2']);
  assert.deepEqual(moved(a, structuredClone(a)), []);
});

test('a deploy that changed convex/ voids a scored cell; a dry run waives it', () => {
  const a = snap(),
    b = snap({ deploy: { headSha: 'd2' }, convexTree: { cli: 't', deploy: 't2' } });
  assert.deepEqual(differences(a, b), ['convexTree.deploy: t -> t2']);
  assert.deepEqual(differences(a, b, { liveMain: true }), []);
});

test('an unreadable convex/ reading after a deploy still voids (void when unsure)', () => {
  assert.deepEqual(differences(snap(), snap({ convexTree: { cli: 't', deploy: null } })), [
    'convexTree.deploy: t -> null',
  ]);
});

test('in a batch a cell needs only the deployed convex/ to match the CLI, not CLI = main', () => {
  const s = snap({ githubMain: 'c2' });
  assert.match(snapshotProblems(s, { requireFreeze: true }).join(), /is not GitHub main/);
  assert.deepEqual(snapshotProblems(s, { requireFreeze: true, inBatch: true }), []);
  const drifted = snap({ githubMain: 'c2', convexTree: { cli: 't', deploy: 't2' } });
  assert.match(snapshotProblems(drifted, { requireFreeze: true, inBatch: true }).join(), /deployed convex\//);
});

test('forgeInFlight filters by workflow; deployInFlight asks for the configured deploy only', async () => {
  const calls = [];
  const exec = async (cmd, args) => {
    calls.push([cmd, ...args]);
    return JSON.stringify(
      args.includes('in_progress') ? [{ databaseId: 1, workflowName: 'Deploy dev Convex' }] : [],
    );
  };
  const runs = await deployInFlight({ forge: { deployWorkflow: 'convex-deploy.yml' } }, exec);
  assert.equal(runs.length, 1);
  assert.equal(calls.length, 2, 'one read per status (queued, in_progress)');
  for (const c of calls)
    assert.deepEqual(c.slice(c.indexOf('--workflow'), c.indexOf('--workflow') + 2), [
      '--workflow',
      'convex-deploy.yml',
    ]);
  calls.length = 0;
  await forgeInFlight({}, exec);
  assert.ok(
    calls.every(c => !c.includes('--workflow')),
    'no filter: every workflow',
  );
});

test('overlapping keeps runs that touch the window, including one still running', () => {
  const runs = [
    {
      databaseId: 1,
      headSha: 'a',
      createdAt: '2026-11-09T09:00:00Z',
      updatedAt: '2026-11-09T09:05:00Z',
      status: 'completed',
      conclusion: 'success',
    },
    {
      databaseId: 2,
      headSha: 'b',
      createdAt: '2026-11-09T10:10:00Z',
      updatedAt: '2026-11-09T10:15:00Z',
      status: 'completed',
      conclusion: 'success',
    },
    {
      databaseId: 3,
      headSha: 'c',
      createdAt: '2026-11-09T09:50:00Z',
      updatedAt: '2026-11-09T09:51:00Z',
      status: 'in_progress',
      conclusion: null,
    },
    {
      databaseId: 4,
      headSha: 'd',
      createdAt: '2026-11-09T11:00:00Z',
      updatedAt: '2026-11-09T11:05:00Z',
      status: 'completed',
      conclusion: 'failure',
    },
  ];
  const got = overlapping(runs, '2026-11-09T09:04:00Z', '2026-11-09T10:12:00Z');
  assert.deepEqual(
    got.map(r => r.id),
    [1, 3, 2],
    'sorted by start; the run after the window is out',
  );
  assert.equal(got[1].status, 'in_progress');
});

test('deploysDuring makes one gh read and returns { error } when it fails', async () => {
  let n = 0;
  const ok = await deploysDuring(
    { forge: { deployWorkflow: 'convex-deploy.yml' } },
    '2026-11-09T09:00:00Z',
    '2026-11-09T10:00:00Z',
    async () => {
      n++;
      return '[]';
    },
  );
  assert.deepEqual(ok, []);
  assert.equal(n, 1);
  const bad = await deploysDuring({ forge: { deployWorkflow: 'x' } }, 'a', 'b', async () => {
    throw Error('gh down');
  });
  assert.match(bad.error, /gh down/);
});
