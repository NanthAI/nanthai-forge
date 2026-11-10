// SPDX-License-Identifier: Apache-2.0
// Any CI reports a check result (flip 3, Issue 4e4204b6): one contract, run against every adapter
// (BYOCI rule: checks work with any CI, contract test on a second adapter). The pass rule must stay
// unforgeable (2026-11-09 design review, security note N4): the job that ran the Candidate cannot pass
// its own check, however it reports, and only the provider's record of the run Forge bound counts.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHmac, generateKeyPairSync } from 'node:crypto';
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

async function providerFixture(t, { creator, prepare = true } = {}) {
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
  if (!prepare) return { s, run, id, scheduled, main, configuration };
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
  return { s, run, id, seed, main, scheduled, configuration, event, receive };
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

// Exercise the registered publisher with synthetic source/GitHub boundaries; no live credentials.
test('ci-status: Candidate LFS objects upload before its ref exists, and upload failure leaves no branch', async t => {
  const { moduleSource } = await import('./convex-module.mjs');
  const { mirrorFixture } = await import('./hosted-github-mirror-fixture.mjs');
  const { digest } = await import('../dist/hash.js');
  const { parseLfsPointer } = await import('../dist/github-lfs.js');
  const fixtureKey = `__ciPublish_${randomUUID().replaceAll('-', '')}`;
  t.after(() => {
    delete globalThis[fixtureKey];
  });
  for (const failedUpload of [false, true]) {
    const object = 'synthetic-lfs-bytes'.repeat(100);
    const f = mirrorFixture({
      before: { '.gitattributes': '*.bin filter=lfs -text\n' },
      after: { '.gitattributes': '*.bin filter=lfs -text\n', 'model.bin': object },
    });
    f.seed.branch = branch;
    const transfers = [];
    globalThis[fixtureKey] = {
      installationTokenMinter: async () => async () => 'synthetic-token',
      mirrorPermissionsFor: () => ({ contents: 'write' }),
      projectSource: () => f.io,
      githubRequest: () => f.io.api,
      lfsBatch: async (repository, operation, objects) => {
        assert.equal(repository, f.seed.repository);
        assert.equal(operation, 'upload');
        assert.deepEqual(objects, [{ oid: digest(Buffer.from(object)), size: Buffer.byteLength(object) }]);
        return objects.map(object => ({
          ...object,
          upload: { href: 'https://lfs.example/upload', header: {} },
        }));
      },
      uploadLfsObject: async (pointer, bytes) => {
        assert.equal(f.branches.size, 0, 'no branch can trigger CI with an unavailable LFS object');
        assert.equal(bytes.toString(), object);
        transfers.push(pointer.oid);
        if (failedUpload) throw new Error('synthetic upload unavailable');
      },
    };
    let source = moduleSource('../convex/projectCiStatusPublish.ts');
    for (const names of [
      'installationTokenMinter, mirrorPermissionsFor',
      'projectSource',
      'githubRequest',
      'lfsBatch, uploadLfsObject',
    ])
      source = source.replace(
        new RegExp(`import \\{ ${names} \\} from [^;]+;`),
        `const { ${names} } = globalThis.${fixtureKey};`,
      );
    const { publish } = await import(
      `data:text/javascript;base64,${Buffer.from(source).toString('base64')}#${failedUpload}`
    );
    const outcomes = [];
    await publish._handler(
      {
        runMutation: async (ref, input) => {
          const name = getFunctionName(ref);
          if (name === 'projectCiStatus:prepare') return JSON.stringify(f.seed);
          outcomes.push({ name, input });
          return null;
        },
      },
      { projectId: 'synthetic-project', runId },
    );
    assert.equal(transfers.length, 1);
    assert.equal(outcomes.length, 1);
    assert.equal(outcomes[0].name, failedUpload ? 'projectCiStatus:failed' : 'projectCiStatus:published');
    assert.equal(f.branches.size, failedUpload ? 0 : 1);
    if (!failedUpload) {
      assert.equal(f.branches.get(branch), outcomes[0].input.commit);
      const pointerBlob = [...f.githubBlobs.values()].find(bytes => parseLfsPointer(bytes));
      assert.deepEqual(parseLfsPointer(pointerBlob), {
        oid: digest(Buffer.from(object)),
        size: Buffer.byteLength(object),
      });
      assert.equal(f.remote(), f.root.commit, 'Candidate publication preserves main');
    }
  }
});

test('ci-status: mirror lag resumes the same check only when its exact base publication settles, without polling', async t => {
  const { s, run, id, scheduled, main } = await providerFixture(t, { prepare: false });
  const mirror = [...s.tables.projectGithubMirrors.values()][0];
  mirror.mapping = null;
  const jobId = s.insert('projectGithubMirrorJobs', {
    projectId: s.projectId,
    repository: 'acme/app',
    receiptId: run.candidate.base.receiptId,
    sequence: 1,
    authorityEpoch: 1,
    status: 'running',
    state: run.candidate.base.head,
    step: 0,
    cursor: null,
  });
  mirror.activeId = jobId;
  const before = scheduled.length;
  assert.equal(await s.transaction('wait-for-mirror', ciStatus.prepare, id), null);
  assert.equal((await s.status(run.id)).status, 'queued');
  const row = [...s.tables.projectHostedCheckRuns.values()].find(row => row.runId === run.id);
  assert.equal(row.ciMirrorJob, jobId);
  assert.equal(s.tables.projectGithubMirrorJobs.get(jobId).ciWaiters, true);
  assert.equal(scheduled.length, before, 'waiting schedules no timer or polling call');
  // Replayed prepare remains on the same publication and starts no second run.
  assert.equal(await s.transaction('wait-for-mirror-replay', ciStatus.prepare, id), null);
  const wakes = await import(moduleUrl('../convex/projectCiStatusMirror.ts'));
  await s.transaction('early-wake', wakes.wake, { jobId });
  assert.equal(scheduled.length, before, 'an unsettled mirror cannot wake it');
  const job = s.tables.projectGithubMirrorJobs.get(jobId);
  job.status = 'done';
  job.mapping = JSON.stringify(main);
  await s.transaction('mirror-done', wakes.wake, { jobId });
  assert.equal(s.tables.projectHostedCheckRuns.get(row._id).ciMirrorJob, undefined);
  assert.equal(scheduled.length, before + 1);
  assert.deepEqual(scheduled.at(-1), { name: 'projectCiStatusPublish:publish', input: id });
  await s.transaction('mirror-done-replay', wakes.wake, { jobId });
  assert.equal(scheduled.length, before + 1, 'duplicate completion has no work left');
  const seed = JSON.parse(await s.transaction('retry-same-check', ciStatus.prepare, id));
  assert.equal(seed.binding.commit, main.commit);
  assert.equal(seed.branch, candidateBranch(run.id));
});

test('ci-status: a terminal mirror failure settles its waiting check and cancelled waiters never publish', async t => {
  const { s, run, id, scheduled } = await providerFixture(t, { prepare: false });
  const mirror = [...s.tables.projectGithubMirrors.values()][0];
  mirror.mapping = null;
  const jobId = s.insert('projectGithubMirrorJobs', {
    projectId: s.projectId,
    repository: 'acme/app',
    receiptId: run.candidate.base.receiptId,
    sequence: 1,
    authorityEpoch: 1,
    status: 'retrying',
    state: run.candidate.base.head,
    step: 0,
    cursor: null,
  });
  await s.transaction('wait-for-failing-mirror', ciStatus.prepare, id);
  const wakes = await import(moduleUrl('../convex/projectCiStatusMirror.ts'));
  s.tables.projectGithubMirrorJobs.get(jobId).status = 'failed';
  await s.transaction('mirror-failed', wakes.wake, { jobId });
  assert.equal(await s.transaction('retry-failed-mirror', ciStatus.prepare, id), null);
  assert.equal((await s.status(run.id)).status, 'runner-unavailable');
  const row = [...s.tables.projectHostedCheckRuns.values()].find(row => row.runId === run.id);
  row.ciMirrorJob = jobId;
  row.status = 'cancelled';
  const before = scheduled.length;
  await s.transaction('cancelled-waiter', wakes.wake, { jobId });
  assert.equal(s.tables.projectHostedCheckRuns.get(row._id).ciMirrorJob, undefined);
  assert.equal(scheduled.length, before);
});

test('ci-status: signed completion cleans only its Candidate ref with no extra Convex calls; replay and failure preserve the verdict', async t => {
  const f = await providerFixture(t);
  const { s, run, event, receive } = f;
  // Use the ordinary project mirror binding, not the operator shortcut, for the IO budget.
  delete process.env.FORGE_GITHUB_REPO_BINDINGS;
  s.insert('projectGithubBindings', {
    projectId: s.projectId,
    fullName: 'acme/app',
    repoId: 11,
    installationId: 42,
    boundBy: 'owner',
    boundAt: 0,
  });
  s.insert('githubBindingInstallations', { installationId: 42, revision: 0, removed: false });
  const values = {
    GITHUB_APP_ID: '123',
    GITHUB_APP_PRIVATE_KEY: generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({
      type: 'pkcs8',
      format: 'pem',
    }),
    GITHUB_WEBHOOK_SECRET: 'synthetic-hook',
  };
  const prior = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]));
  Object.assign(process.env, values);
  t.after(() => {
    for (const [key, value] of Object.entries(prior))
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
  });
  await receive(event({}, 'in_progress'));
  const from = s.counts.length;
  await receive(event({}, 'in_progress'));
  const unchanged = s.counts.slice(from).find(c => c.name === 'ci-receive');
  assert.equal(
    unchanged.readDocumentsByTable.projectHostedCheckRuns,
    1,
    'reuse the already authorized run row',
  );
  assert.equal(unchanged.writes, 0, 'duplicate progress costs no run rewrite or wake');
  let removed = false,
    deleteFails = true,
    deletes = 0,
    mutations = 0;
  t.mock.method(globalThis, 'fetch', async (url, init = {}) => {
    if (url.endsWith('/installation')) return Response.json({ id: 42 });
    if (url.includes('/access_tokens')) {
      const body = JSON.parse(init.body);
      assert.deepEqual(body.permissions, { contents: 'write' });
      assert.deepEqual(body.repository_ids, [11]);
      return Response.json({ token: 'synthetic-cleanup-token' });
    }
    if (url.endsWith('/git/ref/heads/' + candidateBranch(run.id)))
      return removed ? new Response(null, { status: 404 }) : Response.json({ object: { sha: commit } });
    if (url.endsWith('/git/refs/heads/' + candidateBranch(run.id)) && init.method === 'DELETE') {
      deletes++;
      if (deleteFails) return new Response(null, { status: 500 });
      removed = true;
      return new Response(null, { status: 204 });
    }
    throw Error('Unexpected GitHub path: ' + url);
  });
  const { default: http } = await import(moduleUrl('../convex/http.ts'));
  const route = http.getRoutes().find(([path]) => path === '/github/webhook')[2];
  const payload = event().payload;
  const signature =
    'sha256=' + createHmac('sha256', values.GITHUB_WEBHOOK_SECRET).update(payload).digest('hex');
  const send = (sig = signature) =>
    route._handler(
      {
        runMutation: (ref, input) => {
          mutations++;
          assert.equal(getFunctionName(ref), 'projectHostedActionsWebhook:receive');
          return receive(input);
        },
        runQuery: () => {
          throw Error('Cleanup must reuse the scope from the existing webhook mutation');
        },
      },
      new Request('https://forge.example/github/webhook', {
        method: 'POST',
        body: payload,
        headers: {
          'x-github-event': 'workflow_run',
          'x-github-delivery': 'synthetic-delivery',
          'x-hub-signature-256': sig,
        },
      }),
    );
  assert.equal((await send('sha256=invalid')).status, 401);
  assert.equal(mutations, 0);
  assert.equal(deletes, 0);
  await assert.rejects(send(), code('GITHUB_SYNC_API'));
  const passed = await s.status(run.id);
  assert.equal(passed.status, 'passed', 'cleanup failure cannot retract the provider verdict');
  assert.equal(mutations, 1, 'one existing verdict mutation, no cleanup RPC');
  deleteFails = false;
  assert.equal((await send()).status, 204);
  assert.equal(removed, true);
  assert.equal((await send()).status, 204);
  assert.equal(deletes, 2, 'a missing branch is a no-op after the successful retry');
  assert.equal(mutations, 3, 'one mutation per webhook delivery');
  assert.equal((await s.status(run.id)).terminalDigest, passed.terminalDigest);
});

