// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// Item 8b6efb50: deploy tracking, ancestry (first successful deploy whose head contains a landing),
// reactive wait (`wait {"deploy": ...}`), lane-history & receipt integration, and Needs you notices
// for deploy / post-deploy smoke failures (including negative authorization tests).
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { lanesFixture } from './hosted-lanes-fixture.mjs';
import { acceptMirrorReceipt } from './github-mirror-catchup-fixture.mjs';
import { moduleUrl } from './convex-module.mjs';
import { policyPreset } from '../dist/autonomy-policy.js';
import { observeDeploy, deployWaitResult } from '../dist/hosted-deploy-wait.js';
import { hostedWaitSchema } from '../dist/hosted-wait-schema.js';
import { landingsHostedSource } from '../dist/hosted-agent-landings.js';

const deployStore = await import(moduleUrl('../convex/projectDeployStore.ts'));
const boardWait = await import(moduleUrl('../convex/projectBoardWait.ts'));
const laneHistory = await import(moduleUrl('../convex/projectHostedLaneHistory.ts'));
const mirrorStatus = await import(moduleUrl('../convex/projectGithubMirrorStatus.idle.ts'));
const needsMe = await import(moduleUrl('../convex/projectNeedsMe.ts'));
const { hostedRecordValue } = await import(moduleUrl('../src/hosted-records.ts'));

const hex = c => c.repeat(64);

function makeProject({ enrolled = true, runnerRepo } = {}) {
  const s = lanesFixture();
  const projectId = s.insert('hostedProjects', {
    owner: 'owner',
    name: 'forge',
    key: 'forge',
    currentBackup: null,
    revision: 0,
    visibility: 'private',
    sourceAuthority: { mode: 'server', epoch: 1 },
    autonomyPolicy: {
      ...policyPreset('supervised'),
      githubMirror: { repo: 'NanthAI/nanthai-forge', autoPush: false, laneRefs: false },
    },
  });
  if (enrolled) {
    s.insert('projectReleaseSignatures', {
      projectId,
      head: hex('9'),
      keyId: 'k',
      signature: 's',
      release: 1,
      actor: 'release-key:k',
      at: 1,
    });
  }
  if (runnerRepo) {
    s.insert('projectHostedCheckSettings', {
      projectId,
      kind: 'runner',
      key: 'runner',
      version: 1,
      digest: hex('8'),
      value: JSON.stringify({ provider: 'github-actions', repository: runnerRepo }),
    });
  }
  s.projectId = projectId;
  let prev = hex('0');
  const accept = (sequence, head) => {
    const receipt = acceptMirrorReceipt(s, head, prev, sequence);
    prev = head;
    return receipt.id;
  };
  return { s, projectId, accept };
}

