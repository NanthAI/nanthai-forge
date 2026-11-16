// SPDX-License-Identifier: Apache-2.0
// The design system's token source (web/src/ds/tokens.css, Item 6ebb58ab): both themes carry every colour, and the
// contrast floors of DESIGN.md hold in each theme, read from the file itself so a token change cannot drift past them.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const css = readFileSync(new URL('../web/src/ds/tokens.css', import.meta.url), 'utf8').replace(
  /\/\*[\s\S]*?\*\//g,
  '',
);
const block = selector => {
  const at = css.indexOf(`${selector} {`);
  assert.ok(at >= 0, `token block ${selector}`);
  return css.slice(at, css.indexOf('}', at));
};
const decls = text =>
  Object.fromEntries([...text.matchAll(/--([a-z0-9-]+):\s*([^;]+);/g)].map(m => [m[1], m[2].trim()]));
const dark = decls(block('[data-ds]'));
const lightBlock = decls(block('[data-ds][data-theme="light"], [data-theme="light"] [data-ds]'));
const light = { ...dark, ...lightBlock };
const media = css.slice(css.indexOf('@media (prefers-color-scheme: light)'));
const systemLight = decls(media.slice(0, media.indexOf('}\n}')));

const resolve = (theme, name, seen = 0) => {
  const value = theme[name];
  assert.ok(value, `--${name} is defined`);
  const ref = /^var\(--([a-z0-9-]+)\)$/.exec(value);
  return ref && seen < 5 ? resolve(theme, ref[1], seen + 1) : value;
};
const rgb = hex => {
  const h = hex.replace('#', '');
  assert.match(h, /^[0-9a-f]{6}$/i, `${hex} is an opaque colour`);
  return [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16));
};
const lum = c => {
  const f = v => ((v /= 255) <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]);
};
const ratio = (theme, a, b) => {
  const [x, y] = [lum(rgb(resolve(theme, a))), lum(rgb(resolve(theme, b)))].sort((m, n) => n - m);
  return (x + 0.05) / (y + 0.05);
};

// Text is 4.5:1 on every surface step and on a selected row; a filled shape that carries meaning is 3:1.
const surfaces = ['bg', 'surface', 'surface-2', 'surface-3', 'accent-bg'];
const text = [
  'text',
  'text-2',
  'text-3',
  'accent',
  'active',
  'waiting',
  'conflict',
  'passed',
  'failed',
  'stale',
];
const shapes = ['series', 'act', 'k-person'];

for (const [name, theme] of [
  ['dark', dark],
  ['light', light],
]) {
  test(`contrast floors hold in the ${name} theme`, () => {
    const misses = [];
    for (const fg of text)
      for (const bg of surfaces) if (ratio(theme, fg, bg) < 4.5) misses.push(`--${fg} on --${bg}`);
    for (const fg of shapes) if (ratio(theme, fg, 'surface') < 3) misses.push(`--${fg} on --surface`);
    if (ratio(theme, 'on-brand', 'brand') < 4.5) misses.push('--on-brand on --brand');
    if (ratio(theme, 'on-person', 'k-person') < 4.5) misses.push('--on-person on --k-person');
    assert.deepEqual(misses, []);
  });
}

test('the light theme set is complete and the system-light copy matches it exactly', () => {
  const colours = Object.keys(dark).filter(
    k => /^#[0-9a-f]{3,8}$/i.test(dark[k]) && !/^(mark-|band|on-band|brand)/.test(k),
  );
  const missing = colours.filter(k => !(k in lightBlock) && !['on-brand'].includes(k));
  assert.deepEqual(missing, [], 'every theme colour has a light value');
  assert.deepEqual(systemLight, lightBlock, 'prefers-color-scheme: light repeats the light set unchanged');
});
