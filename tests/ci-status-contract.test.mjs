// SPDX-License-Identifier: Apache-2.0
// Any CI reports a check result (flip 3, Issue 4e4204b6): one contract, run against every adapter
// (BYOCI rule: checks work with any CI, contract test on a second adapter). The pass rule must stay
// unforgeable (2026-11-09 design review, security note N4): the job that ran the Candidate cannot pass
// its own check, however it reports, and only the provider's record of the run Forge bound counts.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  candidateBranch,
  candidatePublishable,
  ciStatusEntryPaths,
  ciStatusProviderSchema,
  ciStatusVerdict,
  providerReadPath,
} from '../dist/ci-status.js';

const runId = '6f1c2d3e-4a5b-4c6d-8e7f-0a1b2c3d4e5f';
const commit = 'c'.repeat(40);
const branch = candidateBranch(runId);
const bound = (over = {}) => ({ runId, commit, executionId: null, ...over });

/** Each adapter: its provider setting, a provider record (in the form Forge receives it on its own
 * channel), and the identity claims a job of that run would carry. */
const adapters = {
  'github-actions': {
    provider: ciStatusProviderSchema.parse({
      adapter: 'github-actions',
      repository: 'acme/app',
      workflow: '.github/workflows/test.yml',
    }),
    record: ({
      result = 'success',
      running = false,
      id = 101,
      sha = commit,
      ref = branch,
      startedBy,
    } = {}) => ({
      source: 'provider-event',
      signed: true,
      payload: {
        action: running ? 'in_progress' : 'completed',
        repository: { full_name: 'acme/app' },
        workflow_run: {
          id,
          run_attempt: 1,
          event: startedBy ?? 'push',
          path: '.github/workflows/test.yml',
          head_branch: ref,
          head_sha: sha,
          status: running ? 'in_progress' : 'completed',
          conclusion: running
            ? null
            : { success: 'success', failed: 'failure', cancelled: 'cancelled' }[result],
          html_url: `https://github.com/acme/app/actions/runs/${id}`,
        },
      },
    }),
    claims: {
      repository: 'acme/app',
      ref: `refs/heads/${branch}`,
      sha: commit,
      workflow_ref: `acme/app/.github/workflows/test.yml@refs/heads/${branch}`,
      event_name: 'push',
    },
    jobStartedBy: 'workflow_dispatch',
  },
  'gitlab-ci': {
    provider: ciStatusProviderSchema.parse({
      adapter: 'gitlab-ci',
      origin: 'https://gitlab.example',
      projectPath: 'acme/app',
      projectId: 42,
      credential: { secretId: 'secret-1', version: 1, operation: 'op-1' },
    }),
    record: ({
      result = 'success',
      running = false,
      id = 101,
      sha = commit,
      ref = branch,
      startedBy,
    } = {}) => ({
      source: 'provider-api',
      record: {
        id,
        project_id: 42,
        sha,
        ref,
        source: startedBy ?? 'push',
        status: running ? 'running' : { success: 'success', failed: 'failed', cancelled: 'canceled' }[result],
        web_url: `https://gitlab.example/acme/app/-/pipelines/${id}`,
      },
    }),
    claims: {
      iss: 'https://gitlab.example',
      project_path: 'acme/app',
      ref: branch,
      ref_type: 'branch',
      sha: commit,
      pipeline_source: 'push',
    },
    jobStartedBy: 'pipeline',
  },
};

const passReport = { name: 'test', state: 'passed', link: 'https://ci.example/run/1', summary: 'all green' };

