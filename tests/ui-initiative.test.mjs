// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import test from 'node:test';
import assert from 'node:assert/strict';

const { destination, options } = await import('../scripts/ui-shots/options.mjs');
const at = '2026-10-01T10:00:00Z';
const item = (id, extra = {}) => ({
  id,
  operationId: id,
  kind: 'initiative',
  title: id,
  body: 'Details',
  status: 'open',
  version: 1,
  at,
  intentIds: [],
  ...extra,
});
const initiative = item('initiative', { intentIds: ['planned', 'ready', 'done', 'working'] });

test('screenshot tooling accepts Initiative routes without changing the selected project', () => {
  assert.deepEqual(
    options(['--base', 'http://localhost:5179', '--out', '/tmp/ui', '--pages', 'initiative:abc']).pages,
    ['initiative:abc'],
  );
  const url = new URL(destination('http://localhost:5179', 'project', 'initiative:abc'));
  assert.equal(url.searchParams.get('projectTab'), 'planning');
  assert.equal(url.searchParams.get('planningItem'), 'abc');
  assert.equal(url.searchParams.get('planningRoute'), 'initiative:abc');
  assert.equal(url.searchParams.get('project'), 'project');
});

test('hosted screenshot readiness requires the real Initiative component, not the temporary Planning fallback', async () => {
  const { waitForPage } = await import('../scripts/ui-shots/browser.mjs');
  const { runInNewContext } = await import('node:vm');
  for (const mounted of [true, false]) {
    const heading = { textContent: 'Synthetic Initiative', getClientRects: () => [{}], closest: () => null };
    const main = {
      querySelectorAll: selector => (selector === '[role="alert"]' ? [] : [heading]),
      querySelector: () => mounted,
    };
    let result;
    await waitForPage(
      {
        waitForFunction(fn) {
          result = runInNewContext(`(${fn})('initiative')`, {
            document: { querySelector: () => main },
            window: { Clerk: { user: {} } },
            getComputedStyle: () => ({ visibility: 'visible' }),
          });
        },
        evaluate: async () => {},
      },
      'initiative',
    );
    assert.equal(result, mounted);
  }
});
