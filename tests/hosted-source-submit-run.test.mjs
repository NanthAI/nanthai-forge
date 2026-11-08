// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { driveAgentSource } from '../dist/hosted-agent-source.js';
import { savePin, saveBytes } from '../dist/hosted-save.js';
import { moduleUrl } from './convex-module.mjs';

// source-submit-run (1eef1b43): a sync or compose uploads its input without committing it, and one
// projectSourceRun:submit action commits it, submits and runs the first step.

function session(features) {
  const calls = [],
    operationId = randomUUID(),
    input = { schema: 1, kind: 'forge-hosted-sync-input', operationId };
  return {
    calls,
    operationId,
    input,
    session: {
      capabilities: { features },
      exchange: {
        upload: async pin => calls.push(['upload', pin.sha256]),
        uploadLazyBatch: async (objects, options) => {
          assert.equal(objects.length, 1);
          assert.deepEqual(Buffer.from(await objects[0].read()), Buffer.from(saveBytes(input)));
          calls.push(['uploadLazyBatch', objects[0].pin.sha256]);
          options.deferCommit.push({ id: 'object-1' });
        },
      },
      mutation: async (name, args) => {
        calls.push([name, args]);
        return name.endsWith(':prepare') ? { terminal: null, input } : { status: 'submitted', jobId: 'job' };
      },
      query: async name => assert.fail(`no ${name}`),
      action: async (name, args) => {
        calls.push([name, args]);
        return { status: 'submitted', jobId: 'job' };
      },
    },
  };
}

test('a sync with source-submit-run commits its input inside the one submit action', async () => {
  const run = session(['source-submit-run']);
  const result = await driveAgentSource(run.session, 'Sync', run.operationId, {
    operationId: run.operationId,
  });
  assert.deepEqual(result, { status: 'submitted', jobId: 'job' });
  assert.deepEqual(
    run.calls.map(call => call[0]),
    ['projectHostedSync:prepare', 'uploadLazyBatch', 'projectSourceRun:submit'],
  );
  assert.equal(run.calls[1][1], savePin(run.input).sha256);
  assert.deepEqual(run.calls[2][1], {
    operationId: run.operationId,
    kind: 'sync',
    objects: [{ id: 'object-1' }],
  });
});

test('a sync with prepare-upload-targets PUTs its input to the prepared target and sends it inline (1eef1b43)', async () => {
  const run = session(['source-submit-run', 'prepare-upload-targets', 'source-run-publish']);
  const targets = [{ id: 'object-2', stored: false, target: { url: 'https://r2.invalid/input' } }];
  const mutation = run.session.mutation;
  run.session.mutation = async (name, args) => {
    const reply = await mutation(name, args);
    return name.endsWith(':prepare') ? { ...reply, targets } : reply;
  };
  run.session.exchange.uploadPrepared = async (objects, rows, deferred) => {
    assert.equal(rows, targets);
    assert.equal(objects.length, 1);
    assert.deepEqual(Buffer.from(await objects[0].read()), Buffer.from(saveBytes(run.input)));
    run.calls.push(['uploadPrepared', objects[0].pin.sha256]);
    deferred.push({ id: 'object-2' });
  };
  const published = { terminal: { outcome: { status: 'completed' } }, state: { submittedAt: 1 } };
  run.session.action = async (name, args) => {
    run.calls.push([name, args]);
    return published;
  };
  const result = await driveAgentSource(run.session, 'Sync', run.operationId, {
    operationId: run.operationId,
  });
  assert.equal(result, published);
  assert.deepEqual(
    run.calls.map(call => call[0]),
    ['projectHostedSync:prepare', 'uploadPrepared', 'projectSourceRun:submit'],
  );
  assert.equal(run.calls[0][1].targets, true);
  assert.deepEqual(run.calls[2][1], {
    operationId: run.operationId,
    kind: 'sync',
    objects: [{ id: 'object-2' }],
    progress: true,
    input: Buffer.from(saveBytes(run.input)).toString('utf8'),
  });
});

