// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { moduleUrl } from './convex-module.mjs';
const { drafts, requestNavigation, setNavigationConfirmation } = await import(
  moduleUrl('../web/src/ui/navigation.ts')
);
const { AppLoader } = await import(moduleUrl('../web/src/ui/AppLoader.tsx'));

test('navigation proceeds without user input, and draft confirmation defers the entire action', () => {
  let moved = 0,
    pending;
  setNavigationConfirmation(action => {
    pending = action;
  });
  requestNavigation(() => moved++);
  assert.equal(moved, 1);
  const key = Symbol();
  drafts.set(key, () => undefined);
  requestNavigation(() => moved++);
  assert.equal(moved, 1); // Keeping the draft performs no navigation.
  drafts.delete(key); // A successful save or discard clears protection.
  pending();
  assert.equal(moved, 2);
  requestNavigation(() => moved++);
  assert.equal(moved, 3);
  setNavigationConfirmation();
});

test('the application loader is the accessible Forge mark with no visible loading copy', () => {
  const html = renderToStaticMarkup(h(AppLoader));
  assert.match(html, /aria-label="Loading Forge"/);
  assert.match(html, /role="status"/);
  assert.match(html, /fx-loading-orbit/);
  assert.match(html, /<g class="fx-orbit"><g class="fx-mark-lower">/);
  assert.doesNotMatch(html, /clipPath|fx-loading-fill/);
  assert.doesNotMatch(html, /Connecting|<p[ >]/);
});

test('legacy Settings destinations use the same design-system glyph as desktop and mobile shell navigation', async () => {
  const { Glyph } = await import(moduleUrl('../web/src/ui/Glyph.tsx'));
  const { Icon } = await import(moduleUrl('../web/src/Icons.tsx'));
  assert.equal(
    renderToStaticMarkup(h(Icon, { name: 'settings' })),
    renderToStaticMarkup(h(Glyph, { name: 'settings', size: 20 })),
  );
});
