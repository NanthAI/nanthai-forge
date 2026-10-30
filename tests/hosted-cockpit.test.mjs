// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { hostedCockpitFixture, recoveryNoticesFixture } from './hosted-cockpit-fixture.mjs';
import { moduleUrl } from './convex-module.mjs';
import { materializeWork, indexBatches } from '../dist/work-hosted-index.js';
globalThis.location = { href: 'https://forge.example.test/?project=synthetic' };
const { cockpitLanes } = await import(moduleUrl('../web/src/cockpit/model.ts'));
const { HostedNowView } = await import(moduleUrl('../web/src/cockpit/HostedNow.tsx'));
const { HostedLaneView } = await import(moduleUrl('../web/src/lane/HostedLane.tsx'));
const { HostedIntentsView } = await import(moduleUrl('../web/src/intents/HostedIntents.tsx'));

const renderNow = (f, live = {}) =>
  renderToStaticMarkup(
    h(HostedNowView, {
      now: f.now,
      records: f.records,
      live: {
        sessions: [],
        events: [],
        unacked: [],
        unackedComplete: true,
        claims: [],
        sessionsLoading: false,
        ...live,
      },
      loading: false,
      ack: {
        acknowledge: async () => {},
        reply: async () => {},
        busy: null,
        error: '',
        retrying: () => false,
      },
      newIntent: () => {},
    }),
  );
const renderLane = f =>
  renderToStaticMarkup(
    h(HostedLaneView, {
      laneId: f.laneId,
      records: f.records,
      sessions: [],
      events: [],
      now: f.now,
      changes: h('p', null, 'Source changes'),
    }),
  );
const renderIntents = (f, detail = false) =>
  renderToStaticMarkup(
    h(HostedIntentsView, {
      records: f.records,
      sessions: [],
      now: f.now,
      ...(detail ? { intentId: f.intentId } : {}),
    }),
  );

test('hosted summaries expose cockpit pins, save metadata and check evidence while retaining full payloads', () => {
  const f = hostedCockpitFixture();
  const [lane] = f.records.lanes,
    [view] = f.records.views,
    [run] = f.records.runs;
  assert.deepEqual(lane.checkpoints, []);
  assert.equal(lane.checkpointCount, 2);
  assert.equal(lane.lastCheckpointAt, f.savedAt);
  assert.equal(lane.lastCheckpointMessage.length, 200);
  assert.deepEqual(view.inputs, [{ laneId: f.laneId, head: lane.head, saveIndex: 1 }]);
  assert.deepEqual(view.dependencies, []);
  assert.equal(view.dependencyCount, 0);
  assert.equal(run.checkName, 'verify');
  assert.equal(run.exitCode, 1);
  assert.equal(run.startedAt, f.data.runs[0].startedAt);
  assert.equal(run.endedAt, f.data.runs[0].endedAt);
  assert.equal(run.failureSummary, f.data.runs[0].failureSummary);
  assert.equal(run.check, undefined);
  for (const [collection, original] of [
    ['lanes', f.data.lanes[0]],
    ['views', f.data.views[0]],
    ['runs', f.data.runs[0]],
  ]) {
    const header = f.records[collection][0];
    const payload = f.projection.entries.filter(
      row => row.collection === `${collection}:payload` && row.parent === header.payloadKey,
    );
    assert.deepEqual(JSON.parse(payload.map(row => row.value).join('')), original);
    assert.ok(Buffer.byteLength(JSON.stringify(header)) < 8000);
  }
});

test('eight-Lane summaries and durable failures stay inside existing row and batch limits', () => {
  const f = hostedCockpitFixture();
  f.data.views[0].inputs = Array.from({ length: 8 }, () => f.data.views[0].inputs[0]);
  f.data.views[0].dependencies = [{ kind: 'view', viewId: f.viewId, head: f.data.views[0].head }];
  f.data.runs[0].failureSummary = 'f'.repeat(4096);
  f.data.runs[0].check.name = 'c'.repeat(40000);
  const projection = materializeWork(f.data, f.manifest, []);
  const view = JSON.parse(projection.entries.find(row => row.collection === 'views').value);
  assert.equal(view.inputs.length, 8);
  assert.equal(view.dependencyCount, 1);
  assert.equal(
    JSON.parse(projection.entries.find(row => row.collection === 'runs').value).checkName.length,
    200,
  );
  f.data.runs[0].checkSelection = {
    scope: 'scoped',
    reason: 'Synthetic impact fixture',
    tests: ['tests/files.test.mjs'],
  };
  const scoped = materializeWork(f.data, f.manifest, []);
  const scopedRun = JSON.parse(scoped.entries.find(row => row.collection === 'runs').value);
  assert.equal(scopedRun.checkName.length, 200);
  assert.match(scopedRun.checkName, / · scoped$/);
  assert.ok(projection.entries.every(row => Buffer.byteLength(JSON.stringify(row)) < 200000));
  assert.ok(
    indexBatches(projection.entries).every(
      batch => batch.length <= 100 && Buffer.byteLength(JSON.stringify(batch)) < 510000,
    ),
  );
});

