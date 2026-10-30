import { effectivePolicy } from '../dist/autonomy-policy.js';
// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  readFileSync,
  writeFileSync,
  rmSync,
  mkdirSync,
  utimesSync,
  readdirSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pendingStatus } from '../dist/pending-status.js';
import { readPendingStatus } from '../dist/pending-status-read.js';
import { formatPendingStatus } from '../dist/pending-status-format.js';
import { registerAgentWorkflow } from '../dist/mcp-agent-workflow.js';
import { initNative } from '../dist/native-work.js';
import { WorkStore } from '../dist/work-store.js';
import { AgentWorkflow } from '../dist/agent-workflow.js';

const now = '2026-01-01T12:10:00.000Z',
  at = '2026-01-01T12:00:00.000Z';
const head = 'a'.repeat(64),
  old = 'b'.repeat(64);
const main = { id: 'accept', channel: 'main', head, viewId: 'view', status: 'accepted', at };
const capture = {
  captureId: 'capture',
  capturedAt: at,
  publishedAt: '2026-01-01T12:02:00.000Z',
  mainHead: head,
  workRevision: 4,
  completeHistory: true,
  unavailable: [],
  evidenceComplete: true,
};
function data(extra = {}) {
  return { revision: 4, lanes: [], views: [], runs: [], channelMoves: [main], ...extra };
}
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'forge-pending-status-'));
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  writeFileSync(join(root, 'a.ts'), 'export const n = 1;\n');
  initNative(root);
  return new WorkStore(root);
}