test('Item 8b6efb50: deploy record refuses unenrolled projects, wrong repo/workflow/head, and preserves succeeded attempts across re-runs', async () => {
  // Negative auth: mirror-only project without dev-deploy enrollment is refused.
  const unenrolled = makeProject({ enrolled: false });
  unenrolled.accept(1, hex('a'));
  await assert.rejects(
    unenrolled.s.call('deploy', deployStore.record, {
      projectId: unenrolled.projectId,
      target: 'web',
      repository: 'NanthAI/nanthai-forge',
      workflow: 'web-deploy.yml',
      state: hex('a'),
      sequence: 1,
      status: 'succeeded',
      runId: '99:1',
    }),
    error => error.code === 'EVIDENCE_CHANGED',
  );

  const { s, projectId, accept } = makeProject();
  accept(10, hex('a'));
  accept(11, hex('b'));

  // Negative auth: wrong repository
  await assert.rejects(
    s.call('deploy', deployStore.record, {
      projectId,
      target: 'web',
      repository: 'attacker/evil',
      workflow: 'web-deploy.yml',
      state: hex('b'),
      sequence: 11,
      status: 'succeeded',
      runId: '100',
    }),
    error => error.code === 'EVIDENCE_CHANGED',
  );
  // Negative auth: mismatched workflow for target
  await assert.rejects(
    s.call('deploy', deployStore.record, {
      projectId,
      target: 'web',
      repository: 'NanthAI/nanthai-forge',
      workflow: 'convex-deploy.yml',
      state: hex('b'),
      sequence: 11,
      status: 'succeeded',
      runId: '100',
    }),
    error => error.code === 'EVIDENCE_CHANGED',
  );
  // Negative validation: bogus state/sequence not on hosted main
  await assert.rejects(
    s.call('deploy', deployStore.record, {
      projectId,
      target: 'web',
      repository: 'NanthAI/nanthai-forge',
      workflow: 'web-deploy.yml',
      state: hex('f'),
      sequence: 11,
      status: 'succeeded',
      runId: '100',
    }),
    error => error.code === 'EVIDENCE_CHANGED',
  );

  // Valid record + idempotent retry with same runId:attempt updates in place; long diagnostics clamp cleanly.
  const first = JSON.parse(
    await s.call('deploy', deployStore.record, {
      projectId,
      target: 'web',
      repository: 'NanthAI/nanthai-forge',
      workflow: 'web-deploy.yml',
      state: hex('b'),
      sequence: 11,
      status: 'smoke-failed',
      runId: '101:1',
      url: 'https://github.com/NanthAI/nanthai-forge/actions/runs/101',
      summary: `sitemap returned HTTP 502 ${'x'.repeat(300)}`,
      smoke: {
        ok: false,
        checks: [{ name: 'sitemap', ok: false, status: 502, detail: `HTTP 502 ${'y'.repeat(300)}` }],
      },
    }),
  );
  assert.equal(first.recorded, true);
  assert.equal(s.tables.projectDeploys.size, 1);
  assert([...s.tables.projectDeploys.values()][0].summary.length <= 240);
  assert([...s.tables.projectDeploys.values()][0].smoke.checks[0].detail.length <= 240);

  await s.call('deploy', deployStore.record, {
    projectId,
    target: 'web',
    repository: 'NanthAI/nanthai-forge',
    workflow: 'web-deploy.yml',
    state: hex('b'),
    sequence: 11,
    status: 'succeeded',
    runId: '101:1',
    url: 'https://github.com/NanthAI/nanthai-forge/actions/runs/101',
  });
  assert.equal(s.tables.projectDeploys.size, 1, 'retry with same runId:attempt updates the single row');
  assert.equal([...s.tables.projectDeploys.values()][0].status, 'succeeded');

  // Re-run (attempt 2) failing at a newer head never erases attempt 1's successful deploy!
  accept(12, hex('c'));
  await s.call('deploy', deployStore.record, {
    projectId,
    target: 'web',
    repository: 'NanthAI/nanthai-forge',
    workflow: 'web-deploy.yml',
    state: hex('c'),
    sequence: 12,
    status: 'failed',
    runId: '101:2',
    summary: 'cf deploy failed on rerun',
  });
  assert.equal(s.tables.projectDeploys.size, 2);
  const byRun = new Map([...s.tables.projectDeploys.values()].map(r => [r.runId, r]));
  assert.equal(byRun.get('101:1').status, 'succeeded');
  assert.equal(byRun.get('101:1').sequence, 11);
  assert.equal(byRun.get('101:2').status, 'failed');
});

