// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement as h } from 'react';
import { renderToStaticMarkup as html } from 'react-dom/server';
import { moduleUrl } from './convex-module.mjs';
const { intentTimeline, intentEvents } = await import(moduleUrl('../web/src/intents/intent-timeline.ts'));
const { IntentDetailView } = await import(moduleUrl('../web/src/intents/IntentDetail.tsx'));
const { intentRows } = await import(moduleUrl('../web/src/intents/model.ts'));
const { cockpitLanes } = await import(moduleUrl('../web/src/cockpit/model.ts'));
const { intentViews } = await import(moduleUrl('../web/src/views/intent-views.ts'));
const { Feed, eventAnchor } = await import(moduleUrl('../web/src/cockpit/Feed.tsx'));
const now = Date.parse('2026-10-20T12:00:00Z');
const at = minute => new Date(now - minute * 60000).toISOString();
const records = {
  intents: [
    {
      id: 'i',
      outcome: 'Outcome',
      status: 'active',
      constraints: 'Details',
      createdAt: at(100),
      lifecycle: [{ to: 'completed', at: at(1) }],
    },
  ],
  lanes: ['a', 'b'].map(id => ({
    id,
    intentId: 'i',
    name: id,
    base: 'base',
    head: id,
    state: 'active',
    assignment: '',
    lifecycle: [{ to: 'active', at: at(90) }],
    checkpoints: [{ head: id, at: at(30), message: `Saved ${id}` }],
  })),
  views: [
    {
      id: 'v',
      intentId: 'i',
      base: 'base',
      head: 'vhead',
      status: 'clean',
      at: at(20),
      inputs: [
        { laneId: 'a', head: 'a' },
        { laneId: 'b', head: 'b' },
      ],
    },
  ],
  runs: [{ id: 'r', viewId: 'v', head: 'vhead', checkName: 'verify', status: 'passed', endedAt: at(10) }],
  channelMoves: [],
};
const row = intentRows(records.intents, cockpitLanes(records))[0];
const props = {
  row,
  views: intentViews(records, 'i'),
  records,
  notes: [],
  planning: [],
  now,
  laneHref: id => `/lanes/${id}`,
  reviewHref: id => `/review/${id}`,
  timeline: intentTimeline(records, 'i'),
};

test('Intent timeline merges Lane evidence and Intent lifecycle newest first', () => {
  const result = intentTimeline(records, 'i');
  assert.equal(result[0].text, 'Done');
  assert.equal(result.at(-1).text, 'Created');
  assert.deepEqual(
    result
      .filter(e => e.text === 'Saved')
      .map(e => e.lane.id)
      .sort(),
    ['a', 'b'],
  );
  assert.equal(result.filter(e => e.id === 'run:r').length, 1);
  assert.equal(result.find(e => e.id === 'run:r').lane, undefined);
  assert.equal(result.filter(e => e.text === 'Candidate composed').length, 1);
  assert.deepEqual(intentTimeline(records, 'missing'), []);
});

test('single-Lane Candidate, check and acceptance keep the Lane origin', () => {
  const work = {
    ...records,
    views: [{ ...records.views[0], inputs: [records.views[0].inputs[0]] }],
    channelMoves: [{ channel: 'main', status: 'accepted', viewId: 'v', at: at(2) }],
  };
  const events = intentTimeline(work, 'i');
  for (const id of ['run:r', 'candidate:v', `accepted:v:${at(2)}`])
    assert.equal(events.find(e => e.id === id).lane.id, 'a');
});

test('conversation scopes Lane messages and their acknowledgements, excluding another Intent', () => {
  const events = [
    { operationId: 'm', command: { kind: 'message', text: 'Lane reply', context: { laneId: 'a' } } },
    { operationId: 'ack', command: { kind: 'ack', messageId: 'm' } },
    { operationId: 'i', command: { kind: 'message', text: 'Intent', context: { intentId: 'i' } } },
    { operationId: 'other', command: { kind: 'message', text: 'Elsewhere', context: { intentId: 'other' } } },
    {
      operationId: 'wrong-lane',
      command: { kind: 'message', text: 'Elsewhere', context: { intentId: 'i', laneId: 'other' } },
    },
  ];
  assert.deepEqual(
    intentEvents(records, 'i', events).map(e => e.operationId),
    ['m', 'ack', 'i'],
  );
});

