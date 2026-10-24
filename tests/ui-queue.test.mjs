// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement as h } from 'react';
import { renderToStaticMarkup as render } from 'react-dom/server';
import { moduleUrl } from './convex-module.mjs';
import { s16Work, s16Notice, now } from './fixtures/s16-work.mjs';
import { pendingStatus } from '../dist/pending-status.js';
const { queueFacts, queueStatus, serviceLastSeen, queueHref } = await import(
  moduleUrl('../web/src/cockpit/queue-model.ts')
);
const { cockpitLanes } = await import(moduleUrl('../web/src/cockpit/model.ts'));
const { laneDecisions, localFeed } = await import(moduleUrl('../web/src/cockpit/attention.ts'));
const { laneFacts } = await import(moduleUrl('../web/src/ui/lane-facts.ts'));
const { nextStep, NextStep } = await import(moduleUrl('../web/src/lane/LaneParts.tsx'));
const { laneTimeline } = await import(moduleUrl('../web/src/lane/timeline.ts'));
const { intentRows } = await import(moduleUrl('../web/src/intents/model.ts'));
const { intentViews } = await import(moduleUrl('../web/src/views/intent-views.ts'));
const { IntentDetailView } = await import(moduleUrl('../web/src/intents/IntentDetail.tsx'));
const { LaneRow } = await import(moduleUrl('../web/src/cockpit/LaneRow.tsx'));
const { ChannelStrip } = await import(moduleUrl('../web/src/shell/StatusBar.tsx'));
const { HostedAnswers } = await import(moduleUrl('../web/src/cockpit/HostedAnswers.tsx'));
const { railStops } = await import(moduleUrl('../web/src/ui/rail-stops.ts'));
const { CheckPanel } = await import(moduleUrl('../web/src/lane/CheckPanel.tsx'));
const { WorkMap } = await import(moduleUrl('../web/src/views/WorkMap.tsx'));
const { awayFacts, acceptanceArrival } = await import(moduleUrl('../web/src/cockpit/now-model.ts'));
function fixture(notice = 'current') {
  const work = s16Work();
  const notices = [s16Notice(work, notice)];
  const status = pendingStatus(work, {
    landingWorker: { status: 'driving', observedAt: '2026-10-23T19:49:00Z', workers: 1, code: null },
  });
  const facts = queueFacts(status, notices);
  return { work, notices, status, facts, lanes: cockpitLanes(work, facts) };
}

test('state table distinguishes waiting, review, infrastructure, unknown outcome and failed code', () => {
  const { facts, lanes, work } = fixture();
  assert.deepEqual(
    [
      'queued',
      'checking',
      'review',
      'machine',
      'failed',
      'infra',
      'unknown',
      'later',
      'landed',
      'dirty',
      'dependency',
    ].map(id => [id, facts.get(id).label, facts.get(id).tone]),
    [
      ['queued', 'Queued', 'waiting'],
      ['checking', 'Checking', 'running'],
      ['review', 'Ready', 'passed'],
      ['machine', 'Waiting', 'waiting'],
      ['failed', 'Check failed', 'failed'],
      ['infra', 'Not run', 'plain'],
      ['unknown', 'Not run', 'plain'],
      ['later', 'Later save', 'stale'],
      ['landed', 'Done', 'plain'],
      ['dirty', 'Working', 'active'],
      ['dependency', 'Waiting', 'waiting'],
    ],
  );
  assert.match(facts.get('dirty').text, /2 saves since · not submitted$/);
  const compact = fixture().status;
  compact.lanes.find(lane => lane.laneId === 'dirty').checkpoints = [];
  assert.match(queueFacts(compact).get('dirty').text, /on main · not submitted$/);
  assert.match(facts.get('later').text, /earlier outcome kept/);
  const cancelled = s16Work();
  cancelled.landingEntries.find(entry => entry.id === 'entry-failed').status = 'cancelled';
  cancelled.runs.find(run => run.id === 'run-failed').status = 'cancelled';
  const cancelledFact = queueFacts(pendingStatus(cancelled)).get('failed');
  assert.equal(cancelledFact.tone, 'plain');
  assert.equal(cancelledFact.tip, undefined);
  assert.equal(cancelledFact.text, "Check didn't run");
  assert.deepEqual(
    laneDecisions(lanes).map(item => [item.kind, item.laneId]),
    [
      ['review', 'review'],
      ['failed', 'failed'],
    ],
  );
  const shared = laneFacts(work, lanes, now);
  for (const lane of lanes.filter(lane => lane.queue))
    assert.equal(shared.get(lane.id).text, lane.queue.text);
  for (const id of ['infra', 'unknown', 'later', 'dirty'])
    assert.equal(nextStep(lanes.find(lane => lane.id === id)).tone, 'plain');
});

