// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  classClashes,
  designSystemIndex,
  dsClassClashFindings,
  formatClash,
  readDesignSystem,
} from '../scripts/check-ds-class-clash.mjs';

// A small system in the real one's shape: rules nested under [data-ds], utilities in base.css.
const SYSTEM = [
  {
    path: 'web/src/ds/base.css',
    text: '[data-ds] {\n  .grow { flex: 1 1 auto; } .right { margin-left: auto; }\n}\n',
  },
  {
    path: 'web/src/ds/core.css',
    text: [
      '[data-ds] {',
      '  .row { display: flex; gap: 8px; }',
      '  .row.held { grid-template-columns: 64px 1fr; }',
      '  .chip { display: inline-flex; }',
      '  .row.chip { gap: 4px; }',
      '  .dot { position: absolute; width: var(--mark); height: var(--mark); }',
      '  .veil { position: fixed; inset: 0; display: grid; }',
      '  pre.log { white-space: pre; }',
      '  @media (max-width: 600px) { .tray .row { gap: 2px; } }',
      '}',
    ].join('\n'),
  },
  { path: 'web/src/ds/figures.css', text: '[data-ds] {\n  .bar { display: flex; height: 22px; }\n}\n' },
];
const index = designSystemIndex(SYSTEM);
const clashes = (text, path = 'web/src/app/page.css') =>
  classClashes(index, path, text).map(({ line, className, kind }) => [line, className, kind]);

test('a clashing rule is flagged by file, line and class, naming the system file that owns the name', () => {
  // The three shapes behind e2347b1c: a modifier claimed alone, two system parts joined, a mark laid out.
  const page = [
    '[data-ds] {',
    '  .held { grid-template-columns: 1fr auto; }',
    '  .chip.bar { white-space: normal; }',
    '  .thread .dot { display: grid; padding: 8px; }',
    '}',
  ].join('\n');
  assert.deepEqual(clashes(page), [
    [2, '.held', 'modifier'],
    [3, '.chip.bar', 'fused'],
    [4, '.dot', 'out-of-flow'],
  ]);
  const lines = classClashes(index, 'web/src/app/page.css', page).map(formatClash);
  assert.match(
    lines[0],
    /^web\/src\/app\/page\.css:2 \.held redefines a design-system class owned by web\/src\/ds\/core\.css /,
  );
  assert.match(lines[1], /owned by web\/src\/ds\/core\.css and web\/src\/ds\/figures\.css/);
  assert.ok(
    lines.every(line => !line.includes('grid-template-columns')),
    'names only, never declarations',
  );
});

test('using a system class without redefining it is not flagged', () => {
  const page = [
    '[data-ds] {',
    '  .plan .row { gap: 12px; }', // restyled in a page scope
    '  .row.mine { grid-template-columns: 1fr auto; }', // extended with a page class
    '  .row.chip { padding: 0; }', // a combination the system itself makes
    '  .chip.right, .row .grow { margin: 0; }', // utilities are meant to be combined
    '  .bar { padding: 0 4px; }', // the system styles .bar on its own: same meaning
    '  .row.log { display: grid; }', // the system's .log is pre.log only
    '  .veil.on { display: flex; }', // an overlay the system positions, laid out
    '  .thread .dot::before { display: block; }', // a pseudo-element is its own box
    '  .tray .dot { display: block; position: static; }', // position set: the page owns the box
    '  .chips .held-note { color: red; }', // a different name
    '  :is(.a, .b) .held { color: red; }', // a modifier in context is not the whole page claiming it
    '}',
  ].join('\n');
  assert.deepEqual(clashes(page), []);
});

test('nesting, @media, comments and strings keep selectors and lines true', () => {
  const page = [
    '/* .held { } in a comment */',
    '[data-ds] {',
    '  .x::after { content: "{ .held }"; }',
    '  @media (max-width: 600px) {',
    '    .tray {',
    '      & .dot { display: flex; }',
    '      .chip.bar { gap: 0; }',
    '    }',
    '  }',
    '}',
  ].join('\n');
  assert.deepEqual(clashes(page), [
    [6, '.dot', 'out-of-flow'],
    [7, '.chip.bar', 'fused'],
  ]);
});

test('an HTML page is read through its <style> blocks with page line numbers', () => {
  const html =
    '<!doctype html>\n<html>\n<head>\n<style>\n  .held { min-height: 46px; }\n</style>\n</head>\n<body class="held"></body>\n</html>\n';
  assert.deepEqual(clashes(html, 'mock/page.html'), [[5, '.held', 'modifier']]);
});

test('the repository check reads web/src/ds and scans only page sheets scoped to [data-ds]', t => {
  const root = mkdtempSync(join(tmpdir(), 'ds-clash-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'web/src/ds'), { recursive: true });
  mkdirSync(join(root, 'web/src/app'), { recursive: true });
  for (const { path, text } of SYSTEM) writeFileSync(join(root, path), text);
  writeFileSync(
    join(root, 'web/src/app/scoped.css'),
    '[data-ds] {\n  .page { gap: 0; }\n  .held { gap: 0; }\n}\n',
  );
  // A sheet outside any system frame (a legacy screen, the static landing page) cannot clash.
  writeFileSync(join(root, 'web/src/legacy.css'), '.held { gap: 0; }\n');
  assert.deepEqual(dsClassClashFindings(root), [
    "web/src/app/scoped.css:3 .held redefines a design-system class owned by web/src/ds/core.css (the system styles it only together with another class); give the page's own thing its own name",
  ]);
});

test('the real design system is indexed: owners, parts styled alone and joined compounds', () => {
  const real = readDesignSystem(new URL('..', import.meta.url).pathname);
  assert.ok(real.owner.size > 100, 'the system defines many classes');
  assert.ok(
    real.alone.has('split') && !real.alone.get('split').utility,
    'the split bar is a part styled alone',
  );
  assert.ok(real.alone.get('right')?.utility, 'base.css utilities are marked as combinable');
  assert.ok(
    !real.alone.has('hold') && real.combined.has('hold'),
    '.hold is styled only together with another class',
  );
});
