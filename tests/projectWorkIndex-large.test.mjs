// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { getFunctionName } from 'convex/server';
import { moduleUrl } from './convex-module.mjs';
import { fixture, modules, upload } from './project-exchange-fixture.mjs';
import { initNative } from '../dist/native-work.js';
import { WorkStore } from '../dist/work-store.js';
import { WorkService } from '../dist/work.js';
import { seedHostedProject } from '../dist/hosted-seed.js';
import { continueLongAction } from '../dist/long-action.js';
import { workCliSummary } from '../dist/work-cli-summary.js';
for (const name of ['projectHostedSeed', 'projectHostedSeedActions'])
  modules[name] = await import(moduleUrl(`../convex/${name}.ts`));
const actions = await import(moduleUrl('../convex/projectWorkIndexActions.ts'));
const index = await import(moduleUrl('../convex/projectWorkIndex.ts'));
const indexStore = await import(moduleUrl('../convex/projectWorkIndexStore.ts'));

async function setup(t, size = 3 * 1024 * 1024, changed = false) {
  const root = mkdtempSync('/tmp/forge-index-large-');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, 'a.ts'), 'export const value = 1;\n');
  initNative(root);
  const store = new WorkStore(root),
    service = new WorkService(root);
  const intent = service.execute(
    { action: 'intent', outcome: 'Large synthetic Work' },
    store.revision(),
  ).result;
  let lane = service.execute(
    { action: 'lane', intentId: intent.id, name: 'Synthetic Lane' },
    store.revision(),
  ).result;
  if (changed) {
    writeFileSync(join(store.path(lane.id), 'a.ts'), 'export const value = 2;\n');
    const selected = service.status().lanes.find(row => row.id === lane.id);
    service.execute(
      {
        action: 'checkpoint',
        laneId: lane.id,
        expectedHead: selected.actualHead,
        expectedTree: selected.indexTree,
        message: 'Change source',
      },
      store.revision(),
    );
    lane = store.load().lanes.find(row => row.id === lane.id);
  }
  const prior = service.execute(
    {
      action: 'compose',
      operationId: randomUUID(),
      intentId: intent.id,
      inputs: [{ laneId: lane.id, head: lane.head }],
    },
    store.revision(),
  ).result;
  const view = service.execute(
    {
      action: 'compose',
      operationId: randomUUID(),
      intentId: intent.id,
      inputs: [{ laneId: lane.id, head: lane.head }],
      dependencies: [{ kind: 'view', viewId: prior.id, head: prior.head }],
    },
    store.revision(),
  ).result;
  const data = store.load();
  data.channelMoves.push({
    id: randomUUID(),
    channel: 'main',
    viewId: prior.id,
    head: prior.head,
    previous: data.nativeHead,
    at: 'now',
    status: 'accepted',
    provenance: 'user-declared-local',
  });
  const count = Math.ceil(size / 3900);
  for (let i = 0; i < count; i++)
    data.intents.push({
      ...data.intents[0],
      id: randomUUID(),
      outcome: `Synthetic ${i}`,
      constraints: 'x'.repeat(3900),
      notes: [],
    });
  data.revision++;
  store.save(data);
  const s = fixture();
  for (const table of ['projectHostedSeeds', 'projectHostedSeedPages', 'projectHostedChannels'])
    s.tables[table] = new Map();
  const client = {
    mutation: (ref, args) => s.ctx.runMutation(ref, args),
    action: (ref, args) => s.ctx.runAction(ref, args),
  };
  const exchange = {
    missing: async pins => pins.map(p => p.sha256),
    upload: (pin, bytes) => upload(s, bytes),
    publish: () => assert.fail('not an exchange publication'),
  };
  const input = { projectId: 'project', operationId: randomUUID(), revision: store.revision() };
  const seeded = await seedHostedProject(store, input, client, exchange);
  await modules.projectWorkActions.initialize._handler(s.ctx, {
    projectId: 'project',
    backupId: seeded.backupId,
    operationId: randomUUID(),
  });
  return { root, store, service, intent, lane, view, data, s, seeded };
}

