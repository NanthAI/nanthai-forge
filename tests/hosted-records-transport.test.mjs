// SPDX-License-Identifier: Apache-2.0
import { registerHostedAgentWorkflow } from '../dist/mcp-hosted-agent.js';
import { z } from 'zod';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { getFunctionName } from 'convex/server';
import { HostedAgentTransport } from '../dist/hosted-agent-transport.js';
import {
  hostedAgentActions,
  hostedAgentCapabilitiesSchema,
  hostedAgentRecordActions,
} from '../dist/hosted-agent-contract.js';
import { recordsFixture } from './hosted-context-records-fixture.mjs';
const code = expected => error => (error.code ?? error.data?.code) === expected;
function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'forge-record-transport-'));
  t.after(() => rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  const root = join(directory, 'checkout'),
    address = { url: 'https://fixture.invalid', projectId: 'project' },
    s = recordsFixture(),
    calls = [];
  const call = async (ref, args) => {
    const name = getFunctionName(ref);
    calls.push(name);
    return s.invoke(name, args);
  };
  const transport = new HostedAgentTransport(root, address, {
    projectId: 'project',
    client: { query: call, mutation: call },
  });
  return { ...s, root, address, transport, calls };
}

test('record transport uses one call, keeps original operations across lost replies, and adds no advertised capability', async t => {
  const s = fixture(t),
    command = { title: 'Synthetic friction', detail: 'Hosted ROOT', area: 'records' };
  const first = await s.transport.dispatch('friction', command);
  assert.deepEqual(s.calls, ['projectHostedFriction:capture']);
  const replay = await s.transport.dispatch('friction', command);
  assert.deepEqual(replay, first);
  assert.equal(s.tables.projectHostedFriction.size, 1);
  await assert.rejects(
    s.transport.dispatch('friction', { ...command, operationId: first.operationId, title: 'Changed' }),
    code('WORK_OPERATION_CHANGED'),
  );
  const decide = {
    operationId: randomUUID(),
    target: { kind: 'project' },
    decidedBy: 'Owner',
    what: 'Hosted record',
    why: 'Context',
  };
  const mutate = s.transport.exchange.client.mutation;
  let lose = true;
  s.transport.exchange.client.mutation = async (...args) => {
    const result = await mutate(...args);
    if (lose) {
      lose = false;
      throw new Error('Synthetic lost reply');
    }
    return result;
  };
  await assert.rejects(s.transport.dispatch('decide', decide), code('HOSTED_ACTION_FAILED'));
  const result = await s.transport.dispatch('decide', decide);
  assert.equal(result.result.id, decide.operationId);
  assert.equal(s.tables.projectHostedDecisions.size, 1);
  const before = s.calls.length;
  assert.equal((await s.transport.dispatch('decisions', {})).result.page.length, 1);
  assert.equal(s.calls.length - before, 1);
  assert.equal(s.calls.at(-1), 'projectHostedDecisions:list');
  assert(!existsSync(join(s.root, '.forge', 'native')));
  assert(!existsSync(join(s.root, '.forge', 'work')));
  for (const action of hostedAgentRecordActions) assert(!hostedAgentActions.includes(action));
  const capabilities = {
    schema: 1,
    projectId: 'project',
    actor: 'owner',
    authority: { mode: 'server', epoch: 1 },
    actions: hostedAgentActions,
    mainReady: true,
    sourceWorkerConfigured: true,
    checkCallbackConfigured: true,
    nativeOwnerRequired: false,
    observation: 'finite',
  };
  assert.ok(hostedAgentCapabilitiesSchema.safeParse(capabilities).success);
  assert(
    !hostedAgentCapabilitiesSchema.safeParse({ ...capabilities, actions: [...hostedAgentActions, 'decide'] })
      .success,
  );
});

