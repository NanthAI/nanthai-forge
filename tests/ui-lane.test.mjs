// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { moduleUrl } from './convex-module.mjs';
const { failingTests } = await import(moduleUrl('../web/src/lane/CheckPanel.tsx'));
const { nextStep } = await import(moduleUrl('../web/src/lane/LaneParts.tsx'));
const { Diff } = await import(moduleUrl('../web/src/lane/Diff.tsx'));
const brief = await import(moduleUrl('../web/src/cockpit/brief.ts'));

const lane = (extra = {}) => ({
  id: 'l',
  name: 'l',
  tone: 'active',
  open: true,
  checkpoints: 0,
  conflicts: [],
  ...extra,
});

test('failing test names come from ✖ lines without the summary header or timings', () => {
  const summary = [
    '✖ discount › SAVE10 takes 10% off (12.5ms)',
    '  AssertionError: expected 9, got 8.5',
    '✖ failing tests:',
    '✖ discount › SAVE10 takes 10% off (12.5ms)',
  ].join('\n');
  assert.deepEqual(failingTests(summary), ['discount › SAVE10 takes 10% off']);
});

test('the next step says whether the viewer is needed, in one sentence per state', () => {
  assert.match(nextStep(lane({ tone: 'conflict', conflicts: ['a.ts'] })).title, /1 conflicting file/);
  assert.match(nextStep(lane({ tone: 'failed' })).title, /Not ready to accept/);
  assert.match(nextStep(lane({ tone: 'passed' })).title, /Stopped for your review/);
  assert.equal(nextStep(lane()).title, 'No saved changes yet');
  assert.match(nextStep(lane({ checkpoints: 2 })).body, /2 saves/);
  assert.equal(nextStep(lane({ open: false })).title, 'Done');
  assert.equal(nextStep(lane({ tone: 'waiting', label: 'Needs update' })).title, 'Needs an update from main');
});

test('briefings match the situation of each decision and Lane', () => {
  assert.deepEqual(brief.decisionBrief({ kind: 'review', laneId: 'l', viewId: 'v' }), {
    situation: 'review-and-accept',
    laneId: 'l',
    viewId: 'v',
  });
  assert.equal(brief.decisionBrief({ kind: 'handoff', messageId: 'm' }).situation, 'take-handoff');
  assert.equal(brief.decisionBrief({ kind: 'conflict' }), null);
  assert.equal(brief.laneBrief(lane({ tone: 'failed' }), 'r').runId, 'r');
  assert.equal(brief.laneBrief(lane({ tone: 'passed' })).situation, 'continue-lane');
  assert.equal(brief.laneBrief(lane({ tone: 'passed', viewId: 'v' })).situation, 'review-and-accept');
});

test('diffs number both sides and drop the final-newline artefact of whole-file additions', () => {
  const comparison = {
    truncated: false,
    hunks: [
      {
        beforeStart: 1,
        afterStart: 1,
        beforeLines: 0,
        afterLines: 3,
        lines: [
          { kind: 'added', text: 'one' },
          { kind: 'added', text: 'two' },
          { kind: 'added', text: '' },
        ],
      },
    ],
  };
  const added = renderToStaticMarkup(h(Diff, { comparison, status: 'added' }));
  assert.equal((added.match(/fx-diff-added/g) ?? []).length, 2);
  const modified = renderToStaticMarkup(h(Diff, { comparison, status: 'modified' }));
  assert.equal((modified.match(/fx-diff-added/g) ?? []).length, 3);
  assert.match(
    renderToStaticMarkup(h(Diff, { comparison: { hunks: [], truncated: true, content: 'binary' } })),
    /binary/,
  );
});