test('large record index resumes after a committed step loses its reply without loading complete Work', async t => {
  const f = await setup(t);
  const original = f.s.ctx.runMutation;
  let interrupted = false,
    steps = 0,
    maxBytes = 0;
  f.s.ctx.runMutation = async (ref, args) => {
    const name = getFunctionName(ref);
    if (name === 'projectWorkIndexBuildStore:step') {
      steps++;
      maxBytes = Math.max(maxBytes, Buffer.byteLength(JSON.stringify(args)));
    }
    const result = await original(ref, args);
    if (name === 'projectWorkIndexBuildStore:step' && steps === 3 && !interrupted) {
      interrupted = true;
      throw new Error('lost committed index reply');
    }
    return result;
  };
  const query = f.s.ctx.runQuery;
  f.s.ctx.runQuery = (ref, args) => {
    if (getFunctionName(ref) === 'projectWork:events')
      assert.equal(args.paginationOpts.numItems, 50, 'journal replay reads one bounded ordered page');
    return query(ref, args);
  };
  await assert.rejects(actions.ensure._handler(f.s.ctx, { projectId: 'project' }));
  const stage = [...f.s.tables.projectWorkGenerations.values()][0];
  const savedStep = stage.nextBatch;
  assert(savedStep >= 3);
  await assert.rejects(
    indexStore.publish._handler(f.s.ctx, {
      projectId: 'project',
      owner: 'owner',
      generationId: stage._id,
      batches: savedStep,
    }),
    e => e.code === 'INVALID_WORK_JOURNAL',
  );
  let calls = 0;
  const start = performance.now();
  const id = await continueLongAction('Synthetic index', randomUUID(), async continuation => {
    calls++;
    return actions.ensure._handler(f.s.ctx, { projectId: 'project', continuation });
  });
  const workspace = JSON.parse(await index.workspace._handler(f.s.ctx, { projectId: 'project' }));
  assert.equal(id, stage._id);
  assert.equal(workspace.revision, f.data.revision);
  assert.equal(workspace.counts.intents, f.data.intents.length);
  assert.equal(workspace.sourceHead, f.data.nativeHead);
  assert.equal(workspace.counts.views, 2);
  assert.equal(workspace.counts.viewDetails, 2);
  const detail = JSON.parse(
    (await index.detail._handler(f.s.ctx, { projectId: 'project', collection: 'viewDetails', id: f.view.id }))
      .value,
  );
  assert.equal(detail.viewId, f.view.id);
  assert.equal(
    detail.status,
    'ready',
    'an older family dependency cannot supersede the selected latest View',
  );
  const laneDetail = JSON.parse(
    (await index.detail._handler(f.s.ctx, { projectId: 'project', collection: 'lanes', id: f.lane.id }))
      .value,
  );
  assert.equal(laneDetail.main.included, true);
  assert.equal(detail.provenanceAvailable, true);
  assert.equal(detail.inputs[0].laneId, f.lane.id);
  assert.equal(
    [...f.s.tables.projectWorkRecords.values()].filter(r => r.collection.startsWith('_build')).length,
    0,
  );
  assert(maxBytes < 600000, `RPC page was ${maxBytes} bytes`);
  const before = steps;
  assert.equal(await actions.ensure._handler(f.s.ctx, { projectId: 'project' }), id);
  assert.equal(steps, before, 'ready retry performs no rebuild writes');
  f.s.caller('stranger');
  await assert.rejects(
    actions.ensure._handler(f.s.ctx, { projectId: 'project' }),
    e => e.data?.code === 'PROJECT_UNAVAILABLE',
  );
  f.s.caller('owner');
  t.diagnostic(
    JSON.stringify({
      bytes: Buffer.byteLength(JSON.stringify(f.data)),
      calls,
      steps,
      maxRpcBytes: maxBytes,
      elapsedMs: performance.now() - start,
      maxRssKiB: process.resourceUsage().maxRSS,
    }),
  );
});

test('plain Work summary reads counts without hydrating histories or review projections', async t => {
  const f = await setup(t, 64 * 1024);
  const load = WorkStore.prototype.load;
  WorkStore.prototype.load = () => assert.fail('record summary must not hydrate Work');
  try {
    const summary = workCliSummary(f.root);
    assert.equal(summary.revision, f.data.revision);
    assert.equal(summary.head, f.data.nativeHead);
    assert.equal(summary.counts.intents, f.data.intents.length);
    assert(Buffer.byteLength(JSON.stringify(summary)) < 4096);
    const pointer = WorkStore.prototype.pointer;
    WorkStore.prototype.pointer = function () {
      const raw = JSON.parse(pointer.call(this));
      raw.fields.nativeHead = { unexpected: 'x'.repeat(100000) };
      return Buffer.from(JSON.stringify(raw));
    };
    try {
      assert.throws(() => workCliSummary(f.root), { code: 'INVALID_WORK_STORE' });
    } finally {
      WorkStore.prototype.pointer = pointer;
    }
  } finally {
    WorkStore.prototype.load = load;
  }
});

