// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve } from 'node:path';
import { getFunctionName } from 'convex/server';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { randomUUID } from 'node:crypto';
import { WorkStore } from '../dist/work-store.js';
import { setup } from './hosted-planning-fixture.mjs';
import { moduleUrl } from './convex-module.mjs';
import { dispatchHostedWork } from '../dist/hosted-work-client.js';
import { coordinationClient } from '../dist/coordination-client.js';
const queries = await import(moduleUrl('../convex/projectWorkIndex.ts'));
const actions = await import(moduleUrl('../convex/projectWorkIndexActions.ts'));
const transport = s => ({
  query: (ref, input) => queries[getFunctionName(ref).split(':')[1]]._handler(s.ctx, input),
  action: (ref, input) => actions[getFunctionName(ref).split(':')[1]]._handler(s.ctx, input),
});

test('scoped read transport prepares missing index, hydrates only selected payload, rejects stale source and keeps access current', async t => {
  const s = await setup(t),
    client = transport(s),
    before = s.reads();
  const workspace = await dispatchHostedWork(client, s.projectId, { action: 'workspace' });
  assert.ok(workspace.generationId);
  assert.ok(s.reads() > before);
  const item = s.item({ body: 'Large 🐈 body '.repeat(20000) });
  await s.send(item);
  const rows = await dispatchHostedWork(client, s.projectId, {
    action: 'records',
    collection: 'planningItems',
  });
  assert.equal(rows.page[0].value.payload, true);
  const continuation = await dispatchHostedWork(client, s.projectId, {
    action: 'records',
    collection: 'planningItems',
    cursor: rows.continueCursor,
  });
  assert.equal(continuation.page.length, 0);
  await assert.rejects(
    dispatchHostedWork(client, s.projectId, {
      action: 'records',
      collection: 'intents',
      cursor: rows.continueCursor,
    }),
    error => error.code === 'BAD_ARGUMENT',
  );
  const oldCursor =
    'forge-hosted-work-v1:' +
    JSON.stringify({ projectId: s.projectId, generationId: 'old', collection: 'planningItems', cursor: '0' });
  await assert.rejects(
    dispatchHostedWork(client, s.projectId, {
      action: 'records',
      collection: 'planningItems',
      cursor: oldCursor,
    }),
    error => error.code === 'WORK_STALE',
  );
  const calls = [],
    originalQuery = client.query;
  client.query = (ref, input) => {
    calls.push(getFunctionName(ref));
    return originalQuery(ref, input);
  };
  const reads = s.reads(),
    detail = await dispatchHostedWork(client, s.projectId, {
      action: 'detail',
      collection: 'planningItems',
      id: item.itemId,
    });
  assert.equal(detail.value.body, item.body);
  assert.equal(detail.value.payloadKey, undefined);
  assert.equal(s.reads(), reads);
  assert.ok(calls.every(name => name.startsWith('projectWorkIndex:')));
  await assert.rejects(
    dispatchHostedWork(client, s.projectId, {
      action: 'records',
      collection: 'intents',
      generationId: 'old-source',
    }),
    error => error.code === 'WORK_STALE',
  );
  await assert.rejects(
    dispatchHostedWork(client, s.projectId, { action: 'note', text: 'not a read' }),
    error => error.code === 'BAD_ARGUMENT',
  );
  s.caller('revoked');
  await assert.rejects(
    dispatchHostedWork(client, s.projectId, { action: 'workspace' }),
    error => error.code === 'PROJECT_UNAVAILABLE',
  );
  assert.throws(
    () => coordinationClient('https://example.convex.cloud', 'fga_sourceonly'),
    /Source-read grants/,
  );
});

