// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createElement as h } from 'react';
import { renderToStaticMarkup as render } from 'react-dom/server';
import { moduleUrl } from './convex-module.mjs';
import { decisionRecordSchema } from '../dist/decision-types.js';
import { cleanUrl, routeUrlState, projectIdentity, routeMode } from '../dist/project-routes.js';
const model = await import(moduleUrl('../web/src/decisions/model.ts'));
const { OwnerDecisionRecord } = await import(moduleUrl('../web/src/decisions/OwnerDecisionRecord.tsx'));
const { OwnerDecisionsList } = await import(moduleUrl('../web/src/decisions/OwnerDecisionsList.tsx'));
const { OwnerDecisionPage } = await import(moduleUrl('../web/src/decisions/OwnerDecisionPage.tsx'));
const { OwnerDecisionsPanel, OwnerDecisionsDisclosure, OwnerDecisionsPointer } = await import(
  moduleUrl('../web/src/decisions/OwnerDecisionsPanel.tsx')
);
const { OwnerDecisionsContext } = await import(moduleUrl('../web/src/decisions/context.tsx'));
const { OwnerDecisionsRoute } = await import(moduleUrl('../web/src/decisions/OwnerDecisionsRoute.tsx'));
const { IntentDetailView } = await import(moduleUrl('../web/src/intents/IntentDetail.tsx'));
const real = JSON.parse(readFileSync(new URL('./fixtures/owner-decisions.json', import.meta.url)));
const now = Date.parse('2026-10-25T12:00:00Z');
const intentId = '10000000-0000-4000-8000-000000000001';
const scoped = {
  ...real[0],
  id: '10000000-0000-4000-8000-000000000002',
  operationId: '10000000-0000-4000-8000-000000000002',
  target: { kind: 'intent', intentId },
  what: 'This Intent lands on the focused contract check (r2-range, r2-upload) instead of the full suite.',
  why: 'The change is confined to src/r2; the full suite runs continuously on main and repairs forward.',
  decidedAt: '2026-10-25T08:40:00Z',
  at: '2026-10-25T08:40:00Z',
  overrides: { kind: 'default', description: 'Full-suite landing gate', link: 'docs/workflows.md' },
  actor: { name: 'Dino', kind: 'human' },
};
const records = [...real, scoped];
const intents = [{ id: intentId, outcome: 'Faster first byte from R2' }];
const links = {
  recordHref: id => `/decisions/${id}`,
  intentHref: id => `/intents/${id}`,
  documentHref: link => model.decisionDocumentHref(link, path => `/code/${path}`),
};
const props = { records, intents, now, ...links };
const context = children =>
  h(OwnerDecisionsContext.Provider, { value: { records, intents, now, links } }, children);
const old = real.find(record => records.some(next => next.supersedes === record.id));
const next = records.find(record => record.supersedes === old.id);

test('fixtures preserve all 19 real records and derive Active/Superseded/All across both targets', () => {
  assert.equal(real.length, 19);
  real.forEach(record => decisionRecordSchema.parse(record));
  assert.equal(model.decisionGroups(records, 'all').flatMap(day => day.records).length, 20);
  assert.equal(model.decisionGroups(records, 'active').flatMap(day => day.records).length, 19);
  assert.deepEqual(
    model
      .decisionGroups(records, 'superseded')
      .flatMap(day => day.records)
      .map(record => record.id),
    [old.id],
  );
  assert.equal(model.decisionGroups(records, 'all', 'project').flatMap(day => day.records).length, 19);
  assert.deepEqual(
    model.decisionGroups(records, 'all', intentId).flatMap(day => day.records),
    [scoped],
  );
  const replacement = { ...scoped, id: 'intent-replacement', supersedes: scoped.id };
  assert.equal(
    model.decisionGroups([...records, replacement], 'superseded', intentId)[0].records[0].id,
    scoped.id,
  );
});