test('old hosted server returns HOSTED_ACTION_UNSUPPORTED without native fallback', async t => {
  const s = fixture(t);
  s.transport.exchange.client.mutation = async () => {
    throw new Error('Could not find public function for projectHostedFriction:capture');
  };
  await assert.rejects(
    s.transport.dispatch('friction', { title: 'Skew', detail: 'Old server', area: 'records' }),
    code('HOSTED_ACTION_UNSUPPORTED'),
  );
  s.transport.exchange.client.query = async () => {
    throw new Error('Could not find public function for projectHostedDecisions:list');
  };
  await assert.rejects(s.transport.dispatch('decisions', {}), code('HOSTED_ACTION_UNSUPPORTED'));
  assert(!existsSync(join(s.root, '.forge', 'work')));
});

test('hosted MCP exposes record writes and paged decision reads through the shared transport', async t => {
  const s = fixture(t),
    tools = new Map();
  const close = registerHostedAgentWorkflow(
    {
      registerTool(name, configuration, call) {
        tools.set(name, { ...configuration, call });
      },
    },
    s.transport,
  );
  t.after(close);
  for (const command of [
    { action: 'friction', title: 'MCP capture', detail: 'Synthetic', area: 'records' },
    {
      action: 'decide',
      target: { kind: 'project' },
      decidedBy: 'Owner',
      what: 'MCP decision',
      why: 'Context',
    },
    { action: 'decisions', cursor: null },
  ]) {
    const tool = tools.get(command.action === 'decisions' ? 'forge_work_overview' : 'forge_task');
    const parsed = z.object(tool.inputSchema).parse({ command });
    const before = s.calls.length,
      response = await tool.call(parsed);
    assert.ok(!response.isError, response.content[0].text);
    assert.equal(s.calls.length - before, 1);
    assert.equal(JSON.parse(response.content[0].text).action, command.action);
  }
});

test('friction validation names every field without a network call', async t => {
  const s = fixture(t);
  for (const [field, value] of [
    ['title', ''],
    ['detail', 3],
    ['area', null],
    ['laneId', 'wrong'],
    ['cost', { minutes: -1 }],
    ['operationId', 'wrong'],
  ]) {
    await assert.rejects(
      s.transport.dispatch('friction', { title: 'Title', detail: 'Detail', area: 'cli', [field]: value }),
      error =>
        error.code === 'BAD_ARGUMENT' && error.message.includes(field) && error.message.includes('--help'),
    );
  }
  assert.deepEqual(s.calls, []);
});

test('project friction omits Lane and Lane friction infers it using the same single mutation', async t => {
  const s = fixture(t);
  const project = await s.transport.dispatch('friction', { title: 'Project', detail: 'Detail', area: 'cli' });
  assert.equal(project.result.laneId, undefined);
  const laneId = randomUUID(),
    head = 'a'.repeat(64);
  mkdirSync(join(s.root, '.forge'), { recursive: true });
  writeFileSync(
    join(s.root, '.forge/hosted-lane.json'),
    JSON.stringify({
      schema: 1,
      kind: 'forge-hosted-lane-checkout',
      url: s.address.url,
      operationId: randomUUID(),
      selection: {
        schema: 2,
        projectId: 'project',
        laneId,
        intentId: randomUUID(),
        head,
        version: 0,
        sourceVersion: 0,
        lifecycleVersion: 0,
        state: 'active',
        base: { head, receiptId: randomUUID() },
        authority: { mode: 'server', epoch: 1 },
      },
      state: {
        schema: 1,
        kind: 'forge-source-state',
        parents: [],
        files: [],
        message: 'Fixture',
        at: '2026-01-01T00:00:00Z',
      },
      scope: null,
      materialized: [],
    }),
  );
  s.tables.projectHostedRecordHeads.set('lane', { projectId: 'project', kind: 'lane', key: laneId });
  const lane = await s.transport.dispatch('friction', { title: 'Lane', detail: 'Detail', area: 'cli' });
  assert.equal(lane.result.laneId, laneId);
  assert.deepEqual(s.calls, ['projectHostedFriction:capture', 'projectHostedFriction:capture']);
});