for (const [name, a] of Object.entries(adapters)) {
  const verdict = (evidence, binding = bound()) => ciStatusVerdict(a.provider, binding, evidence);

  test(`${name}: the provider's record of the bound run decides pass, failure and cancellation`, () => {
    assert.deepEqual(
      [
        verdict(a.record()).status,
        verdict(a.record({ result: 'failed' })).status,
        verdict(a.record({ result: 'cancelled' })).status,
      ],
      ['passed', 'failed', 'cancelled'],
    );
    assert.equal(verdict(a.record({ running: true })).outcome, 'pending');
    assert.equal(verdict(a.record()).executionId, '101');
  });

  test(`${name}: a job that reports its own pass is refused (N4)`, () => {
    // With the identity of exactly the bound run, the report only wakes Forge's own provider read.
    const own = verdict({ source: 'job-report', claims: a.claims, status: passReport });
    assert.equal(own.outcome, 'read-provider');
    assert.notEqual(own.status, 'passed');
    // A report from another branch, commit or project is refused outright.
    for (const claims of [{ ...a.claims, sha: 'd'.repeat(40) }, { ...a.claims, ref: 'main' }, {}])
      assert.equal(verdict({ source: 'job-report', claims, status: passReport }).outcome, 'refused');
  });

  test(`${name}: a run a job started itself is refused, even on the same commit`, () => {
    const v = verdict(a.record({ startedBy: a.jobStartedBy }));
    assert.equal(v.outcome, 'refused');
    assert.equal(v.code, 'EVIDENCE_CHANGED');
  });

  test(`${name}: a run of another commit or branch than the published Candidate is refused`, () => {
    assert.equal(verdict(a.record({ sha: 'd'.repeat(40) })).outcome, 'refused');
    assert.equal(
      verdict(a.record({ ref: candidateBranch('00000000-0000-4000-8000-000000000000') })).outcome,
      'refused',
    );
  });

  test(`${name}: a later execution never replaces the run Forge bound`, () => {
    assert.equal(verdict(a.record({ id: 202 }), bound({ executionId: '101' })).outcome, 'refused');
    assert.equal(verdict(a.record({ id: 101 }), bound({ executionId: '101' })).status, 'passed');
  });

  test(`${name}: the CI file is a protected check entry, so changing it needs the owner's review`, () => {
    const file = name === 'github-actions' ? '.github/workflows/test.yml' : '.gitlab-ci.yml';
    assert.deepEqual(ciStatusEntryPaths(a.provider), [file]);
  });

  test(`${name}: Forge reads the provider record from a path the setting and binding fix`, () => {
    const path = providerReadPath(a.provider, bound());
    assert.ok(path.includes(encodeURIComponent(branch)) && path.includes(commit));
    assert.ok(providerReadPath(a.provider, bound({ executionId: '101' })).endsWith('/101'));
  });
}

test('github-actions: an unsigned event never carries a run result', () => {
  const { provider, record } = adapters['github-actions'];
  assert.equal(ciStatusVerdict(provider, bound(), { ...record(), signed: false }).outcome, 'refused');
});

test('github-actions: a run of another workflow file on the Candidate branch is refused', () => {
  const { provider, record } = adapters['github-actions'];
  const evidence = record();
  evidence.payload.workflow_run.path = '.github/workflows/always-green.yml';
  assert.equal(ciStatusVerdict(provider, bound(), evidence).outcome, 'refused');
});

test('gitlab-ci: a webhook only wakes the pipeline read; its status never decides', () => {
  const { provider } = adapters['gitlab-ci'];
  const hook = {
    source: 'provider-event',
    signed: false,
    payload: { object_attributes: { status: 'success' } },
  };
  assert.equal(ciStatusVerdict(provider, bound(), hook).outcome, 'refused');
});

test("outside contributors' Candidates reach a job with the repository's secrets only after owner approval", () => {
  assert.equal(candidatePublishable({ authors: ['owner', 'contributor'], ownerApproved: false }), true);
  assert.equal(candidatePublishable({ authors: ['contributor', 'outside'], ownerApproved: false }), false);
  assert.equal(candidatePublishable({ authors: ['outside'], ownerApproved: true }), true);
  assert.equal(candidatePublishable({ authors: [], ownerApproved: false }), false);
});

// The provider wired into Forge's check runs: configure, publish, then GitHub's signed event decides.
const { checksFixture, code } = await import('./hosted-checks-fixture.mjs');
const { moduleUrl } = await import('./convex-module.mjs');
const { getFunctionName } = await import('convex/server');
const ciStatus = await import(moduleUrl('../convex/projectCiStatus.ts'));
const webhooks = await import(moduleUrl('../convex/projectHostedActionsWebhook.ts'));

