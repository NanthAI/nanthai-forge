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