test('Item 8b6efb50: ancestry picks the first successful deploy >= sequence in lane-history, receipts and wait', async () => {
  const { s, projectId, accept } = makeProject();
  const r10 = accept(10, hex('a'));
  const r11 = accept(11, hex('b'));
  const r12 = accept(12, hex('c'));
  const r13 = accept(13, hex('d'));

  // Deploy at #10 failed; #12 succeeded for web; #11 and #13 succeeded for convex.
  await s.call('deploy', deployStore.record, {
    projectId,
    target: 'web',
    repository: 'NanthAI/nanthai-forge',
    workflow: 'web-deploy.yml',
    state: hex('a'),
    sequence: 10,
    status: 'failed',
    runId: '201',
    summary: 'cf deploy failed',
  });
  await s.call('deploy', deployStore.record, {
    projectId,
    target: 'convex',
    repository: 'NanthAI/nanthai-forge',
    workflow: 'convex-deploy.yml',
    state: hex('b'),
    sequence: 11,
    status: 'succeeded',
    runId: '202',
  });
  await s.call('deploy', deployStore.record, {
    projectId,
    target: 'web',
    repository: 'NanthAI/nanthai-forge',
    workflow: 'web-deploy.yml',
    state: hex('c'),
    sequence: 12,
    status: 'succeeded',
    runId: '203',
  });
  await s.call('deploy', deployStore.record, {
    projectId,
    target: 'convex',
    repository: 'NanthAI/nanthai-forge',
    workflow: 'convex-deploy.yml',
    state: hex('d'),
    sequence: 13,
    status: 'succeeded',
    runId: '204',
  });

  // Landing #10: first successful convex is #11, first successful web is #12 (skips failed #10).
  const readDeploys = seq =>
    s.call('deploys', { _handler: ctx => deployStore.deploysForSequence(ctx, projectId, seq) }, {});
  const d10 = await readDeploys(10);
  assert.equal(d10.convex.sequence, 11);
  assert.equal(d10.web.sequence, 12);

  // Landing #12: convex is #13, web is #12.
  const d12 = await readDeploys(12);
  assert.equal(d12.convex.sequence, 13);
  assert.equal(d12.web.sequence, 12);

  // Landing #13: convex is #13, web is still pending (null).
  const d13 = await readDeploys(13);
  assert.equal(d13.convex.sequence, 13);
  assert.equal(d13.web, null);

  // mirrorReceipt returns { deploys } without inventing a synthetic mirror status when no mirror job exists.
  const project = s.tables.hostedProjects.get(projectId);
  const receiptMirror = await s.call(
    'mirror',
    { _handler: ctx => mirrorStatus.mirrorReceipt(ctx, project, r10) },
    {},
  );
  assert.equal(receiptMirror.status, undefined);
  assert.equal(receiptMirror.deploys.convex.sequence, 11);
  assert.equal(receiptMirror.deploys.web.sequence, 12);

  // landingsHostedSource lifts mirror.deploys onto top-level landing.deploys and drops synthetic mirror wrapper.
  const lifted = await landingsHostedSource(
    {
      query: async () => ({
        schema: 1,
        landings: [{ receiptId: r10, mirror: receiptMirror }],
        nextCursor: null,
      }),
    },
    { receiptId: r10 },
  );
  assert.equal(lifted.landings[0].mirror, undefined);
  assert.equal(lifted.landings[0].deploys.convex.sequence, 11);
  assert.equal(lifted.landings[0].deploys.web.sequence, 12);

  // lane-history attaches landing.deploys via acceptance sequence.
  const laneId = randomUUID();
  const intentId = randomUUID();
  const { value, ref } = hostedRecordValue({
    kind: 'lane',
    id: laneId,
    version: 0,
    at: '2026-11-23T10:00:00.000Z',
    intentId,
    actor: 'owner',
    base: { head: hex('0'), receiptId: 'r-0' },
    head: hex('b'),
    sourceVersion: 0,
    lifecycleVersion: 0,
    state: 'active',
    authorityEpoch: 1,
  });
  const bodyId = s.insert('projectHostedRecordBodies', { projectId, value });
  const recordId = s.insert('projectHostedRecords', {
    projectId,
    kind: 'lane',
    key: laneId,
    parent: intentId,
    status: 'active',
    version: 0,
    bodyId,
    digest: ref.digest,
    bytes: ref.bytes,
  });
  s.insert('projectHostedRecordHeads', {
    projectId,
    kind: 'lane',
    key: laneId,
    parent: intentId,
    status: 'active',
    version: 0,
    recordId,
  });
  s.insert('projectHostedOverlapLanes', {
    lastActivityAt: 4_000_000_000_000,
    projectId,
    laneId,
    intentId,
    actor: 'owner',
    intent: 'test',
    head: hex('b'),
    baseHead: hex('0'),
    baseReceiptId: 'r-0',
    baseSequence: 0,
    recordVersion: 0,
    open: false,
    pathSummary: { paths: [], pathCount: 0 },
    complete: true,
    landed: { receiptId: r11, commit: hex('b'), laneHead: hex('b'), at: '2026-11-23T10:05:00.000Z' },
  });
  const history = JSON.parse(await s.call('history', laneHistory.read, { projectId, laneId }, 'owner'));
  assert.equal(history.landing.deploys.convex.sequence, 11);
  assert.equal(history.landing.deploys.web.sequence, 12);

  // projectBoardWait:deploy returns deployed for r12 (both targets covered), pending for r13 ('all'), deployed for r13 ('convex').
  const w12 = JSON.parse(
    await s.call('wait', boardWait.deploy, { projectId, receiptId: r12.slice(0, 8) }, 'owner'),
  );
  assert.equal(w12.deploy.state, 'deployed');
  const w13All = JSON.parse(await s.call('wait', boardWait.deploy, { projectId, receiptId: r13 }, 'owner'));
  assert.equal(w13All.deploy.state, 'pending');
  const w13Convex = JSON.parse(
    await s.call('wait', boardWait.deploy, { projectId, receiptId: r13, target: 'convex' }, 'owner'),
  );
  assert.equal(w13Convex.deploy.state, 'deployed');

  // Web-only landing (#14): Convex didn't change since #13, so wait {"deploy": r14} settles as deployed once web #14 deploys.
  const r14 = accept(14, hex('e'));
  s.insert('projectHostedOverlapMainLog', {
    projectId,
    sequence: 14,
    after: 13,
    paths: JSON.stringify(['web/src/app/App.tsx']),
  });
  await s.call('deploy', deployStore.record, {
    projectId,
    target: 'web',
    repository: 'NanthAI/nanthai-forge',
    workflow: 'web-deploy.yml',
    state: hex('e'),
    sequence: 14,
    status: 'succeeded',
    runId: '205:1',
  });
  const w14All = JSON.parse(await s.call('wait', boardWait.deploy, { projectId, receiptId: r14 }, 'owner'));
  assert.equal(w14All.deploy.state, 'deployed');
  assert.equal(w14All.deploy.deploys.web.sequence, 14);
  assert.equal(w14All.deploy.deploys.convex.sequence, 13);
  assert.equal(w14All.deploy.deploys.convex.unchanged, true);

  // Regression: a later landing (#16) touching the same Convex file as #15 must NOT mask #15's change
  // when checking whether prior Convex deploy #13 still covers #15.
  const r15 = accept(15, hex('f'));
  s.insert('projectHostedOverlapMainLog', {
    projectId,
    sequence: 15,
    after: 14,
    paths: JSON.stringify(['convex/foo.ts']),
  });
  accept(16, hex('1'));
  s.insert('projectHostedOverlapMainLog', {
    projectId,
    sequence: 16,
    after: 15,
    paths: JSON.stringify(['convex/foo.ts']),
  });
  const w15Convex = JSON.parse(
    await s.call('wait', boardWait.deploy, { projectId, receiptId: r15, target: 'convex' }, 'owner'),
  );
  assert.equal(w15Convex.deploy.state, 'pending');
  assert.equal(w15Convex.deploy.deploys.convex, null);

  // Finding 2 & 4: an unchanged web skip (backend-only landing or equal digest) records unchanged:true
  // alongside the actual live build (liveSequence/liveHead) so default wait settles without miscrediting
  // the new head as uploaded, and never resets the 5-minute web deploy window.
  await s.call('deploy', deployStore.record, {
    projectId,
    target: 'convex',
    repository: 'NanthAI/nanthai-forge',
    workflow: 'convex-deploy.yml',
    state: hex('f'),
    sequence: 15,
    status: 'succeeded',
    runId: '206:1',
  });
  await s.call('deploy', deployStore.record, {
    projectId,
    target: 'web',
    repository: 'NanthAI/nanthai-forge',
    workflow: 'web-deploy.yml',
    state: hex('f'),
    sequence: 15,
    status: 'succeeded',
    runId: '207:1',
    unchanged: true,
    liveSequence: 14,
    liveHead: hex('e'),
  });
  const w15All = JSON.parse(await s.call('wait', boardWait.deploy, { projectId, receiptId: r15 }, 'owner'));
  assert.equal(w15All.deploy.state, 'deployed');
  assert.equal(w15All.deploy.deploys.convex.sequence, 15);
  assert.equal(w15All.deploy.deploys.web.sequence, 15);
  assert.equal(w15All.deploy.deploys.web.unchanged, true);
  assert.equal(w15All.deploy.deploys.web.liveSequence, 14);
  assert.equal(w15All.deploy.deploys.web.liveHead, hex('e'));
});

