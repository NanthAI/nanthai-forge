// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { getFunctionName } from 'convex/server';
import { moduleUrl, moduleSource } from './convex-module.mjs';
import { workSchema } from '../dist/work-types.js';
import { metadataRequest } from '../dist/work-metadata.js';
import { LONG_ACTION_BUDGET_MS, LONG_ACTION_DEADLINE_MS, longActionExpired } from '../dist/long-action.js';
const { replayReturnJournal } = await import(moduleUrl('../convex/projectSourceReturnJournal.ts'));
const { runPublication } = await import(moduleUrl('../convex/projectPublicationRun.ts'));

test('server scheduling window leaves three minutes below the client deadline', t => {
  let now = 100;
  t.mock.method(Date, 'now', () => now);
  assert.equal(LONG_ACTION_BUDGET_MS, 240000);
  assert.equal(LONG_ACTION_DEADLINE_MS, 420000);
  now += LONG_ACTION_BUDGET_MS - 1;
  assert.equal(longActionExpired(100), false);
  now++;
  assert.equal(longActionExpired(100), true);
});

test('journal replay yields after a whole event and resumes by saved revision without duplicates', async t => {
  let now = 1000;
  t.mock.method(Date, 'now', () => now);
  const data = workSchema.parse({
    schema: 15,
    revision: 0,
    nativeHead: 'a'.repeat(64),
    intents: [],
    lanes: [],
    views: [],
  });
  const intentId = randomUUID();
  data.intents.push({
    id: intentId,
    base: data.nativeHead,
    outcome: 'Synthetic',
    constraints: '',
    status: 'active',
    createdAt: 'now',
    notes: [],
  });
  const events = Array.from({ length: 8 }, (_, i) => {
    const command = { action: 'note', intentId, kind: 'comment', text: `event ${i}` };
    return {
      operationId: randomUUID(),
      request: metadataRequest(command),
      previousRevision: i,
      revision: i + 1,
      actor: 'owner',
      at: 'now',
      command: JSON.stringify(command),
    };
  });
  let snapshot = {
    data,
    backup: { digest: 'b'.repeat(64) },
    project: { _id: 'project', key: randomUUID(), work: { initialRevision: 0, revision: 8 } },
    events: [],
  };
  const starts = [];
  const ctx = {
    runQuery: async (_ref, args) => {
      starts.push(args.initialRevision);
      now += LONG_ACTION_BUDGET_MS + 1;
      return { page: events.filter(e => e.revision > args.initialRevision), isDone: true };
    },
  };
  for (let i = 0; i < 8; i++) {
    const done = await replayReturnJournal(ctx, snapshot, 'owner', now);
    assert.equal(done, i === 7);
    // Model the caller's durable cursor save/reload after every action.
    snapshot = structuredClone(snapshot);
    assert.equal(snapshot.data.revision, i + 1);
    assert.equal(snapshot.data.intents[0].notes.length, i + 1);
  }
  assert.deepEqual(starts, [0, 1, 2, 3, 4, 5, 6, 7]);
  assert.equal(new Set(snapshot.data.hostedEvents.map(e => e.id)).size, 8);
});

test('publication wait yields pending at its budget and never releases another worker claim', async t => {
  let now = 0,
    validations = 0,
    releases = 0;
  t.mock.method(Date, 'now', () => now);
  const ctx = {
    runMutation: async ref => {
      assert.equal(getFunctionName(ref), 'projectPublicationAttempt:claim');
      now += LONG_ACTION_BUDGET_MS;
      return { claimed: false, receipt: null };
    },
  };
  const result = await runPublication(
    ctx,
    { projectId: 'project', owner: 'owner', operationId: 'op', request: 'pin' },
    async () => {
      validations++;
      return 'receipt';
    },
  );
  assert.equal(result.pending, true);
  assert.equal(JSON.parse(result.progress).phase, 'publication-wait');
  assert.equal(validations, 0);
  ctx.runMutation = async ref => {
    if (getFunctionName(ref).endsWith(':release')) {
      releases++;
      return null;
    }
    return { claimed: false, receipt: 'receipt' };
  };
  assert.equal(
    await runPublication(
      ctx,
      { projectId: 'project', owner: 'owner', operationId: 'op', request: 'pin' },
      async () => {
        validations++;
        return 'wrong';
      },
    ),
    'receipt',
  );
  assert.equal(releases, 0);
  assert.equal(validations, 0);
});

test('index budget yields only after a committed batch and resumes the next batch', async t => {
  let now = 0,
    nextBatch = 0,
    ready = false;
  t.mock.method(Date, 'now', () => now);
  const source = moduleSource('../convex/projectWorkIndexActions.ts')
    .replace(
      /import \{ workProjection \} from '[^']+';/,
      'const workProjection = async () => ({ metadata: {}, batches: async function* () { for (let i=0; i<3; i++) yield [{key:String(i)}]; } });',
    )
    .replace(
      /import \{ caller, load \} from '[^']+';/,
      'const caller = async () => "owner"; const load = async () => ({backup:{_id:"backup"}, data:{revision:1}, project:{work:{initialRevision:0}}});',
    );
  const { ensure } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
  const committed = [];
  const ctx = {
    auth: { getUserIdentity: async () => ({ subject: 'owner' }) },
    runQuery: async () => (ready ? { _id: 'generation' } : null),
    runMutation: async (ref, args) => {
      const name = getFunctionName(ref);
      if (name.endsWith(':begin')) return { _id: 'generation', nextBatch, status: 'building' };
      if (name.endsWith(':batch')) {
        assert.equal(args.batch, nextBatch);
        committed.push(...args.entries);
        nextBatch++;
        now += LONG_ACTION_BUDGET_MS + 1;
        return true;
      }
      assert.equal(name, 'projectWorkIndexStore:publish');
      assert.equal(args.batches, 3);
      ready = true;
      return true;
    },
  };
  for (let i = 1; i <= 3; i++) {
    const result = await ensure._handler(ctx, { projectId: 'project', continuation: true });
    assert.equal(result.pending, true);
    assert.equal(JSON.parse(result.progress).done, i);
    assert.equal(committed.length, i);
  }
  assert.equal(await ensure._handler(ctx, { projectId: 'project', continuation: true }), 'generation');
  assert.deepEqual(
    committed.map(e => e.key),
    ['0', '1', '2'],
  );
});
