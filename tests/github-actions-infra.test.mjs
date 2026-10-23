// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { ensureActionsPush } from '../dist/github-actions-push.js';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { syncGit, GitSyncError, transientGitFailure } from '../dist/github-sync-git.js';
import { pendingActionsInfra, pushRejectionClass } from '../dist/github-actions-infra.js';

function fixture({
  visibleAt = Infinity,
  failure = new Error('synthetic private transport text'),
  legacy = false,
  succeedAt = Infinity,
} = {}) {
  const plan = { source: 'synthetic', runId: 'run' };
  let clock = Date.parse('2026-10-23T06:29:00Z');
  let journal = {
    repo: 'synthetic/checks',
    commit: 'a'.repeat(40),
    ...(legacy ? {} : { pushOutcome: 'not-sent' }),
  };
  let saved,
    pushes = 0,
    reads = 0;
  const progress = [],
    calls = [],
    waits = [];
  const f = {
    get journal() {
      return journal;
    },
    get pushes() {
      return pushes;
    },
    get reads() {
      return reads;
    },
    get clock() {
      return clock;
    },
    advance(ms) {
      clock += ms;
    },
    reload() {
      journal = structuredClone(saved);
    },
    sleep: async ms => {
      waits.push(ms);
      clock += ms;
    },
    control: () =>
      ensureActionsPush(
        plan,
        journal,
        () => {
          saved = structuredClone(journal);
        },
        async (_, args) => {
          calls.push({ args, at: clock });
          if (args[0] === 'ls-remote')
            return ++reads >= visibleAt ? `${journal.commit}\trefs/heads/forge-check/run` : '';
          pushes++;
          assert.deepEqual(args, [
            'push',
            '--force-with-lease=refs/heads/forge-check/run:',
            'https://github.com/synthetic/checks.git',
            `${journal.commit}:refs/heads/forge-check/run`,
          ]);
          assert.equal(saved.pushOutcome, 'ambiguous', 'intent saved before push');
          assert.equal(saved.pushAttempts.at(-1).outcome, 'ambiguous');
          assert.equal(saved.pushDiscovery.observations, 0);
          if (pushes >= succeedAt) return '';
          throw failure;
        },
        ms => f.sleep(ms),
        message => progress.push(message),
        () => clock,
      ),
    progress,
    calls,
    waits,
  };
  return f;
}

test('an ambiguous push that becomes visible is adopted without another push', async () => {
  const f = fixture({ visibleAt: 5 });
  await f.control();
  assert.equal(f.journal.pushed, true);
  assert.equal(f.journal.pushOutcome, 'ambiguous', 'adoption preserves unknown response evidence');
  assert.equal(f.pushes, 1);
  assert.equal(f.journal.branchEvidence.at(-1).commit, f.journal.commit);
  assert.doesNotMatch(JSON.stringify(f.journal) + f.progress.join(''), /private transport text/);
});

test('five empty observations over sixty seconds permit only an identical create-only re-push', async () => {
  const f = fixture({ succeedAt: 2 });
  await f.control();
  const pushes = f.calls.filter(call => call.args[0] === 'push');
  assert.equal(pushes.length, 2);
  assert.deepEqual(pushes[0].args, pushes[1].args);
  assert.equal(pushes[1].at - pushes[0].at, 60_000);
  assert.ok(
    f.calls.filter(call => call.args[0] === 'ls-remote' && call.at > pushes[0].at && call.at <= pushes[1].at)
      .length >= 5,
  );
  assert.deepEqual(
    f.journal.pushAttempts.map(attempt => attempt.outcome),
    ['ambiguous', 'accepted'],
  );
  assert.equal(f.journal.discovery[0].matches, 0);
  assert.match(f.progress.join('\n'), /retry 2\/5.*identical commit/);
});

test('a ref appearing at the last pre-retry read is adopted without a re-push', async () => {
  const f = fixture({ visibleAt: 7 });
  await f.control();
  assert.equal(f.pushes, 1);
  assert.equal(f.journal.pushed, true);
});

test('restart mid-window resumes the original timestamp and observations', async () => {
  const f = fixture({ succeedAt: 2 });
  const sleep = f.sleep;
  f.sleep = async ms => {
    if (f.waits.length === 2) throw new Error('synthetic restart');
    await sleep(ms);
  };
  await assert.rejects(f.control(), /synthetic restart/);
  const startedAt = f.journal.pushDiscovery.startedAt;
  assert.equal(f.journal.pushDiscovery.observations, 2);
  assert.equal(f.pushes, 1);
  f.reload();
  f.sleep = sleep;
  await f.control();
  const pushes = f.calls.filter(call => call.args[0] === 'push');
  assert.equal(pushes[1].at - Date.parse(startedAt), 60_000);
  assert.equal(f.pushes, 2);
});