test('owner last event changes only the existing strip and never marks a Lane failed', t => {
  // ChannelStrip reads the clock itself; pin it to the fixture time so the strip stays fresh.
  t.mock.timers.enable({ apis: ['Date'], now });
  const { status, facts } = fixture();
  assert.match(serviceLastSeen(status, now).text, /^queue · /);
  for (const worker of [
    { status: 'stopped', observedAt: '2026-10-23T19:49:00Z' },
    { status: 'driving', observedAt: '2026-10-23T19:40:00Z' },
    { status: 'unavailable', observedAt: null },
  ]) {
    const stale = serviceLastSeen({ ...status, landingWorker: worker }, now);
    assert.equal(stale.tone, 'stale');
    assert.match(stale.text, /^owner not seen/);
    assert.deepEqual(
      queueFacts({ ...status, landingWorker: worker }).get('queued').tone,
      facts.get('queued').tone,
    );
  }
  assert.equal(
    serviceLastSeen({ ...status, landingWorker: { status: 'unknown', observedAt: null } }, now),
    null,
  );
  assert.equal(serviceLastSeen({ ...status, lanes: [] }, now), null);
  const strip = render(h(ChannelStrip, { queue: status, live: 'Live' }));
  assert.match(strip, /queue · /);
  assert.doesNotMatch(strip, /fx-dot-failed|offline|down/);
});

test('current repair links and handoff summary agree across decisions, Lane and Intent', () => {
  const { work, status, notices } = fixture();
  const handoff = {
    laneId: 'review',
    head: work.lanes.find(lane => lane.id === 'review').head,
    summary: 'Cost and submission latency recorded.',
  };
  const facts = queueFacts(status, notices, new Map([['review', handoff]]));
  const lanes = cockpitLanes(work, facts);
  const decisions = laneDecisions(lanes);
  assert.equal(decisions[0].subtitle, handoff.summary);
  assert.equal(nextStep(lanes.find(lane => lane.id === 'review')).body, handoff.summary);
  assert.ok(decisions[0].gates.queuedAt);
  assert.equal(facts.get('review').tip, undefined);
  assert.equal(facts.get('checking').tip, undefined);
  assert.equal(facts.get('landed').tip, undefined);
  const failed = decisions.find(item => item.kind === 'failed');
  const answers = render(h(HostedAnswers, { item: failed, ack: {}, laneHref: id => `#${id}`, notNow() {} }));
  assert.match(answers, /Open run/);
  assert.match(answers, /Repair in Lane/);
  assert.match(answers, /view-failed/);
  const step = render(h(NextStep, { step: nextStep(lanes.find(lane => lane.id === 'failed')) }));
  assert.match(step, /fx-tone-failed/);
  const row = intentRows(work.intents, lanes)[0];
  const intent = render(
    h(IntentDetailView, {
      row,
      views: intentViews(work, 'intent'),
      notes: [],
      planning: [],
      now,
      laneHref: id => `#${id}`,
      reviewHref: id => `#${id}`,
      records: work,
    }),
  );
  assert.match(intent, /Candidate from «Rate-limit the sync endpoint» failed its check/);
  assert.doesNotMatch(intent, /passed build-and-test/);
  assert.match(intent, /queued/);
  assert.match(intent, /waiting for you/);
  const rowHtml = render(
    h(LaneRow, { lane: lanes.find(lane => lane.id === 'failed'), now, href: '#failed' }),
  );
  assert.match(rowHtml, /Open run/);
});

test('historical notices stay in the timeline with no repair action or Needs you item', () => {
  const { work, facts, notices, lanes } = fixture('historical');
  assert.equal(facts.get('failed').historical, true);
  assert.ok(!laneDecisions(lanes).some(item => item.laneId === 'failed'));
  const events = laneTimeline(work, 'failed', [], true, notices, facts);
  const notice = events.find(event => event.id.startsWith('notice:'));
  assert.equal(notice.historical, true);
  assert.equal(notice.tone, 'stale');
  assert.deepEqual(notice.links, []);
  const notCurrent = queueFacts(fixture().status, [{ ...s16Notice(work), applicability: undefined }]);
  assert.equal(notCurrent.get('failed').repairIntentId, undefined);
  const current = s16Notice(work);
  current.resolutions = [{ intentId: current.repairIntentId, applicability: 'historical' }];
  assert.equal(queueFacts(fixture().status, [current]).get('failed').repairIntentId, 'repair');
});

test('absent collections preserve legacy behaviour and queued Intents remain Waiting', () => {
  const { work } = fixture();
  delete work.landingEntries;
  delete work.landingBatches;
  assert.equal(queueStatus(work), undefined);
  const legacy = cockpitLanes(work);
  assert.equal(legacy.find(lane => lane.id === 'review').label, 'Ready');
  assert.ok(!legacy.some(lane => lane.queue));
  const queued = fixture().lanes.filter(lane => ['queued', 'checking'].includes(lane.id));
  assert.deepEqual(
    [intentRows(work.intents, queued)[0].tone, intentRows(work.intents, queued)[0].label],
    ['waiting', 'Waiting'],
  );
});