test('record rebuild replays journal events with original identities and timestamps after a cold index invalidation', async t => {
  const f = await setup(t);
  const ensure = () =>
    continueLongAction('Synthetic index', randomUUID(), continuation =>
      actions.ensure._handler(f.s.ctx, { projectId: 'project', continuation }),
    );
  const first = await ensure();
  const operationId = randomUUID();
  const original = await modules.projectWorkActions.command._handler(f.s.ctx, {
    projectId: 'project',
    operationId,
    revision: f.data.revision,
    command: JSON.stringify({
      action: 'note',
      intentId: f.intent.id,
      kind: 'comment',
      text: 'Journal after checkpoint',
    }),
  });
  f.s.tables.projectWorkGenerations.get(first).format = 3;
  const second = await ensure();
  assert.notEqual(first, second);
  const workspace = JSON.parse(await index.workspace._handler(f.s.ctx, { projectId: 'project' }));
  assert.equal(workspace.revision, f.data.revision + 1);
  assert.equal(workspace.counts.notes, 1);
  const event = JSON.parse(
    (await index.detail._handler(f.s.ctx, { projectId: 'project', collection: 'events', id: operationId }))
      .value,
  );
  assert.equal(event.id, operationId);
  assert.equal(event.at, original.at);
  const intent = JSON.parse(
    (await index.detail._handler(f.s.ctx, { projectId: 'project', collection: 'intents', id: f.intent.id }))
      .value,
  );
  assert.equal(intent.noteCount, 1);
});

test('a moving snapshot cannot publish an incomplete record generation', async t => {
  const f = await setup(t);
  const mutate = f.s.ctx.runMutation;
  let moved = false;
  f.s.ctx.runMutation = async (ref, args) => {
    const result = await mutate(ref, args);
    if (getFunctionName(ref) === 'projectWorkIndexBuildStore:step' && !moved) {
      moved = true;
      const head = [...f.s.tables.projectWorkHeads.values()][0];
      if (head) head.revision++;
      else f.s.tables.hostedProjects.get('project').work.revision++;
    }
    return result;
  };
  await assert.rejects(
    actions.ensure._handler(f.s.ctx, { projectId: 'project' }),
    e => e.data?.code === 'WORK_STALE',
  );
  assert.equal(f.s.tables.hostedProjects.get('project').work.generationId, undefined);
  assert([...f.s.tables.projectWorkGenerations.values()].every(g => g.status === 'building'));
});

test('paged View provenance derives changed source and saved Lane history on the server', async t => {
  const f = await setup(t, 3 * 1024 * 1024, true);
  await continueLongAction('Synthetic index', randomUUID(), continuation =>
    actions.ensure._handler(f.s.ctx, { projectId: 'project', continuation }),
  );
  const detail = JSON.parse(
    (await index.detail._handler(f.s.ctx, { projectId: 'project', collection: 'viewDetails', id: f.view.id }))
      .value,
  );
  assert.equal(detail.status, 'ready');
  assert.equal(detail.fileCount, 1);
  assert.equal(detail.provenanceAvailable, true);
  const files = await index.records._handler(f.s.ctx, {
    projectId: 'project',
    collection: 'viewFiles',
    parentId: f.view.id,
    paginationOpts: { cursor: null, numItems: 100 },
  });
  const file = JSON.parse(files.page[0].value);
  assert.equal(file.path, 'a.ts');
  assert.equal(file.status, 'modified');
  assert(file.contributors.some(row => row.laneId === f.lane.id && row.saves.length === 1));
  const lane = JSON.parse(
    (await index.detail._handler(f.s.ctx, { projectId: 'project', collection: 'lanes', id: f.lane.id }))
      .value,
  );
  assert.equal(lane.changes, undefined, 'missing owner counts stay lazy');
  assert.equal(lane.checkpointCount, 1);
});
