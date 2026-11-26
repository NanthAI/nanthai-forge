// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// Item 686ecdde (friction a4e7b483, sweep 5ac0bcf5): a 01:10-02:01Z read burst could only be
// shape-matched to its caller. Every public call now prints who made it (agent, cli, ci, web, public)
// and the spend ledger splits cost by it. Fix 3: source-step compute splits by cause in the same ledger.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { v } from 'convex/values';
import { makeFunctionReference } from 'convex/server';
import { moduleUrl } from './convex-module.mjs';

const { spendEvent, daySummary } = await import('../scripts/convex-spend-model.mjs');
const { guard, query } = await import(moduleUrl('../convex/cliServer.ts'));
const { sourceStepCause, logSourceStep } = await import(moduleUrl('../src/hosted-source-io-error.ts'));
const completion = JSON.parse(
  readFileSync(new URL('./fixtures/benchmark/completions.json', import.meta.url)),
).action;

function captured(t, method = 'log') {
  const lines = [];
  t.mock.method(console, method, (...args) => lines.push(args.join(' ')));
  return lines;
}
const device = { subject: 'user_cli', forgeCredential: 'credential' };
// An action context: the device check is a nested query, answered here with no credential row.
const actionCtx = user => ({ auth: { getUserIdentity: async () => user }, runQuery: async () => null });

test('a public call records one caller kind; only a CLI credential may declare agent', async t => {
  const lines = captured(t);
  await guard(actionCtx(null), 'cli', {});
  await guard(actionCtx({ subject: 'session-user' }), 'cli', { declared: 'agent' });
  await guard(actionCtx(device), 'cli', {});
  await guard(actionCtx(device), 'cli', { declared: 'agent' });
  // A handler's inner check and an action's post-run check record nothing.
  await guard(actionCtx(device), 'cli');
  assert.deepEqual(lines, [
    'FORGE_CALLER public',
    'FORGE_CALLER web',
    'FORGE_CALLER cli',
    'FORGE_CALLER agent',
  ]);
});

test('the declared caller is accepted by a guarded builder and never reaches the handler', async t => {
  const lines = captured(t);
  let seen;
  const fn = query({
    args: { projectId: v.optional(v.string()) },
    returns: v.null(),
    handler: async (_ctx, args) => {
      seen = args;
      return null;
    },
  });
  assert.ok(JSON.parse(fn.exportArgs()).value.forgeCaller, 'every guarded function declares the field');
  await fn._handler(
    { auth: { getUserIdentity: async () => null }, db: {} },
    { projectId: 'p', forgeCaller: 'agent' },
  );
  assert.deepEqual(seen, { projectId: 'p' });
  assert.deepEqual(lines, ['FORGE_CALLER public']);
});

test('the spend ledger splits calls by caller and source steps by cause, keeping only code words', () => {
  const log = (id, messages, io, extra = {}) => ({
    ...structuredClone(completion),
    identifier: 'projectSelfMetrics.js:page',
    requestId: id,
    executionId: id,
    logLines: messages.map(message => ({ messages: [message] })),
    usageStats: { ...completion.usageStats, databaseIoReadBytes: io, databaseIoWriteBytes: 0 },
    ...extra,
  });
  const step = (cause, path) =>
    JSON.stringify({ event: 'forge-source-step', job: 'j', step: 1, kind: 'compose', cause, path });
  const events = [
    spendEvent(log('a', ['FORGE_CALLER agent'], 300), 'dev'),
    spendEvent(log('b', ['FORGE_CALLER agent'], 200), 'dev'),
    spendEvent(log('c', ['FORGE_CALLER cli'], 50), 'dev'),
    // CI reaches Convex only through its result routes.
    spendEvent(log('ci', [], 5, { identifier: 'POST /checks/actions' }), 'dev'),
    // No caller line: scheduled, nested or an HTTP route.
    spendEvent(log('d', [], 7), 'dev'),
    // Not a known word, or two kinds in one call: no claim is kept.
    spendEvent(log('e', ['FORGE_CALLER root'], 1), 'dev'),
    spendEvent(log('f', ['FORGE_CALLER agent', 'FORGE_CALLER web'], 1), 'dev'),
    spendEvent(
      log('g', [step('recompose', 'node-full')], 11, { identifier: 'projectConvexSourceNode.js:step' }),
      'dev',
    ),
    spendEvent(
      log('h', [step('compose'), step('recompose')], 13, { identifier: 'projectConvexSourceNode.js:step' }),
      'dev',
    ),
  ];
  assert.deepEqual(
    events.map(event => event.caller),
    ['agent', 'agent', 'cli', 'ci', 'internal', 'internal', 'internal', 'internal', 'internal'],
  );
  assert.deepEqual(
    events.map(event => event.attribution ?? null),
    [null, null, null, null, null, null, null, 'source-step/recompose/node-full', null],
  );
  for (const [cause, path] of [
    ['compose', 'v8-small'],
    ['precompose', 'v8-small'],
    ['recompose', 'node-full'],
    ['batch-compose', 'node-full'],
    ['batch-recompose', 'node-full'],
    ['batch-recompose', 'node-fast-disjoint'],
  ]) {
    const event = spendEvent(log(cause, [step(cause, path)], 0), 'dev');
    assert.equal(event.attribution, `source-step/${cause}/${path}`);
    const [row] = daySummary(event.day, [event]).perAttribution;
    assert.deepEqual(row.usage, event.usage);
  }
  assert.equal(spendEvent(log('legacy', [step('compose')], 0), 'dev').attribution, 'source-step/compose');
  assert.equal(
    spendEvent(log('mixed-path', [step('compose', 'v8-small'), step('compose', 'node-full')], 0), 'dev')
      .attribution,
    undefined,
  );
  const report = daySummary(events[0].day, events);
  assert.deepEqual(
    report.perCaller
      .map(({ caller, usage }) => [caller, usage.calls, usage.io])
      .sort(([a], [b]) => a.localeCompare(b)),
    [
      ['agent', 2, 500],
      ['ci', 1, 5],
      ['cli', 1, 50],
      ['internal', 5, 33],
    ],
  );
  // Rows recorded before caller kinds existed stay out of the split.
  const { caller: _old, ...legacy } = events[2];
  assert.deepEqual(daySummary(legacy.day, [legacy]).perCaller, []);
});