test('day groups use decidedAt descending, keep superseded records under their original day', () => {
  const groups = model.decisionGroups(records, 'all');
  assert.deepEqual(
    groups.map(group => group.day),
    ['2026-10-25', '2026-10-24'],
  );
  assert.ok(groups.find(group => group.day === old.decidedAt.slice(0, 10)).records.includes(old));
  for (const group of groups) assert.deepEqual(group.records, model.decisionOrder(group.records));
  assert.equal(model.decisionDay('2026-10-25', now), 'Today · 25 Oct');
  assert.equal(model.decisionDay('2026-10-24', now), 'Yesterday · 24 Oct');
  const html = render(h(OwnerDecisionsList, { ...props, initialFilter: 'all' }));
  assert.match(html, /Today · 25 Oct/);
  assert.match(html, /Yesterday · 24 Oct/);
  for (const label of ['Active', 'Superseded', 'All', 'Project + Intents']) assert.ok(html.includes(label));
  assert.doesNotMatch(html, /Record a decision|Hand to an agent|disabled=/);
  assert.match(render(h(OwnerDecisionsList, { ...props, records: [] })), /No owner decisions yet\./);
});

test('full what is never truncated, stale records stay readable and IDs stay out of visible prose', () => {
  const what = 'A very long decision with full retained content. '.repeat(220);
  const html = render(h(OwnerDecisionRecord, { ...props, record: { ...old, what } }));
  assert.ok(html.includes(what));
  assert.match(html, /fx-odec-superseded/);
  assert.match(html, /Superseded by/);
  assert.match(html, /Superseded<\/span>/);
  assert.doesNotMatch(html, /<del|<s>|line-clamp|truncate/);
  assert.doesNotMatch(html.replace(/href="[^"]*"/g, ''), new RegExp(old.id));
  const css = readFileSync(new URL('../web/src/decisions/decisions.css', import.meta.url), 'utf8');
  assert.doesNotMatch(css.match(/\.fx-odec-what\s*\{[^}]+\}/)[0], /clamp|hidden|ellipsis/);
  assert.match(
    render(h(OwnerDecisionRecord, { ...props, record: { ...old, decidedAt: '2026-10-24' } })),
    /recorded/,
  );
  assert.doesNotMatch(render(h(OwnerDecisionRecord, { ...props, record: scoped })), /· recorded/);
});

test('Intent panel follows Details, precedes Lanes and adds one plain timeline event per retained record', () => {
  const panel = render(context(h(OwnerDecisionsPanel, { intentId })));
  assert.ok(panel.includes(scoped.what));
  assert.ok(!panel.includes(old.what));
  assert.match(panel, /18 project-wide decisions also apply/);
  assert.match(panel, /Overrides default/);
  assert.match(panel, /docs\/workflows.md/);
  const html = render(
    context(
      h(IntentDetailView, {
        row: {
          id: intentId,
          outcome: intents[0].outcome,
          constraints: 'Serve bytes from R2.',
          status: 'active',
          tone: 'active',
          label: 'Working',
          lanes: [],
          open: [],
        },
        views: [],
        notes: [],
        planning: [],
        now,
        laneHref: id => `/lanes/${id}`,
        canStart: false,
      }),
    ),
  );
  assert.ok(html.indexOf('Details') < html.indexOf('Owner decisions'));
  assert.ok(html.indexOf('Owner decisions') < html.indexOf('>Lanes<'));
  assert.equal((html.match(/Owner decision recorded/g) ?? []).length, 1);
  const events = model.decisionTimeline(records, intentId);
  assert.equal(events.length, 1);
  assert.equal(events[0].glyph, 'claim');
  assert.equal(events[0].tone, 'plain');
  assert.match(events[0].detail, /by Dino · overrides default Full-suite landing gate/);
});

test('record pages retain both directions, forks, document links and Exact record identities', () => {
  const before = render(h(OwnerDecisionPage, { ...props, record: old }));
  assert.match(before, /Superseded by · 25 Oct/);
  assert.ok(before.includes(links.recordHref(next.id)));
  assert.ok(before.includes(old.id));
  assert.match(before, /Exact record/);
  const after = render(h(OwnerDecisionPage, { ...props, record: next }));
  assert.ok(after.includes(`Replaces · ${model.decisionDate(old.decidedAt, true)}`));
  assert.ok(after.includes(links.recordHref(old.id)));
  const fork = { ...next, id: 'second-replacement', what: 'An independent explicit replacement' };
  assert.ok(
    render(h(OwnerDecisionPage, { ...props, records: [...records, fork], record: old })).includes(fork.what),
  );
  assert.match(render(h(OwnerDecisionPage, { ...props, record: scoped })), /\/code\/docs\/workflows.md/);
});

