// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { moduleUrl } from './convex-module.mjs';
import { recordAgentActivity } from '../dist/agent-activity.js';
import { readHostState } from '../dist/host-binding.js';
import { hostCli } from '../dist/host-command.js';
import { CUTOVER_UPGRADE } from '../dist/cutover-version.js';
import { state } from './hosted-fixture.mjs';
import { HOSTED_WORK_INDEX_FORMAT } from '../dist/work-hosted-summary.js';
const relay = await import(moduleUrl('../convex/ownerAcceptance.ts'));
const lifecycle = await import(moduleUrl('../convex/ownerLifecycle.ts'));
const sync = await import(moduleUrl('../convex/projectOwnerSync.ts'));
const github = await import(moduleUrl('../convex/projectGithubStatus.ts'));
const upgrade = error => {
  assert.equal(error.data?.code ?? error.code, 'CLI_UPGRADE_REQUIRED');
  assert.equal(error.data?.message ?? error.message, CUTOVER_UPGRADE);
  return true;
};
test('all retired relay RPCs return upgrade instructions without accessing source, records or scheduling', async () => {
  const ctx = new Proxy(
    { auth: { getUserIdentity: async () => ({ subject: 'owner' }) } },
    {
      get(target, key) {
        if (key in target) return target[key];
        assert.fail('retired RPC accessed the runtime');
      },
    },
  );
  for (const fn of [
    relay.request,
    relay.status,
    relay.pending,
    relay.poll,
    relay.complete,
    relay.route,
    lifecycle.request,
    sync.publish,
  ])
    await assert.rejects(fn._handler(ctx, {}), upgrade);
});
test('retired CLI switches fail before constructing an owner or starting workers', async () => {
  for (const flag of ['--listen', '--sync-agent', '--auto-sync', '--no-auto-sync'])
    await assert.rejects(hostCli(['/missing/synthetic-owner', flag]), upgrade);
});
test('dogfood activity observes 560 selected Lanes with zero network calls or source/Work hydration', t => {
  const root = mkdtempSync(join(tmpdir(), 'forge-local-activity-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const directory = join(root, '.forge');
  mkdirSync(directory);
  const intents = new Map(
    Array.from({ length: 600 }, () => {
      const id = randomUUID();
      return [id, { id, outcome: 'Synthetic activity', status: 'active' }];
    }),
  );
  const lanes = new Map(
    [...intents.values()].slice(0, 560).map(intent => {
      const id = randomUUID();
      return [id, { id, intentId: intent.id, base: 'a'.repeat(64), head: 'b'.repeat(64), state: 'active' }];
    }),
  );
  const view = { id: randomUUID(), inputs: [...lanes.keys()].map(laneId => ({ laneId })) };
  let selections = 0,
    observations = 0,
    calls = 0;
  t.mock.method(globalThis, 'fetch', () => {
    calls++;
    assert.fail('local presence sent network traffic');
  });
  const store = {
    root,
    directory,
    revision: () => 2800,
    observing(run) {
      observations++;
      return run();
    },
    select(collection, id, field, compact) {
      if (collection !== 'views') assert.equal(compact, true);
      selections++;
      return collection === 'views' ? view : { lanes, intents }[collection].get(id);
    },
    load() {
      assert.fail('full Work was hydrated');
    },
    page() {
      assert.fail('history was scanned');
    },
  };
  const started = performance.now(),
    memory = process.memoryUsage().heapUsed;
  assert.equal(
    recordAgentActivity(
      store,
      { action: 'accept', viewId: view.id },
      { acceptanceId: randomUUID(), viewId: view.id },
    ).status,
    'recorded',
  );
  const heapGrowth = process.memoryUsage().heapUsed - memory;
  const presence = readHostState(store);
  assert.equal(Object.keys(presence.presence).length, 560);
  assert.ok(Object.values(presence.presence).every(row => row.status === 'completed'));
  assert.equal(presence.agentSync, undefined);
  assert.equal(calls, 0);
  assert.equal(selections, 1121);
  assert.equal(observations, 1);
  assert.ok(heapGrowth < 32 * 1024 * 1024, `heap growth ${heapGrowth}`);
  t.diagnostic(
    JSON.stringify({
      lanes: 560,
      intents: 600,
      calls,
      documentsRead: 0,
      documentsWritten: 0,
      selections,
      heapGrowthBytes: heapGrowth,
      peakRssBytes: process.resourceUsage().maxRSS * 1024,
      wallMs: Math.round(performance.now() - started),
    }),
  );
});
function githubFixture() {
  const s = state([]);
  s.tables.hostedProjects.set('project', {
    _id: 'project',
    owner: 'owner',
    key: randomUUID(),
    name: 'Synthetic',
    revision: 0,
    currentBackup: 'backup',
    work: { generationId: 'generation', backupId: 'backup', initialRevision: 0, revision: 0 },
  });
  s.tables.projectWorkGenerations.set('generation', {
    _id: 'generation',
    projectId: 'project',
    backupId: 'backup',
    format: HOSTED_WORK_INDEX_FORMAT,
    status: 'ready',
    revision: 0,
    initialRevision: 0,
    metadata: JSON.stringify({ counts: {} }),
  });
  const entry = {
    collection: 'githubSync',
    key: 'github',
    parent: '',
    value: { id: 'github', repository: 'example/synthetic', branch: 'main' },
  };
  const input = {
    projectId: 'project',
    operationId: randomUUID(),
    metadata: JSON.stringify({ ownerId: randomUUID(), revision: 1, entries: [entry] }),
  };
  return { ...s, input, entry };
}
test('GitHub status preserves idempotence and refuses non-mirror state or unauthorized publication', async () => {
  const f = githubFixture();
  await github.publish._handler(f.ctx, f.input);
  const original = structuredClone([...f.tables.projectWorkRecords.values()]);
  await github.publish._handler(f.ctx, f.input);
  assert.deepEqual([...f.tables.projectWorkRecords.values()], original);
  assert.ok(original.some(row => row.collection === 'githubSync'));
  await assert.rejects(
    github.publish._handler(f.ctx, {
      ...f.input,
      metadata: JSON.stringify({
        ...JSON.parse(f.input.metadata),
        entries: [{ ...f.entry, collection: 'lanes' }],
      }),
    }),
    error => error.data?.code === 'BAD_ARGUMENT',
  );
  f.caller('outsider');
  await assert.rejects(
    github.publish._handler(f.ctx, f.input),
    error => error.data?.code === 'PROJECT_UNAVAILABLE',
  );
  assert.deepEqual([...f.tables.projectWorkRecords.values()], original);
});