test('records discovers canonical saved work in one bounded call and reads exact authorized versions', async t => {
  const s = fixture(t);
  const { writeHostedRecord } = await import(
    (await import('./convex-module.mjs')).moduleUrl('../convex/projectHostedRecords.ts')
  );
  const parentId = randomUUID(),
    hash = 'a'.repeat(64);
  const records = [];
  for (let i = 0; i < 205; i++) {
    const record = {
      kind: 'save',
      id: randomUUID(),
      version: 0,
      at: '2026-01-01T00:00:00.000Z',
      laneId: parentId,
      actor: 'owner',
      operationId: randomUUID(),
      expectedHead: hash,
      expectedSourceVersion: i,
      head: hash,
      sourceVersion: i + 1,
      changes: { sha256: hash, size: 1 },
    };
    await writeHostedRecord(s.ctx, {
      projectId: 'project',
      actor: 'owner',
      authorityEpoch: 1,
      record,
      expectedVersion: null,
    });
    records.push(record);
  }
  const before = s.counts();
  const first = (await s.transport.dispatch('records', { collection: 'saves', parentId })).result;
  const after = s.counts();
  assert.equal(after.calls - before.calls, 1);
  assert.equal(after.writes, before.writes);
  assert.equal(
    after.reads - before.reads,
    201,
    'one project, 100 heads and 100 descriptors; no bodies or project hydration',
  );
  assert.equal(first.items.length, 100);
  assert(first.items.every(row => row.parentId === parentId && row.source.digest && !row.value));
  const second = (
    await s.transport.dispatch('records', { collection: 'saves', parentId, cursor: first.nextCursor })
  ).result;
  const third = (
    await s.transport.dispatch('records', { collection: 'saves', parentId, cursor: second.nextCursor })
  ).result;
  assert.equal(third.nextCursor, null);
  assert.equal(new Set([...first.items, ...second.items, ...third.items].map(row => row.id)).size, 205);
  const calls = s.calls.length;
  await assert.rejects(
    s.transport.dispatch('records', { collection: 'jobs', cursor: first.nextCursor }),
    code('BAD_ARGUMENT'),
  );
  await assert.rejects(
    s.transport.dispatch('records', { collection: 'saves', parentId, status: 'active' }),
    code('BAD_ARGUMENT'),
  );
  assert.equal(s.calls.length, calls, 'invalid selection cannot make a network call');
  const selected = records[0];
  const exact = (await s.transport.dispatch('records', { collection: 'saves', id: selected.id, version: 0 }))
    .result;
  assert.deepEqual(exact.record.value, selected);
  await assert.rejects(
    s.transport.dispatch('records', { collection: 'saves', id: selected.id, version: 1 }),
    code('NOT_FOUND'),
  );
  s.caller('stranger');
  for (const input of [{ collection: 'saves' }, { collection: 'saves', id: selected.id, version: 0 }])
    await assert.rejects(s.transport.dispatch('records', input), code('PROJECT_UNAVAILABLE'));
  assert.equal(s.scheduled.length, 0);
  assert(!existsSync(join(s.root, '.forge', 'work')));
});

test('MCP dispatches records and retained check logs through the same supported read paths', async t => {
  const s = fixture(t),
    tools = new Map();
  t.after(
    registerHostedAgentWorkflow(
      {
        registerTool(name, configuration, call) {
          tools.set(name, { ...configuration, call });
        },
      },
      s.transport,
    ),
  );
  const query = s.transport.exchange.client.query;
  s.transport.exchange.client.query = async (ref, args) => {
    const name = getFunctionName(ref);
    if (name === 'projectHostedOutputRead:manifest') return { status: 'passed', complete: true };
    if (name === 'projectHostedOutputRead:streams') return { page: [], isDone: true, continueCursor: '' };
    return query(ref, args);
  };
  for (const [toolName, command] of [
    ['forge_work_overview', { action: 'records', collection: 'candidates' }],
    ['forge_check', { action: 'log', runId: randomUUID() }],
  ]) {
    const tool = tools.get(toolName);
    const parsed = z.object(tool.inputSchema).parse({ command });
    const reply = await tool.call(parsed);
    assert(!reply.isError, reply.content[0].text);
    const actual = JSON.parse(reply.content[0].text);
    const { action, ...input } = command;
    assert.deepEqual(actual.result, (await s.transport.dispatch(action, input)).result);
    assert.equal(actual.action, action);
    assert.equal(actual.operationId, null);
  }
});

