// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { exportActionsSnapshot } from '../dist/github-actions-export.js';
import { controlActions } from '../dist/github-actions-controller.js';
import { GitSyncError } from '../dist/github-sync-git.js';

// A fake check repo that, like a loaded remote, rejects pushes when too many arrive at once and
// transiently rejects the first push of every other run (a lost race on the repo).
function fakeRemote({ limit = 2, flaky = true } = {}) {
  const refs = new Map(),
    pushes = new Map();
  let active = 0,
    peak = 0;
  const git = async (_, args) => {
    if (args.includes('ls-remote')) {
      const ref = args.at(-1);
      return refs.has(ref) ? `${refs.get(ref)}\t${ref}` : '';
    }
    assert.ok(args.includes('push'));
    const [commit, ref] = args.at(-1).split(':');
    assert.ok(args.includes(`--force-with-lease=${ref}:`), 'push is a create-only CAS on the run ref');
    pushes.set(ref, (pushes.get(ref) ?? 0) + 1);
    peak = Math.max(peak, ++active);
    try {
      await new Promise(resolve => setTimeout(resolve, 5));
      if (active > limit || (flaky && pushes.get(ref) === 1 && Number.parseInt(commit[0], 16) % 2 === 0))
        throw new GitSyncError('remote: cannot lock ref; Authorization: Bearer ghs_synthetic', true);
      refs.set(ref, commit);
      return '';
    } finally {
      active--;
    }
  };
  return { git, refs, pushes, peak: () => peak };
}
function controller(t, index) {
  const output = mkdtempSync(join(tmpdir(), 'forge-burst-'));
  t.after(() => rmSync(output, { recursive: true, force: true }));
  const plan = { runId: randomUUID(), output, source: output, groups: [], pin: 'p' };
  const journal = {
    pin: 'p',
    repo: 'synthetic/checks',
    runsOn: 'ubuntu-latest',
    retrying: [],
    retrySources: {},
    oom: [],
    logged: [],
    states: {},
  };
  return { plan, journal, commit: index.toString(16).padStart(40, `${index % 16}`.slice(-1)) };
}
function dispatchApi(plan, journal, dispatched) {
  return {
    async request(endpoint, method) {
      if (endpoint.endsWith('/dispatches')) return void dispatched.push(plan.runId);
      if (endpoint.endsWith('/timing')) return {};
      return { id: 10, head_sha: journal.commit, status: 'completed', conclusion: 'success' };
    },
    async pages(endpoint) {
      if (endpoint.includes('/runs?'))
        return [{ id: 10, head_sha: journal.commit, display_title: `forge-check/${plan.runId}` }];
      return [{ id: 20, name: 'forge-static', status: 'completed', conclusion: 'success' }];
    },
    async log() {
      return 'ok\n';
    },
    async sleep() {},
  };
}
for (const size of [4, 8]) {
  test(`${size} concurrent controllers against one check repo all export, dispatch and pass`, async t => {
    const remote = fakeRemote(),
      dispatched = [],
      sleeps = [];
    const all = Array.from({ length: size }, (_, index) => controller(t, index + 1));
    const results = await Promise.all(
      all.map(async ({ plan, journal, commit }) => {
        await exportActionsSnapshot(
          plan,
          journal,
          () => {},
          remote.git,
          () => commit,
          async ms => void sleeps.push(ms),
        );
        const api = dispatchApi(plan, journal, dispatched);
        return controlActions(
          plan,
          journal,
          () => {},
          api,
          () => false,
          () => {},
        );
      }),
    );
    assert.deepEqual(
      results.map(result => result.status),
      Array(size).fill('passed'),
    );
    assert.equal(dispatched.length, size);
    assert.equal(new Set(dispatched).size, size, 'one dispatch per run, none repeated');
    assert.equal(remote.refs.size, size);
    assert.ok(remote.peak() <= 2, `at most two pushes at once (saw ${remote.peak()})`);
    assert.ok(sleeps.length > 0, 'flaky first pushes were retried');
    assert.ok(sleeps.every(ms => ms >= 1000 && ms <= 24_000));
  });
}
test('a run ref that already names different source is never retried or overwritten', async t => {
  const { plan, journal, commit } = controller(t, 3),
    calls = [];
  await assert.rejects(
    exportActionsSnapshot(
      plan,
      journal,
      () => {},
      async (_, args) => {
        calls.push(args);
        return `other\trefs/heads/forge-check/${plan.runId}`;
      },
      () => commit,
      async () => assert.fail('no retry'),
    ),
    /different source/,
  );
  assert.equal(calls.length, 1);
});
test('permanent git failures are not retried; transient ones give up after bounded attempts', async t => {
  const { plan, journal, commit } = controller(t, 5);
  let tries = 0;
  const failing = transient => async () => {
    tries++;
    throw new GitSyncError('fatal: nope', transient);
  };
  await assert.rejects(
    exportActionsSnapshot(
      plan,
      journal,
      () => {},
      failing(false),
      () => commit,
      async () => {},
    ),
    /GitHub sync could not finish/,
  );
  assert.equal(tries, 1);
  tries = 0;
  const other = controller(t, 6);
  await assert.rejects(
    exportActionsSnapshot(
      other.plan,
      other.journal,
      () => {},
      failing(true),
      () => other.commit,
      async () => {},
    ),
    err => err instanceof GitSyncError && err.detail === 'fatal: nope',
  );
  assert.equal(tries, 5);
});
