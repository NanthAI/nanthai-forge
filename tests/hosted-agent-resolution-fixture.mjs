// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { getFunctionName } from 'convex/server';
import { moduleUrl } from './convex-module.mjs';
import { revertFixture, synthetic } from './hosted-revert-fixture.mjs';
import { HostedAgentTransport } from '../dist/hosted-agent-transport.js';
import { digest } from '../dist/hash.js';
const names = [
  'projectHostedAgent',
  'projectHostedChannels',
  'projectHostedLanes',
  'projectObjectDownloads',
  'projectHostedCompose',
  'projectHostedComposeSelection',
  'projectHostedComposeJobs',
  'projectHostedSync',
  'projectHostedSyncJobs',
  'projectHostedLanding',
  'projectHostedLandingDesired',
  'projectHostedFinish',
  'projectHostedCheckDefinitions',
  'projectHostedChecks',
  'projectHostedLifecycle',
  'projectHostedStart',
  'projectHostedSaves',
  'projectHostedSaveJobs',
];
const modules = Object.fromEntries(
  await Promise.all(names.map(async name => [name, await import(moduleUrl(`../convex/${name}.ts`))])),
);
const prior = Object.fromEntries(Object.keys(synthetic).map(key => [key, process.env[key]]));
test.before(() => Object.assign(process.env, synthetic));
test.after(() => {
  for (const [key, value] of Object.entries(prior)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});
export async function resolutionFixture(t, options = {}) {
  const f = await revertFixture(t, options),
    directory = mkdtempSync(join(tmpdir(), 'forge-agent-api-'));
  t.after(() => rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  const root = join(directory, 'client'),
    address = { url: 'https://fixture.invalid', projectId: f.projectId },
    calls = [];
  let lost = null,
    eager = true;
  const invoke = async (ref, args) => {
    const name = getFunctionName(ref),
      [module, member] = name.split(':');
    assert(modules[module]?.[member], `Only synthetic registered API handlers: ${name}`);
    calls.push({ name, args: structuredClone(args) });
    let result;
    try {
      result = await f.tx(`agent:${name}`, modules[module][member], args);
      if (
        eager &&
        member === 'submit' &&
        /projectHosted(Compose|Sync|Save)Jobs/.test(module) &&
        JSON.parse(result).status === 'submitted'
      ) {
        const kind = module.match(/projectHosted(Compose|Sync|Save)Jobs/)[1];
        const table = {
          Compose: 'projectHostedComposes',
          Sync: 'projectHostedSyncs',
          Save: 'projectHostedSaves',
        }[kind];
        const state = [...f.tables[table].values()].find(row => row.operationId === args.operationId);
        const progressModule = modules[`projectHosted${kind === 'Save' ? 'Saves' : kind}`];
        const progress = JSON.parse(await f.tx('sourceProgress', progressModule.progress, args));
        const output = await f.c.compute(progress.input);
        const job = await f.c.activate(state.jobId);
        await f.c.callback(job, { status: 'completed', output: output.output });
        result = await f.tx(`agent:${module}:publish`, modules[module].publish, {
          projectId: f.projectId,
          jobId: job.id,
          result: output.manifest,
        });
        for (const task of f.pending().filter(task => task.args[0]?.jobId === job.id))
          f.patch('_scheduled_functions', task._id, { state: { kind: 'success' } });
      }
    } catch (error) {
      t.diagnostic(`Synthetic handler ${name}: ${error.message}`);
      throw error;
    }
    if (name === lost) {
      lost = null;
      throw new Error('Synthetic reply lost after transaction');
    }
    return result;
  };
  const exchange = {
    projectId: f.projectId,
    client: { query: invoke, mutation: invoke },
    upload: async (pin, value) => {
      assert.equal(digest(value), pin.sha256);
      f.c.put(value);
      return {};
    },
    uploadFile: async (pin, _directory, file) => {
      const bytes = readFileSync(join(_directory, file));
      assert.equal(digest(bytes), pin.sha256);
      f.c.put(bytes);
      return {};
    },
    missing: async pins => pins.filter(pin => !f.c.objects.has(pin.sha256)).map(pin => pin.sha256),
    objects: async ids => ids.map(sha256 => ({ sha256, size: f.c.objects.get(sha256).length })),
    downloadToFile: async (pin, path) => writeFileSync(path, f.c.objects.get(pin.sha256)),
    downloadBatch: async pins => pins.map(pin => f.c.objects.get(pin.sha256)),
    prepareDownloads: async () => {},
  };
  return {
    f,
    root,
    calls,
    address,
    exchange,
    eagerSource(value) {
      eager = value;
    },
    transport: (selectedRoot = root) => new HostedAgentTransport(selectedRoot, address, exchange),
    lose: name => {
      lost = name;
    },
  };
}
