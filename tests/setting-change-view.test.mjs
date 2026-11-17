// SPDX-License-Identifier: Apache-2.0
// Item 16093ed1: a held settings change reads as a summary line, a before/after row per changed field and a line diff
// per script; internal request fields (operation id, authority epoch, digests, ids) never show outside Details, and a
// request the server could not compare still shows the request as sent instead of an empty card.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { moduleUrl } from './convex-module.mjs';

const { settingChangeView, lineDiff, DIFF_LINE_LIMIT } = await import(
  moduleUrl('../web/src/review/setting-change.ts')
);
const { SettingChange } = await import(moduleUrl('../web/src/review/SettingChange.tsx'));

const before = {
  name: 'verify',
  executable: 'bash',
  args: ['-c', 'npm ci\nnpm test'],
  environmentLabel: 'clean',
};
const after = {
  name: 'verify',
  executable: 'bash',
  args: ['-c', 'npm ci\n./gradlew build\nnpm test'],
  environmentLabel: 'clean',
  actionsToolchains: { java: '17' },
  artifactPaths: ['reports/**'],
};

test('a check definition change says what it adds and that the script changed, with a line diff', () => {
  const view = settingChangeView('check-definition', { subject: 'verify', before, after });
  assert.equal(view.unavailable, false);
  assert.match(view.summary, /^Check verify: /);
  assert.match(view.summary, /adds reports\/\*\* to artifact paths/);
  assert.match(view.summary, /sets actions toolchains › java to 17/);
  assert.match(view.summary, /script changed\.$/);
  assert.deepEqual(
    view.scripts[0].lines.map(line => `${line.op}:${line.text}`),
    ['same:npm ci', 'add:./gradlew build', 'same:npm test'],
  );
  assert.equal(view.same, 4, 'name, executable, the -c flag and the environment label stay');
});

test('a policy change lists only the fields the grant moves, before and after, without internal fields', () => {
  const policy = {
    preset: 'custom',
    acceptance: { protectedPaths: ['ci/**', 'deploy/**'], landingMode: 'strict' },
  };
  const asked = {
    operationId: 'a3f5c0de-0000-4000-8000-000000000000',
    preset: 'custom',
    acceptance: { protectedPaths: ['ci/**'], landingMode: 'fast' },
  };
  const view = settingChangeView('policy', { before: policy, after: asked });
  assert.deepEqual(
    view.rows.map(row => [row.label, row.before, row.after]),
    [
      ['Acceptance › protected paths', 'ci/**, deploy/**', 'ci/**'],
      ['Acceptance › landing mode', 'strict', 'fast'],
    ],
  );
  assert.deepEqual(view.rows[0].dropped, ['deploy/**']);
  assert.ok(!view.rows.some(row => /operation/i.test(row.label)), 'the operation id is internal');
  assert.match(
    view.summary,
    /drops deploy\/\*\* from acceptance › protected paths, changes acceptance › landing mode/,
  );
});

test('a request the server could not compare keeps the request intact behind Details', () => {
  const change = { operationId: 'x', authorityEpoch: 3, change: { kind: 'runner' } };
  const view = settingChangeView('runner', null);
  assert.equal(view.unavailable, true);
  const html = renderToStaticMarkup(
    createElement(SettingChange, { origin: 'runner', compare: null, change }),
  );
  assert.match(html, /could not be compared/);
  const [outside, inside] = html.split('<details');
  assert.ok(!/authorityEpoch/.test(outside), 'internal fields show only inside Details');
  assert.match(inside, /authorityEpoch/);
});

test('rendered rows hide internal ids by default and a long script becomes wrapped text, not one escaped line', () => {
  const html = renderToStaticMarkup(
    createElement(SettingChange, {
      origin: 'check-definition',
      compare: { subject: 'verify', before, after },
      change: {
        operationId: 'op',
        authorityEpoch: 9,
        change: { kind: 'definition', checkId: 'c', command: after },
      },
    }),
  );
  const [outside] = html.split('<details');
  assert.ok(!/authorityEpoch|checkId|operationId/.test(outside));
  assert.ok(!outside.includes('\\n'), 'no escaped newlines outside Details');
  assert.match(outside, /class="sc-diff"/);
});

test('a script past the diff limit is shown whole on both sides instead of diffed', () => {
  const long = Array.from({ length: DIFF_LINE_LIMIT + 1 }, (_, i) => `echo ${i}`).join('\n');
  assert.equal(lineDiff(long, `${long}\necho end`), null);
  const view = settingChangeView('check-definition', {
    before: { args: ['-c', long] },
    after: { args: ['-c', `${long}\necho end`] },
  });
  assert.equal(view.scripts[0].lines, null);
  assert.ok(view.scripts[0].after.endsWith('echo end'));
});