test('ci-status: cleanup preserves a Candidate ref moved to another commit and cannot target main', async t => {
  const { moduleSource } = await import('./convex-module.mjs');
  const calls = [];
  const key = '__ciCleanup_' + randomUUID().replaceAll('-', '');
  globalThis[key] = {
    actionsToken: async () => 'synthetic-token',
    githubRequest: () => async (path, method) => {
      calls.push({ path, method });
      return { object: { sha: 'd'.repeat(40) } };
    },
  };
  t.after(() => {
    delete globalThis[key];
  });
  const source = moduleSource('../convex/projectCiStatusCleanup.ts')
    .replace(/import \{ actionsToken \} from [^;]+;/, `const { actionsToken } = globalThis.${key};`)
    .replace(
      /import \{ githubRequest, GithubMirrorApiError \} from [^;]+;/,
      `import { GithubMirrorApiError } from '${new URL('../dist/hosted-github-api.js', import.meta.url).href}'; const { githubRequest } = globalThis.${key};`,
    );
  const { cleanupCiBranch } = await import(
    'data:text/javascript;base64,' + Buffer.from(source).toString('base64')
  );
  const input = { projectId: 'synthetic-project', runId, repository: 'acme/app', commit, scope: null };
  await assert.rejects(cleanupCiBranch({}, input), code('EVIDENCE_CHANGED'));
  assert.equal(calls.length, 1);
  assert.notEqual(calls[0].method, 'DELETE');
  await assert.rejects(cleanupCiBranch({}, { ...input, runId: 'main' }), code('EVIDENCE_CHANGED'));
  assert.equal(calls.length, 1, 'invalid cleanup identity makes no IO');
});