test('large diffs initially render a row window while retaining the complete scroll extent', () => {
  const comparison = {
    truncated: false,
    hunks: [
      {
        beforeStart: 1,
        afterStart: 1,
        beforeLines: 0,
        afterLines: 6000,
        lines: Array.from({ length: 6000 }, (_, i) => ({ kind: 'added', text: `line ${i + 1}` })),
      },
    ],
  };
  const html = renderToStaticMarkup(h(Diff, { comparison, status: 'added' }));
  assert.equal((html.match(/fx-diff-added/g) ?? []).length, 100);
  assert.match(html, /line 100/);
  assert.doesNotMatch(html, /line 101</);
  assert.equal((html.match(/height:1800px/g) ?? []).length, 59);
  assert.doesNotMatch(html, /<table[^>]*>\s*<div/);
  for (const mode of ['split', 'inline']) {
    const windowed = renderToStaticMarkup(h(Diff, { comparison, status: 'added', mode, file: 'large.ts' }));
    assert.match(windowed, /line 100/);
    assert.doesNotMatch(windowed, /line 101</);
    assert.equal((windowed.match(/height:1800px/g) ?? []).length, 59);
  }
});

const { numberedLines, pairedLines, wordChanges } = await import(moduleUrl('../web/src/lane/diff-rows.ts'));

test('split pairs adjacent changes without moving line numbers or pairing across context', () => {
  const lines = numberedLines({
    beforeStart: 40,
    afterStart: 43,
    lines: [
      { kind: 'removed', text: 'old one' },
      { kind: 'removed', text: 'old two' },
      { kind: 'added', text: 'new one' },
      { kind: 'context', text: 'same' },
      { kind: 'added', text: 'new after context' },
    ],
  });
  const rows = pairedLines(lines);
  assert.deepEqual(
    rows.map(row => [row.left?.before ?? '', row.right?.after ?? '']),
    [
      [40, 43],
      [41, ''],
      [42, 44],
      ['', 45],
    ],
  );
  const markup = renderToStaticMarkup(
    h(Diff, {
      mode: 'split',
      comparison: { truncated: false, hunks: [{ beforeStart: 40, afterStart: 43, lines }] },
    }),
  );
  assert.match(markup, /fx-diff-split/);
  assert.match(markup, /fx-diff-empty/);
  assert.match(markup, /old two/);
  assert.match(markup, /new after context/);
});

test('inline word changes reconstruct both exact inputs, including punctuation and hostile markup', () => {
  for (const [before, after] of [
    ['summary: v.string(),', 'summary: v.optional(v.string()),'],
    ['staleAfterMs: 900000,', 'staleAfterMs: 600000, // ten min'],
    ['', '<script>not executable</script>'],
    ['removed only', ''],
    ['same', 'same'],
    ['😀 é spaces\tand symbols', '😀 É spaces  and symbols'],
    ['a '.repeat(700), 'b '.repeat(700)],
  ]) {
    const words = wordChanges(before, after);
    assert.equal(
      words
        .filter(word => word.kind !== 'added')
        .map(word => word.text)
        .join(''),
      before,
    );
    assert.equal(
      words
        .filter(word => word.kind !== 'removed')
        .map(word => word.text)
        .join(''),
      after,
    );
  }
  const html = renderToStaticMarkup(
    h(Diff, {
      mode: 'inline',
      comparison: {
        truncated: false,
        hunks: [
          {
            beforeStart: 1,
            afterStart: 1,
            lines: [
              { kind: 'removed', text: '<old>' },
              { kind: 'added', text: '<script>new</script>' },
            ],
          },
        ],
      },
    }),
  );
  assert.match(html, /fx-diff-modified/);
  assert.match(html, /class="w d"/);
  assert.match(html, /class="w"/);
  assert.doesNotMatch(html, /<script>/);
});

test('the mode toggle exposes its selected choice accessibly', async () => {
  const { DiffModes } = await import(moduleUrl('../web/src/lane/Diff.tsx'));
  const html = renderToStaticMarkup(h(DiffModes, { mode: 'inline', onChange() {} }));
  assert.match(html, /aria-label="Diff mode"/);
  assert.match(html, /aria-pressed="true">Inline/);
  assert.equal((html.match(/aria-pressed="true"/g) ?? []).length, 1);
});

