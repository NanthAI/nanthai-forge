// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// Item 12ed415f: local component-render checks for Needs me and FYI cards (failed-check copy, Messages filter,
// headline longest hold, shared Standing count, Waiting casing, "Asked just now", approval Later placement,
// and in-page settings guidance).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { moduleUrl } from './convex-module.mjs';

const { Fyi } = await import(moduleUrl('../web/src/app/needs/FyiRegion.tsx'));
const { Ahead, Held, NoticeCard, Parked, Question } = await import(
  moduleUrl('../web/src/app/needs/NeedsCards.tsx')
);
const { fyiView } = await import(moduleUrl('../web/src/app/needs/fyi.ts'));
const { needsSentence, needsView, standingInProgress } = await import(
  moduleUrl('../web/src/app/needs/model.ts')
);
const { Standing } = await import(moduleUrl('../web/src/ds/index.ts'));
const { progressCells, progressOf } = await import(moduleUrl('../web/src/app/progress.ts'));
const { SettingChange } = await import(moduleUrl('../web/src/review/SettingChange.tsx'));

const NOW = Date.UTC(2026, 10, 27, 1, 30);
const ago = minutes => NOW - minutes * 60_000;
const project = { handle: 'sample-one', project: 'tidepool' };
const noop = async () => '{}';

test('12ed415f: FyiRegion renders Messages filter and human-facing failed-check card with holder and age', () => {
  const held = needsView(
    {
      held: [
        {
          laneId: 'lane-fail-1',
          title: 'Add failing check fixture',
          actor: 'sample-one',
          agent: 'amber-fox',
          why: 'check-failed',
          note: 'Fix it in this Lane, save, then run land --save again; do not abandon or re-create the Lane. If it fails without your c',
          submissionId: null,
          attemptId: 'attempt-failed-1',
          since: ago(11),
        },
      ],
      more: 0,
      moreIsLowerBound: false,
      approvals: '{"requests":[],"complete":true}',
      canDecide: true,
    },
    NOW,
  ).fyi;
  const view = fyiView(
    {
      owner: true,
      state: { clearedAt: null, clearedSequence: null, dismissed: [] },
      landings: [],
      landingsMore: false,
      broke: [],
      settings: [],
      access: [],
      messages: [
        {
          id: 'm1',
          at: ago(2),
          actor: 'sample-two',
          agent: 'still-heron',
          text: 'Fixtures updated; nothing for you to do.',
          laneId: 'lane-fail-1',
        },
      ],
      messagesMore: false,
    },
    held,
    NOW,
  );
  const html = renderToStaticMarkup(
    createElement(Fyi, {
      handle: null,
      view,
      state: { clearedAt: null, clearedSequence: null, dismissed: [] },
      drawnAt: NOW,
      dismiss: noop,
      announce() {},
      href: ({ place, section, rest }) =>
        ['/sample-one/tidepool', place, section, rest].filter(Boolean).join('/'),
      history: () => view,
      sectionLinked: false,
      headingRef() {},
    }),
  );
  assert.match(html, /Messages 1/);
  assert.match(html, /amber-fox/);
  assert.match(html, /Failed 11 min ago/);
  assert.doesNotMatch(html, /land --save|Fix it in this Lane/i);
  assert.match(
    html,
    /href="\/sample-one\/tidepool\/lanes\/lane-fail-1\?checkAttempt=attempt-failed-1"[^>]*>Open the Lane</,
  );
});