for (const legacy of [false, true]) {
  test(`unobserved pushes exhaust the persisted attempt bound and stay terminal after restart (legacy=${legacy})`, async () => {
    const f = fixture({ legacy });
    await assert.rejects(f.control(), error => error.code === 'GITHUB_ACTIONS_PUSH_EXHAUSTED');
    assert.equal(f.pushes, legacy ? 4 : 5);
    assert.equal(f.journal.pushAttempts.length, 5);
    assert.equal(f.journal.terminal, true);
    assert.equal(f.journal.discovery.length, 5);
    const reads = f.reads;
    f.reload();
    await assert.rejects(f.control(), error => error.code === 'GITHUB_ACTIONS_PUSH_EXHAUSTED');
    assert.equal(f.reads, reads, 'terminal attempts never restart discovery');
    assert.equal(f.pushes, legacy ? 4 : 5);
  });
}

test('an old journal uses retained observation time instead of restarting its discovery window', async () => {
  const f = fixture({ legacy: true, succeedAt: 1 });
  f.journal.branchEvidence = [
    { source: 'git', observedAt: new Date(f.clock - 3_600_000).toISOString(), commit: null },
  ];
  await f.control();
  assert.equal(f.pushes, 1);
  assert.equal(f.journal.pushAttempts.length, 2, 'legacy unknown attempt counts toward the bound');
  assert.equal(
    f.waits.reduce((sum, ms) => sum + ms, 0),
    60_000,
  );
});

test('a different commit discovered during the ambiguity window refuses all replacement pushes', async () => {
  const f = fixture();
  f.sleep = async ms => {
    f.advance(ms);
    throw new Error('restart');
  };
  await assert.rejects(f.control(), /restart/);
  f.reload();
  await assert.rejects(
    ensureActionsPush(
      { source: 'synthetic', runId: 'run' },
      f.journal,
      () => {},
      async (_, args) => {
        assert.equal(args[0], 'ls-remote');
        return `${'b'.repeat(40)}\trefs/heads/forge-check/run`;
      },
      async () => assert.fail('changed ref must not wait'),
    ),
    error => error.code === 'EVIDENCE_CHANGED',
  );
  assert.equal(f.pushes, 1);
});

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

for (const [detail, rejectionClass, message] of [
  [
    'remote: refusing to allow an OAuth App to create or update workflow `.github/workflows/forge-check.yml` without `workflow` scope',
    'workflow-scope',
    /token lacks workflow scope/,
  ],
  [
    "remote: refusing to allow a Personal Access Token to create or update workflow `.github/workflows/forge-check.yml` without 'workflow' scope",
    'workflow-scope',
    /token lacks workflow scope/,
  ],
  ['remote: GH013: Repository rule violations found', 'ref-policy', /branch protection or repository rules/],
  ['remote: protected branch hook declined', 'ref-policy', /branch protection or repository rules/],
  ['fatal: invalid refspec forge-check/run', 'ref-name', /ref name/],
  ['remote rejected: pre-receive hook declined', 'ref-rejected', /rejected the check ref/],
  ['fatal: Authentication failed', 'access-rejected', /credential write access/],
]) {
  test(`deterministic rejection is terminal and actionable: ${rejectionClass} (${detail.slice(0, 25)})`, async () => {
    const f = fixture({ failure: new GitSyncError(detail, transientGitFailure(detail)) });
    await assert.rejects(
      f.control(),
      error => error.code === 'GITHUB_ACTIONS_PUSH_REJECTED' && message.test(error.message),
    );
    assert.equal(f.pushes, 1);
    assert.equal(f.journal.pushOutcome, 'rejected');
    assert.equal(f.journal.pushAttempts[0].rejectionClass, rejectionClass);
    assert.equal(f.journal.pushAttempts[0].detail, detail);
    assert.equal(f.journal.terminal, true);
    assert.equal(f.waits.length, 0);
  });
}

test('pending infrastructure is an observation and explicit cancellation still wins', () => {
  const run = { status: 'interrupted', error: { code: 'GITHUB_ACTIONS_PENDING_INFRA' } };
  assert.equal(pendingActionsInfra(run), true);
  assert.equal(pendingActionsInfra({ ...run, cancelRequested: true }), false);
  assert.equal(pendingActionsInfra({ ...run, status: 'failed' }), false);
  assert.equal(pendingActionsInfra({ status: 'interrupted' }), false);
});

