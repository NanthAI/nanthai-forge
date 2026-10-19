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
test('Planning Intent selection shows compact metadata and an existing Intent destination', () => {
  const html = render('intent', true);
  assert.match(html, /Open Intent →/);
  assert.match(html, /href="\/local\/project\/intents\/intent"/);
  assert.match(html, /updated just now/);
  assert.match(html, />History<\/button>/);
  assert.match(html, /data-selected="true"/);
  assert.doesNotMatch(html, /Entry provenance|Planning history|1 versions/);
});
test('legacy unlinked Planning details remain readable without inventing an Intent action', () => {
  const html = render('plan', false);
  assert.match(html, /Keep context while browsing/);
  assert.match(html, /Clear navigation/);
  assert.doesNotMatch(html, /Open Intent|Start work|Entry provenance|1 versions/);
});