async function provenanceFixture(t, saves = 1, files = 1) {
  const s = fixture(t),
    objects = new Map(),
    at = '2026-01-01T00:00:00.000Z',
    nonce = randomUUID();
  const { digest } = await import('../dist/hash.js');
  const { saveBytes } = await import('../dist/hosted-save.js');
  const { buildComposePages } = await import('../dist/hosted-compose.js');
  const { writeHostedRecord } = await import(
    (await import('./convex-module.mjs')).moduleUrl('../convex/projectHostedRecords.ts')
  );
  const put = value => {
    const bytes = typeof value === 'string' ? Buffer.from(value) : Buffer.from(saveBytes(value));
    const sha256 = digest(bytes);
    objects.set(sha256, bytes);
    return { sha256, size: bytes.length };
  };
  const state = (text, parents = [], message = 'Synthetic source') => {
    const blob = put(text).sha256;
    const value = {
      schema: 1,
      kind: 'forge-source-state',
      parents,
      files: Array.from({ length: files }, (_, i) => ({
        path: i ? `file-${i}.txt` : 'a.txt',
        blob,
        mode: 'file',
      })),
      message: `${message} ${nonce}`,
      at,
    };
    return { ...put(value), value };
  };
  const base = state('one\nbase\nthree\n'),
    left = [],
    right = state('one\nbase\nright\n', [base.sha256], 'Right save');
  const intentId = randomUUID();
  const putRecord = (record, expectedVersion = null) =>
    writeHostedRecord(s.ctx, {
      projectId: 'project',
      actor: 'owner',
      authorityEpoch: 1,
      record,
      expectedVersion,
    });
  await putRecord({
    kind: 'intent',
    id: intentId,
    version: 0,
    at,
    outcome: 'Keep both contributors',
    constraints: '',
    creatorAccountId: 'owner',
    assigneeAccountIds: [],
    status: 'active',
    base: { head: base.sha256, receiptId: 'main' },
  });
  const lanes = [],
    nativeLanes = [],
    sourceStates = new Map([
      [base.sha256, base.value.files],
      [right.sha256, right.value.files],
    ]);
  for (const branch of ['left', 'right']) {
    const id = randomUUID(),
      checkpoints = [];
    let previous = base,
      current;
    for (let version = 0; version <= (branch === 'left' ? saves : 1); version++) {
      const saved =
        version === 0
          ? base
          : branch === 'right'
            ? right
            : state(`one\nleft ${version}\nthree\n`, [previous.sha256], `Left save ${version}`);
      if (version && branch === 'left') left.push(saved);
      if (version)
        checkpoints.push({ head: saved.sha256, parent: previous.sha256, message: saved.value.message, at });
      sourceStates.set(saved.sha256, saved.value.files);
      current = {
        kind: 'lane',
        id,
        version,
        at,
        intentId,
        actor: 'owner',
        base: { head: base.sha256, receiptId: 'main' },
        head: saved.sha256,
        sourceVersion: version,
        lifecycleVersion: 0,
        state: 'active',
        authorityEpoch: 1,
      };
      await putRecord(current, version ? version - 1 : null);
      previous = saved;
    }
    lanes.push(current);
    nativeLanes.push({ id, intentId, checkpoints });
  }
  const selected = state(
    `one\nleft ${saves}\nright\n`,
    [left.at(-1).sha256, right.sha256],
    'Synthetic Candidate',
  );
  sourceStates.set(selected.sha256, selected.value.files);
  const page = buildComposePages(
    lanes.map(lane => ({
      laneId: lane.id,
      head: lane.head,
      version: lane.version,
      sourceVersion: lane.sourceVersion,
      lifecycleVersion: 0,
      state: { object: { sha256: lane.head, size: objects.get(lane.head).length }, recipe: null },
    })),
  );
  const empty = buildComposePages([]);
  for (const p of [...page.pages, ...empty.pages]) put(p.value);
  const candidate = {
    kind: 'candidate',
    id: randomUUID(),
    version: 0,
    at,
    intentId,
    base: { head: base.sha256, receiptId: 'main' },
    inputs: page.manifest.root,
    dependencies: empty.manifest.root,
    algorithm: 'forge-native-compose-v1',
    result: { status: 'clean', head: selected.sha256 },
  };
  await putRecord(candidate);
  const query = s.transport.exchange.client.query;
  const mutation = s.transport.exchange.client.mutation;
  s.transport.exchange.client.mutation = async (ref, args) => {
    if (getFunctionName(ref) === 'projectObjectDownloads:lanePage') {
      s.calls.push('projectObjectDownloads:lanePage');
      return args.digests.map(digest => ({ digest, size: objects.get(digest).length }));
    }
    return mutation(ref, args);
  };
  s.transport.exchange.downloadBatch = async pins => pins.map(pin => objects.get(pin.sha256));
  s.transport.exchange.client.query = query;
  const nativeView = {
    id: candidate.id,
    base: base.sha256,
    head: selected.sha256,
    at,
    status: 'ready',
    inputs: lanes.map(lane => ({ laneId: lane.id, head: lane.head })),
    dependencies: [],
  };
  return {
    ...s,
    objects,
    candidate,
    lanes,
    base,
    left,
    right,
    selected,
    put,
    putRecord,
    buildComposePages,
    nativeView,
    nativeData: {
      lanes: nativeLanes,
      intents: [{ id: intentId, outcome: 'Keep both contributors' }],
      views: [nativeView],
    },
    sourceStates,
  };
}

