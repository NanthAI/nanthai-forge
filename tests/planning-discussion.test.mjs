// SPDX-License-Identifier: Apache-2.0
// Discussion records (Item 9a3d6f5f): threads, decisions written into the Item body, the writing agent's slug and the
// server-observed author on comments.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { WorkService } from '../dist/work.js';
import { bodyWithDecision, decisionActor } from '../dist/work-planning-put.js';
import { stampPlanningAuthor } from '../dist/work-planning-state.js';
import { fixture, git } from './helpers.mjs';

function setup(t) {
  const root = fixture(t, { 'a.ts': 'export const a = 1;\n' });
  git(root, ['add', '.']);
  git(root, ['commit', '-qm', 'Baseline']);
  const work = new WorkService(root);
  const run = async command => (await work.dispatch(command, work.status().revision)).result;
  const put = patch =>
    run({
      action: 'put-planning-item',
      operationId: randomUUID(),
      itemId: randomUUID(),
      kind: 'issue',
      title: 'Synthetic Item',
      body: 'Intro.\n\n## Decisions\n- 2026-11-01 @mara: first\n\n## Notes\nkeep',
      ...patch,
    });
  const comment = (itemId, patch = {}) =>
    run({ action: 'comment-planning-item', operationId: randomUUID(), itemId, text: 'Said.', ...patch });
  return { work, run, put, comment };
}

test('a reply joins its thread root and must answer a comment on the same Item', async t => {
  const { put, comment } = setup(t);
  const item = await put({}),
    other = await put({});
  const root = await comment(item.id);
  const reply = await comment(item.id, { replyTo: root.id });
  const nested = await comment(item.id, { replyTo: reply.id });
  assert.equal(reply.replyTo, root.id);
  assert.equal(nested.replyTo, root.id, 'a reply to a reply stays in one thread');
  assert.equal(root.replyTo, undefined);
  await assert.rejects(comment(other.id, { replyTo: root.id }), error => error.code === 'NOT_FOUND');
  await assert.rejects(comment(item.id, { replyTo: randomUUID() }), error => error.code === 'NOT_FOUND');
});

test('a decision comment writes one dated line into the body Decisions section in the same write, once', async t => {
  const { work, run, put, comment } = setup(t);
  const item = await put({});
  const command = {
    action: 'comment-planning-item',
    operationId: randomUUID(),
    itemId: item.id,
    authorLabel: 'mara',
    text: 'v3 drops Node 18.\n\nLonger reasoning stays in the comment.',
    decision: true,
  };
  const written = await run(command);
  assert.equal(written.decision, true);
  const versions = () => work.store.load().planningItems.filter(entry => entry.id === item.id);
  const latest = versions().at(-1);
  assert.equal(latest.version, 2);
  const day = written.at.slice(0, 10);
  assert.equal(
    latest.body,
    `Intro.\n\n## Decisions\n- 2026-11-01 @mara: first\n- ${day} @mara: v3 drops Node 18. (comment ${written.id.slice(0, 8)})\n\n## Notes\nkeep\n`,
  );
  assert.equal(latest.title, 'Synthetic Item', 'the decision keeps every other field');
  assert.deepEqual(await run(command), written, 'a retry returns the original comment');
  assert.equal(versions().length, 2, 'a retry adds no second body version');
  // A body edited since keeps its text: the next decision appends to the latest version.
  await run({
    action: 'put-planning-item',
    operationId: randomUUID(),
    itemId: item.id,
    expectedVersion: 2,
    body: `${latest.body}Concurrent edit.\n`,
  });
  await comment(item.id, { decision: true, authorLabel: 'Ada Lovelace', text: 'Second.' });
  const body = versions().at(-1).body;
  assert.match(body, /Concurrent edit\./);
  assert.match(
    body,
    new RegExp(`- ${day}: Second\\. \\(comment [0-9a-f]{8}\\)`),
    'a display name is never written',
  );
  assert.doesNotMatch(body, /Ada/);
});

test('decision lines: a new section at the end, public labels only, long text cut', () => {
  const at = '2026-11-17T10:00:00.000Z',
    commentId = '1a2b3c4d-0000-4000-8000-000000000000';
  assert.equal(
    bodyWithDecision('', { at, label: '', text: 'Ship it.', commentId }),
    '## Decisions\n- 2026-11-17: Ship it. (comment 1a2b3c4d)\n',
  );
  assert.equal(
    bodyWithDecision('Body', { at, label: 'mara/keen-impala', text: 'Yes', commentId }),
    'Body\n\n## Decisions\n- 2026-11-17 mara/keen-impala: Yes (comment 1a2b3c4d)\n',
  );
  assert.equal(decisionActor('@Mara'), '@mara');
  for (const label of ['Ada Lovelace', 'host.local', 'a@b.c', 'x/notaslug!'])
    assert.equal(decisionActor(label), '');
  const long = bodyWithDecision('', { at, label: '', text: 'x'.repeat(900), commentId });
  assert.ok(long.length < 560);
});

test('only fixed-list agent slugs are kept on a comment', async t => {
  const { put, comment } = setup(t);
  const item = await put({});
  assert.equal((await comment(item.id, { agent: 'keen-impala' })).agent, 'keen-impala');
  assert.equal((await comment(item.id, { agent: 'dinos-macbook' })).agent, undefined);
});

test('hosted replay stamps the server-observed actor on a new comment and its decision version', () => {
  const data = { planningItems: [{ id: 'i', version: 1 }], planningComments: [] };
  const command = {
    action: 'comment-planning-item',
    operationId: 'c',
    itemId: 'i',
    text: 't',
    authorLabel: '',
  };
  data.planningComments.push({ id: 'c' });
  data.planningItems.push({ id: 'i', version: 2 });
  stampPlanningAuthor(data, 1, command, 'account-1', 0);
  assert.equal(data.planningComments[0].author, 'account-1');
  assert.equal(data.planningItems[1].author, 'account-1');
});