test('a source step names its cause from the state it already loaded', t => {
  const compose = cause => ({
    cause,
    main: { object: { sha256: 'same-head' } },
    request: { expectedMain: { head: 'same-head' } },
  });
  assert.equal(sourceStepCause('save', null), 'save');
  assert.equal(sourceStepCause('register-state', null), 'register');
  assert.equal(sourceStepCause('sync', { work: { mode: 'resolve' } }), 'resolve');
  for (const cause of ['compose', 'recompose', 'precompose', 'batch-compose', 'batch-recompose'])
    assert.equal(sourceStepCause('compose', compose(cause)), cause);
  assert.equal(sourceStepCause('compose', { batch: {} }), 'batch-compose');
  assert.equal(sourceStepCause('compose', {}), 'compose');
  const lines = captured(t, 'warn');
  const fields = {
    runtime: 'node',
    kind: 'compose',
    path: 'node-full',
    from: 'input',
    to: 'done',
    objects: 0,
    bytes: 0,
    outputs: 0,
  };
  logSourceStep({ jobId: 'j', step: 0 }, { ...fields, cause: 'recompose', started: performance.now() });
  logSourceStep({ jobId: 'j', step: 1 }, { ...fields, cause: 'Not A Code', started: performance.now() });
  assert.equal(JSON.parse(lines[0]).cause, 'recompose');
  assert.equal(JSON.parse(lines[0]).path, 'node-full');
  assert.equal('cause' in JSON.parse(lines[1]), false);
});

test('an agent CLI declares itself; only a validator refusal of the field is sent again, without it', async t => {
  const bodies = [];
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    bodies.push(body.args[0]);
    res.setHeader('content-type', 'application/json');
    if (body.path === 'app:write')
      return res.end(
        JSON.stringify({
          status: 'error',
          errorMessage: 'Uncaught Error: src/forgeCaller.ts failed after writing',
        }),
      );
    res.end(
      JSON.stringify(
        'forgeCaller' in body.args[0]
          ? {
              status: 'error',
              errorMessage:
                'ArgumentValidationError: Object contains extra field `forgeCaller` that is not in the validator.',
            }
          : { status: 'success', value: 7 },
      ),
    );
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const argv = process.argv;
  process.argv = [argv[0], argv[1], 'agent'];
  t.after(() => (process.argv = argv));
  const { deadlineConvexClient } = await import('../dist/network-convex-client.js');
  const client = deadlineConvexClient(`http://127.0.0.1:${server.address().port}`, {
    skipConvexDeploymentUrlCheck: true,
    logger: false,
  });
  const ref = makeFunctionReference('old:read');
  assert.equal(await client.query(ref, { id: 1 }), 7);
  assert.equal(await client.query(ref, { id: 2 }), 7);
  assert.deepEqual(bodies, [{ id: 1, forgeCaller: 'agent' }, { id: 1 }, { id: 2 }]);
  // Any other error, even one naming the field, is the handler's own: never sent twice.
  await assert.rejects(client.mutation(makeFunctionReference('app:write'), { id: 3 }), /forgeCaller\.ts/);
  assert.deepEqual(bodies.at(-1), { id: 3, forgeCaller: 'agent' });
  assert.equal(bodies.length, 4);
});