test('canonical Candidate provenance matches native file/count/line plans without a Work store or legacy projection', async t => {
  const s = await provenanceFixture(t);
  const { provenancePlan } = await import('../dist/view-provenance-plan.js');
  const { readFileProvenance } = await import('../dist/view-provenance.js');
  const expected = await readFileProvenance(
    provenancePlan(s.nativeData, s.nativeView, s.sourceStates)[0],
    async id => s.objects.get(id),
    true,
    id => s.objects.get(id).length,
  );
  const before = s.counts();
  const result = await s.transport.dispatch('provenance', { candidateId: s.candidate.id, lines: true });
  const actual = result.result.files[0];
  assert.equal(result.result.nextCursor, null);
  assert.equal(actual.historyComplete, true);
  const comparable = {
    ...actual,
    contributors: actual.contributors.map(c => ({
      ...c,
      saves: c.saves.map(({ requester, ...save }) => save),
    })),
  };
  assert.deepEqual(comparable, expected);
  assert.equal(result.result.why[0].outcome, 'Keep both contributors');
  assert.equal(s.counts().writes, before.writes);
  assert.equal(s.scheduled.length, 0);
  assert.equal(s.calls.filter(name => name === 'projectHostedProvenanceRead:read').length, 1);
  assert(!existsSync(join(s.root, '.forge', 'work')));
  assert.equal(s.tables.projectWorkRecords.size, 0);
  assert.equal(result.result.cost.idleCalls, 0);
});

test('provenance history continues exact old Lane versions after newer saves, with explicit partial line coverage', async t => {
  const s = await provenanceFixture(t, 25, 3000);
  const command = { candidateId: s.candidate.id, file: 'a.txt', lines: true };
  const budgetStart = s.counts(),
    started = performance.now();
  const first = await s.transport.dispatch('provenance', command);
  const firstBudget = {
    calls: s.counts().calls - budgetStart.calls,
    reads: s.counts().reads - budgetStart.reads,
    ms: performance.now() - started,
  };
  assert.equal(firstBudget.calls, 3, 'three metadata queries per history page, never one per version');
  assert(firstBudget.reads <= 150, `bounded metadata reads: ${firstBudget.reads}`);
  assert.equal(first.result.files[0].historyComplete, false);
  assert.equal(first.result.files[0].lines.status, 'partial');
  assert.equal(first.result.cost.historyVersions, 20);
  assert(first.result.nextCursor);
  const newer = { ...s.lanes[0], version: 26, sourceVersion: 26, head: s.base.sha256 };
  await s.putRecord(newer, 25);
  const second = await s.transport.dispatch('provenance', { ...command, cursor: first.result.nextCursor });
  assert.equal(second.result.nextCursor, null);
  assert.equal(
    second.result.files[0].contributors[0].head,
    s.lanes[0].head,
    'the newer Lane head never substitutes',
  );
  assert.equal(second.result.cost.historyVersions, 8);
  await assert.rejects(
    s.transport.dispatch('provenance', {
      ...command,
      file: 'different.txt',
      cursor: first.result.nextCursor,
    }),
    code('BAD_ARGUMENT'),
  );
  t.diagnostic(
    `3000-file manifests, 20-version page: ${JSON.stringify(first.result.cost)}, metadata ${JSON.stringify(firstBudget)}, peak RSS ${process.resourceUsage().maxRSS * 1024}`,
  );
});

