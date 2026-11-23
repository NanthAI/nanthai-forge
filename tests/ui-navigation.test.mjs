// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { moduleUrl } from './convex-module.mjs';

const { AppLoader } = await import(moduleUrl('../web/src/ui/AppLoader.tsx'));

test('the application loader is the accessible Forge mark with no visible loading copy', () => {
  const html = renderToStaticMarkup(h(AppLoader));
  assert.match(html, /aria-label="Loading Forge"/);
  assert.match(html, /role="status"/);
  assert.match(html, /<svg class="fx-mark mk c64"[^>]*width="64"[^>]*data-state="checks"/);
  assert.match(html, /<g class="armL">/);
  assert.doesNotMatch(html, /clipPath|fx-loading-fill/);
  assert.doesNotMatch(html, /Connecting|<p[ >]/);
});

test('the Forge mark renders every Hearth state from data-state within its size budget', async () => {
  const { ForgeMark } = await import(moduleUrl('../web/src/ui/brand.tsx'));
  const { readFileSync } = await import('node:fs');
  const { gzipSync } = await import('node:zlib');
  const css = readFileSync(new URL('../web/src/ui/mark.css', import.meta.url));
  const states = 'idle w1 wN checks overlap waiting queued landing landed failed rolledback paused';
  for (const state of [...states.split(' '), 'first', 'streak', 'many', 'thousand']) {
    const html = renderToStaticMarkup(h(ForgeMark, { state }));
    assert.match(html, new RegExp(`data-state="${state}"`));
    assert.ok(html.length <= 1024, `${state} SVG is ${html.length} bytes`);
    assert.ok(css.includes(`[data-state=${state}]`), `mark.css styles ${state}`);
  }
  assert.match(renderToStaticMarkup(h(ForgeMark)), /data-state="idle"/);
  assert.match(renderToStaticMarkup(h(ForgeMark, { arrive: true })), /data-state="first"/);
  assert.ok(
    css.length <= 24 * 1024 && gzipSync(css).length <= 6 * 1024,
    'mark.css within 24 KB raw / 6 KB gzip',
  );
});
