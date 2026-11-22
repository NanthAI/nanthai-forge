// SPDX-License-Identifier: Apache-2.0
// Incident 67771ca6 (2026-11-22 15:27Z): the GitHub mirror stopped with GITHUB_SYNC_HASH. Receipt
// 893d4653 was a no-op landing (landed base = landed head = State 541ed345, already mirrored as
// GitHub 95fe4ed). It waited in the batch hold and ran as a staged burst member
// (main.publish:false) ahead of 827760ee. Its deterministic commit is the parent itself, but with
// no ref read the step still POSTed git/commits and GitHub returned a new commit, so the
// "GitHub commit differs from the deterministic mirror commit" invariant stopped the mirror.
import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareMirror, stepMirror } from '../dist/hosted-github-mirror.js';
import { digest } from '../dist/hash.js';
import { mirrorFixture } from './hosted-github-mirror-fixture.mjs';

async function drain(f, plan) {
  while (plan.phase !== 'done') plan = await stepMirror(structuredClone(plan), f.io);
  return plan;
}
/** A third State on the fixture (the follower landing 827760ee), stored like the fixture's own. */
function addState(f, files) {
  const value = {
    schema: 1,
    kind: 'forge-source-state',
    parents: [],
    message: 'source',
    at: '2026-01-01T00:00:00.000Z',
    files: Object.entries(files).map(([path, text]) => {
      const bytes = Buffer.from(text);
      const blob = digest(bytes);
      f.objects.set(blob, bytes);
      return { path, blob, mode: 'file' };
    }),
  };
  const head = digest(JSON.stringify(value));
  f.states.set(head, value);
  return head;
}
const commitPosts = f => f.calls.filter(call => call.method === 'POST' && call.path.endsWith('/git/commits'));

test('incident 67771ca6: a no-op landing staged in a burst publishes no commit and the burst tip lands', async () => {
  // GitHub main holds State S (the fixture root); the held no-op landing is S again.
  const f = mirrorFixture({ before: { 'stats.ts': 'v1' }, after: { 'stats.ts': 'v1' } });
  assert.equal(f.head, f.root.state, 'the no-op landing selects the mirrored State');
  const noop = await prepareMirror({ ...f.seed, previous: f.root.state, main: { publish: false } }, f.io);
  const staged = await drain(f, noop);
  assert.equal(commitPosts(f).length, 0, 'no commit is created for an unchanged State');
  assert.equal(staged.entry.commit, f.root.commit, 'the deterministic commit is the mirrored parent');
  assert.equal(staged.entry.parent, f.root.commit);
  assert.equal(f.remote(), f.root.commit, 'a staged member never moves main');
  // The follower (827760ee) is the burst tip on top of the staged no-op.
  const next = addState(f, { 'stats.ts': 'v1', 'trash.ts': 'new' });
  const tip = await drain(
    f,
    await prepareMirror(
      {
        ...f.seed,
        state: next,
        previous: f.root.state,
        message: `Settings trash\n\nForge-State: ${next}`,
        binding: staged.entry,
        main: { publish: true, expectedRef: f.root.commit },
      },
      f.io,
    ),
  );
  assert.equal(commitPosts(f).length, 1);
  assert.equal(f.remote(), tip.entry.commit, 'GitHub main reaches the burst tip');
  assert.equal(f.commits.get(tip.entry.commit).parent, f.root.commit);
});

test('incident 67771ca6: a no-op burst tip moves main to the staged commit without creating one', async () => {
  // [real landing S1 (staged C1), no-op S1 (tip, publish)]: the tip's commit is C1 itself.
  const f = mirrorFixture({ before: { a: 'old' }, after: { a: 'new' } });
  const staged = await drain(f, await prepareMirror({ ...f.seed, main: { publish: false } }, f.io));
  assert.equal(f.remote(), f.root.commit, 'the staged member leaves main at C0');
  const posts = commitPosts(f).length;
  const tip = await drain(
    f,
    await prepareMirror(
      {
        ...f.seed,
        previous: f.head,
        binding: staged.entry,
        main: { publish: true, expectedRef: f.root.commit },
      },
      f.io,
    ),
  );
  assert.equal(commitPosts(f).length, posts, 'the no-op tip creates no commit');
  assert.equal(tip.entry.commit, staged.entry.commit);
  assert.equal(f.remote(), staged.entry.commit, 'main fast-forwards to the staged commit');
  assert.equal(f.calls.filter(call => call.method === 'PATCH').length, 1);
});

test('incident 67771ca6: an unchanged Candidate branch points at main without creating a commit', async () => {
  const f = mirrorFixture({ before: { a: 'a' }, after: { a: 'a' } });
  const branch = 'forge/candidates/6f1c2d3e-4a5b-4c6d-8e7f-0a1b2c3d4e5f';
  const plan = await drain(f, await prepareMirror({ ...f.seed, branch }, f.io));
  assert.equal(commitPosts(f).length, 0);
  assert.equal(plan.entry.commit, f.root.commit);
  assert.equal(f.branches.get(branch), f.root.commit);
  assert.equal(f.remote(), f.root.commit, 'main is untouched');
});

test('incident 67771ca6: a commit hash mismatch names the expected and the returned commit', async () => {
  const f = mirrorFixture();
  const api = f.io.api;
  f.io.api = async (path, method, body) => {
    const result = await api(path, method, body);
    return method === 'POST' && path.endsWith('/git/commits') ? { sha: 'f'.repeat(40) } : result;
  };
  const plan = await prepareMirror(f.seed, f.io);
  await assert.rejects(drain(f, plan), error => {
    assert.equal(error.code, 'GITHUB_SYNC_HASH');
    assert.match(error.message, /expected [0-9a-f]{12}, GitHub returned ffffffffffff/);
    return true;
  });
});
