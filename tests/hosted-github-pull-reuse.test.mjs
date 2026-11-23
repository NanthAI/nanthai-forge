// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import assert from 'node:assert/strict';
import test from 'node:test';
import { performance } from 'node:perf_hooks';
import { finishFixture } from './hosted-finish-fixture.mjs';
import { inboundCostFixture } from './hosted-github-inbound-cost-fixture.mjs';
import { useSyntheticHostedEnv } from './hosted-race-fixture.mjs';
import { storageClock } from './storage-clock.mjs';
import { moduleUrl } from './convex-module.mjs';
import { actionsIssuer } from '../dist/github-actions-oidc.js';
import { checkCause } from '../dist/hosted-check.js';

const direct = await import(moduleUrl('../convex/projectHostedActionsDirect.ts'));
const checks = await import(moduleUrl('../convex/projectHostedCheckStore.ts'));
const session = await import(moduleUrl('../convex/projectHostedActionsSession.ts'));
const verdict = await import(moduleUrl('../convex/projectHostedActionsVerdict.ts'));
const landings = await import(moduleUrl('../convex/projectHostedLandings.ts'));
useSyntheticHostedEnv(test);

const rowFor = (f, id) => [...f.tables.projectHostedCheckRuns.values()].find(row => row.runId === id);
const pullJob = f => [...f.tables.projectGithubMirrorJobs.values()].find(job => job.pullKey);
const runs = f => [...f.tables.projectHostedCheckRuns.values()].map(row => JSON.parse(row.value));