async function providerFixture(t, { creator } = {}) {
  const s = await checksFixture(),
    scheduled = [];
  s.decorateContext(ctx => {
    ctx.scheduler = {
      runAfter: async (delay, ref, input) => (scheduled.push({ name: getFunctionName(ref), input }), 'id'),
      cancel: async () => {},
    };
  });
  const prior = process.env.FORGE_GITHUB_REPO_BINDINGS;
  process.env.FORGE_GITHUB_REPO_BINDINGS = `${s.projectId}=acme/app`;
  t.after(() => {
    if (prior === undefined) delete process.env.FORGE_GITHUB_REPO_BINDINGS;
    else process.env.FORGE_GITHUB_REPO_BINDINGS = prior;
  });
  const ci = { adapter: 'github-actions', repository: 'acme/app', workflow: '.github/workflows/test.yml' };
  const runner = {
    provider: 'ci-status',
    ci,
    runtime: 'e'.repeat(64),
    environmentFingerprint: 'e'.repeat(64),
  };
  // Candidate branches start from main's mirrored commit: no mirror, no setting.
  await assert.rejects(
    s.configure({ kind: 'runner', configuration: runner }, s.configuration.digest),
    code('BAD_ARGUMENT'),
  );
  const identity = { name: 'Forge Sync', email: 'sync@users.noreply.github.com' };
  const main = {
    publication: 'tracked',
    operationId: randomUUID(),
    state: s.state.sha256,
    acceptanceId: randomUUID(),
    viewId: randomUUID(),
    commit: 'b'.repeat(40),
    parent: 'a'.repeat(40),
    tree: 'f'.repeat(40),
    message: 'main',
    author: identity,
    committer: identity,
    seconds: 1767225600,
  };
  s.insert('projectGithubMirrors', {
    projectId: s.projectId,
    repository: 'acme/app',
    activeId: null,
    mapping: JSON.stringify(main),
  });
  const configuration = await s.configure({ kind: 'runner', configuration: runner }, s.configuration.digest);
  const run = await s.enqueue(
    s.selection({
      expectedConfiguration: configuration.digest,
      expectedEnvironment: configuration.value.environmentFingerprint,
    }),
  );
  const id = { projectId: s.projectId, runId: run.id };
  if (creator) {
    const head = [...s.tables.projectHostedRecordHeads.values()].find(
      row => row.kind === 'candidate' && row.key === run.request.candidateId,
    );
    s.tables.projectHostedRecords.get(head.recordId).creatorAccountId = creator;
    return { s, run, id, scheduled };
  }
  const seed = JSON.parse(await s.transaction('ci-prepare', ciStatus.prepare, id));
  const published = 'c'.repeat(40);
  await s.transaction('ci-published', ciStatus.published, { ...id, commit: published });
  const event = (over = {}, action = 'completed', conclusion = 'success') => ({
    payload: JSON.stringify({
      action,
      repository: { full_name: 'acme/app' },
      workflow_run: {
        id: 777,
        run_attempt: 1,
        event: 'push',
        path: '.github/workflows/test.yml',
        head_branch: candidateBranch(run.id),
        head_sha: published,
        status: action === 'completed' ? 'completed' : 'in_progress',
        conclusion: action === 'completed' ? conclusion : null,
        html_url: 'https://github.com/acme/app/actions/runs/777',
        ...over,
      },
    }),
  });
  const receive = value => s.transaction('ci-receive', webhooks.receive, value);
  return { s, run, seed, main, scheduled, configuration, event, receive };
}