test('cockpit uses hosted save count and last save time and selects the latest run by time', () => {
  const f = hostedCockpitFixture();
  f.records.runs.push({
    ...f.records.runs[0],
    id: 'older',
    status: 'passed',
    startedAt: '2026-10-14T10:11:01.000Z',
    endedAt: '2026-10-14T10:11:30.000Z',
  });
  const [lane] = cockpitLanes(f.records);
  assert.equal(lane.checkpoints, 2);
  assert.equal(lane.label, 'Check failed');
  assert.match(lane.fact, /verify failed.*exit 1/);
  assert.equal(lane.lastAt, f.records.runs[0].endedAt);
  assert.match(renderLane(f), /verify failed/);
  assert.doesNotMatch(renderLane(f).split('class="fx-feed"')[0], /verify passed/);
  assert.match(renderLane(f).split('class="fx-feed"')[1], /verify passed/);
  f.records.runs = [];
  f.records.views = [];
  const [saved] = cockpitLanes(f.records);
  assert.equal(saved.fact, '2 saves');
  assert.equal(saved.lastAt, f.savedAt);
  assert.match(renderNow(f), /2 saves/);
  assert.match(renderNow(f), /10 min/);
});

test('hosted Now, Lane and Intents render real index summaries with check labels, ages and save details', () => {
  const f = hostedCockpitFixture();
  assert.match(renderNow(f), /Check failed/);
  assert.match(renderNow(f), /hosted summary labels \(1ms\) · nobody working/);
  assert.match(renderNow(f), /7 min/);
  const lane = renderLane(f);
  assert.match(lane, /verify failed/);
  assert.match(lane, /1 min 0 s/);
  assert.match(lane, /<b>Latest save x+/);
  assert.doesNotMatch(lane, />Save 2</);
  assert.match(lane, /Progress: edited, saved; check failed/);
  assert.match(lane, /Collapse side panels/);
  assert.match(lane, />Timeline</);
  assert.match(lane, /Latest save/);
  assert.match(lane, /hosted summary labels/);
  assert.match(renderIntents(f), /Check failed/);
  assert.match(renderIntents(f, true), /Check failed/);
  assert.match(renderIntents(f, true), /summary-lane/);
});

test('old slim summaries and absent arrays render all hosted cockpit screens without crashing', () => {
  const f = hostedCockpitFixture();
  delete f.records.views[0].inputs;
  for (const key of ['startedAt', 'endedAt', 'exitCode', 'checkName', 'failureSummary'])
    delete f.records.runs[0][key];
  delete f.records.lanes[0].checkpoints;
  delete f.records.lanes[0].lastCheckpointAt;
  delete f.records.lanes[0].lastCheckpointMessage;
  assert.equal(cockpitLanes(f.records)[0].checkpoints, 2);
  assert.match(renderNow(f), /2 saves/);
  assert.match(renderLane(f), /No check yet/);
  assert.match(renderIntents(f, true), /summary-lane/);
});

test('current-Lane heads exclude stale Views and summary runs show passed and queued labels', () => {
  const f = hostedCockpitFixture();
  f.records.runs[0].status = 'passed';
  assert.match(renderNow(f), /Ready<\/span>[\s\S]*passed[\s\S]*waiting for a person/);
  const intent = renderIntents(f, true);
  assert.match(intent, /verify passed/);
  assert.match(intent, /Review &amp; accept/);
  f.records.runs[0].status = 'queued';
  assert.match(renderNow(f), /Queued/);
  assert.match(renderLane(f), /Queued/);
  assert.doesNotMatch(renderLane(f), /fx-running/);
  f.records.views[0].inputs[0].head = 'c'.repeat(64);
  assert.equal(cockpitLanes(f.records)[0].viewId, undefined);
  assert.match(renderLane(f), /No check yet/);
});