test('actual CLI and MCP share authenticated scoped Work reads and never expose credentials or backend logs', async t => {
  const s = await setup(t),
    item = s.item({ body: 'Retained detail '.repeat(8000) });
  await s.send(item);
  const modules = { projectWorkIndex: queries, projectWorkIndexActions: actions },
    paths = [];
  const server = createServer(async (request, response) => {
    try {
      assert.equal(request.headers.authorization, 'Bearer synthetic-test-jwt');
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks)),
        [module, name] = body.path.split(':');
      paths.push(body.path);
      const value = await modules[module][name]._handler(s.ctx, body.args[0]);
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ status: 'success', value, logLines: ['Hidden backend log'] }));
    } catch (error) {
      response.writeHead(560, { 'Content-Type': 'application/json' });
      response.end(
        JSON.stringify({
          status: 'error',
          errorMessage: 'Read failed',
          errorData: error.data ?? { code: 'FIXTURE' },
        }),
      );
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const deployment = `http://127.0.0.1:${server.address().port}`,
    env = { ...process.env, FORGE_AUTH_TOKEN: 'synthetic-test-jwt' },
    cli = resolve('dist/cli.js');
  const result = await promisify(execFile)(
    process.execPath,
    [
      cli,
      'hosted-work',
      deployment,
      s.projectId,
      JSON.stringify({ action: 'detail', collection: 'planningItems', id: item.itemId }),
    ],
    { env },
  );
  assert.equal(JSON.parse(result.stdout).value.body, item.body);
  assert.equal(result.stderr, '');
  assert.ok(!result.stdout.includes(env.FORGE_AUTH_TOKEN));
  const client = new Client({ name: 'hosted-work-reader', version: '1' });
  const stdio = new StdioClientTransport({
    command: process.execPath,
    args: [cli, 'mcp-coordination', deployment, s.projectId],
    env,
    stderr: 'pipe',
  });
  let stderr = '';
  stdio.stderr?.on('data', data => (stderr += data));
  await client.connect(stdio);
  t.after(() => client.close());
  const tool = (await client.listTools()).tools.find(tool => tool.name === 'forge_hosted_work');
  assert.equal(tool.annotations.readOnlyHint, false);
  const read = await client.callTool({
    name: 'forge_hosted_work',
    arguments: { command: { action: 'detail', collection: 'planningItems', id: item.itemId } },
  });
  assert.equal(JSON.parse(read.content[0].text).value.body, item.body);
  s.caller('revoked');
  const denied = await client.callTool({
    name: 'forge_hosted_work',
    arguments: { command: { action: 'workspace' } },
  });
  assert.equal(denied.isError, true);
  await client.close();
  assert.equal(stderr, '');
  assert.ok(paths.every(path => path.startsWith('projectWorkIndex:')));
});

test('small imported planning/comment/note transport-like fields roundtrip through hydrated detail without being interpreted or discarded', async t => {
  const intentId = randomUUID(),
    itemId = randomUUID(),
    operationId = randomUUID(),
    commentId = randomUUID();
  const extensions = { payloadKey: 'external value', payloadParts: 42, payload: { nested: 'retained' } };
  const s = await setup(t, true, root => {
    const store = new WorkStore(root),
      data = store.load();
    data.intents.push({
      id: intentId,
      outcome: 'Retained',
      constraints: '',
      base: data.nativeHead,
      status: 'active',
      createdAt: 'now',
      notes: [{ text: 'Note', kind: 'comment', at: 'now', ...extensions }],
    });
    data.planningItems.push({
      id: itemId,
      operationId,
      request: 'a'.repeat(64),
      version: 1,
      previousVersion: 0,
      kind: 'issue',
      title: 'Imported',
      body: '',
      status: 'open',
      intentIds: [],
      at: 'now',
      provenance: 'user-declared-local',
      ...extensions,
    });
    data.planningComments.push({
      id: commentId,
      itemId,
      request: 'b'.repeat(64),
      authorLabel: 'Owner',
      text: 'Comment',
      at: 'now',
      provenance: 'user-declared-local',
      ...extensions,
    });
    data.revision++;
    store.save(data);
  });
  const client = transport(s);
  for (const [collection, id] of [
    ['planningItems', itemId],
    ['planningComments', commentId],
    ['notes', `${intentId}:0`],
  ]) {
    const detail = await dispatchHostedWork(client, s.projectId, { action: 'detail', collection, id });
    for (const key of Object.keys(extensions)) assert.deepEqual(detail.value[key], extensions[key]);
  }
});