test('a sync whose client cannot PUT to prepared targets does not ask for them', async () => {
  const run = session(['source-submit-run', 'prepare-upload-targets']);
  await driveAgentSource(run.session, 'Sync', run.operationId, { operationId: run.operationId });
  assert.equal(run.calls[0][1].targets, undefined);
  assert.equal(run.calls[1][0], 'uploadLazyBatch');
});

test('a compose without the feature keeps the committing upload and the submit mutation', async () => {
  const run = session([]);
  await driveAgentSource(run.session, 'Compose', run.operationId, { operationId: run.operationId });
  assert.deepEqual(
    run.calls.map(call => call[0]),
    ['projectHostedCompose:prepare', 'upload', 'projectHostedComposeJobs:submit'],
  );
});

test('projectSourceRun:submit refuses an unauthenticated caller before any commit or submit', async () => {
  const { submit } = await import(moduleUrl('../convex/projectSourceRun.ts'));
  const touched = [];
  const ctx = {
    auth: { getUserIdentity: async () => null },
    runQuery: async () => touched.push('query'),
    runMutation: async () => touched.push('mutation'),
    runAction: async () => touched.push('action'),
  };
  await assert.rejects(
    submit._handler(ctx, {
      projectId: 'project',
      operationId: randomUUID(),
      kind: 'save',
      objects: [{ id: 'object-1' }],
    }),
    error => error.data?.code === 'PROJECT_UNAVAILABLE',
  );
  assert.deepEqual(touched, []);
});

test('projectSourceRunStore:submit takes a delta page only for a save', async () => {
  const { submit } = await import(moduleUrl('../convex/projectSourceRunStore.ts'));
  await assert.rejects(
    submit._handler(
      {},
      {
        projectId: 'project',
        operationId: randomUUID(),
        actor: 'owner',
        kind: 'sync',
        index: 0,
        page: '{}',
      },
    ),
    error => error.data?.code === 'BAD_ARGUMENT',
  );
});

test('a submit reply that already holds the published outcome ends the wait at once and still gives its server timing (source-run-publish)', async () => {
  const { waitHostedAgentSource } = await import('../dist/hosted-agent-source-wait.js');
  const reply = {
    terminal: { outcome: { status: 'completed', result: { status: 'clean' } } },
    state: { submittedAt: 1, serverTiming: { steps: [] } },
  };
  const seen = [];
  const result = await waitHostedAgentSource(
    { url: 'https://fixture.invalid', projectId: 'project' },
    randomUUID(),
    reply,
    undefined,
    () => assert.fail('no subscription for a published reply'),
    'Sync',
    60,
    value => seen.push(value),
  );
  assert.deepEqual(result, reply.terminal);
  assert.deepEqual(seen, [reply]);
});

test('only a save settles in the background (save-settle-background, fea47345 C)', async () => {
  const run = await import(moduleUrl('../convex/projectSourceRun.ts'));
  const touched = [];
  const ctx = {
    auth: { getUserIdentity: async () => ({ subject: 'owner' }) },
    runQuery: async () => touched.push('query'),
    runMutation: async () => touched.push('mutation'),
    runAction: async () => touched.push('action'),
  };
  for (const kind of ['sync', 'compose'])
    await assert.rejects(
      run.submit._handler(ctx, {
        projectId: 'project',
        operationId: randomUUID(),
        kind,
        settle: 'background',
      }),
      error => error.data?.code === 'BAD_ARGUMENT',
    );
  assert.deepEqual(touched, [], 'refused before any commit or submit');
  const store = await import(moduleUrl('../convex/projectSourceRunStore.ts'));
  await assert.rejects(
    store.submit._handler(
      {},
      { projectId: 'project', operationId: randomUUID(), actor: 'owner', kind: 'sync', background: true },
    ),
    error => error.data?.code === 'BAD_ARGUMENT',
  );
});