test('review disclosure is collapsed by default, includes active Intent and acceptance context only', () => {
  const html = render(context(h(OwnerDecisionsDisclosure, { intentId })));
  assert.match(html, /^<details/);
  assert.doesNotMatch(html, /<details[^>]*\bopen[ =>]/);
  assert.match(html, /Owner decisions in effect · 1 for this Intent · 18 project/);
  assert.ok(html.includes(scoped.what));
  assert.ok(!html.includes(old.what));
  assert.match(html, /fx-odec-compact/);
});

test('Now pointer uses recording time, renders only within seven days and shows at most three', () => {
  const make = (values, at) =>
    render(
      h(
        OwnerDecisionsContext.Provider,
        { value: { records: values, intents, now: at, links } },
        h(OwnerDecisionsPointer),
      ),
    );
  assert.equal(make([], now), '');
  const recent = { ...scoped, decidedAt: '2026-01-01', at: '2026-10-25T10:00:00Z' };
  assert.match(make([recent], now), /Owner decisions/);
  assert.equal(make([recent], Date.parse(recent.at) + 7 * 86_400_000 + 1), '');
  assert.match(make([recent], Date.parse(recent.at) + 7 * 86_400_000), /Owner decisions/);
  assert.equal(make([{ ...recent, at: '2026-10-26T00:00:00Z' }], now), '');
  assert.equal((make(records, now).match(/class="fx-odec-compact"/g) ?? []).length, 3);
});

test('decision routes round trip, share deep links and clear decision selection on main navigation', () => {
  routeMode('hosted');
  projectIdentity('fixture-project', 'dino', 'nanthai-forge');
  const base = 'http://local/dino/nanthai-forge/decisions';
  const href = cleanUrl(`?project=fixture-project&projectTab=decisions&decision=${old.id}`, base);
  const state = routeUrlState(new URL(href, base).href);
  assert.equal(state.searchParams.get('projectTab'), 'decisions');
  assert.equal(state.searchParams.get('decision'), old.id);
  assert.match(href, /\/decisions\/d-/);
  const originalLocation = globalThis.location;
  try {
    globalThis.location = new URL(href, base);
    assert.ok(render(context(h(OwnerDecisionsRoute))).includes('Exact record'));
    globalThis.location = new URL(base);
    assert.ok(render(context(h(OwnerDecisionsRoute))).includes('Owner decision status'));
  } finally {
    if (originalLocation) globalThis.location = originalLocation;
    else delete globalThis.location;
  }
});

test('record document references cannot execute scripts or disguise unsupported protocols', () => {
  for (const value of ['javascript:alert(1)', 'data:text/html,hello', '//attacker.example/path'])
    assert.equal(
      model.decisionDocumentHref(value, x => x),
      undefined,
    );
  assert.equal(
    model.decisionDocumentHref('docs/workflows.md', x => `/code/${x}`),
    '/code/docs/workflows.md',
  );
  assert.equal(
    model.decisionDocumentHref('https://example.com/doc', x => x),
    'https://example.com/doc',
  );
});

test('read-only decision surfaces introduce no queries, subscriptions, effects or polling', () => {
  for (const name of [
    'model.ts',
    'context.tsx',
    'OwnerDecisionRecord.tsx',
    'OwnerDecisionsList.tsx',
    'OwnerDecisionPage.tsx',
    'OwnerDecisionsPanel.tsx',
    'OwnerDecisionsRoute.tsx',
  ]) {
    const source = readFileSync(new URL(`../web/src/decisions/${name}`, import.meta.url), 'utf8');
    assert.doesNotMatch(
      source,
      /useQuery\(|usePaginatedQuery\(|useEffect\(|setInterval\(|setTimeout\(|client\.query\(/,
      name,
    );
  }
});
