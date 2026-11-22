// SPDX-License-Identifier: Apache-2.0
// Who did it (Item 41514fee): a row shows a person by handle, or an agent run with its declared model ("model not
// declared" when it declared none) and its person; each name leads to the person page or the run's page; a viewer
// who may not follow links (a public page, a row that is itself a link) gets the same words as text.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { moduleUrl } from './convex-module.mjs';

const { Who, whoParts, whoWords } = await import(moduleUrl('../web/src/ds/marks.tsx'));
const { whoLinks } = await import(moduleUrl('../web/src/app/who-links.ts'));
const text = html => html.replace(/<[^>]+>/g, '');
const project = { handle: 'sample-owner', project: 'sample-project' };

test('an agent run with a model reads run · model · for @person, and each name links to its page', () => {
  const html = renderToStaticMarkup(
    h(Who, {
      handle: 'sample-one/amber-fox',
      model: 'sample-model-1',
      layout: 'line',
      ...whoLinks('sample-one/amber-fox', project),
    }),
  );
  assert.equal(text(html), 'afagent run amber-foxsample-model-1for @sample-one');
  assert.match(html, /class="av ag"/, 'a run has the hollow mark');
  assert.match(html, /title="sample-one\/amber-fox · sample-model-1"/);
  assert.match(
    html,
    /href="\/sample-owner\/sample-project\/lanes\/sessions\/sample-one\/amber-fox"[^>]*>amber-fox</,
  );
  assert.match(html, /href="\/sample-one"[^>]*>@sample-one</);
});

test('an agent run that declared no model says so, and never guesses one', () => {
  const html = renderToStaticMarkup(h(Who, { handle: 'sample-two/copper-moth', model: '' }));
  assert.match(text(html), /copper-moth.*model not declared.*for @sample-two/);
  assert.equal(whoWords('sample-two/copper-moth', null), 'sample-two/copper-moth · model not declared');
  // An older record with no declaration field at all says nothing about a model.
  assert.doesNotMatch(renderToStaticMarkup(h(Who, { handle: 'sample-two/copper-moth' })), /model/);
});

test('a person shows the handle with the solid mark and no model', () => {
  const html = renderToStaticMarkup(h(Who, { handle: '@sample-one', ...whoLinks('@sample-one', project) }));
  assert.equal(text(html), 'so@sample-one');
  assert.match(html, /class="av"/);
  assert.doesNotMatch(html, /model|agent run/);
  assert.match(html, /href="\/sample-one"/);
});

test('a public viewer and a row that is itself a link get the same words as text, with no links', () => {
  const html = renderToStaticMarkup(h(Who, { handle: 'sample-one/amber-fox', model: 'sample-model-1' }));
  assert.doesNotMatch(html, /<a /);
  assert.match(text(html), /amber-fox.*sample-model-1.*for @sample-one/);
  // Without a project a run has no page to open; the person still has a public page.
  const links = whoLinks('sample-one/amber-fox');
  assert.equal(links.runHref, undefined);
  assert.equal(links.personHref, '/sample-one');
});

test('an owner stored as @handle/run is the run of @handle, never @@handle (Plan board mock check, d3357f40)', () => {
  assert.deepEqual(whoParts('@sample-one/amber-fox'), {
    agent: true,
    person: '@sample-one',
    run: 'amber-fox',
  });
  assert.deepEqual(whoParts('sample-one/amber-fox'), whoParts('@sample-one/amber-fox'));
  assert.equal(whoParts('@@sample-one').person, '@sample-one');
  const html = renderToStaticMarkup(h(Who, { handle: '@sample-one/amber-fox' }));
  assert.doesNotMatch(text(html), /@@/);
  assert.match(text(html), /for @sample-one$/);
});

test('the whole identity shows handle/run or @handle in full, with no model and no "for @person"', () => {
  const run = renderToStaticMarkup(
    h(Who, { handle: '@sample-one/amber-fox', model: 'sample-model-1', whole: true }),
  );
  assert.equal(text(run), 'afagent run sample-one/amber-fox');
  assert.match(run, /class="av ag"/);
  assert.match(run, /title="sample-one\/amber-fox · sample-model-1"/);
  const person = renderToStaticMarkup(h(Who, { handle: 'sample-one', whole: true }));
  assert.equal(text(person), 'so@sample-one');
  assert.doesNotMatch(person, /agent run/);
});