test('newer metadata cannot establish hosted source or recovery freshness', () => {
  const status = pendingStatus(data({ revision: 9 }), { metadataPending: 0 }, now);
  assert.equal(status.hosted.source, 'unknown');
  assert.equal(status.hosted.work, 'unknown');
  assert.equal(status.hosted.recovery, null);
  assert.equal(status.hosted.evidence, 'unknown');
  assert.equal(status.ownerHeartbeat, null);
});
test('equal source with newer Work remains pending; capture age uses capture, not publication', () => {
  const status = pendingStatus(data({ revision: 5 }), { recovery: capture }, now);
  assert.equal(status.hosted.source, 'matching');
  assert.equal(status.hosted.work, 'pending');
  assert.equal(status.hosted.captureAgeMs, 600_000);
  assert.equal(status.hosted.pendingAgeMs, null);
});
test('clock-free Work projections retain event times without inventing observation times or ages', () => {
  const worker = { status: 'idle', workers: 1, observedAt: at, code: null };
  const records = data({
    githubSync: { commits: [{ state: head, commit: 'commit' }], pushed: 1, pushedAt: at },
  });
  const observations = {
    recovery: capture,
    landingWorker: worker,
    deployment: { head, observedAt: at, state: 'ready' },
  };
  const status = pendingStatus(records, observations, null);
  assert.equal(status.snapshot.observedAt, null);
  assert.equal(status.hosted.captureAgeMs, null);
  assert.equal(status.github.ageMs, null);
  assert.equal(status.deployment.ageMs, null);
  assert.equal(status.github.pushedAt, at);
  assert.equal(status.deployment.observedAt, at);
  assert.equal(status.landingWorker.observedAt, at);
  assert.deepEqual(pendingStatus(records, observations, null), status);
  const timed = pendingStatus(records, observations, now);
  assert.equal(timed.snapshot.observedAt, now);
  assert.equal(timed.hosted.captureAgeMs, 600_000);
  assert.equal(timed.github.ageMs, 600_000);
  assert.equal(timed.deployment.ageMs, 600_000);
});
test('new logs after capture and later run completion remain pending independently of source', () => {
  for (const observations of [{ evidenceChangedAt: '2026-01-01T12:05:00Z' }, {}]) {
    const status = pendingStatus(
      data({
        runs: observations.evidenceChangedAt
          ? []
          : [
              {
                id: 'run',
                viewId: 'view',
                head,
                status: 'failed',
                startedAt: at,
                endedAt: '2026-01-01T12:06:00Z',
              },
            ],
      }),
      { recovery: capture, ...observations },
      now,
    );
    assert.equal(status.hosted.source, 'matching');
    assert.equal(status.hosted.evidence, 'pending');
  }
});
test('no heartbeat, unknown capture time and incomplete first-host history remain explicit', () => {
  const status = pendingStatus(
    data(),
    {
      recovery: {
        ...capture,
        capturedAt: null,
        completeHistory: false,
        evidenceComplete: false,
        unavailable: ['runs/run/stdout.log'],
      },
    },
    now,
  );
  assert.equal(status.hosted.captureAgeMs, null);
  assert.equal(status.hosted.evidence, 'incomplete');
  assert.equal(status.hosted.recovery.completeHistory, false);
  assert.equal(status.ownerHeartbeat, null);
  assert.match(formatPendingStatus(status), /capture age unknown/);
});
test('pending local saves do not advance successful capture pins', () => {
  const status = pendingStatus(
    data(),
    {
      recovery: { ...capture, mainHead: old, workRevision: 3 },
    },
    now,
  );
  assert.equal(status.hosted.mainHead, old);
  assert.equal(status.hosted.source, 'different');
  assert.equal(status.hosted.work, 'pending');
});
test('GitHub success and stale deployment observations stay separate from hosted recovery', () => {
  const status = pendingStatus(
    data({
      githubSync: { commits: [{ state: old }, { state: head, commit: 'git' }], pushed: 2, pushedAt: at },
    }),
    { recovery: { ...capture, mainHead: old }, deployment: { head: old, observedAt: at, state: 'ready' } },
    now,
  );
  assert.equal(status.github.source, 'matching');
  assert.equal(status.hosted.source, 'different');
  assert.equal(status.deployment.source, 'different');
  assert.equal(status.deployment.ageMs, 600_000);
  assert.equal(status.deployment.scope, 'last-recorded-observation');
  assert.equal(status.installedSource, null);
});
test('prepared but unpushed Git commits are never shown as synced', () => {
  const status = pendingStatus(data({ githubSync: { commits: [{ state: head }], pushed: 0 } }), {}, now);
  assert.equal(status.github.mainHead, null);
  assert.equal(status.github.source, 'unknown');
});
test('50 Lanes keep full JSON and compact human output; checking requires the saved input head', () => {
  const lanes = Array.from({ length: 50 }, (_, i) => ({
    id: `lane-${i}`,
    intentId: `intent-${i}`,
    name: `Lane ${i}\nsynthetic`,
    head,
    state: i === 0 ? 'paused' : 'ready',
  }));
  const views = [
    { id: 'check-view', inputs: [{ laneId: 'lane-1', head }] },
    { id: 'stale-view', inputs: [{ laneId: 'lane-2', head: old }] },
  ];
  const runs = ['check-view', 'stale-view'].map((viewId, i) => ({
    id: `run-${i}`,
    viewId,
    head,
    status: 'running',
    startedAt: at,
  }));
  const status = pendingStatus(data({ lanes, views, runs }), {}, now);
  assert.equal(status.lanes.length, 50);
  assert.deepEqual(status.counts, { ready: 48, waiting: 1, checking: 1 });
  assert.ok(formatPendingStatus(status).split('\n').length <= 15);
  assert.equal(status.checks[0].processState, 'unknown');
});
test('handoffs and overlap groups share the 15-line budget without truncating JSON', () => {
  const lanes = Array.from({ length: 50 }, (_, i) => ({
    id: `lane-${i}`,
    intentId: `intent-${i}`,
    name: `Lane ${i}\nsynthetic`,
    head,
    state: 'ready',
  }));
  const intents = lanes.map(lane => ({
    id: lane.intentId,
    notes: [
      {
        handoff: {
          operationId: `handoff-${lane.id}`,
          laneId: lane.id,
          head,
          at,
          summary: `Delivery ${lane.id}\nwith details`,
          tests: [{ command: `test-${lane.id}` }],
          recordedChecks: [{ operationId: `check-${lane.id}`, source: 'forge-recorded', status: 'passed' }],
        },
      },
    ],
  }));
  const groups = lanes
    .filter((_, i) => i % 2 === 0)
    .map((lane, i) => ({
      paths: [`src/file-${i}\nsynthetic.ts`],
      order: [lane.id, lanes[i * 2 + 1].id],
    }));
  for (const coverage of ['local', 'local-incomplete', 'unknown']) {
    for (const count of [0, 1, groups.length]) {
      const overlap = { groups: groups.slice(0, count), coverage };
      const status = pendingStatus(data({ lanes, intents }), { overlap }, now);
      const before = JSON.stringify(status);
      const text = formatPendingStatus(status);
      assert.ok(text.split('\n').length <= 15, text);
      assert.match(text, /Handoffs: 50 Lanes · 50 self-reported commands · 50 Forge-recorded checks/);
      assert.match(text, new RegExp(`coverage ${coverage}`));
      if (count > 1) assert.match(text, /Overlap: 25 groups.*--json and peers/);
      if (count === 1) assert.match(text, /Overlap: src\/file-0 synthetic.ts · land lane-0 → lane-1/);
      const json = JSON.parse(JSON.stringify(status));
      assert.equal(json.lanes.length, 50);
      assert.deepEqual(json.overlap, overlap);
      for (const [i, lane] of json.lanes.entries()) {
        assert.equal(lane.handoff.operationId, `handoff-lane-${i}`);
        assert.equal(lane.handoff.summary, `Delivery lane-${i}\nwith details`);
        assert.equal(lane.handoff.tests.commands, 1);
        assert.equal(lane.handoff.recordedChecks[0].operationId, `check-lane-${i}`);
      }
      assert.equal(JSON.stringify(status), before);
    }
  }
});
test('ignore counts and metrics keep submission identities visible within the compact budget', () => {
  const submission = {
    submissionId: 'submission-id',
    attemptId: 'attempt-id',
    state: 'pending',
    pendingReason: 'checking',
  };
  const status = pendingStatus(
    data({ lanes: [{ id: 'lane', name: 'Pending Lane', head, state: 'ready' }] }),
    {
      recovery: capture,
      metrics: {
        landings: 0,
        firstTryShare: null,
        interventionsPerLanding: null,
        checkMinutesPerLanding: null,
        dollarsPerLanding: [],
        redMainMinutes: { forge: null },
        partial: true,
      },
    },
    now,
  );
  status.lanes[0].submission = submission;
  status.lanes[0].submissions = [submission];
  status.ignored = {
    counts: { '.gitignore': 1, '.forgeignore': 2, builtin: 3 },
    scope: 'local-paths-pruned-directories',
  };
  for (const crowded of [false, true]) {
    if (crowded) {
      status.lanes[0].handoff = {
        summary: 'Current delivery',
        tests: { commands: 1 },
        recordedChecks: [],
      };
      status.lanes[0].stack = { summary: 'base → pending' };
      status.metrics.diskWarning = 'Disk: synthetic metrics warning';
      status.disk = { warning: 'Disk: distinct local warning' };
    }
    const before = JSON.stringify(status);
    const text = formatPendingStatus(status);
    assert.ok(text.split('\n').length <= 15, text);
    assert.match(text, /lane pending \(checking\).*submission submissi.*attempt attempt-/);
    assert.match(text, /^Ignored: 1 .gitignore · 2 .forgeignore · 3 built-in$/m);
    assert.doesNotMatch(text, /Automatic hosted push:/);
    for (const label of [
      'Hosted main:',
      'Recovery:',
      'Pending:',
      'Transfers:',
      'GitHub main:',
      'Checks:',
      'Audits:',
      'Deployment:',
      'Metrics · last 7 days',
      'Checks/landing',
    ])
      assert.ok(text.includes(label), label);
    if (crowded) {
      assert.match(text, /Handoff lane: Current delivery/);
      assert.match(text, /Stack: base → pending/);
      assert.match(text, /^Disk: synthetic metrics warning$/m);
      assert.match(text, /^Disk: distinct local warning$/m);
    }
    assert.equal(JSON.stringify(status), before, 'formatting preserves full JSON');
  }
});
test('dependency waits, review and failed audits retain their recorded state', () => {
  const status = pendingStatus(
    data({
      lanes: [{ id: 'lane', name: 'Synthetic wait', head, state: 'ready', after: { intentId: 'missing' } }],
      channelMoves: [{ ...main, postAccept: { checkId: 'check' }, postAcceptRunId: 'audit' }],
      runs: [{ id: 'audit', viewId: 'view', head, status: 'failed', mainCheck: {}, startedAt: at }],
    }),
    {},
    now,
  );
  assert.equal(status.lanes[0].status, 'waiting');
  assert.equal(status.audits[0].status, 'failed');
  assert.match(formatPendingStatus(status), /Audits: 0 pending · 1 failed/);
});

