// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { makeFunctionReference } from 'convex/server';
import { executeHostedMacCheck } from '../dist/hosted-mac-execute.js';
import { hostedCheckKey } from '../dist/worker-cli.js';
const parse = value => (typeof value === 'string' ? JSON.parse(value) : value);

/** One finite, harmless check on the scratch project. It uses the existing
 * collector credential; it never generates or changes a deployment secret. */
export async function runDrillCheck(client, exchange, address, machineId, until) {
  const query = async (name, args) =>
    parse(await client.query(makeFunctionReference(name), { projectId: address.projectId, ...args }));
  const mutation = async (name, args) =>
    parse(await client.mutation(makeFunctionReference(name), { projectId: address.projectId, ...args }));
  const action = async (name, args) =>
    parse(await client.action(makeFunctionReference(name), { projectId: address.projectId, ...args }));
  const current = await query('projectHostedCheckDefinitions:current', { checkId: '' });
  const capabilities = await query('projectHostedAgent:capabilities', {
    clientVersion: (await import('../dist/cutover-version.js')).CUTOVER_CLI_VERSION,
  });
  const sessionId = randomUUID();
  const registered = await mutation('projectHostedCheckWorker:register', {
    request: JSON.stringify({
      operationId: sessionId,
      authorityEpoch: capabilities.authority.epoch,
      configuration: current.configuration,
    }),
  });
  const key = hostedCheckKey(registered.result.keyId);
  const worker = { machineId, sessionId };
  const ids = await until(
    () => query('projectHostedCheckWorker:work', worker),
    value => value.length > 0,
  );
  assert.equal(ids.length, 1, 'the scratch drill owns exactly one check');
  const runId = ids[0];
  const control = command =>
    mutation('projectHostedCheckWorker:control', { ...worker, runId, command: JSON.stringify(command) });
  const claimed = await control({ kind: 'claim', owner: sessionId, leaseMs: 60_000 });
  assert(claimed.acquired, 'scratch check has one live execution owner');
  const entry = ({ message, signature }) => ({ message: JSON.stringify(message), signature });
  const output = {
    prepareBatch: entries =>
      mutation('projectHostedOutputBatch:workerPrepare', { entries: entries.map(entry) }),
    commitBatch: entries => action('projectHostedOutputBatch:workerCommit', { entries: entries.map(entry) }),
    prepare: (message, signature) =>
      mutation('projectHostedOutputApi:workerPrepare', entry({ message, signature })),
    commit: (message, signature) =>
      action('projectHostedOutputApi:workerCommit', entry({ message, signature })),
    put: async (url, headers, bytes) => ({
      status: (
        await fetch(url, {
          method: 'PUT',
          headers,
          body: bytes,
          redirect: 'error',
          signal: AbortSignal.timeout(30_000),
        })
      ).status,
    }),
  };
  await executeHostedMacCheck(
    claimed.run,
    AbortSignal.timeout(60_000),
    async command => (await control(command)).run,
    {
      objects: ids => exchange.objects(ids),
      downloadToFile: (pin, path) => exchange.downloadToFile(pin, path),
      upload: (pin, bytes) => exchange.upload(pin, bytes),
      callback: (callback, signature) =>
        mutation('projectHostedCheckWorker:callback', { callback: JSON.stringify(callback), signature }),
      output,
    },
    key,
  );
  const completed = await query('projectHostedCheckRead:status', { runId });
  assert.equal(completed.status, 'passed');
  return { runId, status: completed.status };
}