test('ci-status: a revoked mirror binding prevents cleanup IO without retracting a signed provider pass', async t => {
  const { s, run, event, receive } = await providerFixture(t);
  delete process.env.FORGE_GITHUB_REPO_BINDINGS;
  const cleanup = await receive(event());
  assert.equal(cleanup, null, 'no private cleanup instruction without the current mirror binding');
  assert.equal((await s.status(run.id)).status, 'passed');
});

test('ci-status: superseding a bound run shares the Actions stop path and reconciles lost preparation and transient GitHub replies', async t => {
  const { s, run, id, scheduled, event, receive } = await providerFixture(t);
  await receive(event({}, 'in_progress'));
  const cancelStore = await import(moduleUrl('../convex/projectHostedCheckCancel.ts'));
  const cancel = () =>
    s.transaction('cancel-ci', { _handler: ctx => cancelStore.cancelUnneededHostedCheck(ctx, id) });
  await cancel();
  await cancel();
  assert.equal((await s.status(run.id)).status, 'cancelled');
  assert.equal(scheduled.filter(job => job.name === 'projectHostedActionsWebhook:cancel').length, 1);
  const prepared = JSON.parse(await s.transaction('lost-ci-stop-prepare', webhooks.cancellation, id));
  assert.equal(prepared.executionId, '777');
  assert.equal(prepared.configuration.ci.repository, 'acme/app');
  const key = '__ciCancel_' + randomUUID().replaceAll('-', '');
  let mints = 0,
    requests = 0;
  globalThis[key] = {
    actionsToken: async () => {
      mints++;
      return 'synthetic-token';
    },
    githubAppRequest: async (path, _token, request) => {
      assert.equal(path, 'repos/acme/app/actions/runs/777/cancel');
      assert.equal((await request('https://api.github.com/' + path, { method: 'POST' })).status, 204);
    },
  };
  t.after(() => {
    delete globalThis[key];
  });
  t.mock.method(
    globalThis,
    'fetch',
    async () => new Response(null, { status: ++requests === 1 ? 503 : 409 }),
  );
  const { moduleSource } = await import('./convex-module.mjs');
  const source = moduleSource('../convex/projectHostedActionsWebhook.ts').replace(
    /import \{ actionsToken, githubAppRequest \} from [^;]+;/,
    `const { actionsToken, githubAppRequest } = globalThis.${key};`,
  );
  const { cancel: action } = await import(
    'data:text/javascript;base64,' + Buffer.from(source).toString('base64')
  );
  await action._handler(
    {
      runMutation: (ref, input) => {
        assert.equal(getFunctionName(ref), 'projectHostedActionsWebhook:cancellation');
        return s.transaction('replay-ci-stop-prepare', webhooks.cancellation, input);
      },
    },
    id,
  );
  assert.equal(mints, 1);
  assert.equal(requests, 2);
  assert.equal((await s.status(run.id)).status, 'cancelled');
});

