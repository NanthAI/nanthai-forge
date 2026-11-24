// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// The site Worker's PUBLIC_PAGES R2 binding (Item 8947a779): on dev every edge-cache miss still called Convex because
// the Worker had no binding to read the snapshot bucket through. The bucket's name stays out of the repo and comes in
// from the FORGE_PUBLIC_PAGES_BUCKET repository variable; a build without it must still work.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { siteWorkerEnv } from '../scripts/site-worker-env.mjs';

test('the variable set binds PUBLIC_PAGES to that bucket and leaves every other binding as before', () => {
  const env = siteWorkerEnv('synthetic-pages');
  assert.deepEqual(env.PUBLIC_PAGES, { type: 'r2', name: 'synthetic-pages' });
  const { PUBLIC_PAGES: _, ...rest } = env;
  assert.deepEqual(rest, siteWorkerEnv(undefined));
});

test('the variable unset or empty leaves the binding off, so the Worker keeps its Convex read', () => {
  for (const unset of [undefined, '', '  '])
    assert.equal('PUBLIC_PAGES' in siteWorkerEnv(unset), false, JSON.stringify(unset));
  assert.equal(siteWorkerEnv(undefined).ASSETS.type, 'assets');
});

test('a malformed bucket name stops the build without repeating it in the log', () => {
  for (const bad of ['Bad_Name', 'zq', '-edge', 'x'.repeat(64), 'has space', '../up']) {
    assert.throws(
      () => siteWorkerEnv(bad),
      error => error.message.includes('FORGE_PUBLIC_PAGES_BUCKET') && !error.message.includes(bad),
      bad,
    );
  }
});

test('the dev web deploy passes the repository variable to the site build, and nothing names a bucket', () => {
  const workflow = readFileSync(new URL('../.github/workflows/web-deploy.yml', import.meta.url), 'utf8');
  const step = workflow.split(/^ {6}- /m).find(text => text.startsWith('name: Build the site'));
  assert.match(step, /FORGE_PUBLIC_PAGES_BUCKET: \$\{\{ vars\.FORGE_PUBLIC_PAGES_BUCKET \}\}/);
  assert.doesNotMatch(workflow, /secrets\.FORGE_PUBLIC_PAGES_BUCKET/);
});
