// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fixture } from './landing-batch-fixture.mjs';
import { enqueueLanding, composeBatch } from '../dist/landing-batch-store.js';
import { evaluateBatch } from '../dist/landing-batch-check.js';
import { queuedOutcome } from '../dist/landing-submission.js';
import { readSemanticConflicts, semanticCompositionPlan } from '../dist/native-semantic-plan.js';
import { NativeSource } from '../dist/native-source.js';
const at = '2026-01-01T00:00:00.000Z';
const contract = view => ({
  version: 1,
  operationId: randomUUID(),
  request: 'a'.repeat(64),
  candidateId: view.id,
  measuredOn: view.head,
  runId: randomUUID(),
  at,
  proposedTests: ['tests/prove.test.mjs'],
  tests: [{ path: 'tests/prove.test.mjs', durationMs: 1 }],
  totalMs: 1,
});

test('native batch checks the union once and publishes a named conflict with the original clean source', async t => {
  const f = await fixture(t, { remote: false, delay: 0, failWhen: 'false' });
  async function candidate(path) {
    const result = await f.candidate(path, 'changed\n', false);
    mkdirSync(join(result.lane.path, 'tests'));
    writeFileSync(
      join(result.lane.path, 'tests/prove.test.mjs'),
      `import test from 'node:test';import assert from 'node:assert/strict';import {existsSync} from 'node:fs';test('pair contract',()=>assert.ok(!(existsSync('own.txt')&&existsSync('peer.txt'))));`,
    );
    const checkpoint = (
      await f.agent.dispatch({
        action: 'checkpoint',
        laneId: result.lane.laneId,
        message: 'Synthetic proving test',
      })
    ).result;
    const composed = (
      await f.agent.dispatch({
        action: 'compose',
        operationId: randomUUID(),
        laneId: result.lane.laneId,
        intentId: result.lane.intentId,
        inputs: [{ laneId: result.lane.laneId, head: checkpoint.head }],
        dependencies: [],
      })
    ).result;
    const view = f.store.select('views', composed.viewId);
    result.view = view;
    result.command.expectedHead = view.head;
    await f.store.locked(() => {
      const data = f.store.load();
      data.intents.find(i => i.id === view.intentId).testContracts = [contract(view)];
      data.revision++;
      f.store.save(data);
    });
    await enqueueLanding(f.work, result.command, view);
    return result;
  }
  const a = await candidate('own.txt'),
    b = await candidate('peer.txt');
  const source = new NativeSource(f.root),
    base = a.view.base;
  const batch = {
    id: randomUUID(),
    channel: 'main',
    base,
    previous: null,
    arrivedAt: at,
    entryIds: [a.command.operationId, b.command.operationId],
    mode: 'halving',
    status: 'composing',
    prefixes: [],
    conflicts: [],
  };
  await f.store.locked(() => {
    const data = f.store.load();
    data.landingBatches = [batch];
    for (const e of data.landingEntries) {
      e.status = 'checking';
      e.batchId = batch.id;
    }
    data.revision++;
    f.store.save(data);
  });
  await composeBatch(f.work, batch);
  const composed = f.store.select('landingBatches', batch.id),
    full = composed.prefixes.at(-1);
  assert.equal(composed.prefixes.length, 2);
  assert.equal(f.store.select('views', full.viewId).status, 'clean');
  assert.equal(f.store.select('views', full.viewId).semanticPlan.members.length, 2);
  await evaluateBatch(f.work, composed, { generation: 0, beforePublish() {} }, 10000);
  const entry = f.store.select('landingEntries', b.command.operationId);
  assert.equal(entry.status, 'conflict');
  assert.equal(entry.error.code, 'INTENT_SEMANTIC_CONFLICT');
  assert.equal(
    f.store.select('views', full.viewId).status,
    'clean',
    'source and semantic conflict remain distinct',
  );
  assert.equal(entry.semanticConflicts[0].head, full.head);
  assert.equal(readSemanticConflicts(f.store, full.viewId).length, 1);
  assert.equal(queuedOutcome(f.store, entry).semanticConflicts.length, 1);
  assert.match(queuedOutcome(f.store, entry).message, /Intent semantic conflict/);
  const count = f.store.load().runs.length;
  await evaluateBatch(
    f.work,
    f.store.select('landingBatches', batch.id),
    { generation: 0, beforePublish() {} },
    10000,
  );
  assert.equal(f.store.load().runs.length, count, 'recovery observes the existing check');
  assert(source.state(full.head).files.some(file => file.path === 'tests/prove.test.mjs'));
});

test('accepted peer discovery pages 575 landings without loading Work or unrelated Intents', async t => {
  const f = await fixture(t, { remote: false, delay: 0, failWhen: 'false' });
  const own = await f.candidate('own.txt', 'own\n', false),
    peer = await f.candidate('peer.txt', 'peer\n', false);
  await f.store.locked(() => {
    const data = f.store.load();
    for (const view of [own.view, peer.view])
      data.intents.find(i => i.id === view.intentId).testContracts = [contract(view)];
    data.revision++;
    f.store.save(data);
  });
  let pages = 0,
    selected = 0;
  const moves = Array.from({ length: 575 }, () => ({
    status: 'accepted',
    head: peer.view.head,
    viewId: peer.view.id,
  }));
  const plan = semanticCompositionPlan(
    {
      native: true,
      root: f.root,
      page: (_collection, offset, limit) => {
        pages++;
        return {
          records: moves.slice(offset, offset + limit),
          nextOffset: offset + limit < moves.length ? offset + limit : null,
        };
      },
      select: (collection, id) => {
        selected++;
        return f.store.select(collection, id);
      },
      load: () => assert.fail('no full Work load'),
    },
    own.view,
    peer.view.head,
  );
  assert.equal(pages, 6);
  assert.equal(plan.members.length, 2);
  // Repeated accepted pins share selected metadata in the source owner.
  assert(selected <= 10);
  t.diagnostic(JSON.stringify({ landings: 575, pages, selectedMetadataReads: selected, convexCalls: 0 }));
});
