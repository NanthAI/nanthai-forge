// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// Item a08b0d3a, lead 2026-11-23 21:20Z: a burst tip moved GitHub main across a staged commit
// that changed .github/workflows/release-sign.yml, but its token was picked from the tip's own
// paths only, and GitHub answered 403 "Resource not accessible by integration" on PATCH git/refs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareMirror, stepMirror } from '../dist/hosted-github-mirror.js';
import { GithubMirrorApiError } from '../dist/hosted-github-api.js';
import { mirrorFixture } from './hosted-github-mirror-fixture.mjs';
import { moduleUrl } from './convex-module.mjs';
const tokens = await import(moduleUrl('../convex/githubAppToken.ts'));

const both = { contents: 'write', workflows: 'write' };
const workflow = '.github/workflows/sign.yml';
const workflowEntries = (f, commit) =>
  JSON.stringify(
    f.trees
      .get(f.commits.get(commit).tree)
      .filter(file => file.path.startsWith('.github/workflows/'))
      .map(file => [file.path, file.mode, file.sha])
      .sort(),
  );
/** GitHub's rule: without workflows write, a tree or ref move that changes a workflow path is 403. */
function gate(f) {
  const api = f.io.api;
  let granted = null;
  f.io.api = async (path, method = 'GET', body) => {
    if (!granted?.workflows) {
      const refused =
        (path.endsWith('/git/trees') &&
          body.tree.some(entry => entry.path.startsWith('.github/workflows'))) ||
        (path.endsWith('/git/refs/heads/main') &&
          method === 'PATCH' &&
          workflowEntries(f, f.remote()) !== workflowEntries(f, body.sha));
      if (refused)
        throw new GithubMirrorApiError(
          403,
          `${method} git/refs`,
          64,
          undefined,
          'Resource not accessible by integration',
        );
    }
    return api(path, method, body);
  };
  return async plan => {
    while (plan.phase !== 'done') {
      granted = tokens.mirrorPermissionsFor(plan);
      plan = await stepMirror(structuredClone(plan), f.io);
    }
    return plan;
  };
}
/** GitHub main at `before`; the staged State changes the workflow; the tip changes only hello.txt. */
async function burst(between) {
  const f = mirrorFixture({
    before: { 'hello.txt': 'old', [workflow]: 'on: push' },
    between,
    after: { ...between, 'hello.txt': 'new' },
  });
  const drain = gate(f);
  const staged = await drain(
    await prepareMirror(
      { ...f.seed, state: f.seed.previous, previous: f.root.state, main: { publish: false } },
      f.io,
    ),
  );
  assert.equal(f.remote(), f.root.commit, 'a staged member never moves main');
  return { f, drain, staged };
}

test('a burst tip asks for workflows when an earlier staged State changed one (403 replay)', async () => {
  const { f, drain, staged } = await burst({ 'hello.txt': 'old', [workflow]: 'on: workflow_dispatch' });
  const tipSeed = {
    ...f.seed,
    binding: staged.entry,
    main: { publish: true, expectedRef: f.root.commit, refState: f.root.state },
  };
  const tip = await prepareMirror(tipSeed, f.io);
  assert(
    ![...tip.changes, ...tip.pending].some(file => file.path === workflow),
    "the tip's own diff has no workflow",
  );
  assert.equal(tip.refWorkflows, true);
  assert.deepEqual(tokens.mirrorPermissionsFor(tip), both);
  // The old picker (tip paths only) is refused exactly like the live 21:20Z failure.
  await assert.rejects(drain({ ...structuredClone(tip), refWorkflows: false }), error => {
    assert.equal(error.status, 403);
    assert.match(error.githubError, /not accessible by integration/);
    return true;
  });
  const done = await drain(tip);
  assert.equal(f.remote(), done.entry.commit);
  assert.equal(done.entry.parent, staged.entry.commit);
});

test('a burst that changes no workflow keeps the contents-only token', async () => {
  const { f, drain, staged } = await burst({ 'hello.txt': 'middle', [workflow]: 'on: push' });
  const tip = await prepareMirror(
    {
      ...f.seed,
      binding: staged.entry,
      main: { publish: true, expectedRef: f.root.commit, refState: f.root.state },
    },
    f.io,
  );
  assert.equal(tip.refWorkflows, false);
  assert.deepEqual(tokens.mirrorPermissionsFor(tip), { contents: 'write' });
  const done = await drain(tip);
  assert.equal(f.remote(), done.entry.commit);
});

test('a burst tip with no known published State (older cursor) asks for workflows', async () => {
  const { f, drain, staged } = await burst({ 'hello.txt': 'old', [workflow]: 'on: workflow_dispatch' });
  const tip = await prepareMirror(
    { ...f.seed, binding: staged.entry, main: { publish: true, expectedRef: f.root.commit } },
    f.io,
  );
  assert.equal(tip.refWorkflows, undefined);
  assert.deepEqual(tokens.mirrorPermissionsFor(tip), both);
  const done = await drain(tip);
  assert.equal(f.remote(), done.entry.commit);
});

test('a workflow changed and restored inside one burst still gets workflows from the staged flag', async () => {
  // Staged A edits the workflow, staged B restores it, the tip changes hello.txt: the net move has
  // no workflow change, but each pushed commit is checked, so the flag from A's commit decides.
  const f = mirrorFixture({
    before: { 'hello.txt': 'old', [workflow]: 'on: push' },
    between: { 'hello.txt': 'mid', [workflow]: 'on: push' },
    after: { 'hello.txt': 'new', [workflow]: 'on: push' },
  });
  const tip = await prepareMirror(
    {
      ...f.seed,
      main: { publish: true, expectedRef: 'a'.repeat(40), refState: f.seed.previous, workflows: true },
    },
    f.io,
  );
  assert.equal(tip.refWorkflows, false);
  assert.deepEqual(tokens.mirrorPermissionsFor(tip), both);
  assert.deepEqual(
    tokens.mirrorPermissionsFor({
      ...tip,
      seed: { ...tip.seed, main: { ...tip.seed.main, workflows: undefined } },
    }),
    { contents: 'write' },
  );
});

test('an unreadable published State leaves the move unknown, so the tip asks for workflows', async () => {
  const f = mirrorFixture();
  const tip = await prepareMirror(
    { ...f.seed, main: { publish: true, expectedRef: 'a'.repeat(40), refState: 'f'.repeat(64) } },
    f.io,
  );
  assert.equal(tip.refWorkflows, undefined);
  assert.deepEqual(tokens.mirrorPermissionsFor(tip), both);
});

test('the token module stays free of the Node mirror engine', async () => {
  const { readFileSync } = await import('node:fs');
  const source = readFileSync(new URL('../convex/githubAppToken.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /^import (?!type )[^;]*hosted-github-mirror'/m);
});

test('a single job and a staged member read no extra State and ask only for contents', async () => {
  const f = mirrorFixture();
  const plan = await prepareMirror(
    { ...f.seed, main: { publish: true, expectedRef: f.root.commit, refState: f.root.state } },
    f.io,
  );
  assert.deepEqual(f.windows.at(-1), { states: 2 }, 'refState equal to the binding adds no State read');
  assert.equal(plan.refWorkflows, undefined);
  assert.deepEqual(tokens.mirrorPermissionsFor(plan), { contents: 'write' });
  const staged = await prepareMirror({ ...f.seed, main: { publish: false, refState: 'x'.repeat(64) } }, f.io);
  assert.deepEqual(f.windows.at(-1), { states: 2 });
  assert.deepEqual(tokens.mirrorPermissionsFor(staged), { contents: 'write' });
});
