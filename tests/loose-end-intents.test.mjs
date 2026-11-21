// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { getHeapStatistics } from 'node:v8';
import { moduleUrl } from './convex-module.mjs';
import { projectRow, state } from './hosted-fixture.mjs';
import { meterReads } from './hosted-read-set.mjs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { agentFixture } from './hosted-agent-fixture.mjs';
import { registerAgentWorkflow } from '../dist/mcp-agent-workflow.js';
import { hostedRecordValue } from '../dist/hosted-records.js';
import { looseEndIntentCursor } from '../dist/hosted-lifecycle.js';

const loose = await import(moduleUrl('../convex/projectLooseEnds.ts'));
const batch = await import(moduleUrl('../convex/projectLooseEndIntents.ts'));
const lifecycle = await import(moduleUrl('../convex/projectHostedLifecycle.ts'));
const epoch = 1;
const baseAt = 1_735_689_600_000;
const pin = { head: 'a'.repeat(64), receiptId: randomUUID() };
const code = expected => error => error.data?.code === expected || error.code === expected;

function fixture(projectId = 'project') {
  const s = state([], { keysetPaging: true });
  const project = projectRow({ _id: projectId, sourceAuthority: { mode: 'server', epoch } });
  s.tables.hostedProjects.set(projectId, project);
  let sequence = 0;
  // Retained records are seeded from the public codec; fixture timestamps let us
  // prove ordering without waiting for the clock to advance between selections.
  const insert = (table, value, at = baseAt + sequence) => {
    const id = `fixture-${sequence++}`;
    s.tables[table].set(id, { ...value, _id: id, _creationTime: at });
    return id;
  };
  const write = (record, fields = {}) => {
    const { ref, value } = hostedRecordValue(record);
    const header = {
      projectId,
      kind: record.kind,
      key: record.id,
      status: record.status ?? record.state ?? 'saved',
      version: record.version,
      parent: record.intentId ?? record.laneId ?? 'owner',
    };
    const bodyId = insert('projectHostedRecordBodies', { projectId, value });
    const recordId = insert(
      'projectHostedRecords',
      { ...header, digest: ref.digest, bytes: ref.bytes, bodyId },
      Date.parse(record.at),
    );
    const existing = [...s.tables.projectHostedRecordHeads.values()].find(row => row.key === record.id);
    const headId = existing?._id ?? insert('projectHostedRecordHeads', {});
    Object.assign(s.tables.projectHostedRecordHeads.get(headId), header, fields, { recordId });
    return headId;
  };
  const intent = (fields = {}, pointer = {}) => {
    const record = {
      id: randomUUID(),
      kind: 'intent',
      version: 0,
      at: new Date(baseAt).toISOString(),
      outcome: 'Review an unfinished execution',
      constraints: 'Synthetic repository',
      creatorAccountId: 'owner',
      assigneeAccountIds: [],
      base: pin,
      status: 'active',
      ...fields,
    };
    const headId = write(record, pointer);
    return { record, headId };
  };
  const lane = (intentId, at = baseAt + 1000) => {
    const record = {
      kind: 'lane',
      id: randomUUID(),
      intentId,
      version: 0,
      sourceVersion: 0,
      lifecycleVersion: 0,
      at: new Date(at).toISOString(),
      actor: 'owner',
      authorityEpoch: epoch,
      head: pin.head,
      base: pin,
      state: 'active',
    };
    write(record);
    const table = s.tables.projectHostedLifecycleGuards;
    const current = [...table.values()].find(guard => guard.intentId === intentId);
    if (current) current.revision++;
    else insert('projectHostedLifecycleGuards', { projectId, intentId, revision: 1, planId: null });
    return record;
  };
  const save = (laneId, at) =>
    insert('projectHostedRecords', { projectId, kind: 'save', parent: laneId, status: 'saved' }, at);
  const read = async (cursor = looseEndIntentCursor) => {
    return JSON.parse(await loose.read._handler(s.ctx, { projectId, cursor }));
  };
  const setAside = (intents, operationId = randomUUID(), reason = 'Reviewed loose ends') =>
    s.transaction(async () =>
      JSON.parse(
        await batch.setAside._handler(s.ctx, {
          projectId,
          operationId,
          request: JSON.stringify({ authorityEpoch: epoch, reason, intents }),
        }),
      ),
    );
  return { ...s, projectId, project, intent, lane, save, read, setAside, write, insert };
}