test('landed hosted-index Lane heads and completed Lanes never request acceptance', () => {
  for (const evidence of ['ancestry', 'completed', 'accepted-view', 'accepted-head']) {
    const f = hostedCockpitFixture();
    f.records.runs[0].status = 'passed';
    // A checked View containing main is still reviewable: this is the opposite direction.
    f.records.runs[0].main = { head: 'a'.repeat(64), included: true };
    assert.match(renderNow(f), /Ready to accept/);
    assert.match(renderNow(f), /Review &amp; accept/);
    if (evidence === 'ancestry') f.records.lanes[0].main = { head: 'c'.repeat(64), included: true };
    if (evidence === 'completed') f.records.lanes[0].state = 'completed';
    if (evidence.startsWith('accepted-'))
      f.records.channelMoves = [
        {
          id: 'acceptance',
          channel: 'main',
          status: 'accepted',
          at: f.savedAt,
          viewId: evidence === 'accepted-view' ? f.viewId : 'other-view',
          head: evidence === 'accepted-head' ? f.records.lanes[0].head : 'c'.repeat(64),
        },
      ];
    const [lane] = cockpitLanes(f.records);
    assert.equal(lane.open, false, evidence);
    assert.equal(lane.label, 'Done', evidence);
    assert.doesNotMatch(renderNow(f), /Ready to accept|Review &amp; accept/, evidence);
    // New work on a newer Lane head remains open even after its previous View landed.
    if (evidence === 'accepted-view') {
      f.records.lanes[0].head = 'd'.repeat(64);
      assert.equal(cockpitLanes(f.records)[0].open, true);
    }
  }
});

test('unknown ancestry and pending acceptances keep hosted Lanes open', () => {
  const f = hostedCockpitFixture();
  f.records.runs[0].status = 'passed';
  f.records.lanes[0].main = { head: 'c'.repeat(64), included: null };
  f.records.channelMoves = [
    { channel: 'main', status: 'pending', head: f.records.lanes[0].head, viewId: f.viewId },
  ];
  assert.equal(cockpitLanes(f.records)[0].open, true);
  assert.match(renderNow(f), /Ready to accept/);
});

test('Intent rows expose full title tooltips without repeating the outcome as a fact', () => {
  const f = hostedCockpitFixture();
  f.records.lanes[0].name = 'Hosted summaries';
  f.records.intents[0].outcome = 'Hosted summaries and indexed cockpit details';
  const html = renderIntents(f);
  assert.match(html, /class="fx-wr-title" title="Hosted summaries and indexed cockpit details"/);
  assert.doesNotMatch(html, /the outcome you want|fx-eyebrow/);
  assert.match(html, /verify failed/);
  assert.match(renderNow(f), /class="fx-row-lane"[^>]*title="Hosted summaries"/);
});

test('abandoned source-return lifecycle retains reason and history, leaves Now, and renders its grey badge', async () => {
  const f = hostedCockpitFixture();
  const event = {
    from: 'active',
    to: 'abandoned',
    at: f.savedAt,
    reason: 'Superseded by main',
    actor: { kind: 'agent', name: 'Worker' },
  };
  f.data.schema = 13;
  f.data.lanes[0].state = 'abandoned';
  f.data.lanes[0].lifecycle = [event];
  f.data.intents[0].status = 'abandoned';
  f.data.intents[0].lifecycle = [event];
  const projection = materializeWork(f.data, f.manifest, []);
  const header = JSON.parse(projection.entries.find(row => row.collection === 'lanes').value);
  assert.equal(header.state, 'abandoned');
  const payload = projection.entries.filter(
    row => row.collection === 'lanes:payload' && row.parent === header.payloadKey,
  );
  assert.deepEqual(JSON.parse(payload.map(row => row.value).join('')).lifecycle, [event]);
  const lifecycle = projection.entries.find(row => row.collection === 'lifecycle');
  assert.equal(JSON.parse(lifecycle.value).reason, 'Superseded by main');
  const { laneTimeline } = await import(moduleUrl('../web/src/lane/timeline.ts'));
  const events = laneTimeline({ ...f.records, lanes: f.data.lanes }, f.laneId);
  assert.ok(events.some(entry => entry.detail === 'by Worker · Superseded by main'));
  f.records.lanes = [header];
  const rows = cockpitLanes({ ...f.records, intents: f.data.intents });
  assert.equal(rows[0].open, false);
  assert.equal(rows[0].label, 'Abandoned');
  assert.doesNotMatch(renderNow(f), /summary-lane/);
  const { WorkStatus } = await import(moduleUrl('../web/src/WorkStatus.tsx'));
  assert.match(renderToStaticMarkup(h(WorkStatus, { status: 'abandoned' })), /Abandoned/);
});

