// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { setup } from './hosted-planning-fixture.mjs';
import { moduleUrl } from './convex-module.mjs';
import { installPlanningSearch } from './planning-search-fixture.mjs';
import { planningSearchEntry, planningSearchTerms, planningSummary } from '../dist/planning-search.js';
import { indexedRecord } from '../dist/work-hosted-index.js';
import { hostedAgentCommandSchemas } from '../dist/hosted-agent-contract.js';
const search = await import(moduleUrl('../convex/projectHostedPlanningSearch.ts'));
const prepare = await import(moduleUrl('../convex/projectHostedPlanningPrepare.ts'));
const friction = await import(moduleUrl('../convex/projectHostedFriction.ts'));
const code = expected => error => (error.data?.code ?? error.code) === expected;
const run = async (s, text, extra = {}) =>
  JSON.parse(
    await search.search._handler(s.ctx, {
      projectId: s.projectId,
      ...planningSearchTerms(text),
      status: 'active',
      limit: 50,
      cursor: null,
      ...extra,
    }),
  );
const add = async (s, patch = {}) => {
  const input = s.item(patch);
  await s.send(input);
  return input;
};

test('title/body search filters in the index, ranks, pages, binds cursors and checks current access', async t => {
  const s = await setup(t);
  const reads = installPlanningSearch(s);
  const initiative = await add(s, { kind: 'initiative', title: 'Search launch' });
  const a = await add(s, {
    title: 'Parser recovery',
    body: 'sync sync sync',
    initiativeId: initiative.itemId,
  });
  await add(s, { title: 'sync later', status: 'proposed' });
  await add(s, { title: 'sync completed', status: 'closed' });
  const first = await run(s, 'sync', { limit: 1 });
  assert.equal(first.items[0].id, a.itemId);
  assert(first.nextCursor);
  const second = await run(s, 'sync', { limit: 1, cursor: first.nextCursor });
  assert.equal(second.items[0].title, 'sync later');
  assert.equal(second.nextCursor, null);
  assert.equal((await run(s, 'sync', { status: 'all' })).items.length, 3);
  assert.equal((await run(s, 'sync', { status: 'closed' })).items.length, 1);
  assert.equal((await run(s, 'sync', { initiativeId: initiative.itemId, kind: 'issue' })).items.length, 1);
  assert(reads.at(-1).filters.some(([key]) => key === 'planning.initiativeId'));
  assert.equal((await run(s, 'launch', { kind: 'initiative' })).items.length, 1);
  await assert.rejects(run(s, 'different', { limit: 1, cursor: first.nextCursor }), code('WORK_STALE'));
  await assert.rejects(run(s, 'sync', { cursor: 'garbage' }), code('BAD_ARGUMENT'));
  await assert.rejects(run(s, 'sync', { limit: 101 }), code('BAD_ARGUMENT'));
  s.caller('stranger');
  await assert.rejects(run(s, 'sync'), code('PROJECT_UNAVAILABLE'));
  s.caller(null);
  await assert.rejects(run(s, 'sync'), code('PROJECT_UNAVAILABLE'));
});

test('large body matches beyond compact summary; summaries keep membership, body length and Done when', async t => {
  const s = await setup(t);
  installPlanningSearch(s);
  const body = 'detail '.repeat(7000) + 'uniqueneedle\nDone when:\n- [ ] proven';
  const item = await add(s, { title: 'Large record', body });
  const result = await run(s, 'uniqueneedle');
  assert.equal(result.items[0].id, item.itemId);
  assert.equal(result.items[0].bodyLength, body.length);
  assert.equal(result.items[0].hasDoneWhen, true);
  assert.equal(result.items[0].initiativeId, null);
  const header = indexedRecord('planningItems', item.itemId, '', 0, { ...item, id: item.itemId })[0];
  const rows = JSON.parse(header.value);
  assert.equal(rows.bodyLength, body.length);
  assert.equal(rows.hasDoneWhen, true);
});