test('Item 8b6efb50: a landing arriving during an in-flight web deploy gets a trailing flush and claimQueued defers inside the 5-min window', async () => {
  const { s, projectId, accept } = makeProject();
  accept(41, hex('a'));
  accept(42, hex('b'));
  s.insert('projectHostedOverlapMainLog', {
    projectId,
    sequence: 42,
    after: 41,
    paths: JSON.stringify(['web/src/app/App.tsx']),
  });

  // Case A: #42 landed while #41 was building and its queued marker was already consumed.
  // When #41 records succeeded, Forge schedules one trailing web flush at 5m+1s for #42.
  const rec41 = JSON.parse(
    await s.call('deploy', deployStore.record, {
      projectId,
      target: 'web',
      repository: 'NanthAI/nanthai-forge',
      workflow: 'web-deploy.yml',
      state: hex('a'),
      sequence: 41,
      status: 'succeeded',
      runId: '401:1',
    }),
  );
  assert.equal(rec41.trailingFlushScheduled, true);
  const queued = [...s.tables.projectDeploys.values()].filter(
    r => r.runId === 'queued' && r.target === 'web',
  );
  assert.equal(queued.length, 1);
  assert.equal(queued[0].sequence, 42);
  assert.equal(queued[0].head, hex('b'));

  // Case B: if a dispatch action fires while #41's 5-min window is still closed, claimQueued keeps
  // the queued marker alive and returns action:'defer' instead of dispatching into a closed window.
  const claimed = JSON.parse(await s.call('deploy', deployStore.claimQueued, { projectId, target: 'web' }));
  assert.equal(claimed.action, 'defer');
  assert.equal(claimed.sequence, 42);
  assert(claimed.delayMs >= 10_000 && claimed.delayMs <= 5 * 60_000 + 2_000);
  const stillQueued = [...s.tables.projectDeploys.values()].filter(
    r => r.runId === 'queued' && r.target === 'web',
  );
  assert.equal(stillQueued.length, 1, 'queued marker stays alive while deferred');

  // Recording an unchanged skip at #42 schedules no trailing flush.
  const rec42Unchanged = JSON.parse(
    await s.call('deploy', deployStore.record, {
      projectId,
      target: 'web',
      repository: 'NanthAI/nanthai-forge',
      workflow: 'web-deploy.yml',
      state: hex('b'),
      sequence: 42,
      status: 'succeeded',
      runId: '402:1',
      unchanged: true,
      liveSequence: 41,
      liveHead: hex('a'),
    }),
  );
  assert.equal(rec42Unchanged.trailingFlushScheduled, undefined);
});