test('provenance rechecks current authority after source reads and on warm-cache reads; MCP routes the same action', async t => {
  const s = await provenanceFixture(t);
  const download = s.transport.exchange.downloadBatch;
  s.transport.exchange.downloadBatch = async pins => {
    const bytes = await download(pins);
    s.caller('stranger');
    return bytes;
  };
  await assert.rejects(
    s.transport.dispatch('provenance', { candidateId: s.candidate.id, lines: true }),
    code('PROJECT_UNAVAILABLE'),
  );
  s.transport.exchange.downloadBatch = download;
  s.caller('owner');
  const tools = new Map();
  t.after(
    registerHostedAgentWorkflow(
      {
        registerTool(name, configuration, call) {
          tools.set(name, { ...configuration, call });
        },
      },
      s.transport,
    ),
  );
  const tool = tools.get('forge_review');
  const command = { action: 'provenance', candidateId: s.candidate.id, file: 'a.txt', lines: true };
  const reply = await tool.call(z.object(tool.inputSchema).parse({ command }));
  assert(!reply.isError, reply.content[0].text);
  assert.equal(JSON.parse(reply.content[0].text).result.files[0].historyComplete, true);
  const query = s.transport.exchange.client.query;
  let selectedReads = 0;
  s.transport.exchange.client.query = async (ref, args) => {
    if (getFunctionName(ref) === 'projectHostedCompose:candidate' && ++selectedReads === 2)
      s.caller('stranger');
    return query(ref, args);
  };
  await assert.rejects(
    s.transport.dispatch('provenance', { candidateId: s.candidate.id }),
    code('PROJECT_UNAVAILABLE'),
  );
});

test('provenance pages every selected file and pinned dependency without claiming unseen contributors', async t => {
  const s = await provenanceFixture(t, 1, 2);
  const empty = s.buildComposePages([]),
    deps = s.buildComposePages([
      {
        candidateId: s.candidate.id,
        head: s.selected.sha256,
        state: { object: { sha256: s.selected.sha256, size: s.selected.size }, recipe: null },
      },
    ]);
  for (const page of [...empty.pages, ...deps.pages]) s.put(page.value);
  const parent = {
    ...s.candidate,
    id: randomUUID(),
    inputs: empty.manifest.root,
    dependencies: deps.manifest.root,
  };
  await s.putRecord(parent);
  const pages = [];
  let cursor;
  for (let i = 0; i < 12; i++) {
    const response = await s.transport.dispatch('provenance', {
      candidateId: parent.id,
      lines: true,
      ...(cursor ? { cursor } : {}),
    });
    pages.push(response.result);
    cursor = response.result.nextCursor;
    if (!cursor) break;
  }
  assert.equal(cursor, null, 'finite dependency and file cursors finish');
  assert.deepEqual(pages.flatMap(page => page.files.map(file => file.path)).sort(), ['a.txt', 'file-1.txt']);
  assert(pages.every(page => !page.coverage.complete));
  assert(pages.filter(page => page.dependency).length === 2, 'each file visits its pinned dependency');
  assert(pages.flatMap(page => page.files).every(file => file.lines.status === 'partial'));
  assert(
    pages
      .flatMap(page => page.files)
      .every(file => file.contributors.every(c => c.viewId === s.candidate.id)),
  );
});

