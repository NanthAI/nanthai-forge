// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { ensureActionsPush } from '../dist/github-actions-push.js';
import { GitSyncError } from '../dist/github-sync-git.js';
import { pendingActionsInfra, pushRejectionClass } from '../dist/github-actions-infra.js';

function fixture({
  visibleAt = Infinity,
  failure = new Error('synthetic private transport text'),
  legacy = false,
} = {}) {
  const plan = { source: 'synthetic', runId: 'run' };
  let journal = {
    repo: 'synthetic/checks',
    commit: 'a'.repeat(40),
    ...(legacy ? {} : { pushOutcome: 'not-sent' }),
  };
  let saved,
    pushes = 0,
    reads = 0;
  const progress = [];
  return {
    get journal() {
      return journal;
    },
    get pushes() {
      return pushes;
    },
    get reads() {
      return reads;
    },
    reload() {
      journal = structuredClone(saved);
    },
    control: () =>
      ensureActionsPush(
        plan,
        journal,
        () => {
          saved = structuredClone(journal);
        },
        async (_, args) => {
          if (args[0] === 'ls-remote')
            return ++reads >= visibleAt ? `${journal.commit}\trefs/heads/forge-check/run` : '';
          pushes++;
          assert.equal(saved.pushOutcome, 'ambiguous', 'intent saved before push');
          assert.equal(saved.pushAttempts.at(-1).outcome, 'ambiguous');
          throw failure;
        },
        async () => {},
        message => progress.push(message),
      ),
    progress,
  };
}

test('a lost push reply adopts the exact ref beyond two discovery windows without another push', async () => {
  const f = fixture({ visibleAt: 15 });
  for (let window = 0; window < 2; window++) {
    await assert.rejects(f.control(), error => error.state === 'pending-infra');
    assert.equal(f.journal.discovery.length, window + 1);
    assert.equal(f.journal.discovery.at(-1).phase, 'push');
    assert.equal(f.pushes, 1);
    f.reload();
  }
  await f.control();
  assert.equal(f.journal.pushed, true);
  assert.equal(f.journal.pushOutcome, 'ambiguous', 'adoption preserves unknown response evidence');
  assert.equal(f.pushes, 1);
  assert.equal(f.journal.branchEvidence.at(-1).commit, f.journal.commit);
  assert.doesNotMatch(JSON.stringify(f.journal) + f.progress.join(''), /private transport text/);
});

for (const legacy of [false, true]) {
  test(`empty ref listings never authorize a push after an unknown outcome (legacy=${legacy})`, async () => {
    const f = fixture({ legacy });
    for (let window = 0; window < 3; window++) {
      await assert.rejects(f.control(), error => error.state === 'pending-infra');
      f.reload();
    }
    assert.equal(f.pushes, legacy ? 0 : 1);
    assert.equal(f.journal.pushed, undefined);
    assert.equal(f.journal.pushAttempts?.length, legacy ? undefined : 1);
  });
}

test('definitive rejection classes remain distinct from transport transience', () => {
  for (const detail of [
    'RPC failed',
    'early EOF',
    'HTTP 503',
    'Connection reset',
    'cannot lock ref',
    'unknown git error',
  ])
    assert.equal(pushRejectionClass(detail), undefined, detail);
  assert.equal(pushRejectionClass('! [remote rejected] a -> forge-check/run (failed)'), 'ref-rejected');
  assert.equal(pushRejectionClass('fatal: Authentication failed'), 'access-rejected');
});

test('a definitive access rejection stays retained and is never guessed to be transient', async () => {
  const failure = new GitSyncError('fatal: Authentication failed', false);
  const f = fixture({ failure });
  await assert.rejects(f.control(), error => error === failure);
  assert.equal(f.journal.pushOutcome, 'rejected');
  assert.equal(f.journal.pushAttempts[0].rejectionClass, 'access-rejected');
  assert.equal(f.pushes, 1);
});

test('pending infrastructure is an observation and explicit cancellation still wins', () => {
  const run = { status: 'interrupted', error: { code: 'GITHUB_ACTIONS_PENDING_INFRA' } };
  assert.equal(pendingActionsInfra(run), true);
  assert.equal(pendingActionsInfra({ ...run, cancelRequested: true }), false);
  assert.equal(pendingActionsInfra({ ...run, status: 'failed' }), false);
  assert.equal(pendingActionsInfra({ status: 'interrupted' }), false);
});

test('a rejection marker without retained definitive rejection evidence cannot authorize another push', async () => {
  const f = fixture();
  f.journal.pushOutcome = 'rejected';
  await assert.rejects(f.control(), error => error.state === 'pending-infra');
  assert.equal(f.pushes, 0);
});