test('Item 8b6efb50: failed deploy or post-deploy smoke creates a Needs you notice that clears on next success', async () => {
  const { s, projectId, accept } = makeProject();
  accept(20, hex('a'));
  accept(21, hex('b'));

  await s.call('deploy', deployStore.record, {
    projectId,
    target: 'web',
    repository: 'NanthAI/nanthai-forge',
    workflow: 'web-deploy.yml',
    state: hex('a'),
    sequence: 20,
    status: 'smoke-failed',
    runId: '301',
    url: 'https://github.com/NanthAI/nanthai-forge/actions/runs/301',
    summary: 'old-redirect: HTTP 404 location=none',
  });
  const failing = await s.call('needs', needsMe.read, { projectId }, 'owner');
  const notice = failing.notices?.find(n => n.kind === 'deploy' && n.id === 'deploy:web');
  assert(notice, 'smoke failure surfaces as a Needs you notice');
  assert.match(notice.summary, /Dev web post-deploy smoke failed at main #20.*old-redirect/);
  assert.equal(notice.next, 'https://github.com/NanthAI/nanthai-forge/actions/runs/301');

  // Next successful deploy clears the notice automatically.
  await s.call('deploy', deployStore.record, {
    projectId,
    target: 'web',
    repository: 'NanthAI/nanthai-forge',
    workflow: 'web-deploy.yml',
    state: hex('b'),
    sequence: 21,
    status: 'succeeded',
    runId: '302',
  });
  const recovered = await s.call('needs', needsMe.read, { projectId }, 'owner');
  assert.equal(
    (recovered.notices ?? []).some(n => n.kind === 'deploy'),
    false,
    'notice clears once a newer deploy succeeds',
  );
});

test('Item 8b6efb50: observeDeploy subscribes reactively without polling and settles on deployed or failed', async () => {
  assert(hostedWaitSchema.safeParse({ deploy: 'latest' }).success);
  assert(hostedWaitSchema.safeParse({ deploy: '8b6efb50' }).success);
  assert(hostedWaitSchema.safeParse({ deploy: { receiptId: '8b6efb50', target: 'web' } }).success);

  let closed = false;
  const subscribe = () => ({
    onUpdate(_query, _args, onValue) {
      queueMicrotask(() => {
        onValue(
          JSON.stringify({
            deploy: { sequence: 12, target: 'web', state: 'pending', deploys: { web: null } },
          }),
        );
        onValue(
          JSON.stringify({
            deploy: {
              sequence: 12,
              target: 'web',
              state: 'deployed',
              deploys: { web: { sequence: 12, head: hex('c'), at: '2026-11-23T21:00:00Z', runId: '500' } },
            },
          }),
        );
      });
      return () => {};
    },
    close: async () => {
      closed = true;
    },
  });
  const outcome = await observeDeploy(
    { address: { url: 'https://example.invalid', projectId: 'p1' } },
    { selection: { sequence: 12, target: 'web' }, timeoutSeconds: 5 },
    undefined,
    subscribe,
  );
  assert.equal(outcome.status, 'deployed');
  assert.equal(outcome.deploy.deploys.web.sequence, 12);
  assert.equal(closed, true);
  assert.equal(deployWaitResult(outcome, 5, {}).status, 'terminal');
  assert.equal(
    deployWaitResult(
      { status: 'failed', deploy: { sequence: 12, target: 'web', state: 'failed', deploys: {} } },
      5,
      {},
    ).reason,
    'deploy-failed',
  );
});
