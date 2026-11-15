// SPDX-License-Identifier: Apache-2.0
// Retained protocol shapes only; no live repository, deployment or benchmark inputs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { replayAdapters } from '../scripts/bench-t3code/replay-adapters.mjs';
import { replayPlan } from '../scripts/bench-t3code/replay-schedule.mjs';

async function githubFixture(t, statuses, { pushFailure } = {}) {
  const ws = mkdtempSync(join(tmpdir(), 'replay-queue-'));
  t.after(() => rmSync(ws, { recursive: true, force: true }));
  const calls = [],
    records = [];
  let queued = false,
    reads = 0;
  const github = {
    repository: 'synthetic/replay',
    fromGithub: x => x,
    async workspace(_hub, _root, branch) {
      calls.push(['workspace', branch]);
      return {};
    },
    async gh(args) {
      calls.push(args);
      if (args[1] === 'create') return 'https://github.com/synthetic/replay/pull/1\n';
      if (args[1] === 'merge') {
        queued = true;
        return '';
      }
      assert.equal(args[1], 'view');
      const status = statuses[reads++];
      assert.ok(status, 'no extra PR observation');
      // A DIRTY PR was removed from the queue for source recovery.
      if (status.mergeStateStatus === 'DIRTY') queued = false;
      return JSON.stringify(status);
    },
  };
  const plan = replayPlan({ independent: true });
  const adapter = replayAdapters({
    plan,
    arm: 'github',
    github,
    ws,
    bin: ws,
    base: 'base',
    records,
    lanes: new Map(),
    run: async (_root, args) => {
      calls.push(args);
      if (args[0] === 'rev-parse') return 'base\n';
      if (args[0] === 'push') {
        if (pushFailure) throw pushFailure;
        if (queued)
          throw Error(
            'remote: error: GH006: Protected branch update failed.\nA pull request for this branch has been added to a merge queue. Branches that are queued for merging cannot be updated.',
          );
      }
      return '';
    },
    sleep: async () => {},
  });
  const task = plan.tasks[0],
    ctx = await adapter.prepare(task);
  return { calls, records, ctx, land: () => adapter.land(task, ctx) };
}
const merged = { state: 'MERGED', mergedAt: '2026-01-01T00:00:01Z', mergeCommit: { oid: 'accepted' } };

test('queued PR with null autoMergeRequest waits without a protected recovery push', async t => {
  const f = await githubFixture(t, [
    ...['CLEAN', 'UNKNOWN', 'BLOCKED'].map(mergeStateStatus => ({
      state: 'OPEN',
      mergeStateStatus,
      autoMergeRequest: null,
      mergeCommit: null,
      mergedAt: null,
    })),
    merged,
  ]);
  const result = await f.land();
  assert.equal(result.landed, true);
  assert.equal(result.mergeCommit, 'accepted');
  assert.equal(f.calls.filter(c => c[0] === 'push').length, 1, 'only initial publish');
  assert.equal(f.calls.filter(c => c[0] === 'fetch' || c[0] === 'merge').length, 0);
  assert.equal(f.calls.filter(c => c[1] === 'view').length, 4);
  assert.equal(f.ctx.branch, 'agent-1/s01');
  assert.ok(f.calls.filter(c => c[0] === 'push').every(c => !c.some(a => /force/.test(a))));
});

test('a DIRTY PR still merges main, publishes normally and rejoins the merge queue', async t => {
  const f = await githubFixture(t, [
    { state: 'OPEN', mergeStateStatus: 'DIRTY', autoMergeRequest: null },
    merged,
  ]);
  assert.equal((await f.land()).landed, true);
  assert.deepEqual(
    f.calls.filter(c => c[0] === 'push'),
    [
      ['push', '-q', '-u', 'origin', 'agent-1/s01'],
      ['push', '-q', 'origin', 'agent-1/s01'],
    ],
  );
  assert.equal(f.calls.filter(c => c[0] === 'merge').length, 1);
  assert.equal(f.calls.filter(c => c[0] === 'pr' && c[1] === 'merge').length, 2);
});

test('GitHub protection refusal remains an error rather than a force push or bypass', async t => {
  const failure = Error('remote: error: GH006: Protected branch update failed: required policy');
  const f = await githubFixture(t, [], { pushFailure: failure });
  await assert.rejects(f.land(), error => error === failure);
  assert.equal(f.calls.filter(c => c[0] === 'push').length, 1);
  assert.equal(f.calls.filter(c => c[0] === 'pr').length, 0);
  assert.equal(f.records[0].landing.landed, false);
});

test('ordinary scripted GitHub agent also leaves queued heads alone and recovers DIRTY heads', async t => {
  const { scriptedAgent } = await import('../scripts/bench-t3code/github-arm.mjs');
  const { mkdirSync, writeFileSync, readFileSync, chmodSync } = await import('node:fs');
  const { execFileSync } = await import('node:child_process');
  const { dirname } = await import('node:path');
  const root = mkdtempSync(join(tmpdir(), 'scripted-queue-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const bin = join(root, 'bin'),
    stateFile = join(root, 'state.json');
  mkdirSync(bin);
  writeFileSync(stateFile, JSON.stringify({ calls: [], reads: 0 }));
  for (const name of ['git', 'gh', 'sleep']) {
    const file = join(bin, name);
    writeFileSync(
      file,
      `#!${process.execPath}
const fs = require('node:fs');
const file = process.env.REPLAY_FIXTURE_STATE;
const state = JSON.parse(fs.readFileSync(file));
const name = require('node:path').basename(process.argv[1]);
const args = process.argv.slice(2);
state.calls.push({ name, args, reads: state.reads });
if (name === 'gh' && args[1] === 'view') {
  console.log(['OPEN BLOCKED false', 'OPEN DIRTY false', 'MERGED CLEAN false'][state.reads++]);
}
fs.writeFileSync(file, JSON.stringify(state));
if (name === 'git' && args[0] === 'push' && state.reads === 1) {
  console.error('GH006: Branches that are queued for merging cannot be updated.');
  process.exitCode = 1;
}
`,
    );
    chmodSync(file, 0o755);
  }
  execFileSync('bash', [scriptedAgent(bin), 'agent-1/task', 'task', 'group'], {
    cwd: root,
    env: { PATH: `${bin}:${dirname(process.execPath)}:/usr/bin:/bin`, REPLAY_FIXTURE_STATE: stateFile },
    stdio: 'pipe',
  });
  const { calls, reads } = JSON.parse(readFileSync(stateFile, 'utf8'));
  assert.equal(reads, 3);
  assert.equal(calls.filter(c => c.name === 'git' && c.args[0] === 'push' && c.reads === 1).length, 0);
  assert.equal(calls.filter(c => c.name === 'git' && c.args[0] === 'push').length, 2);
  assert.equal(calls.filter(c => c.name === 'git' && c.args[0] === 'merge').length, 1);
});