test('queue outcome delivery deduplicates feed events and caps Away at three facts', () => {
  const { work, lanes, status } = fixture();
  const feed = localFeed({ ...work, pendingStatus: status }, 0, 100);
  assert.equal(feed.filter(event => event.id === 'run:run-failed').length, 1);
  assert.match(feed.find(event => event.id === 'move:move-landed').text, /Landed on main/);
  const away = awayFacts(0, [], lanes);
  assert.ok(away.length <= 3);
  assert.ok(away.some(fact => /landed from the queue/.test(fact.text)));
  assert.ok(away.some(fact => fact.text === '1 stopped: check failed' && fact.glyph === 'waiting'));
});

test('infrastructure stays neutral in rails, check cards and Candidate maps', () => {
  const { work, lanes } = fixture();
  const lane = lanes.find(lane => lane.id === 'unknown');
  assert.ok(!railStops(lane).segments.includes('bad'));
  const run = work.runs.find(run => run.id === lane.queue.runId);
  const card = render(h(CheckPanel, { run: { ...run, check: run.check.name }, queue: lane.queue, now }));
  assert.match(card, /Not run/);
  assert.doesNotMatch(card, /fx-tone-failed/);
  assert.ok(
    laneTimeline(work, lane.id)
      .filter(event => event.id === `run:${run.id}`)
      .every(event => event.tone === 'plain'),
  );
  const map = render(
    h(WorkMap, {
      lanes: [lane],
      views: intentViews(work, 'intent').filter(view => view.id === lane.queue.viewId),
      laneHref: id => `#${id}`,
      now,
      compact: true,
    }),
  );
  assert.match(map, /Not run/);
  assert.doesNotMatch(map, /var\(--fx-failed\)/);
  work.lanes.find(lane => lane.id === 'dirty').state = 'completed';
  assert.equal(cockpitLanes(work).find(lane => lane.id === 'dirty').open, true);
  const saved = fixture();
  saved.work.lanes.find(lane => lane.id === 'queued').head = 'f'.repeat(64);
  assert.equal(cockpitLanes(saved.work, saved.facts).find(lane => lane.id === 'queued').queue, undefined);
});

test('run links use the existing retained-output pin in the Candidate review', () => {
  const link = fixture().facts.get('failed').link;
  assert.match(queueHref(link), /checkRun=run-failed/);
  assert.match(queueHref(link), /view-failed/);
  const work = s16Work();
  const view = work.views.find(view => view.id === 'view-failed');
  work.views.push({ ...view, id: 'batch-view', intentId: 'batch-intent' });
  work.runs.find(run => run.id === 'run-failed').viewId = 'batch-view';
  const combined = queueFacts(pendingStatus(work)).get('failed').link;
  assert.equal(combined.intentId, 'batch-intent');
  assert.match(queueHref(combined), /batch-view/);
});

test('guarded sync history retains its automatic tag, recorded undo and completed undo reason', () => {
  const { work, notices } = fixture();
  const lane = work.lanes.find(lane => lane.id === 'failed');
  const save = lane.checkpoints[0];
  save.sync = { changedPaths: ['a.ts', 'b.ts', 'c.ts'], operation: { id: 'sync-operation' } };
  const sync = {
    laneId: lane.id,
    operationId: 'sync-operation',
    head: save.head,
    undo: { action: 'undo-sync', laneId: lane.id, syncOperationId: 'sync-operation', force: false },
    undoneBy: [],
  };
  notices[0].syncs = [sync];
  const facts = queueFacts(pendingStatus(work), notices);
  const event = laneTimeline(work, lane.id, [], true, notices, facts).find(
    event => event.id === 'sync:sync-operation',
  );
  assert.equal(event.text, 'Updated from main · 3 files');
  assert.equal(event.tone, 'plain');
  assert.match(event.automatic.undo, /undo-sync/);
  sync.undoneBy = [{ operationId: 'undo' }];
  const undone = queueFacts(pendingStatus(work), notices)
    .get(lane.id)
    .events.find(event => event.id === 'sync:sync-operation');
  assert.equal(undone.undone, true);
  assert.equal(undone.automatic.undo, 'Already undone');
});

test('live acceptance delivery reuses a baseline and suppresses initial or away catch-up', () => {
  const first = { id: 'one', at: '2026-10-23T19:40:00Z', title: 'First' };
  const next = { id: 'two', at: '2026-10-23T19:49:00Z', title: 'Second' };
  const baseline = acceptanceArrival(null, [first], 0);
  assert.equal(baseline.arrival, undefined);
  const live = acceptanceArrival(baseline.seen, [next, first], Date.parse('2026-10-23T19:45:00Z'));
  assert.equal(live.arrival, next);
  assert.equal(acceptanceArrival(live.seen, [next, first], 0).arrival, undefined);
  assert.equal(acceptanceArrival(baseline.seen, [next, first], 0, true).arrival, undefined);
  assert.equal(acceptanceArrival(baseline.seen, [next, first], now).arrival, undefined);
});