test('legacy preparation is explicit, bounded, resumable and original-operation retry safe', async t => {
  const s = await setup(t);
  installPlanningSearch(s);
  for (let n = 0; n < 23; n++)
    await add(s, { title: `legacy sync ${n}`, body: n === 0 ? 'x'.repeat(40000) + ' deepneedle' : '' });
  const generation = [...s.tables.projectWorkGenerations.values()].find(g => g.status === 'ready');
  delete generation.planningSearchVersion;
  const legacyHeader = [...s.tables.projectWorkRecords.values()].find(
    row => row.collection === 'planningItems' && JSON.parse(row.value).payloadKey,
  );
  const oldHeader = JSON.parse(legacyHeader.value);
  delete oldHeader.bodyLength;
  delete oldHeader.hasDoneWhen;
  legacyHeader.value = JSON.stringify(oldHeader);
  assert.equal(planningSummary(oldHeader).bodyLength, null);
  assert.equal(planningSummary(oldHeader).hasDoneWhen, null);
  for (const [id, row] of s.tables.projectWorkRecords)
    if (row.collection === 'planningSearch') s.tables.projectWorkRecords.delete(id);
  assert.equal((await run(s, 'sync')).coverage, 'partial-needs-preparation');
  const input = {
    projectId: s.projectId,
    owner: 'owner',
    generationId: generation._id,
    operationId: randomUUID(),
    cursor: null,
  };
  const first = JSON.parse(await prepare.page._handler(s.ctx, input));
  assert(first.processed >= 1 && first.processed <= 20);
  assert(first.nextCursor);
  assert.deepEqual(JSON.parse(await prepare.page._handler(s.ctx, input)), first);
  await assert.rejects(
    prepare.page._handler(s.ctx, { ...input, cursor: first.nextCursor }),
    code('WORK_OPERATION_CHANGED'),
  );
  let cursor = first.nextCursor,
    total = first.processed;
  while (cursor) {
    const page = JSON.parse(
      await prepare.page._handler(s.ctx, { ...input, operationId: randomUUID(), cursor }),
    );
    total += page.processed;
    cursor = page.nextCursor;
  }
  assert.equal(total, 23);
  assert.equal((await run(s, 'sync')).coverage, 'complete');
  assert.equal((await run(s, 'deepneedle')).items.length, 1);
  const preparedHeader = planningSummary(JSON.parse(s.tables.projectWorkRecords.get(legacyHeader._id).value));
  assert(preparedHeader.bodyLength > 40000);
  assert.equal(preparedHeader.hasDoneWhen, false);
});

test('50a26ac4/700de905 reproduction: source-worker body finds the existing sync Issue across Initiatives', async t => {
  const s = await setup(t);
  installPlanningSearch(s);
  const runtime = await add(s, { kind: 'initiative', title: 'Runtime stability' });
  const workflow = await add(s, { kind: 'initiative', title: 'Agent workflow' });
  // Sanitized fixture of the original subject/body concepts, with synthetic identities and operations.
  const existing = await add(s, {
    initiativeId: runtime.itemId,
    title: 'Expose the failed source-worker cause and retain sync recovery diagnostics',
    body: 'Two same-Lane actual-main sync jobs failed at source-step with generic SOURCE_WORKER_FAILED and no actionable cause. Explicit resolution draft compose followed by pinned-Candidate sync succeeded. Done when: retain the worker cause and failing phase.',
  });
  const query = 'Lane sync stalls with SOURCE_JOB_STALLED at source-step';
  const found = await run(s, query, { kind: 'issue', limit: 5 });
  assert(found.items.some(item => item.id === existing.itemId));
  s.tables.hostedProjects.get(s.projectId).sourceAuthority = { mode: 'server', epoch: 1 };
  const capture = {
    operationId: randomUUID(),
    title: query,
    detail: 'Root cause of source-step stall; sync completes or returns a typed continuation.',
    area: 'sync',
  };
  const filed = JSON.parse(
    await friction.capture._handler(s.ctx, { projectId: s.projectId, request: JSON.stringify(capture) }),
  );
  assert(filed.likelyDuplicates.items.some(item => item.id === existing.itemId));
  await add(s, { title: query, initiativeId: workflow.itemId });
  const replay = JSON.parse(
    await friction.capture._handler(s.ctx, { projectId: s.projectId, request: JSON.stringify(capture) }),
  );
  assert.deepEqual(replay, filed);
});