test('12ed415f: Needs cards render aligned Waiting, Asked just now, approval Later row, shared Standing count, and in-page settings copy', () => {
  const view = needsView(
    {
      held: [
        {
          laneId: 'lane-rev-1',
          title: 'Deploy workflow: update token scope',
          actor: 'sample-one',
          agent: 'salt-wren',
          why: 'review',
          note: 'needs owner approval: protected paths .github/workflows/deploy.yml',
          submissionId: 'sub-1',
          attemptId: 'att-1',
          reviewCheck: 'ran',
          url: '/approve?project=synthetic&submission=sub-1',
          since: ago(18),
        },
      ],
      more: 0,
      moreIsLowerBound: false,
      approvals: JSON.stringify({
        requests: [
          {
            laneId: 'setting:policy',
            kind: 'setting',
            needsOwner: true,
            label: 'Held settings change waits for you',
            nextStep: 'Open the approve link, then approve or decline the settings change.',
            reason: 'Add ops/** to protected paths.',
            requester: 'sample-one',
            agent: 'amber-fox',
            head: 'a'.repeat(64),
            at: new Date(NOW).toISOString(),
            setting: { origin: 'policy' },
          },
          {
            laneId: 'setting:runner',
            kind: 'setting',
            needsOwner: true,
            label: 'Held settings change waits for you',
            nextStep: 'Open the approve link, then approve or decline the settings change.',
            reason: 'Run 8 checks at once.',
            requester: 'sample-one',
            agent: 'amber-fox',
            head: 'b'.repeat(64),
            at: new Date(ago(31)).toISOString(),
            setting: { origin: 'runner' },
          },
        ],
        complete: true,
      }),
      canDecide: true,
      asks: [
        {
          id: 'ask-1',
          at: ago(9),
          actor: 'sample-two',
          agent: 'amber-fox',
          text: 'Which shard budget?',
          choices: ['4', '8'],
          laneId: 'lane-rev-1',
        },
        {
          id: 'ask-ahead-1',
          at: NOW,
          actor: 'sample-two',
          agent: 'amber-fox',
          text: 'Reuse cache?',
          choices: ['Yes', 'No'],
          laneId: null,
          ahead: true,
        },
      ],
      parked: [
        {
          laneId: 'lane-park-1',
          intentId: 'item-park-1',
          title: 'Docs: queue limits page',
          actor: 'sample-two',
          agent: 'brisk-heron',
          park: { to: 'sample-one', named: true, reason: 'Pick limit.', at: ago(35), by: 'sample-two' },
          at: ago(35),
        },
      ],
      notices: [
        {
          kind: 'reverted',
          id: '5d1c7a0e-0000-4000-8000-000000000710',
          summary: '',
          next: null,
          taken: {
            laneId: '5d1c7a0e-0000-4000-8000-000000000713',
            title: 'Fresh revert',
            by: 'sample-two',
            agent: null,
            at: NOW,
          },
        },
      ],
    },
    NOW,
  );

  // Headline + Standing use oldest eligible hold and shared attention count (1 review + 1 ask + 1 parked + 1 taken = 4; holds = 3).
  assert.deepEqual(needsSentence(view, NOW), {
    bold: '4 things need you.',
    rest: '3 things hold work until you decide; the longest has waited 35 min.',
  });
  const standingHtml = renderToStaticMarkup(
    createElement(Standing, {
      of: 'app',
      ...progressCells(
        progressOf(
          {
            exact: true,
            issue: { proposed: 0, open: 2, inProgress: 1, closed: 3, abandoned: 0 },
            closedToday: null,
          },
          NOW,
        ),
        {
          inProgress: standingInProgress(7, view),
          hrefs: { done: '/code', inProgress: '/lanes', left: '/plan' },
        },
      ),
    }),
  );
  assert.match(standingHtml, /7 Lanes open, 4 need you/);

  const singleStandingHtml = renderToStaticMarkup(
    createElement(Standing, {
      of: 'app',
      ...progressCells(
        progressOf(
          {
            exact: true,
            issue: { proposed: 0, open: 0, inProgress: 1, closed: 1, abandoned: 0 },
            closedToday: null,
          },
          NOW,
        ),
        {
          inProgress: standingInProgress(1, { count: 1, countAtLeast: false }),
          hrefs: { done: '/code', inProgress: '/lanes', left: '/plan' },
        },
      ),
    }),
  );
  assert.match(singleStandingHtml, /1 Lane open, 1 needs you/);

  const heldHtml = renderToStaticMarkup(
    createElement(Held, {
      row: view.now[0],
      project,
      drawnAt: NOW,
      laneHref: '/sample-one/tidepool/lanes/lane-rev-1',
      waitsHref: '/sample-one/tidepool/lanes/touching?lane=lane-rev-1',
      anchor: 'lane-rev-1',
      decide: noop,
      canDecide: true,
      announce() {},
    }),
  );
  assert.match(heldHtml, /Waiting 18 min/);
  assert.match(
    heldHtml,
    /class="btns needs-dec-actions"[^>]*>[\s\S]*Approve and land[\s\S]*Decline[\s\S]*Later/,
  );

  const questionHtml = renderToStaticMarkup(
    createElement(Question, {
      row: view.asks[0],
      project,
      drawnAt: NOW,
      answer: async () => {},
      contextHref: '/sample-one/tidepool/lanes/lane-rev-1/thread',
      announce() {},
    }),
  );
  assert.match(questionHtml, /Waiting 9 min/);
  assert.doesNotMatch(questionHtml, /\bwaiting 9 min/);

  const aheadQuestionHtml = renderToStaticMarkup(
    createElement(Question, {
      row: view.askedAhead[0],
      project,
      drawnAt: NOW,
      answer: async () => {},
      contextHref: undefined,
      announce() {},
    }),
  );
  assert.match(aheadQuestionHtml, /Asked just now/);
  assert.doesNotMatch(aheadQuestionHtml, /just now ago/i);

  const parkedHtml = renderToStaticMarkup(
    createElement(Parked, {
      row: view.parked[0],
      drawnAt: NOW,
      laneHref: '/sample-one/tidepool/lanes/lane-park-1',
      project,
    }),
  );
  assert.match(parkedHtml, /Parked 35 min/);

  const noticeHtml = renderToStaticMarkup(
    createElement(NoticeCard, {
      row: view.notices[0],
      href: () => '/sample-one/tidepool',
      taken: undefined,
      announce() {},
      drawnAt: NOW,
    }),
  );
  assert.match(noticeHtml, />just now</);
  assert.doesNotMatch(noticeHtml, /just now ago/i);

  const newAheadHtml = renderToStaticMarkup(
    createElement(Ahead, {
      row: view.ahead[0],
      project,
      drawnAt: NOW,
      decide: noop,
      canDecide: true,
      announce() {},
    }),
  );
  assert.match(newAheadHtml, /Asked just now/);
  assert.doesNotMatch(newAheadHtml, /just now ago/i);
  assert.match(newAheadHtml, /Approve or decline the settings change below\./);
  assert.doesNotMatch(newAheadHtml, /Open the approve link/i);

  const oldAheadHtml = renderToStaticMarkup(
    createElement(Ahead, {
      row: view.ahead[1],
      project,
      drawnAt: NOW,
      decide: noop,
      canDecide: true,
      announce() {},
    }),
  );
  assert.match(oldAheadHtml, /Asked 31 min ago/);

  const settingHtml = renderToStaticMarkup(
    createElement(SettingChange, {
      origin: 'policy',
      compare: {
        before: { preset: 'strict', acceptance: { protectedPaths: ['ci/**'] } },
        after: { preset: 'custom', acceptance: { protectedPaths: ['ci/**', 'ops/**'] } },
      },
      change: {},
    }),
  );
  assert.match(settingHtml, /acceptance › protected paths/);
  assert.doesNotMatch(settingHtml, /U\+203A/);
});