test('local read and MCP share pinned JSON without running recovery, exports or remote calls', async t => {
  const store = fixture(t);
  const before = readFileSync(join(store.directory, 'work.json'));
  const files = readdirSync(store.directory).sort();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () => {
    throw new Error('Status must not use the network');
  };
  try {
    const status = readPendingStatus(store, () => capture, now);
    assert.equal(status.snapshot.workRevision, store.revision());
    assert.equal(status.hosted.recovery.captureId, 'capture');
    let handler;
    registerAgentWorkflow(
      {
        registerTool(name, options, callback) {
          if (name === 'forge_work_overview') {
            assert.ok(options.inputSchema.command.safeParse({ action: 'pending-status' }).success);
            assert.ok(
              options.inputSchema.command.safeParse({
                action: 'pending-status',
                detail: true,
                offset: 0,
                limit: 2,
              }).success,
            );
            handler = callback;
          }
        },
      },
      store.root,
    );
    const mcp = JSON.parse((await handler({ command: { action: 'pending-status' } })).content[0].text);
    assert.deepEqual(mcp.main, readPendingStatus(store).main);
    assert.equal(mcp.hosted.recovery, null);
    assert.ok(mcp.sections.skipped.includes('overlap'));
    const detailed = JSON.parse(
      (await handler({ command: { action: 'pending-status', detail: true } })).content[0].text,
    );
    assert.deepEqual(detailed.sections.skipped, []);
    assert.deepEqual(readFileSync(join(store.directory, 'work.json')), before);
    assert.deepEqual(readdirSync(store.directory).sort(), files);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
test('native CLI needs no graph index; paged JSON and compact text preserve existing status interfaces', t => {
  const store = fixture(t);
  const run = (...args) =>
    spawnSync(process.execPath, [resolve('dist/cli.js'), 'status', store.root, ...args], {
      encoding: 'utf8',
    });
  const text = run();
  assert.equal(text.status, 0, text.stderr);
  assert.match(text.stdout, /Pending work/);
  assert.ok(text.stdout.trim().split('\n').length <= 15);
  const json = run('--json');
  assert.equal(json.status, 0, json.stderr);
  assert.equal(JSON.parse(json.stdout).snapshot.workRevision, store.revision());
  assert.equal(run('--pending', '--json').status, 0);
  assert.equal(run('--pending', '--detail', '--json').status, 0);
  assert.equal(run('--pending', '--offset', '1', '--limit', '2', '--json').status, 0);
  assert.equal(run('--pending', '--limit', '0').status, 1);
  assert.equal(run('--not-an-option').status, 1);
});
test('reader observes new log tails but leaves recorded active runs unchanged', async t => {
  const store = fixture(t),
    agent = new AgentWorkflow(store.root);
  const lane = (await agent.dispatch({ action: 'start', outcome: 'Synthetic check' })).result;
  const view = (
    await agent.dispatch({
      action: 'compose',
      operationId: randomUUID(),
      intentId: lane.intentId,
      inputs: [{ laneId: lane.laneId, head: lane.head }],
    })
  ).result;
  await agent.dispatch({
    action: 'define-check',
    name: 'Synthetic check',
    executable: process.execPath,
    args: ['-e', '0'],
  });
  const run = (await agent.dispatch({ action: 'run', viewId: view.viewId })).result;
  const saved = store.load();
  saved.runs[0].status = 'running';
  saved.runs[0].startedAt = at;
  delete saved.runs[0].endedAt;
  saved.autonomyPolicy = { ...effectivePolicy(saved), checkLogs: { uploadLocal: true, retentionDays: 90 } };
  store.save(saved);
  const directory = join(store.directory, `check-${run.operationId}`);
  mkdirSync(directory, { recursive: true });
  const path = join(directory, 'stdout.log');
  writeFileSync(path, 'synthetic later output\n');
  utimesSync(path, new Date(now), new Date(now));
  const before = readFileSync(join(store.directory, 'work.json'));
  const status = readPendingStatus(store, () => capture, now, { detail: true });
  assert.equal(status.hosted.evidence, 'pending');
  assert.equal(status.checks[0].status, 'running');
  assert.deepEqual(readFileSync(join(store.directory, 'work.json')), before);
});

test('one immutable Work pointer pins the summary even when a newer revision exists', t => {
  const store = fixture(t),
    original = store.revision();
  const newer = store.load();
  newer.revision++;
  store.observing(() => {
    new WorkStore(store.root).save(newer);
    const load = store.load;
    store.load = () => {
      throw new Error('Record-backed status must not hydrate complete Work');
    };
    try {
      assert.equal(readPendingStatus(store, undefined, now).snapshot.workRevision, original);
    } finally {
      store.load = load;
    }
  });
  assert.equal(readPendingStatus(store, undefined, now).snapshot.workRevision, original + 1);
});

test('journals newer than the pinned Work snapshot cannot introduce unavailable Lane references', t => {
  const store = fixture(t);
  const directory = join(store.directory, 'agent-land');
  mkdirSync(directory, { recursive: true });
  const operationId = randomUUID(),
    laneId = randomUUID();
  writeFileSync(
    join(directory, `${operationId}.json`),
    JSON.stringify({
      schema: 1,
      request: 'future request',
      entries: [{ command: { operationId, laneId }, inputs: [{ laneId, head }] }],
    }),
  );
  const before = readFileSync(join(store.directory, 'work.json'));
  const status = readPendingStatus(store, undefined, now);
  assert.deepEqual(status.lanes, []);
  assert.deepEqual(readFileSync(join(store.directory, 'work.json')), before);
});

test('an unresolved provider outcome stays pending-infra in the local submission projection', () => {
  const lane = { id: randomUUID(), intentId: randomUUID(), head, state: 'active', name: 'Synthetic' };
  const view = { id: randomUUID(), inputs: [{ laneId: lane.id, head }] };
  const run = {
    id: randomUUID(),
    viewId: view.id,
    status: 'interrupted',
    error: { code: 'GITHUB_ACTIONS_PENDING_INFRA' },
  };
  const observation = pendingStatus(
    data({
      lanes: [lane],
      views: [view],
      runs: [run],
      channelMoves: [],
      landingEntries: [{ id: randomUUID(), viewId: view.id, runId: run.id, status: 'checking' }],
    }),
  ).lanes[0].submission;
  assert.equal(observation.pendingReason, 'pending-infra');
  assert.equal(observation.terminal, false);
});
