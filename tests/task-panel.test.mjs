// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { moduleUrl } from './convex-module.mjs';
const { DetailPanel } = await import(moduleUrl('../web/src/DetailPanel.tsx'));

test('task launchers inside forms cannot accidentally submit and retain an accessible named task', () => {
  const html = renderToStaticMarkup(
    createElement(
      'form',
      { action: '/original-submit' },
      createElement(
        DetailPanel,
        { title: 'Choose starting source' },
        createElement(
          'label',
          null,
          'Branch',
          createElement('input', { name: 'branch', defaultValue: 'work-in-progress', required: true }),
        ),
      ),
    ),
  );
  assert.match(html, /<button[^>]*type="button"[^>]*aria-haspopup="dialog"/);
  const id = html.match(/<dialog id="([^"]+)"/)[1];
  assert.ok(html.includes(`aria-controls="${id}"`));
  assert.ok(html.includes(`aria-labelledby="${id}-title"`));
  assert.ok(html.includes(`id="${id}-title">Choose starting source`));
  const input = html.match(/<input[^>]+>/)[0];
  assert.match(input, /name="branch"/);
  assert.match(input, /required=""/);
  assert.match(input, /value="work-in-progress"/);
  assert.match(html, /type="button" aria-label="Close panel"/);
  assert.doesNotMatch(html, /<dialog[^>]* open[=> ]/);
});
