// SPDX-License-Identifier: Apache-2.0
// Account > Your data as words and outcomes (Item 17cdc774, review 8e86eb09): the sentence names what Forge holds,
// kind by kind, and says "at least" past the read bound; the deletion selects exactly the owned rows with their pins
// and carries the reviewed token; the typed confirmation is the handle; the archive keeps its documented format. A
// refused begin is `failed` with Forge's words; an unanswered one is `unknown` and asking again sends the SAME request
// (same operation id); a refused pass is driven again on retry; a pass with removals still running ends `waiting`
// with the marks the watch compares against. No timer anywhere.
import test from 'node:test';
import assert from 'node:assert/strict';
import { ConvexError } from 'convex/values';
import { moduleUrl } from './convex-module.mjs';

const m = await import(moduleUrl('../web/src/app/data/model.ts'));
const c = await import(moduleUrl('../web/src/app/data/cleanup.ts'));
const row = (id, label = id, note) => ({ id, pin: id.padEnd(64, '0'), label, ...(note ? { note } : {}) });
const none = () => Object.fromEntries(m.KINDS.map(kind => [kind, { rows: [], more: false }]));

test('the sentence lists what is held in kind order, with "at least" past the first page', () => {
  assert.equal(m.sentence(none()), 'Forge holds nothing of yours yet.');
  const held = none();
  held.project = { rows: [row('p1', 'forge')], more: false };
  assert.equal(m.sentence(held), 'Forge holds 1 project for you.');
  held.team = { rows: [row('t1'), row('t2')], more: false };
  held.view = { rows: Array.from({ length: 10 }, (_, i) => row(`v${i}`)), more: true };
  assert.equal(m.sentence(held), 'Forge holds 1 project, 2 teams and at least 10 saved views for you.');
  assert.equal(m.kindCount('import', held.import), 'None');
  assert.equal(m.kindCount('view', held.view), 'at least 10 saved views');
});

test('the deletion selects every owned row once, sorted, with its pin, and carries the reviewed token', () => {
  const owned = [
    { ...row('t1'), kind: 'team' },
    { ...row('p2', 'docs', 'trash'), kind: 'project' },
    { ...row('p1'), kind: 'project' },
  ];
  assert.deepEqual(
    m.selection(owned).map(r => `${r.kind}:${r.id}`),
    ['project:p1', 'project:p2', 'team:t1'],
  );
  const request = m.request('op', { owned, shared: [], incoming: 'token' });
  assert.deepEqual(request.leave, [...m.LEAVES]);
  assert.deepEqual(request.leave, [...m.LEAVES].sort(), 'leave kinds in the order the token is built');
  assert.equal(request.incoming, 'token');
  assert.equal(m.deleteWords(owned), 'Delete 3 items for good');
  assert.equal(m.deleteWords([owned[2]]), 'Delete 1 item for good');
  assert.equal(
    m.deleteWords([]),
    'Leave everything shared with you',
    'a person who owns nothing can still leave',
  );
  assert.equal(m.itemNote(owned[1]), 'in the trash');
  assert.equal(m.itemNote(owned[2]), null);
});

test('only the exact handle confirms; stages read as words', () => {
  assert.equal(m.confirmed(' Sample-Owner ', 'sample-owner'), true);
  assert.equal(m.confirmed('sample', 'sample-owner'), false);
  assert.equal(m.confirmed('', ''), false);
  assert.equal(m.stageWords('completed'), 'Done');
  assert.equal(m.stageWords('running'), 'Deleting');
});

test('the metadata archive keeps its format and never claims authority', () => {
  const item = { kind: 'team', id: 't1', pin: '0'.repeat(64), metadata: { id: 't1' } };
  const archive = JSON.parse(m.metadataArchive([item], [], '2026-11-17T12:00:00.000Z'));
  assert.equal(archive.kind, 'forge-account-metadata');
  assert.equal(archive.schemaVersion, 1);
  assert.deepEqual(archive.coverage, m.KINDS);
  assert.equal(archive.grantsAuthority, 'historical-only');
  assert.equal(archive.items.length, 1);
});

const request = { operationId: 'op-1', selection: [], leave: [...m.LEAVES], incoming: 'token' };
const refused = (code, message) => new ConvexError({ code, message });
function calls(script) {
  const sent = [];
  return {
    sent,
    begin: async r => {
      sent.push(['begin', r]);
      return script.begin(r);
    },
    advance: async (operationId, cursor) => {
      sent.push(['advance', operationId, cursor]);
      return script.advance(operationId, cursor);
    },
  };
}
const done = { stage: 'completed', cursor: null, isDone: true, waiting: [] };

test("a refused begin is failed with Forge's words; trying again sends the same request", async () => {
  let answer = () => {
    throw refused('AUTH_REQUIRED', 'Sign in again to continue.');
  };
  const api = calls({ begin: () => answer(), advance: async () => done });
  const first = await c.begin(api, request);
  assert.equal(first.run.status, 'failed');
  assert.equal(first.run.stale, false);
  assert.equal(m.runWords(first.run), 'Sign in again to continue.');
  answer = async () => ({ stage: 'ready' });
  const again = await c.retry(api, first.run, request);
  assert.equal(again.run.status, 'done');
  const begins = api.sent.filter(([kind]) => kind === 'begin').map(([, r]) => r);
  assert.equal(begins.length, 2);
  assert.equal(begins[0], begins[1], 'the same stored request, same operation id');
});