test('Intent uses the same detail frame with Timeline then Conversation at the top of the side', () => {
  const markup = html(h(IntentDetailView, props));
  assert.match(markup, /fx-detail-grid/);
  const side = markup.slice(markup.indexOf('<aside'));
  assert.ok(side.indexOf('<h2>Timeline</h2>') < side.indexOf('<h2>Conversation</h2>'));
  assert.doesNotMatch(side, /<h2>Candidates<\/h2>/);
  assert.doesNotMatch(markup, /role="tablist"|What and why|Decisions and notes/);
  assert.match(markup, /fx-wr/);
  assert.match(markup, /href="\/lanes\/a#event-save%3Aa%3A0"/);
  assert.match(markup, /class="fx-ltag"/);
});

test('review actions require current exact-head passing evidence', () => {
  const passed = props.views[0];
  for (const extra of [
    { accepted: true },
    { supersededBy: 'later' },
    { check: 'failed' },
    { check: 'running' },
    { status: 'conflict' },
    { checkHead: 'wrong' },
  ]) {
    const markup = html(h(IntentDetailView, { ...props, views: [{ ...passed, ...extra }] }));
    assert.doesNotMatch(markup, /Review &amp; accept/);
  }
  assert.match(html(h(IntentDetailView, props)), /Review &amp; accept/);
});

test('no Candidates panel or ready banner for an Intent with no Candidates', () => {
  const markup = html(h(IntentDetailView, { ...props, views: [] }));
  assert.doesNotMatch(markup, /<h2>Candidates<\/h2>|Review &amp; accept/);
  assert.match(markup, /<h2>Details<\/h2>/);
});

test('Lane timeline event links resolve to the same anchor in the shared Lane feed', () => {
  const event = { id: 'save:a:0', at: at(1), glyph: 'file', tone: 'plain', text: 'Saved' };
  assert.match(html(h(Feed, { items: [event], now })), new RegExp(`id="${eventAnchor(event.id)}"`));
});

test('Lane message renders its actor, Lane chip and reply action', () => {
  const markup = html(
    h(IntentDetailView, {
      ...props,
      notes: [
        {
          text: 'Ready',
          kind: 'comment',
          at: at(2),
          lane: { id: 'a', name: 'sidecars' },
          actor: { name: 'claude-whos', kind: 'agent' },
        },
      ],
      sendMessage: async () => null,
    }),
  );
  assert.match(markup, /claude-whos/);
  assert.match(markup, /sidecars/);
  assert.match(markup, />Reply<\/button>/);
  assert.match(markup, /Message everyone on this Intent/);
});

test('compact maps keep tracks compact and every Candidate point navigable', async () => {
  const { WorkMap } = await import(moduleUrl('../web/src/views/WorkMap.tsx'));
  const markup = html(
    h(WorkMap, {
      compact: true,
      lanes: row.lanes,
      views: props.views,
      laneHref: props.laneHref,
      viewHref: id => `/candidate/${id}`,
      now,
    }),
  );
  assert.match(markup, /height:112px/);
  assert.match(markup, /href="\/candidate\/v"/);
  assert.match(markup, /href="\/lanes\/a"/);
  assert.match(markup, /href="\/lanes\/b"/);
  assert.doesNotMatch(markup, /fx-map-marker/);
});

test('Details emphasize only leading template labels and keep source bytes as text', async () => {
  const { DetailsText } = await import(moduleUrl('../web/src/ui/DetailsText.tsx'));
  const text =
    'Outcome. Exact bytes <script>stay text</script>\n\nWhy. Measure first.\n\nDone when. Reviewed.\n\nA sentence with Why. inside.';
  const markup = html(h(DetailsText, { text }));
  for (const label of ['Outcome.', 'Why.', 'Done when.'])
    assert.ok(markup.includes(`<strong>${label}</strong>`));
  assert.match(markup, /&lt;script&gt;stay text&lt;\/script&gt;/);
  assert.match(markup, /<p>A sentence with Why. inside.<\/p>/);
  assert.equal((markup.match(/<strong>/g) ?? []).length, 3);
});