test('provenance retains the exact sync operation and requester without guessing an executor', async t => {
  const s = await provenanceFixture(t);
  const jobId = randomUUID(),
    operationId = randomUUID();
  s.tables.projectHostedStates.set('state', {
    _id: 'state',
    projectId: 'project',
    head: s.left[0].sha256,
    size: s.left[0].size,
    input: 'a'.repeat(64),
    jobId,
    output: 'b'.repeat(64),
  });
  s.tables.projectHostedSyncs.set('sync', {
    _id: 'sync',
    projectId: 'project',
    actor: 'owner',
    operationId,
    jobId,
    value: JSON.stringify({
      request: { laneId: s.lanes[0].id, expected: { version: 0 }, message: 'Resolve the selected changes' },
    }),
  });
  const reply = await s.transport.dispatch('provenance', { candidateId: s.candidate.id, file: 'a.txt' });
  const save = reply.result.files[0].contributors.find(c => c.laneId === s.lanes[0].id).saves[0];
  assert.equal(save.kind, 'sync');
  assert.equal(save.operationId, operationId);
  assert.equal(save.message, 'Resolve the selected changes');
  assert.equal(save.actor, null);
  assert.equal(save.actorSource, 'not-recorded');
  assert.equal(typeof save.requester, 'string');
  // The same State registered by an operation for another Lane is not attribution for this transition.
  s.tables.projectHostedSyncs.get('sync').value = JSON.stringify({
    request: { laneId: randomUUID(), expected: { version: 0 }, message: 'Unrelated' },
  });
  const unrelated = await s.transport.dispatch('provenance', { candidateId: s.candidate.id, file: 'a.txt' });
  assert.equal(
    unrelated.result.files[0].contributors.find(c => c.laneId === s.lanes[0].id).saves[0].operationId,
    null,
  );
});

test('each file continuation reports complete history when all its pinned input history fits', async t => {
  const s = await provenanceFixture(t, 1, 2);
  const first = await s.transport.dispatch('provenance', { candidateId: s.candidate.id, lines: true });
  const second = await s.transport.dispatch('provenance', {
    candidateId: s.candidate.id,
    lines: true,
    cursor: first.result.nextCursor,
  });
  assert.equal(first.result.files[0].historyComplete, true);
  assert.equal(second.result.files[0].path, 'file-1.txt');
  assert.equal(second.result.files[0].historyComplete, true, 'a file cursor is not a history truncation');
  assert.equal(second.result.files[0].lines.status, 'available');
  assert.equal(second.result.nextCursor, null);
});

test('negotiated Candidate file-list pins preserve canonical CLI provenance without an extra root read', async t => {
  const s = await provenanceFixture(t);
  const { reviewPaths } = await import('../dist/source-review-format.js');
  const before = await s.transport.dispatch('provenance', { candidateId: s.candidate.id, lines: true });
  const listing = s.put({
    schema: 1,
    kind: 'forge-candidate-files',
    base: s.candidate.base.head,
    head: s.candidate.result.head,
    files: reviewPaths(s.base.value.files, s.selected.value.files).filter(
      file => file.status !== 'unchanged',
    ),
  });
  const row = [...s.tables.projectHostedRecords.values()].find(
    row => row.kind === 'candidate' && row.key === s.candidate.id,
  );
  await s.ctx.db.patch(row._id, { candidateFiles: listing });
  // Simulate the feature set already learned by the process's ordinary capability read.
  s.transport.serverFeatures = ['candidate-source-files'];
  const calls = s.calls.length;
  const after = await s.transport.dispatch('provenance', { candidateId: s.candidate.id, lines: true });
  assert.deepEqual(after.result.files, before.result.files);
  assert.deepEqual(after.result.why, before.result.why);
  assert.deepEqual(after.sourceContext, before.sourceContext);
  assert.equal(s.calls.slice(calls).filter(name => name === 'projectHostedCompose:candidate').length, 2);
  assert.equal(after.result.cost.idleCalls, 0);
});