test('Loose ends pages at 408 and 816 open Intents stay bounded across listing and set-aside', async t => {
  for (const size of [408, 816]) {
    const f = fixture();
    const expected = new Set();
    for (let index = 0; index < size; index++) {
      const { record } = f.intent({ status: index % 9 === 0 ? 'ready' : 'active' });
      expected.add(record.id);
      if (index % 2 === 0) f.lane(record.id);
    }
    f.intent({ status: 'completed' });
    f.intent({}, { planningItemId: randomUUID() });
    const measured = meterReads(f.ctx);
    const before = performance.now();
    const heap = getHeapStatistics().used_heap_size;
    let pages = 0;
    let maxDocuments = 0;
    let maxReadBytes = 0;
    let maxReplyBytes = 0;
    let peakHeap = heap;
    let cursor;
    let selections;
    do {
      let response;
      const cost = await measured.cost(async () => {
        response = await f.read(cursor);
      });
      const group = response.groups.intents;
      cursor = group.continueCursor;
      selections ??= group.rows.map(row => row.selection);
      assert(group.rows.length <= 25);
      for (const { selection } of group.rows)
        assert(expected.delete(selection.intentId), 'one selected row per open unlinked Intent');
      pages++;
      maxDocuments = Math.max(maxDocuments, cost.documents);
      maxReadBytes = Math.max(maxReadBytes, cost.bytes);
      maxReplyBytes = Math.max(maxReplyBytes, Buffer.byteLength(JSON.stringify(response)));
      peakHeap = Math.max(peakHeap, getHeapStatistics().used_heap_size);
    } while (cursor);
    assert.equal(expected.size, 0);
    assert.equal(pages, Math.ceil((size + 1) / 25));
    assert(maxDocuments <= 140);
    assert(maxReadBytes <= 108 * 1024);
    assert(maxReplyBytes <= 12 * 1024);
    const writes = f.tables.projectHostedRecords.size;
    let receipt;
    const setAsideCost = await measured.cost(async () => {
      receipt = await f.setAside(selections);
    });
    assert.equal(receipt.results.filter(row => row.result === 'set-aside').length, selections.length);
    assert.equal(
      f.tables.projectHostedRecords.size - writes,
      selections.length,
      'one Intent version per row',
    );
    assert(setAsideCost.documents <= 600);
    assert(setAsideCost.bytes <= 512 * 1024);
    assert.equal(f.scheduled.length, 0);
    t.diagnostic(
      `${size} Intents: ${pages} list calls with max ${maxDocuments} documents, ${maxReadBytes} fixture read B and ${maxReplyBytes} reply B per page; 1 batch call, ${setAsideCost.documents} documents, ${setAsideCost.bytes} fixture read B; ${(performance.now() - before).toFixed(0)} ms, ${Math.max(peakHeap, getHeapStatistics().used_heap_size) - heap} B sampled heap growth`,
    );
  }
});

test('batch names stale rows including a no-op save, and replay preserves the original receipt after reopen', async () => {
  const f = fixture();
  const safe = f.intent().record;
  const saved = f.intent().record;
  const linked = f.intent().record;
  const changed = f.intent().record;
  const siblingChanged = f.intent().record;
  const recent = baseAt + 10_000;
  const lane = f.lane(saved.id, recent);
  const previousSave = recent + 2_000;
  f.save(lane.id, previousSave);
  f.insert(
    'projectHostedRecords',
    { projectId: f.projectId, kind: 'lane', key: lane.id, parent: saved.id, lifecyclePlanId: 'pending' },
    previousSave + 1_000,
  );
  const { rows } = (await f.read()).groups.intents;
  const selected = id => rows.find(row => row.selection.intentId === id);
  assert.equal(selected(saved.id).lastActivityAt, new Date(previousSave).toISOString());
  const selections = [safe, saved, linked, changed, siblingChanged].map(({ id }) => selected(id).selection);
  // A no-change save adds a save record and leaves both the child and Intent version unchanged.
  f.save(lane.id, selected(saved.id).selection.observedAt);
  f.write(linked, { planningItemId: randomUUID() });
  f.write({ ...changed, version: 1 });
  f.lane(siblingChanged.id);
  const operationId = randomUUID();
  const receipt = await f.setAside(selections, operationId);
  assert.deepEqual(
    receipt.results.map(row => row.result),
    ['set-aside', 'saved-since-selection', 'item-linked', 'intent-changed', 'lane-changed'],
  );
  assert.equal([...f.tables.projectHostedLifecycleEvents.values()].length, 1);
  const undo = {
    operationId: randomUUID(),
    authorityEpoch: epoch,
    action: 'reopen',
    target: { kind: 'intent', intentId: safe.id, version: 1 },
  };
  await lifecycle.transition._handler(f.ctx, { projectId: f.projectId, request: JSON.stringify(undo) });
  assert.deepEqual(await f.setAside(selections, operationId), receipt);
  assert.equal([...f.tables.projectHostedLifecycleEvents.values()].length, 2, 'replay never reapplies');
  await assert.rejects(
    f.setAside(selections, operationId, 'Different reason'),
    code('WORK_OPERATION_CHANGED'),
  );

  const fresh = (await f.read()).groups.intents.rows.find(row => row.selection.intentId === changed.id);
  const retry = await f.setAside([fresh.selection]);
  assert.deepEqual(
    retry.results.map(row => [row.intentId, row.result]),
    [[changed.id, 'set-aside']],
  );
});