test('ci-status: cancellation before publish acknowledgement binds a late signed execution once and never revives it', async t => {
  const { s, run, id, scheduled } = await providerFixture(t, { prepare: false });
  await s.transaction('prepare-before-cancel', ciStatus.prepare, id);
  const cancelStore = await import(moduleUrl('../convex/projectHostedCheckCancel.ts'));
  await s.transaction('cancel-before-published', { _handler: ctx => cancelStore.cancelHostedCheck(ctx, id) });
  const cancelled = await s.status(run.id);
  await s.transaction('late-publish', ciStatus.published, { ...id, commit });
  assert.equal((await s.status(run.id)).status, 'cancelled');
  const record = adapters['github-actions'].record({ ref: candidateBranch(run.id), id: 777, running: true });
  const payload = over => ({
    payload: JSON.stringify({ ...record.payload, workflow_run: { ...record.payload.workflow_run, ...over } }),
  });
  await s.transaction('forged-late-event', webhooks.receive, payload({ event: 'workflow_dispatch' }));
  assert.equal(scheduled.filter(job => job.name === 'projectHostedActionsWebhook:cancel').length, 0);
  for (let i = 0; i < 2; i++) await s.transaction('late-signed-event', webhooks.receive, payload({}));
  const stopped = await s.status(run.id);
  assert.equal(stopped.status, 'cancelled');
  assert.equal(stopped.executionId, '777');
  assert.equal(stopped.terminalDigest, cancelled.terminalDigest);
  assert.equal(scheduled.filter(job => job.name === 'projectHostedActionsWebhook:cancel').length, 1);
});

