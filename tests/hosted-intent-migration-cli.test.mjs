// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { getFunctionName } from 'convex/server';
import { ConvexError } from 'convex/values';
import { dispatchHostedWork } from '../dist/hosted-work-client.js';
import { setup } from './hosted-planning-fixture.mjs';
import { moduleUrl } from './convex-module.mjs';
const actions = await import(moduleUrl('../convex/projectIntentMigrationActions.ts'));
const migration = await import(moduleUrl('../convex/projectIntentMigration.ts'));
const index = await import(moduleUrl('../convex/projectWorkIndexStore.ts'));

async function fixture(t) {
  const s = await setup(t);
  const original = s.ctx.runQuery;
  s.ctx.runQuery = s.ctx.runMutation = (ref, args) => {
    const [module, name] = getFunctionName(ref).split(':');
    return (
      { projectIntentMigration: migration, projectWorkIndexStore: index }[module]?.[name]?._handler(
        s.ctx,
        args,
      ) ?? original(ref, args)
    );
  };
  return s;
}

test('hosted migration dispatch retains the original operation, skips workspace refresh, and validates requests', async () => {
  const operationId = randomUUID(),
    calls = [];
  const client = {
    query: async () => {
      throw Error('must not refresh workspace pins');
    },
    action: async (ref, args) => {
      calls.push([getFunctionName(ref), args]);
      return 'generation';
    },
  };
  const command = { action: 'migrate-intents', operationId };
  assert.deepEqual(await dispatchHostedWork(client, 'project', command), {
    operationId,
    generationId: 'generation',
  });
  await dispatchHostedWork(client, 'project', command);
  assert.deepEqual(
    calls,
    Array(2).fill(['projectIntentMigrationActions:migrate', { projectId: 'project', operationId }]),
  );
  for (const patch of [
    { operationId: 'invalid' },
    { operationId: undefined },
    { dryRun: 'true' },
    { revision: 1 },
  ])
    await assert.rejects(
      dispatchHostedWork(client, 'project', { ...command, ...patch }),
      e => e.code === 'BAD_ARGUMENT',
    );
  assert.equal(calls.length, 2);
});

test('progress reports retained batches and completion while preserving operation UUID across observations', async () => {
  const operationId = randomUUID(),
    lines = [],
    calls = [];
  let queries = 0,
    complete;
  const completion = new Promise(resolve => {
    complete = resolve;
  });
  const client = {
    query: async (ref, args) => {
      calls.push([getFunctionName(ref), args]);
      queries++;
      if (queries === 2) complete('generation');
      return {
        operationId,
        state: 'building',
        generationId: 'generation',
        revision: 5,
        batches: queries + 2,
      };
    },
    action: (ref, args) => {
      calls.push([getFunctionName(ref), args]);
      return completion;
    },
  };
  const result = await dispatchHostedWork(
    client,
    'project',
    { action: 'migrate-intents', operationId },
    line => lines.push(line),
  );
  assert.equal(result.generationId, 'generation');
  assert.ok(lines.some(line => line.includes('3 staged batches')));
  assert.ok(lines.some(line => line.includes('4 staged batches')));
  assert.ok(lines.at(-1).includes('completed; generation generation'));
  assert.ok(calls.every(([, args]) => args.operationId === operationId && args.projectId === 'project'));
});

test('failed migration preserves structured errors, reports resumability, and never claims completion', async () => {
  const operationId = randomUUID(),
    lines = [];
  const client = {
    query: async () => ({ operationId, state: 'pending', generationId: null, revision: 5, batches: 0 }),
    action: async () => {
      throw new ConvexError({ code: 'PROJECT_UNAVAILABLE', message: 'Owner access required.' });
    },
  };
  await assert.rejects(
    dispatchHostedWork(client, 'project', { action: 'migrate-intents', operationId }, line =>
      lines.push(line),
    ),
    e => e.code === 'PROJECT_UNAVAILABLE',
  );
  assert.ok(lines.at(-1).includes('resume with the same operationId'));
  assert.ok(lines.every(line => !line.includes('completed')));
  client.action = async () => {
    throw Error('private backend details');
  };
  await assert.rejects(
    dispatchHostedWork(client, 'project', { action: 'migrate-intents', operationId }),
    e => e.code === 'HOSTED_WORK_REQUEST_FAILED' && !e.message.includes('private'),
  );
});

test('an unavailable progress read leaves the original action result authoritative', async () => {
  const operationId = randomUUID(),
    lines = [];
  let queries = 0,
    complete;
  const completion = new Promise(resolve => {
    complete = resolve;
  });
  const client = {
    query: async () => {
      if (++queries > 1) {
        complete('retained');
        throw Error('private progress error');
      }
      return { operationId, state: 'building', generationId: 'retained', revision: 5, batches: 3 };
    },
    action: () => completion,
  };
  const result = await dispatchHostedWork(
    client,
    'project',
    { action: 'migrate-intents', operationId },
    line => lines.push(line),
  );
  assert.equal(result.generationId, 'retained');
  assert.ok(lines.some(line => line.includes('progress unavailable')));
  assert.ok(!lines.join().includes('private'));
});

