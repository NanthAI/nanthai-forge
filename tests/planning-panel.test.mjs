// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { moduleUrl } from './convex-module.mjs';
const { WorkPlanning } = await import(moduleUrl('../web/src/WorkPlanning.tsx'));
const item = {
  id: 'plan',
  operationId: 'save',
  kind: 'issue',
  title: 'Phone navigation',
  body: 'Keep context while browsing.',
  status: 'open',
  initiativeId: 'initiative',
  intentIds: ['intent'],
  version: 1,
  at: new Date().toISOString(),
};
const initiative = {
  ...item,
  id: 'initiative',
  kind: 'initiative',
  title: 'Clear navigation',
  initiativeId: undefined,
  intentIds: [],
};
function render(selected, linked) {
  const previous = globalThis.location;
  globalThis.location = new URL(`http://localhost/?planningItem=${selected}`);
  try {
    return renderToStaticMarkup(
      createElement(WorkPlanning, {
        data: {
          revision: 1,
          intents: linked ? [{ id: 'intent', outcome: 'Phone navigation', status: 'active' }] : [],
          planningItems: [initiative, { ...item, intentIds: linked ? ['intent'] : [] }],
          lanes: [],
          planningComments: [],
          hostedEvents: [],
        },
        busy: false,
        readOnly: true,
        act: async () => {},
      }),
    );
  } finally {
    if (previous === undefined) delete globalThis.location;
    else globalThis.location = previous;
  }
}
test('Planning selection uses a full page with breadcrumbs and no side panel', () => {
  const html = render('intent', true);
  assert.match(html, /aria-label="Breadcrumb"/);
  assert.match(html, /Keep context while browsing/);
  assert.match(html, />History<\/button>/);
  assert.doesNotMatch(html, /planning-detail|<aside|Open Intent|Edit item|Entry provenance/);
});
test('legacy unlinked Planning full pages retain readable details', () => {
  const html = render('plan', false);
  assert.match(html, /Keep context while browsing/);
  assert.match(html, /aria-label="Breadcrumb"/);
  assert.doesNotMatch(html, /Open Intent|Start work|Entry provenance|1 versions|<aside/);
});
