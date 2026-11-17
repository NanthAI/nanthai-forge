// SPDX-License-Identifier: Apache-2.0
// Reactions on planning comments (Item 9a3d6f5f): only the project's planning writers react, a retried toggle never
// flips twice, and a read returns counts and the viewer's own marks, never who else reacted.
import test from 'node:test';
import assert from 'node:assert/strict';
import { moduleUrl } from './convex-module.mjs';
import { projectRow, state } from './hosted-fixture.mjs';

const reactions = await import(moduleUrl('../convex/planningReactions.ts'));
const item = '00000000-0000-4000-8000-000000000001',
  comment = '00000000-0000-4000-8000-000000000002';
const denied = error => (error.data?.code ?? error.code) === 'PROJECT_UNAVAILABLE';
function fixture(subject = 'owner') {
  const s = state([]);
  s.tables.hostedProjects.set('project', projectRow({ _id: 'project', name: 'synthetic', revision: 1 }));
  s.ctx.auth.getUserIdentity = async () => (subject ? { subject } : null);
  return s;
}
const toggle = (s, on, kind = '+1') =>
  reactions.toggle._handler(s.ctx, { projectId: 'project', itemId: item, commentId: comment, kind, on });
const read = s => reactions.forItem._handler(s.ctx, { projectId: 'project', itemId: item });

test('a writer’s reaction toggles once per state asked for, and the read shows counts with the viewer’s own', async () => {
  const s = fixture();
  assert.deepEqual(await toggle(s, true), { on: true });
  assert.deepEqual(await toggle(s, true), { on: true }, 'a retried add keeps one reaction');
  await toggle(s, true, 'rocket');
  const seen = await read(s);
  assert.equal(seen.complete, true);
  assert.deepEqual(
    seen.counts.sort((a, b) => a.kind.localeCompare(b.kind)),
    [
      { commentId: comment, kind: '+1', count: 1, mine: true },
      { commentId: comment, kind: 'rocket', count: 1, mine: true },
    ],
  );
  assert.ok(
    seen.counts.every(entry => !('actor' in entry)),
    'no reader learns who reacted',
  );
  await toggle(s, false);
  await toggle(s, false);
  assert.deepEqual(
    (await read(s)).counts.map(entry => entry.kind),
    ['rocket'],
  );
});

test('people without planning write access cannot react, and a signed-out read is refused', async () => {
  const stranger = fixture('stranger');
  await assert.rejects(toggle(stranger, true), denied);
  await assert.rejects(read(stranger), denied);
  await assert.rejects(read(fixture(null)), denied);
  const s = fixture();
  await assert.rejects(
    reactions.toggle._handler(s.ctx, {
      projectId: 'project',
      itemId: 'x',
      commentId: comment,
      kind: '+1',
      on: true,
    }),
    error => (error.data?.code ?? error.code) === 'BAD_ARGUMENT',
  );
});