test("ci-status: a run publishes its Candidate branch on main's mirrored commit, then GitHub's signed event passes it", async t => {
  const { s, run, seed, main, scheduled, configuration, event, receive } = await providerFixture(t);
  assert.ok(
    scheduled.some(job => job.name === 'projectCiStatusPublish:publish' && job.input.runId === run.id),
  );
  assert.equal(seed.branch, candidateBranch(run.id));
  assert.equal(seed.binding.commit, main.commit);
  assert.equal(seed.state, run.request.expectedHead);
  // The CI file is a protected check entry (owner review when a Candidate changes it).
  assert.ok(s.tables.hostedProjects.get(s.projectId).checkEntries.includes('.github/workflows/test.yml'));
  assert.equal(
    configuration.value.runtime,
    s.checkPin({ provider: 'ci-status', ci: configuration.value.ci }),
  );
  await receive(event({}, 'in_progress'));
  assert.equal((await s.status(run.id)).status, 'running');
  await receive(event());
  const passed = await s.status(run.id);
  assert.equal(passed.status, 'passed');
  assert.equal(passed.executionId, '777');
  // The same exact-evidence rule acceptance applies to every provider.
  assert.equal((await s.evidence(passed)).id, run.id);
  // An older CLI (no ci-status-check feature) is refused by name instead of getting a shape it cannot parse.
  await assert.rejects(s.status(run.id, 'owner', null), /update the Forge CLI/);
});

test('ci-status: a job that reports its own pass through another run never passes the check (N4)', async t => {
  const { s, run, event, receive } = await providerFixture(t);
  // A run the job dispatched, another workflow file, another commit, a re-run: all ignored.
  for (const over of [
    { event: 'workflow_dispatch' },
    { path: '.github/workflows/always-green.yml' },
    { head_sha: 'd'.repeat(40) },
    { run_attempt: 2 },
  ])
    await receive(event(over));
  assert.equal((await s.status(run.id)).status, 'running');
  // The bound run's own failure fails it.
  await receive(event({}, 'completed', 'failure'));
  const failed = await s.status(run.id);
  assert.equal(failed.status, 'failed');
  await assert.rejects(s.evidence(failed), code('EVIDENCE_CHANGED'));
});

test("ci-status: an outside contributor's Candidate never reaches a job that holds the repository's secrets", async t => {
  const { s, run, id } = await providerFixture(t, { creator: 'outside-account' });
  assert.equal(await s.transaction('ci-prepare', ciStatus.prepare, id), null);
  const settled = await s.status(run.id);
  assert.equal(settled.status, 'runner-unavailable');
  assert.equal(settled.ci, undefined);
  assert.match(settled.failureReason, /outside contributor/);
});

for (const [name, a] of Object.entries(adapters)) {
  test(`${name}: optional proof reports share one contract and never decide the check verdict`, () => {
    const proof = {
      kind: 'proof',
      reports: [{ file: 'tests/regression.test.mjs', base: 'failed', head: 'passed' }],
    };
    assert.deepEqual(
      ciStatusVerdict(a.provider, bound(), { source: 'job-report', claims: a.claims, status: proof }),
      { outcome: 'proof', proof },
    );
    assert.equal(
      ciStatusVerdict(a.provider, bound(), { source: 'job-report', claims: {}, status: proof }).outcome,
      'refused',
    );
    assert.equal(
      ciStatusVerdict(a.provider, bound(), {
        source: 'job-report',
        claims: a.claims,
        status: { ...proof, reports: [{ file: '../secret', base: 'failed' }] },
      }).outcome,
      'refused',
    );
    assert.equal(
      ciStatusVerdict(a.provider, bound(), a.record()).status,
      'passed',
      'provider success needs no proof',
    );
    assert.equal(
      ciStatusVerdict(a.provider, bound(), a.record({ result: 'failed' })).status,
      'failed',
      'proof never overrides the provider failure',
    );
  });
}

test('proof counts only failures on base with a passing non-flaky head report', async () => {
  const { proofSummary } = await import('../dist/landing-proof.js');
  const proof = {
    kind: 'proof',
    reports: ['a', 'b', 'c', 'd', 'e'].map(file => ({
      file: `tests/${file}.test.mjs`,
      base: file === 'd' ? 'passed' : file === 'e' ? 'error' : 'failed',
      head: 'passed',
    })),
  };
  assert.deepEqual(
    proofSummary(proof, {
      contractReports: {
        'tests/a.test.mjs': { failed: false },
        'tests/b.test.mjs': { failed: true },
        'tests/c.test.mjs': { failed: false, flaky: true },
      },
    }),
    { proven: 1, passedOnBase: 1, inconclusive: 3 },
  );
});