test('Intent meta and timeline attribute only matching recorded actors', () => {
  const known = structuredClone(records);
  known.intents[0].lifecycle.unshift({
    to: 'active',
    at: known.intents[0].createdAt,
    actor: { kind: 'person', name: 'Dino' },
  });
  known.intents[0].lifecycle.at(-1).actor = { kind: 'agent', name: 'gpt-builder' };
  known.lanes[0].checkpoints[0].actor = { kind: 'agent', name: 'save-worker' };
  const events = intentTimeline(known, 'i');
  assert.equal(events.find(event => event.text === 'Created').detail, 'by Dino');
  assert.equal(events.find(event => event.text === 'Done').detail, 'by gpt-builder');
  assert.equal(events.find(event => event.id === 'save:a:0').detail, 'by save-worker · Saved a');
  const knownRow = intentRows(known.intents, cockpitLanes(known))[0];
  assert.equal(knownRow.createdBy, 'Dino');
  assert.match(html(h(IntentDetailView, { ...props, row: knownRow })), /started .*? by Dino/);
  assert.equal(intentRows(records.intents, row.lanes)[0].createdBy, undefined);
  assert.equal(intentTimeline(records, 'i').find(event => event.text === 'Created').detail, undefined);
});

test('Candidate rows reuse recorded diffstats and omit unknown totals', () => {
  const candidate = records.views[0];
  for (const [changes, files] of [
    [{ files: 6, add: 210, del: 61 }, '6 files'],
    [{ files: 1, add: 0, del: 0 }, '1 file'],
    [{ files: 0, add: 0, del: 0 }, '0 files'],
    [{ files: 2 }, '2 files'],
  ]) {
    const views = intentViews({ ...records, views: [{ ...candidate, changes }] }, 'i');
    assert.deepEqual(views[0].changes, changes);
    const markup = html(h(IntentDetailView, { ...props, views }));
    const candidates = markup.slice(markup.indexOf('id="intent-views"'));
    assert.ok(candidates.includes(`· ${files}`), candidates);
    if (changes.add !== undefined && changes.del !== undefined) {
      assert.ok(candidates.includes(`class="fx-add">+${changes.add}</span>`));
      assert.ok(candidates.includes(`class="fx-del">−${changes.del}</span>`));
    } else assert.doesNotMatch(candidates, /fx-diffstat|fx-add|fx-del/);
  }
  const views = intentViews(records, 'i');
  assert.equal(Object.hasOwn(views[0], 'changes'), false);
  const markup = html(h(IntentDetailView, { ...props, views }));
  const candidates = markup.slice(markup.indexOf('id="intent-views"'));
  assert.doesNotMatch(candidates, /fx-diffstat|\d files?\b|Unknown|Loading/);
});

test('hosted Candidate and closure labels use recorded hosted facts', async () => {
  const { candidateState } = await import(moduleUrl('../web/src/views/WorkMap.tsx'));
  const { viewStatus } = await import(moduleUrl('../web/src/views/model.ts'));
  const work = structuredClone({ ...records, runs: [] });
  work.lanes[0].state = 'completed';
  const markup = html(
    h(IntentDetailView, {
      ...props,
      records: work,
      row: intentRows(work.intents, cockpitLanes(work))[0],
      views: intentViews(work, 'i'),
    }),
  );
  assert.match(markup, /Closed without landing/);
  assert.match(markup, /Not checked/);
  assert.doesNotMatch(markup, /owner machine|not yet synced|not synced|next push/);
  assert.equal(candidateState(intentViews(work, 'i')[0]), 'Not checked');
  assert.deepEqual(viewStatus({ status: 'clean' }), ['plain', 'Not checked']);
  assert.deepEqual(viewStatus({ status: 'accepted' }), ['passed', 'Accepted']);
});
