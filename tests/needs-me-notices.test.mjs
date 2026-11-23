// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// Item 12fde646: Needs you holds the shared-state decisions the rule keeps there. Work reverted from main (or still
// needing a fix) and a GitHub mirror that stopped on a conflict come from rows the read already holds, bounded, and
// count like any other decision; a mirror that only lags asks nobody, and only the owner is told about the mirror.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mirrorControlsFixture } from './github-mirror-controls-fixture.mjs';
import { mirrorFixture } from './hosted-github-mirror-fixture.mjs';
import { acceptMirrorReceipt as accept } from './github-mirror-catchup-fixture.mjs';
import { moduleUrl } from './convex-module.mjs';
const needs = await import(moduleUrl('../convex/projectNeedsMe.ts'));
const { needsCount } = await import(moduleUrl('../web/src/app/needs/count.ts'));
const { needsView, needsSentence, heldSentence } = await import(moduleUrl('../web/src/app/needs/model.ts'));

const fix = (state, summary) =>
  JSON.stringify({
    state,
    head: 'a'.repeat(64),
    previousHead: 'b'.repeat(64),
    failed: [],
    summary,
    undo: `nforge agent ROOT start '{"intentId":"x"}'`,
  });
/** A one-way mirror whose publish stopped because GitHub's main moved without Forge. */
function stopped() {
  const f = mirrorControlsFixture(false, 'synthetic/mirror'),
    github = mirrorFixture();
  const base = accept(f, github.root.state, github.root.state, 0);
  f.patch('projectGithubMirrors', f.mirrorId, {
    mapping: JSON.stringify({ ...github.root, acceptanceId: base.id }),
  });
  const receipt = accept(f, github.head, github.root.state, 1);
  const publish = f.insert('projectGithubMirrorJobs', {
    projectId: f.projectId,
    repository: 'synthetic/mirror',
    receiptId: receipt.id,
    sequence: 1,
    authorityEpoch: 1,
    state: github.head,
    status: 'failed',
    step: 2,
    cursor: null,
    error: 'GITHUB_SYNC_CHANGED',
    detail: 'GitHub main moved away from the retained Forge mirror mapping.',
  });
  f.patch('projectGithubMirrors', f.mirrorId, { activeId: publish });
  return f;
}
const read = (f, actor = 'owner') => f.call('needs', needs.read, { projectId: f.projectId }, actor);

test('work reverted from main and a stopped mirror are in Needs you, counted, and the mirror is the owner’s', async () => {
  const f = stopped();
  const ids = [randomUUID(), randomUUID()];
  f.patch('hostedProjects', f.projectId, {
    needsFix: {
      [ids[0]]: fix('reverted', 'Reverted receipt r1: a.test.mjs failed.'),
      [ids[1]]: fix('needs-fix', 'Fix needed for receipt r2.'),
    },
  });
  const mine = await read(f);
  assert.deepEqual(mine.notices.map(({ kind, id }) => [kind, id]).sort(), [
    ['mirror', 'mirror'],
    ['needs-fix', ids[1]],
    ['reverted', ids[0]],
  ]);
  assert.match(
    mine.notices.find(notice => notice.kind === 'mirror').summary,
    /GitHub’s main moved without Forge/,
  );
  const view = needsView(mine);
  assert.equal(view.notices.length, 3);
  assert.deepEqual(needsCount(mine), { n: 3, atLeast: false }, 'the shell count is the page count');
});

test('a mirror that only lags asks nobody, and notices are bounded with the rest counted', async () => {
  const f = mirrorControlsFixture(false, 'synthetic/mirror');
  const many = Object.fromEntries(
    Array.from({ length: 25 }, () => [randomUUID(), fix('reverted', 'Reverted.')]),
  );
  f.patch('hostedProjects', f.projectId, { needsFix: many });
  const reply = await read(f);
  assert.equal(reply.notices.length, 20, 'at most 20 are listed');
  assert.equal(reply.noticesMore, true);
  assert(
    reply.notices.every(notice => notice.kind === 'reverted'),
    'no mirror notice while the mirror is level',
  );
  assert.deepEqual(needsCount(reply), { n: 20, atLeast: true });
});

test('a reader of a public project who cannot write sees no notice (failing test names stay with the team)', async () => {
  const f = stopped();
  f.patch('hostedProjects', f.projectId, {
    visibility: 'public',
    needsFix: { [randomUUID()]: fix('reverted', 'Reverted receipt r1: a.test.mjs failed.') },
  });
  assert.equal((await read(f, 'owner')).notices.length, 2, 'the owner sees the revert and the mirror');
  const stranger = await read(f, 'stranger');
  assert.equal(stranger.notices, undefined);
  assert.equal(needsCount(stranger).n, 0);
});

test('more notices than the read lists make the Needs you count a lower bound, not the Held page’s Lane count', async () => {
  const f = mirrorControlsFixture(false, 'synthetic/mirror');
  f.patch('hostedProjects', f.projectId, {
    needsFix: Object.fromEntries(
      Array.from({ length: 21 }, () => [randomUUID(), fix('reverted', 'Reverted.')]),
    ),
  });
  const view = needsView(await read(f));
  assert.equal(view.countAtLeast, true);
  assert.match(needsSentence(view).bold, /^At least 20 things hold work/);
  assert.equal(heldSentence(view).bold, 'Nothing is held now.', 'the held-Lane read was complete');
});