test('ci-status: supersession preserves a bound run while another landing still consumes it', async t => {
  const { s, run, id, scheduled, event, receive } = await providerFixture(t);
  await receive(event({}, 'in_progress'));
  const consumer = s.insert('projectHostedLandingRequests', {
    projectId: s.projectId,
    channel: 'main',
    submissionId: randomUUID(),
    operationId: randomUUID(),
    actor: 'owner',
    sequence: 1,
    runnable: true,
    phase: 'checking',
    runId: run.id,
    attemptId: randomUUID(),
    value: '{}',
  });
  const cancelStore = await import(moduleUrl('../convex/projectHostedCheckCancel.ts'));
  await s.transaction('preserve-ci-consumer', {
    _handler: ctx => cancelStore.cancelUnneededHostedCheck(ctx, id),
  });
  assert.equal((await s.status(run.id)).status, 'running');
  assert.equal(scheduled.filter(job => job.name === 'projectHostedActionsWebhook:cancel').length, 0);
  s.tables.projectHostedLandingRequests.delete(consumer);
  await s.transaction('release-ci-consumer', {
    _handler: ctx => cancelStore.cancelUnneededHostedCheck(ctx, id),
  });
  assert.equal((await s.status(run.id)).status, 'cancelled');
  assert.equal(scheduled.filter(job => job.name === 'projectHostedActionsWebhook:cancel').length, 1);
});