test('lexical candidates flag four historical duplicate classes (synthetic fixtures; provider recall unmeasured)', async t => {
  const s = await setup(t);
  installPlanningSearch(s);
  for (const [existing, proposed] of [
    ['Hosted diff and peers unavailable from checkout', 'Expose hosted Lane diff peers'],
    ['Mirror commit loses co-author trailers', 'GitHub mirror must preserve co-author trailers'],
    ['Sync deletes ignored build outputs', 'Keep ignored build outputs during sync'],
    ['Flaky concurrent runner tests race', 'Repeated flaky runner tests fail on race'],
  ]) {
    const a = await add(s, { title: existing });
    assert((await run(s, proposed, { limit: 5 })).items.some(item => item.id === a.itemId));
  }
});

for (const size of [1000, 10000])
  test(`${size} planning items: one query, bounded 50-row bytes, no writes or idle work`, async t => {
    const s = await setup(t);
    const reads = installPlanningSearch(s);
    const generation = [...s.tables.projectWorkGenerations.values()].find(g => g.status === 'ready');
    for (let n = 0; n < size; n++) {
      const item = {
        id: randomUUID(),
        kind: 'issue',
        title: 'sync recovery',
        body: 'body '.repeat(100),
        status: 'open',
        version: 1,
        intentIds: [],
        at: '2026-01-01',
      };
      const entry = planningSearchEntry(item, n);
      const id = `synthetic-${n}`;
      s.tables.projectWorkRecords.set(id, {
        ...entry,
        _id: id,
        _creationTime: n,
        projectId: s.projectId,
        generationId: generation._id,
      });
    }
    reads.reset();
    const before = s.tables.projectWorkRecords.size;
    const started = performance.now();
    const result = await run(s, 'sync');
    assert.equal(result.items.length, 50);
    assert.equal(reads.length, 1);
    assert.equal(reads[0].documents, 50);
    assert(reads[0].bytes < 100000);
    assert.equal(result.matchedRecordsRead, 50);
    assert(reads.db.documents <= 54);
    assert(reads.db.bytes < 110000);
    assert.equal(s.tables.projectWorkRecords.size, before);
    const idle = reads.length;
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(reads.length, idle);
    t.diagnostic(
      `${size} items: 1 query, ${reads[0].documents} match documents, ${reads[0].bytes} serialized match DB bytes, total ${reads.db.documents} DB documents/${reads.db.bytes} serialized read bytes; fake wall ${(performance.now() - started).toFixed(1)}ms; provider billing unmeasured`,
    );
  });

test('CLI/MCP share search schema and briefings require it; validation names id UUID shape', () => {
  assert.equal(hostedAgentCommandSchemas.planning.parse({ search: 'sync', status: 'all' }).search, 'sync');
  const bad = hostedAgentCommandSchemas.planning.safeParse({ id: '50a26ac4' });
  assert.equal(bad.success, false);
  assert.match(bad.error.message, /id must be a complete planning UUID/);
  assert.equal(
    hostedAgentCommandSchemas.planning.safeParse({ search: 'sync', id: randomUUID() }).success,
    false,
  );
  for (const path of [
    'src/agent-cli.ts',
    'src/mcp-hosted-agent.ts',
    'docs/agents/briefings.md',
    'AGENTS.md',
    'docs/agents/brief-template.md',
  ]) {
    const text = readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
    assert.match(text, /search/);
    assert.doesNotMatch(text, /until search .*ships/i);
  }
});

test('source snapshot transport preserves indexed search fields', async t => {
  const s = await setup(t);
  const item = await add(s, { title: 'Roundtrip search', body: 'Original searchable body' });
  const store = await import(moduleUrl('../convex/projectWorkIndexStore.ts'));
  const index = await import(moduleUrl('../convex/projectWorkIndex.ts'));
  const ws = JSON.parse(await index.workspace._handler(s.ctx, { projectId: s.projectId }));
  const expected = [...s.tables.projectWorkRecords.values()].find(
    row => row.collection === 'planningSearch' && row.key === item.itemId,
  );
  assert.equal(expected.planning.text, 'Roundtrip search\nOriginal searchable body');
  const snapshot = await store.snapshotEntries._handler(s.ctx, {
    projectId: s.projectId,
    owner: 'owner',
    generationId: ws.generationId,
    revision: ws.revision,
    cursor: null,
  });
  assert.deepEqual(
    snapshot.entries.find(entry => entry.collection === 'planningSearch').planning,
    expected.planning,
  );
});