test('an unanswered begin is unknown; checking again reconciles the same operation', async () => {
  let lost = true;
  const api = calls({
    begin: async () => {
      if (lost) {
        lost = false;
        throw new Error('network gone');
      }
      return { stage: 'ready' };
    },
    advance: async () => done,
  });
  const first = await c.begin(api, request);
  assert.equal(first.run.status, 'unknown');
  assert.match(m.runWords(first.run), /may or may not have gone ahead/);
  const again = await c.retry(api, first.run, request);
  assert.equal(again.run.status, 'done');
  assert.deepEqual(
    api.sent.filter(([kind]) => kind === 'begin').map(([, r]) => r.operationId),
    ['op-1', 'op-1'],
  );
});

test('a review that no longer matches asks for a new review, not a retry', async () => {
  const api = calls({
    begin: async () => {
      throw refused(
        'ACCOUNT_CHANGED',
        'What is shared with you changed after your review. Review again; nothing was deleted.',
      );
    },
    advance: async () => done,
  });
  const { run } = await c.begin(api, request);
  assert.equal(run.status, 'failed');
  assert.equal(run.stale, true);
});

test('a refused pass is failed and is driven again on retry, not begun again', async () => {
  let fail = true;
  const api = calls({
    begin: async () => ({ stage: 'ready' }),
    advance: async () => {
      if (fail) {
        fail = false;
        throw refused('PROJECT_UNAVAILABLE', 'Only the owner person can permanently delete projects.');
      }
      return done;
    },
  });
  const first = await c.begin(api, request);
  assert.equal(first.run.status, 'failed');
  assert.equal(first.run.stage, 'ready');
  const again = await c.retry(api, first.run, request);
  assert.equal(again.run.status, 'done');
  assert.equal(api.sent.filter(([kind]) => kind === 'begin').length, 1);
});

test('a pass with removals still running ends waiting with their marks; the watch moves it on a changed mark', async () => {
  const api = calls({
    begin: async () => ({ stage: 'ready' }),
    advance: async (_op, cursor) =>
      cursor === null
        ? {
            stage: 'running',
            cursor: 'next',
            isDone: false,
            waiting: [{ kind: 'project', id: 'p1', mark: 'a' }],
          }
        : { stage: 'running', cursor: null, isDone: true, waiting: [{ kind: 'team', id: 't1', mark: 'b' }] },
  });
  const { run, waiting } = await c.begin(api, request);
  assert.equal(run.status, 'waiting');
  assert.deepEqual(
    waiting.map(w => w.id),
    ['p1', 't1'],
    'every page',
  );
  assert.equal(c.moved({ stage: 'running', marks: [{ mark: 'a' }, { mark: 'b' }] }, run, waiting), false);
  assert.equal(c.moved({ stage: 'running', marks: [{ mark: 'a' }, { mark: 'gone' }] }, run, waiting), true);
  assert.equal(c.moved({ stage: 'completed', marks: [{ mark: 'a' }, { mark: 'b' }] }, run, waiting), true);
  const many = calls({
    begin: async () => ({ stage: 'ready' }),
    advance: async () => ({
      stage: 'running',
      cursor: null,
      isDone: true,
      waiting: Array.from({ length: 70 }, (_, i) => ({ kind: 'team', id: `t${i}`, mark: 'x' })),
    }),
  });
  // Every waiting removal is kept: the page chains watches over them, WATCH_MAX at a time at most.
  assert.equal((await c.begin(many, request)).waiting.length, 70);
  // Completion never waits on background work (review s1-sol62 r4 #2), so a pass that ends unfinished with nothing
  // running elsewhere stopped: it offers Continue instead of a watch that would never move.
  const stopped = calls({
    begin: async () => ({ stage: 'ready' }),
    advance: async () => ({ stage: 'running', cursor: null, isDone: true, waiting: [] }),
  });
  const quiet = await c.begin(stopped, request);
  assert.equal(quiet.run.status, 'failed');
  assert.match(quiet.run.words, /Continue it/);
  // A deletion that kept items which changed after the review says so, and how many (review c4ece6f2 #1).
  const keeping = calls({
    begin: async () => ({ stage: 'ready' }),
    advance: async () => ({ stage: 'completed', cursor: null, isDone: true, waiting: [], kept: 2 }),
  });
  const kept = await c.begin(keeping, request);
  assert.equal(kept.run.status, 'done');
  assert.equal(
    m.runWords(kept.run),
    'Done. Forge kept 2 items that changed after your review; everything else selected is deleted.',
  );
  assert.equal(m.runWords({ ...kept.run, kept: 0 }), 'Done: everything selected is deleted.');
  assert.equal(m.receiptWords('completed', 1), 'Done; 1 item kept because it changed');
  assert.equal(m.receiptWords('completed', 0), 'Done');
  // An earlier deletion left preparing never deleted anything.
  assert.equal(m.receiptWords('preparing'), 'Not started; nothing was deleted');
  assert.equal(m.receiptWords('running'), m.stageWords('running'));
});
