// SPDX-License-Identifier: Apache-2.0
// Exit plan "Quiet rule and deploys" (lead 2026-11-09): only a Convex deploy in flight holds a
// batch start; main, the deploy head and off-path convex/ changes during a batch are recorded,
// not voids; a convex/ change on the landing path voids. Synthetic readings only; no network.
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
  landingPathChanges,
  voidingChanges,
  offLandingPath,
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

test('recorded keys are main, the deploy head and the convex/ tree; live main adds the check', () => {
  assert.deepEqual(RECORDED_KEYS, ['githubMain', 'deploy.headSha', 'convexTree.deploy']);
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

const compare = (files, status = 'ahead') => {
  const calls = [];
  const exec = async (cmd, args) => {
    calls.push([cmd, ...args]);
    return JSON.stringify({ status, n: files.length, files });
  };
  return { exec, calls };
};
const deployed = snap({ deploy: { headSha: 'd2' }, convexTree: { cli: 't', deploy: 't2' } });

test('a deploy that changed only off-path convex/ files is recorded, not a void (dry on 5b707970)', async () => {
  const { exec, calls } = compare([
    'convex/gitServe.ts',
    'convex/gitServeAuth.ts',
    'convex/projectGithubImport.ts',
    'convex/projectGithubInbound.ts',
    'src/app.tsx',
  ]);
  assert.deepEqual(differences(snap(), deployed), [], 'the tree itself is a recorded key');
  const r = await landingPathChanges(snap(), deployed, exec);
  assert.deepEqual(r.voids, []);
  assert.equal(r.files.length, 4, 'only convex/ files are recorded');
  assert.equal(calls.length, 1, 'one compare call');
  assert.match(calls[0].join(' '), /compare\/d\.\.\.d2/);
});

test('a deploy that changed a landing-path convex/ file voids; history, schema and hosted are on it', async () => {
  for (const file of ['convex/projectHistoryStore.ts', 'convex/schema.ts', 'convex/projectHostedLand.ts']) {
    const r = await landingPathChanges(snap(), deployed, compare(['convex/gitServe.ts', file]).exec);
    assert.equal(r.voids.length, 1, file);
    assert.match(r.voids[0], new RegExp(`landing path changed by deploy d -> d2: ${file}`));
  }
  assert.equal(offLandingPath('convex/projectBoardView.ts'), true);
  assert.equal(offLandingPath('convex/projectLandingQueue.ts'), false);
});

test('an unreadable or unclassifiable convex/ change voids (void when unsure); no change, no call', async () => {
  const boom = async () => {
    throw new Error('HTTP 502');
  };
  assert.match(
    (await landingPathChanges(snap(), deployed, boom)).voids.join(),
    /unreadable.*void when unsure/,
  );
  const nulled = snap({ convexTree: { cli: 't', deploy: null } });
  assert.match((await landingPathChanges(snap(), nulled, boom)).voids.join(), /t -> null \(unreadable/);
  const noHead = snap({ deploy: { headSha: null }, convexTree: { cli: 't', deploy: 't2' } });
  assert.equal((await landingPathChanges(snap(), noHead, boom)).voids.length, 1);
  assert.equal(
    (await landingPathChanges(snap(), deployed, compare(['convex/a.ts'], 'diverged').exec)).voids.length,
    1,
  );
  assert.equal(
    (await landingPathChanges(snap(), deployed, compare(Array(300).fill('convex/gitServe.ts')).exec)).voids
      .length,
    1,
    'GitHub truncates a compare at 300 files',
  );
  assert.equal((await landingPathChanges(snap(), deployed, compare(['src/a.ts']).exec)).voids.length, 1);
  assert.deepEqual(await landingPathChanges(snap(), snap({ deploy: { headSha: 'd2' } }), boom), {
    voids: [],
    files: [],
  });
});

test('voidingChanges adds landing-path voids for a scored cell; a dry run waives them', async () => {
  const { exec } = compare(['convex/projectWorkQueue.ts']);
  const scored = await voidingChanges(snap(), deployed, { exec });
  assert.equal(scored.changes.length, 1);
  assert.deepEqual(scored.convexFiles, ['convex/projectWorkQueue.ts']);
  const dry = await voidingChanges(snap(), deployed, { liveMain: true, exec });
  assert.deepEqual(dry.changes, []);
  assert.equal(dry.waived.length, 1);
});

test('in a batch a cell needs neither CLI = main nor deployed convex/ = the CLI at its start', () => {
  const s = snap({ githubMain: 'c2' });
  assert.match(snapshotProblems(s, { requireFreeze: true }).join(), /is not GitHub main/);
  assert.deepEqual(snapshotProblems(s, { requireFreeze: true, inBatch: true }), []);
  const drifted = snap({ githubMain: 'c2', convexTree: { cli: 't', deploy: 't2' } });
  assert.match(snapshotProblems(drifted, { requireFreeze: true }).join(), /deployed convex\//);
  assert.deepEqual(snapshotProblems(drifted, { requireFreeze: true, inBatch: true }), []);
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