async function verifiedPull(t, f, inbound, runId) {
  const site = 'https://forge.example';
  const vars = { CONVEX_SITE_URL: site, FORGE_HOSTED_CHECK_KEY_SYNTHETIC: 'synthetic-check-collector-only' };
  const prior = Object.fromEntries(Object.keys(vars).map(key => [key, process.env[key]]));
  Object.assign(process.env, vars);
  t.after(() => {
    for (const [key, value] of Object.entries(prior)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  const id = { projectId: f.projectId, runId };
  const plan = await f.rawChecks.prepare(runId);
  const reserved = JSON.parse(await f.tx('pullTestDispatch', direct.reserve, id));
  assert.equal(reserved.planDigest, plan.run.planDigest);
  const executionId = '123';
  await f.tx('pullTestDispatchAck', direct.observe, {
    ...id,
    fence: reserved.fence,
    outcome: 'accepted',
    executionId,
  });
  const seconds = Math.floor(f.now() / 1000);
  await f.tx(
    'pullTestActionsSession',
    {
      _handler: (ctx, input) => session.actionsSession(ctx, input, false),
    },
    {
      ...id,
      claims: JSON.stringify({
        iss: actionsIssuer,
        aud: site,
        exp: seconds + 300,
        iat: seconds,
        nbf: seconds,
        repository: inbound.repository,
        repository_visibility: 'private',
        workflow_ref: `${inbound.repository}/.github/workflows/forge-check.yml@refs/heads/main`,
        workflow_sha: inbound.root.commit,
        ref: 'refs/heads/main',
        event_name: 'workflow_dispatch',
        run_id: executionId,
        run_attempt: '1',
        runner_environment: 'github-hosted',
      }),
    },
  );
  const active = await f.rawChecks.status(runId);
  for (let index = 0; index < active.plan.shardCount; index++)
    await f.rawChecks.callback(f.rawChecks.shard(active, index));
  await f.tx(
    'pullTestProviderVerdict',
    {
      _handler: async ctx =>
        verdict.completeFromResults(ctx, await checks.loadHostedCheck(ctx, id, false), 'passed'),
    },
    {},
  );
  return f.rawChecks.status(runId);
}

async function drain(f, inbound, beforeTask, afterTask) {
  for (let steps = 0; f.pending().length; steps++) {
    assert(steps < 150, 'the mirror and landing settle without polling');
    await f.passChecks();
    const task = f.pending()[0];
    if (!task) break;
    await beforeTask(task);
    await inbound.execute(task);
    afterTask();
  }
}

const cases = [
  ['base moved', 'main-moved', 0],
  ['tree moved', 'no-unique-checked-tree', 0],
  ['definition changed', 'check-changed', 0],
  ['runner label changed', 'runner-changed', 0],
  ['environment changed', 'runner-changed', 0],
  ['workflow edited by PR', 'check-source-changed', 0],
  ['workflow SHA differs', 'workflow-changed', 0],
  ['missing run', 'missing-run', 0],
  ['missing dispatch', 'missing-forge-dispatch', 0],
  ['foreign repository', 'foreign-proof', 0],
  ['non-member', 'unverified-member', 0],
  ['trigger removed', 'trigger-no-longer-writer', 0],
  ['fork', 'fork', 0],
  ['older run', 'run-predates-base', 0],
  ['PR head changed', 'head-changed', 1],
  ['merge is unproven', 'github-merge-unproven', 1],
  ['lookup rate limited', 'github-lookup-unavailable', 1],
  ['optional permission withdrawn', 'github-lookup-unavailable', 0],
  ['check selector changed after proof', 'proof-refreshed', 1],
  ['trigger removed after proof', 'proof-refreshed', 1],
];
test('GitHub inbound: an exact merged PR reuses its Forge run', t => replay(t, 'exact', 'exact-tree-v1', 1));
test('GitHub inbound: a member trigger can check a same-repo PR by an outsider', t =>
  replay(t, 'outsider author', 'exact-tree-v1', 1));
test('GitHub inbound: main moved after proof keeps a full check', t =>
  replay(t, 'main moved after proof', 'main-moved-after-proof', 1));
for (const [scenario, reason, lookups] of cases)
  test(`GitHub inbound: ${scenario} keeps a full check`, t => replay(t, scenario, reason, lookups));

async function replay(t, scenario, reason, lookups) {
  storageClock(t);
  const f = await finishFixture(t);
  const repository = 'synthetic/mirror';
  await f.rawChecks.store.bindRepository(f.projectId, { repository, repoId: 71, installationId: 42 });
  const { credential: _credential, ...directRunner } = f.rawChecks.runner;
  void _credential;
  const runner = { ...directRunner, repository };
  f.rawChecks.configuration = await f.rawChecks.configure(
    { kind: 'runner', configuration: runner },
    f.rawChecks.configuration.digest,
  );
  f.rawChecks.setPlanSelection(JSON.stringify({ scope: 'full' }));
  if (scenario === 'check selector changed after proof')
    f.rawChecks.definition = await f.rawChecks.configure(
      {
        kind: 'definition',
        checkId: f.rawChecks.checkId,
        command: {
          name: 'team-check',
          executable: 'node',
          args: ['scripts/forge-check.mjs'],
          environmentLabel: 'clean',
        },
      },
      f.rawChecks.definition.digest,
    );
  await f.enqueue(f.request());
  await f.drain();
  await f.passChecks();
  await f.drain();
  const path = scenario === 'workflow edited by PR' ? '.github/workflows/forge-check.yml' : 'inbound.js';
  const inbound = await inboundCostFixture(t, f, { pull: true, path });
  const base = f.currentMain();
  f.advanceClock(60_000);
  const member = 'synthetic-linked-writer';
  f.insert('users', { githubId: '81', accountKey: member, emailVerified: false });
  const membership =
    scenario !== 'non-member'
      ? f.insert('projectContributors', {
          projectId: f.projectId,
          contributor: member,
        })
      : null;
  await inbound.receivePull(scenario === 'outsider author' ? 82 : 81);
  let run;
  for (let steps = 0; f.pending().length; steps++) {
    assert(steps < 100);
    const task = f.pending()[0];
    await inbound.execute(task);
    if (task.name === 'projectGithubPull:start') {
      const { runId } = JSON.parse(pullJob(f).inbound).pull;
      assert(runId, JSON.stringify(pullJob(f)));
      run = await verifiedPull(t, f, inbound, runId);
    }
  }
  assert.equal(run?.status, 'passed');
  const job = pullJob(f);
  const contents = JSON.parse(job.inbound);
  assert.equal(contents.pull.outcome, 'success');
  // Route provider-hosted plan objects through the same fake R2 as source manifests.
  for (const [id, bytes] of f.rawChecks.objectBytes) f.c.objects.set(id, bytes);

  if (scenario === 'base moved') f.moveMain({ sameHead: true });
  if (scenario === 'tree moved') inbound.changeTree();
  if (scenario === 'definition changed')
    await f.rawChecks.configure(
      {
        kind: 'definition',
        checkId: f.rawChecks.checkId,
        command: {
          name: 'verify',
          executable: 'node',
          args: ['scripts/new-check.mjs'],
          environmentLabel: 'clean',
        },
      },
      f.rawChecks.definition.digest,
    );
  if (scenario === 'runner label changed' || scenario === 'environment changed')
    await f.rawChecks.configure(
      {
        kind: 'runner',
        configuration: {
          ...runner,
          ...(scenario === 'runner label changed'
            ? { runsOn: 'ubuntu-24.04' }
            : { environmentFingerprint: 'e'.repeat(64) }),
        },
      },
      f.rawChecks.configuration.digest,
    );
  if (scenario === 'missing run')
    f.patch('projectGithubMirrorJobs', job._id, {
      inbound: JSON.stringify({ ...contents, pull: { ...contents.pull, runId: undefined } }),
    });
  if (scenario === 'foreign repository')
    f.patch('projectGithubMirrorJobs', job._id, { repository: 'synthetic/other' });
  if (scenario === 'fork')
    f.patch('projectGithubMirrorJobs', job._id, {
      inbound: JSON.stringify({ ...contents, pull: { ...contents.pull, fork: true } }),
    });
  if (['missing dispatch', 'older run', 'workflow SHA differs'].includes(scenario))
    f.patch('projectHostedCheckRuns', rowFor(f, run.id)._id, {
      value: JSON.stringify({
        ...run,
        ...(scenario === 'missing dispatch' ? { dispatchStarted: false } : {}),
        ...(scenario === 'older run' ? { at: '2025-12-31T23:59:00.000Z' } : {}),
        ...(scenario === 'workflow SHA differs'
          ? { actions: { ...run.actions, workflowSha: 'd'.repeat(40) } }
          : {}),
      }),
    });
  if (scenario === 'PR head changed')
    inbound.setAssociation({
      number: contents.pull.number,
      merge_commit_sha: 'e'.repeat(40),
      merged_at: '2026-01-01T00:00:00Z',
      base: { ref: 'main', repo: { id: 71 } },
      head: { sha: 'a'.repeat(40), repo: { id: 71 } },
    });
  if (scenario === 'merge is unproven') inbound.setAssociation([]);
  if (scenario === 'lookup rate limited') inbound.failAssociation(429);
  if (scenario === 'optional permission withdrawn') inbound.revokeOptionalPermission();
  if (scenario === 'trigger removed') f.tables.projectContributors.delete(membership);
  if (scenario === 'environment changed')
    f.rawChecks.setPlanOverrides({
      environmentFingerprint: 'e'.repeat(64),
    });

  const from = f.counts.length;
  const githubBefore = inbound.requestCount();
  const started = performance.now();
  const existing = new Set(runs(f).map(run => run.id));
  await inbound.receive();
  let changed = false;
  let published;
  let scheduledSteps = 0;
  await drain(
    f,
    inbound,
    async task => {
      if (scenario.endsWith(' after proof') && !changed && task.name === 'projectHostedFinishDriver:drive') {
        assert([...f.tables.projectHostedLandingRequests.values()].some(row => row.githubInboundProof));
        changed = true;
        if (scenario === 'main moved after proof') f.moveMain({ sameHead: true });
        if (scenario === 'trigger removed after proof') f.tables.projectContributors.delete(membership);
        if (scenario === 'check selector changed after proof')
          await f.rawChecks.configure({
            kind: 'definition',
            checkId: crypto.randomUUID(),
            command: {
              name: 'verify',
              executable: 'node',
              args: ['scripts/new-check.mjs'],
              environmentLabel: 'clean',
            },
          });
      }
    },
    () => {
      scheduledSteps++;
      const outcome = [...f.tables.projectGithubMirrors.values()][0].inbound;
      if (!published && outcome && JSON.parse(outcome).outcome === 'landed')
        published = { transactions: f.counts.length - from, ms: Math.round(performance.now() - started) };
    },
  );
  const queue = [...f.tables.projectGithubMirrors.values()][0];
  const newRuns = runs(f).filter(run => !existing.has(run.id));
  const landingChecks = newRuns.filter(run => rowFor(f, run.id).cause !== checkCause.audit);
  if (scenario === 'workflow edited by PR') {
    const job = f.tables.projectGithubMirrorJobs.get(queue.activeId);
    const state = JSON.parse(job.inbound);
    assert.deepEqual(state.reuse, { reason, githubLookups: lookups });
    const landing = [...f.tables.projectHostedLandingRequests.values()].find(
      row => row.submissionId === state.submissionId,
    );
    assert.equal(JSON.parse(landing.value).observation.pendingReason, 'waiting-for-review');
    assert.equal(f.currentMain().receipt.id, base.receipt.id);
    assert.equal(landingChecks.length, 1);
    assert.equal(inbound.lookupCount(), lookups);
    return;
  }
  const receipt = JSON.parse(
    [...f.tables.projectHostedAcceptances.values()].find(row => row.receiptId === f.currentMain().receipt.id)
      .value,
  );
  assert.notEqual(receipt.id, base.receipt.id);
  assert.equal(queue.activeId, null);
  const outcome = JSON.parse(queue.inbound);
  assert.equal(outcome.outcome, 'landed');
  assert.deepEqual(outcome.reuse, { reason, githubLookups: lookups });
  assert.equal(inbound.lookupCount(), lookups);
  const reused = reason === 'exact-tree-v1';
  assert.equal(landingChecks.length, reused ? 0 : 1);
  if (reused) {
    assert.equal(receipt.check.runId, run.id);
    assert.equal(receipt.crossHeadProof.algorithm, 'exact-tree-v1');
    assert.notEqual(receipt.candidate.id, run.request.candidateId);
    assert.notEqual(receipt.candidate.head, run.request.expectedHead);
  } else {
    assert.equal(receipt.crossHeadProof, undefined);
    assert.notEqual(receipt.check.runId, run.id);
    assert.equal(landingChecks[0].request.expectedHead, receipt.candidate.head);
  }
  assert.equal(f.pending().length, 0);
  const counts = f.counts.slice(from);
  t.diagnostic(
    JSON.stringify({
      scenario,
      githubLookups: lookups,
      githubRequests: inbound.requestCount() - githubBefore,
      postLandingAudits: newRuns.length - landingChecks.length,
      published,
      scheduledSteps,
      convexTransactions: counts.length,
      documentsRead: counts.reduce((n, call) => n + call.documents, 0),
      documentsWritten: counts.reduce((n, call) => n + call.writes, 0),
      bytesRead: counts.reduce((n, call) => n + call.readBytes, 0),
      bytesWritten: counts.reduce((n, call) => n + call.writeBytes, 0),
      replayMs: Math.round(performance.now() - started),
      rssBytes: process.memoryUsage().rss,
      peakRssBytes: process.resourceUsage().maxRSS * 1024,
    }),
  );
  if (scenario === 'main moved after proof') {
    const history = JSON.parse(
      await f.tx('inboundLandingHistory', landings.read, {
        projectId: f.projectId,
        receiptId: receipt.id,
      }),
    );
    assert.equal(history.landings[0].receiptId, receipt.id);
  }
}