test('dry run reports conversion counts without mutations; actual migration resumes staged batches and rechecks owner', async t => {
  const s = await fixture(t),
    operationId = randomUUID();
  await s.send(s.item());
  const before = structuredClone(s.tables);
  const originalMutation = s.ctx.runMutation;
  s.ctx.runMutation = () => {
    throw Error('dry run must not mutate');
  };
  const preview = JSON.parse(await actions.preview._handler(s.ctx, { projectId: s.projectId }));
  assert.equal(preview.dryRun, true);
  assert.equal(preview.alreadyUnified, false);
  assert.equal(preview.counts.before.intents, 0);
  assert.equal(preview.counts.before.issues, 1);
  assert.equal(preview.counts.after.intents, 1);
  assert.equal(preview.counts.foldedPairs, 0);
  assert.deepEqual(s.tables, before);
  s.ctx.runMutation = originalMutation;
  let interrupted = false;
  s.ctx.runMutation = async (ref, args) => {
    const result = await originalMutation(ref, args);
    if (!interrupted && getFunctionName(ref) === 'projectWorkIndexStore:batch') {
      interrupted = true;
      throw new ConvexError({ code: 'SYNTHETIC_LOST_REPLY', message: 'Synthetic lost batch reply' });
    }
    return result;
  };
  const input = { projectId: s.projectId, operationId };
  await assert.rejects(actions.migrate._handler(s.ctx, input));
  assert.equal(interrupted, true);
  const progress = await migration.progress._handler(s.ctx, input);
  assert.equal(progress.state, 'building');
  assert.ok(progress.batches > 0);
  assert.notEqual(s.tables.hostedProjects.get(s.projectId).work.generationId, progress.generationId);
  s.ctx.runMutation = async (ref, args) => {
    if (getFunctionName(ref) === 'projectWorkIndexStore:batch')
      assert.ok(args.batch >= progress.batches, 'resume skips batches with retained receipts');
    return originalMutation(ref, args);
  };
  assert.equal(await actions.migrate._handler(s.ctx, input), progress.generationId);
  assert.equal((await migration.progress._handler(s.ctx, input)).state, 'completed');
  assert.equal(await actions.migrate._handler(s.ctx, input), progress.generationId);
  const unified = JSON.parse(await actions.preview._handler(s.ctx, { projectId: s.projectId }));
  assert.equal(unified.alreadyUnified, true);
  assert.equal(unified.counts.after.intents, 1);
  assert.deepEqual(unified.counts.before, unified.counts.after);
  s.caller('contributor');
  for (const [fn, args] of [
    [actions.preview, { projectId: s.projectId }],
    [migration.progress, input],
    [actions.migrate, input],
  ])
    await assert.rejects(fn._handler(s.ctx, args), e => e.data?.code === 'PROJECT_UNAVAILABLE');
});

test('actual hosted-work CLI keeps dry-run and migration JSON separate from resumable progress', async t => {
  const s = await fixture(t),
    paths = [];
  const modules = { projectIntentMigration: migration, projectIntentMigrationActions: actions };
  const server = createServer(async (request, response) => {
    try {
      assert.equal(request.headers.authorization, 'Bearer synthetic-migration-jwt');
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks)),
        [module, name] = body.path.split(':');
      paths.push(body.path);
      const value = await modules[module][name]._handler(s.ctx, body.args[0]);
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ status: 'success', value, logLines: ['private backend log'] }));
    } catch (error) {
      response.writeHead(560, { 'Content-Type': 'application/json' });
      response.end(
        JSON.stringify({ status: 'error', errorMessage: 'Request failed', errorData: error.data }),
      );
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const operationId = randomUUID();
  const run = command =>
    promisify(execFile)(
      process.execPath,
      [
        'dist/cli.js',
        'hosted-work',
        `http://127.0.0.1:${server.address().port}`,
        s.projectId,
        JSON.stringify(command),
      ],
      {
        env: { ...process.env, FORGE_AUTH_TOKEN: 'synthetic-migration-jwt' },
      },
    );
  const command = { action: 'migrate-intents', operationId };
  const preview = await run({ ...command, dryRun: true });
  assert.equal(JSON.parse(preview.stdout).dryRun, true);
  assert.equal(preview.stderr, '');
  assert.deepEqual(paths, ['projectIntentMigrationActions:preview']);
  const result = await run(command),
    retry = await run(command);
  assert.equal(JSON.parse(result.stdout).operationId, operationId);
  assert.deepEqual(JSON.parse(result.stdout), JSON.parse(retry.stdout));
  assert.ok(result.stderr.includes(operationId));
  assert.ok(retry.stderr.includes('completed; revision'));
  assert.ok(![result.stdout, result.stderr, preview.stdout].join().includes('synthetic-migration-jwt'));
  assert.ok(!result.stdout.includes('private backend log'));
});