test('same-id legacy Items and current authority are checked on read, apply and replay', async () => {
  const f = fixture();
  const legacy = f.intent();
  f.insert('projectHostedRecordHeads', { projectId: f.projectId, kind: 'issue', key: legacy.record.id });
  const independent = f.intent();
  const result = await f.read();
  assert.deepEqual(
    result.groups.intents.rows.map(row => row.selection.intentId),
    [independent.record.id],
  );
  const selection = result.groups.intents.rows[0].selection;
  const operationId = randomUUID();
  await f.setAside([selection], operationId);
  f.caller(null);
  await assert.rejects(f.read(), code('PROJECT_UNAVAILABLE'));
  await assert.rejects(f.setAside([selection], operationId), code('PROJECT_UNAVAILABLE'));
  f.caller('reader');
  f.insert('projectReaders', { projectId: f.projectId, reader: 'reader' });
  assert.equal((await f.read()).setAside, null);
  await assert.rejects(f.setAside([selection]), code('PROJECT_UNAVAILABLE'));
  f.caller('owner');
  f.project.owner = 'new-owner';
  await assert.rejects(f.setAside([selection], operationId), code('PROJECT_UNAVAILABLE'));
});

test('CLI and MCP list Intent selections and send one explicit batch mutation', async t => {
  const f = fixture();
  f.intent();
  const calls = [];
  const agent = agentFixture(t);
  const transport = agent.transport();
  transport.query = async (name, { cursor }) => {
    calls.push(name);
    return f.read(cursor);
  };
  transport.mutation = async (name, { operationId, request }) => {
    calls.push(name);
    const { intents, reason } = JSON.parse(request);
    return f.setAside(intents, operationId, reason);
  };
  const list = { view: 'loose-ends', intents: true };
  const { result } = await transport.dispatch('lanes', list);
  const { selection } = result.groups.intents.rows[0];
  const operationId = randomUUID();
  const change = {
    operationId,
    authorityEpoch: result.setAside.authorityEpoch,
    reason: 'Reviewed',
    intents: [selection],
  };
  const server = new McpServer({ name: 'nanthai-forge', version: 'test' });
  const close = registerAgentWorkflow(server, agent.root, transport);
  const client = new Client({ name: 'test', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  await client.connect(b);
  t.after(async () => {
    close();
    await client.close();
    await server.close();
  });
  const invoke = async (name, command) => {
    const response = await client.callTool({ name, arguments: { command } });
    assert(!response.isError, JSON.stringify(response.content));
    return JSON.parse(response.content[0].text);
  };
  const page = await invoke('forge_work_overview', { action: 'lanes', ...list });
  assert.equal(page.result.groups.intents.rows[0].selection.intentId, selection.intentId);
  const cli = await transport.dispatch('abandon', change);
  const mcp = await invoke('forge_task', { action: 'abandon', ...change });
  assert.equal(cli.operationId, operationId);
  assert.equal(cli.result.results[0].result, 'set-aside');
  assert.deepEqual(mcp.result, cli.result);
  assert.deepEqual(calls, [
    'projectLooseEnds:read',
    'projectLooseEnds:read',
    'projectLooseEndIntents:setAside',
    'projectLooseEndIntents:setAside',
  ]);
});

test('an Intent selection cannot set aside the same Intent identity on a different project', async () => {
  const first = fixture('project-a');
  const second = fixture('project-b');
  const { record } = first.intent();
  second.intent({ id: record.id });
  const selection = (await first.read()).groups.intents.rows[0].selection;
  await assert.rejects(second.setAside([selection]), code('BAD_ARGUMENT'));
  assert.equal((await second.read()).groups.intents.rows[0].status, 'active');
});