test('44 planned hosted Intents do not enter Now or Needs you', () => {
  const f = hostedCockpitFixture();
  f.records.intents = Array.from({ length: 44 }, (_, n) => ({
    id: `planned-${n}`,
    outcome: `Backlog ${n}`,
    status: 'active',
  }));
  f.records.lanes = [];
  f.records.views = [];
  f.records.runs = [];
  const html = renderNow(f);
  assert.doesNotMatch(html, /Backlog|44.*in progress|Review &amp; accept/);
});

test('an empty hosted project keeps the first-run handoff after local UI retirement', () => {
  const f = hostedCockpitFixture();
  const html = renderNow({ ...f, records: { intents: [], lanes: [], views: [], runs: [] } });
  assert.match(html, /Create an Intent/);
  assert.match(html, /Hand it to an agent/);
  assert.match(html, /Accept when it’s green/);
});

test('hosted Now retains GitHub divergence and its hosted settings handoff', () => {
  const html = renderNow(hostedCockpitFixture(), {
    githubAutoPush: {
      status: 'needs-you',
      operationId: 'synthetic-divergence',
      repository: 'example/project',
      state: 'forge-state',
      localHead: 'forge-git',
      remoteHead: 'outside-git',
      expectedHead: 'expected-git',
      at: '2026-10-17',
    },
  });
  assert.match(html, /forge-state/);
  assert.match(html, /forge-git/);
  assert.match(html, /outside-git/);
  assert.match(html, /expected-git/);
  assert.match(html, /Open GitHub mirror/);
  assert.match(html, /settingsSection=github/);
});

test('Now exposes hosted mirror lag, scheduled retries and terminal failures from workspace facts', () => {
  const f = hostedCockpitFixture();
  const githubMirror = {
    repository: 'synthetic/mirror',
    status: 'retrying',
    targetHead: 'target',
    mirroredHead: 'prior',
    gitHead: 'git',
    lagging: true,
    pendingSince: f.now - 600_000,
    mirroredAt: null,
    failures: 1,
    nextAttemptAt: f.now + 60_000,
    error: 'GITHUB_SYNC_API',
    detail: 'HTTP 500',
    jobId: 'job',
  };
  const retrying = renderNow(f, { githubMirror });
  assert.match(retrying, /GitHub mirror synthetic\/mirror: retrying.*behind for 10m.*retry at/);
  const terminal = renderNow(f, {
    githubMirror: { ...githubMirror, status: 'failed', failures: 5, nextAttemptAt: null },
  });
  assert.match(terminal, /GitHub mirror synthetic\/mirror: failed.*5\/5 failed attempts.*HTTP 500/);
  const healthy = renderNow(f, { githubMirror: { ...githubMirror, status: 'synced', lagging: false } });
  assert.doesNotMatch(healthy, /GitHub mirror synthetic\/mirror/);
});

test('workspace recovery notices appear in Now and shell attention with matching counts and no extra copy', async () => {
  const f = recoveryNoticesFixture();
  const { hostedAttention } = await import(moduleUrl('../web/src/shell/Attention.tsx'));
  const live = { sessions: [], events: [], unacked: [], claims: [] };
  const attention = hostedAttention(f.records, live, f.now);
  assert.equal(attention.decisions.length, 2);
  const html = renderNow(f);
  assert.match(html, /2 things need you/);
  assert.match(html, /Needs you<\/h2><span class="fx-count fx-count-hot">2/);
  for (const text of [
    'Reverted from main',
    'Fix needed',
    'main audit failed 2 tests after it landed',
    'main audit failed 1 test; no single culprit, main unchanged',
    'Exact record',
    'tests/r2-range.test.mjs',
    'tests/http-limits.test.mjs',
    'Open Intent',
  ])
    assert.ok(html.includes(text), text);
  assert.doesNotMatch(
    html,
    /Start a fix|Close without a fix|ask the owner|advisory|Forge never locks|please|this may take a while/,
  );
  f.records.needsFix = [];
  assert.equal(hostedAttention(f.records, live, f.now).decisions.length, 0);
  assert.doesNotMatch(renderNow(f), /Reverted from main|Fix needed|Exact record/);
});