test('owner decision reads page immutable Work, hydrate oversized what, retain access checks and reject changed selection', async () => {
  const { readFileSync } = await import('node:fs');
  const { indexedRecord } = await import('../dist/work-hosted-index.js');
  const { readProjectedDecisions } = await import(moduleUrl('../web/src/hosted-work-index.ts'));
  const records = JSON.parse(readFileSync(new URL('./fixtures/owner-decisions.json', import.meta.url)));
  const huge = { ...records[0], what: 'A complete untruncated owner decision. '.repeat(2000) };
  const entries = indexedRecord('decisions', huge.id, '', 0, huge);
  const header = entries[0];
  const workspace = { generationId: 'g', decisionVersion: 'v1' };
  let calls = 0;
  let changed = false;
  const client = {
    query: async (ref, args) => {
      calls++;
      const method = getFunctionName(ref).split(':')[1];
      if (method === 'workspace')
        return JSON.stringify({ ...workspace, decisionVersion: changed ? 'v2' : 'v1' });
      if (method === 'detail') return { generationId: 'g', revision: 1, value: header.value };
      if (args.collection === 'decisions:payload')
        return {
          generationId: 'g',
          revision: 1,
          page: entries.slice(1).map(row => ({ ...row, id: row.key })),
          isDone: true,
          continueCursor: '',
        };
      return args.paginationOpts.cursor
        ? {
            generationId: 'g',
            revision: 1,
            page: records
              .slice(1)
              .map((value, i) => ({ id: value.id, position: i + 1, value: JSON.stringify(value) })),
            isDone: true,
            continueCursor: '',
          }
        : {
            generationId: 'g',
            revision: 1,
            page: [{ ...header, id: header.key }],
            isDone: false,
            continueCursor: 'next',
          };
    },
  };
  const result = await readProjectedDecisions(client, 'project', workspace);
  assert.equal(result.length, 19);
  assert.equal(result[0].what, huge.what);
  assert.ok(calls > 3, 'pages and exact large payload are hydrated');
  changed = true;
  await assert.rejects(readProjectedDecisions(client, 'project', workspace), /source changed/);
  await assert.rejects(
    readProjectedDecisions(
      {
        query: async () => {
          throw new Error('PROJECT_UNAVAILABLE');
        },
      },
      'project',
      workspace,
    ),
    /PROJECT_UNAVAILABLE/,
  );
  calls = 0;
  assert.deepEqual(
    await readProjectedDecisions(
      {
        query: async () => {
          calls++;
        },
      },
      'project',
      { generationId: 'old' },
    ),
    [],
  );
  assert.equal(calls, 0, 'older optional projections render empty without reads');
});

test('a hosted read drives index continuations to completion and reports counts without progress queries', async () => {
  const { ensureWorkIndex } = await import('../dist/work-index-client.js');
  const { hostProgress } = await import('../dist/host-progress.js');
  const events = [],
    progress = hostProgress(event => events.push(event));
  progress.phase('building Work index');
  let calls = 0;
  const client = {
    action: async (ref, args) => {
      assert.equal(getFunctionName(ref), 'projectWorkIndexActions:ensure');
      assert.equal(args.continuation, calls > 0);
      calls++;
      return calls < 3
        ? {
            pending: true,
            progress: JSON.stringify({
              phase: 'index',
              buildPhase: 'parents',
              done: calls * 50,
              total: 2495,
              step: calls,
            }),
          }
        : 'generation';
    },
  };
  assert.equal(await ensureWorkIndex(client, 'project', progress.index), 'generation');
  assert.equal(calls, 3);
  assert.equal(events.at(-1).objectsDone, 100);
  assert.equal(events.at(-1).objectsTotal, 2495);
});
