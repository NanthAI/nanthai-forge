// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { getFunctionName } from 'convex/server';
import { waitForGithubConnection, githubConnectCli } from '../dist/github-connect-cli.js';
const address = { url: 'https://forge.example', projectId: 'synthetic-project' };
test('GitHub connect waits on one operation subscription, closes when complete, and never polls', async () => {
  const operationId = randomUUID(),
    calls = [];
  let emit;
  const promise = waitForGithubConnection(address, operationId, undefined, () => ({
    onUpdate: (ref, args, update) => {
      calls.push([getFunctionName(ref), args]);
      emit = update;
      return () => calls.push('unsubscribe');
    },
    close: async () => {
      calls.push('close');
    },
  }));
  emit(JSON.stringify({ operationId, status: 'waiting', code: null, repoId: null }));
  emit(JSON.stringify({ operationId, status: 'completed', code: null, repoId: 42 }));
  assert.equal((await promise).repoId, 42);
  assert.deepEqual(calls, [
    ['githubBindingStore:status', { projectId: address.projectId, operationId }],
    'unsubscribe',
    'close',
  ]);
});
test('GitHub connect cancellation and subscription errors close all observation resources', async () => {
  for (const failure of [false, true]) {
    const controller = new AbortController(),
      calls = [];
    let error;
    const promise = waitForGithubConnection(address, randomUUID(), controller.signal, () => ({
      onUpdate: (_ref, _args, _update, reject) => {
        error = reject;
        return () => calls.push('unsubscribe');
      },
      close: async () => {
        calls.push('close');
      },
    }));
    if (failure) {
      error(new Error('synthetic-disconnect'));
      await assert.rejects(promise, /synthetic-disconnect/);
    } else {
      controller.abort();
      assert.equal((await promise).status, 'cancelled');
    }
    assert.deepEqual(calls, ['unsubscribe', 'close']);
  }
});
test('GitHub CLI exposes connect/status/disconnect and rejects malformed invocation before network IO', async () => {
  assert.match((await githubConnectCli(['--help'])).usage, /connect\|status\|disconnect/);
  await assert.rejects(githubConnectCli(['connect']), error => error.code === 'BAD_ARGUMENT');
});