test('inline alignment keeps inserted fields separate from the fields being modified', () => {
  const rows = pairedLines(
    numberedLines({
      beforeStart: 1,
      afterStart: 1,
      lines: [
        { kind: 'removed', text: '  summary: v.string(),' },
        { kind: 'removed', text: '  staleAfterMs: 900000,' },
        { kind: 'added', text: '  mergedInto: v.optional(v.id("channels")),' },
        { kind: 'added', text: '  mergedAt: v.optional(v.number()),' },
        { kind: 'added', text: '  summary: v.optional(v.string()),' },
        { kind: 'added', text: '  staleAfterMs: 600000,' },
      ],
    }),
  );
  assert.deepEqual(
    rows.map(row => [row.left?.before ?? '', row.right?.after ?? '']),
    [
      ['', 1],
      ['', 2],
      [1, 3],
      [2, 4],
    ],
  );
});

test('prose diffs opt into wrapping while source code keeps its scroll layout', () => {
  const comparison = {
    truncated: false,
    hunks: [
      {
        beforeStart: 1,
        afterStart: 1,
        beforeLines: 0,
        afterLines: 1,
        lines: [{ kind: 'added', text: 'A long paragraph with words to wrap.' }],
      },
    ],
  };
  assert.match(renderToStaticMarkup(h(Diff, { comparison, file: 'docs/design.md' })), /data-prose="true"/);
  assert.doesNotMatch(renderToStaticMarkup(h(Diff, { comparison, file: 'src/design.ts' })), /data-prose/);
});

const { fitPath } = await import(moduleUrl('../web/src/lane/PathLabel.tsx'));
test('file labels shorten directories first and use middle ellipsis for narrow basenames', () => {
  const basename = 'ADR-082-human-lane-source-context.md';
  const path = `docs/decisions/${basename}`;
  assert.equal(
    fitPath(path, text => text.length <= 45),
    `docs/…/${basename}`,
  );
  const narrow = fitPath(path, text => text.length <= 25);
  assert.ok(narrow.length <= 25);
  assert.match(narrow, /^ADR.*….*context\.md$/);
  assert.doesNotMatch(narrow, /\n/);
});

test('streamed TAP failures retain their names in the check panel', () => {
  assert.deepEqual(failingTests('[test] not ok 12 - source regression\nnot ok 12 - source regression'), [
    'source regression',
  ]);
});

test('Done Lane header names the Lane once and omits placeholder actor and absent check', async () => {
  const { LaneHeader } = await import(moduleUrl('../web/src/lane/LaneParts.tsx'));
  const html = renderToStaticMarkup(
    h(LaneHeader, {
      lane: lane({
        name: 'Customer exports',
        intent: 'Customer exports',
        open: false,
        label: 'Done',
        fact: '1 save. Customer exports',
      }),
      now: 0,
      base: 'From main',
    }),
  );
  assert.equal((html.match(/Customer exports/g) ?? []).length, 1);
  assert.doesNotMatch(html, /No check yet|fx-situation|>—</);
});

test('Lane timeline names events without repeating the Lane title', async () => {
  const { laneTimeline } = await import(moduleUrl('../web/src/lane/timeline.ts'));
  const rows = laneTimeline(
    {
      lanes: [
        {
          id: 'l',
          name: 'Customer exports',
          intentId: 'i',
          checkpoints: [{ at: '2026-10-16', message: 'Keep filename' }],
        },
      ],
      intents: [{ id: 'i', outcome: 'Customer exports' }],
      views: [],
      runs: [],
    },
    'l',
    [{ id: 'return', at: '2026-10-16', text: 'Customer exports · returned source · 152 files' }],
  );
  assert.equal(rows[0].text, 'Saved');
  assert.equal(rows[0].detail, 'Keep filename');
  assert.equal(rows[1].text, 'Returned source · 152 files');
});

test('unified context has old and new line numbers in two cells of the same row', () => {
  const html = renderToStaticMarkup(
    h(Diff, {
      comparison: {
        truncated: false,
        hunks: [
          {
            beforeStart: 12,
            afterStart: 15,
            beforeLines: 1,
            afterLines: 1,
            lines: [{ kind: 'context', text: 'same' }],
          },
        ],
      },
      file: 'a.ts',
    }),
  );
  assert.match(
    html,
    /<tr class="fx-diff-line fx-diff-context"><td class="fx-diff-n">12<\/td><td class="fx-diff-n">15<\/td>/,
  );
});