test('an uncorroborated old rejection marker still goes through bounded discovery', async () => {
  const f = fixture({ succeedAt: 1 });
  f.journal.pushOutcome = 'rejected';
  await f.control();
  assert.equal(f.journal.discovery.length, 1);
  assert.equal(f.journal.pushAttempts.length, 2);
  assert.equal(f.pushes, 1);
});

test('git classifies original stderr before truncating and retains only redacted diagnostics', async t => {
  const bin = mkdtempSync(join(tmpdir(), 'forge-push-stderr-'));
  t.after(() => rmSync(bin, { recursive: true, force: true }));
  const detail =
    'remote: token=synthetic-credential ' +
    'progress '.repeat(100) +
    'refusing to allow an OAuth App to create or update workflow .github/workflows/test.yml without `workflow` scope';
  writeFileSync(
    join(bin, 'git'),
    `#!${process.execPath}\nprocess.stderr.write(${JSON.stringify(detail)}); process.exit(1);\n`,
    { mode: 0o755 },
  );
  const previousPath = process.env.PATH;
  process.env.PATH = `${bin}:${previousPath}`;
  t.after(() => {
    process.env.PATH = previousPath;
  });
  let failure;
  await assert.rejects(syncGit(bin, ['push']), error => {
    failure = error;
    assert.equal(error.rejectionClass, 'workflow-scope');
    assert.equal(error.transient, false);
    assert.ok(error.detail.length <= 603);
    assert.doesNotMatch(error.detail, /synthetic-credential|workflow/);
    assert.match(error.detail, /token=\[redacted\]/);
    return true;
  });
  const f = fixture({ failure });
  await assert.rejects(f.control(), /token lacks workflow scope/);
  assert.doesNotMatch(JSON.stringify(f.journal) + f.progress.join(''), /synthetic-credential/);
  assert.equal(f.journal.pushAttempts[0].rejectionClass, 'workflow-scope');
});

test('a restart after three attempts cannot replenish the five-attempt budget', async () => {
  const f = fixture();
  const sleep = f.sleep;
  f.sleep = async ms => {
    if (f.pushes === 3) throw Error('synthetic restart');
    await sleep(ms);
  };
  await assert.rejects(f.control(), /synthetic restart/);
  assert.equal(f.journal.pushAttempts.length, 3);
  f.reload();
  f.sleep = sleep;
  await assert.rejects(f.control(), error => error.code === 'GITHUB_ACTIONS_PUSH_EXHAUSTED');
  assert.equal(f.pushes, 5);
  assert.equal(f.journal.pushAttempts.length, 5);
});

for (const race of ['same', 'different']) {
  test(`create-only retry lease survives a ${race} commit appearing after the final observation (local bare repo)`, async t => {
    const { workGit } = await import('../dist/work-git.js');
    const root = mkdtempSync(join(tmpdir(), 'forge-push-lease-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    workGit(root, ['init', '--bare', '--template=']);
    const tree = workGit(root, ['write-tree']).trim();
    const commit = workGit(root, ['commit-tree', tree, '-m', 'synthetic check']).trim();
    const other = workGit(root, ['commit-tree', tree, '-m', 'synthetic competing ref']).trim();
    const ref = 'refs/heads/forge-check/run';
    const journal = { repo: 'synthetic/checks', commit, pushOutcome: 'not-sent' };
    let clock = Date.now(),
      pushes = 0;
    const control = ensureActionsPush(
      { source: root, runId: 'run' },
      journal,
      () => {},
      async (_, args) => {
        if (args[0] === 'ls-remote') return workGit(root, ['ls-remote', '--refs', root, ref]);
        if (++pushes === 1) throw new GitSyncError('early EOF', true);
        workGit(root, ['update-ref', ref, race === 'same' ? commit : other]);
        return syncGit(
          root,
          args.map(arg => (arg === 'https://github.com/synthetic/checks.git' ? root : arg)),
        );
      },
      async ms => {
        clock += ms;
      },
      undefined,
      () => clock,
    );
    if (race === 'different')
      await assert.rejects(control, error => error.code === 'GITHUB_ACTIONS_PUSH_REJECTED');
    else await control;
    assert.equal(pushes, 2);
    assert.equal(workGit(root, ['rev-parse', ref]).trim(), race === 'same' ? commit : other);
    assert.equal(journal.pushed, race === 'same' ? true : undefined);
  });
}
