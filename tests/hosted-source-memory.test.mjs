// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { getFunctionName } from 'convex/server';
import { moduleUrl } from './convex-module.mjs';
import { digest } from '../dist/hash.js';
import { provenancePlan } from '../dist/view-provenance-plan.js';
import { hostedActionError } from '../dist/hosted-action-error.js';
import { ConvexError } from 'convex/values';
const ancestry = await import(moduleUrl('../convex/projectWorkAncestry.ts'));
const { sourceParents } = ancestry;
const { viewStates } = await import(moduleUrl('../convex/projectSourceProjection.ts'));

function synthetic(count, width) {
  const heads = [],
    pins = [],
    indexes = new Map();
  function bytes(i) {
    return Buffer.from(
      JSON.stringify({
        schema: 1,
        kind: 'forge-source-state',
        parents: i ? [heads[i - 1]] : [],
        files: Array.from({ length: width }, (_, n) => ({
          path: `file-${n}.ts`,
          blob: digest(n === 0 ? `changed-${i}` : `stable-${n}`),
          mode: 'file',
        })),
        message: `save-${i}`,
        at: 'now',
      }),
    );
  }
  for (let i = 0; i < count; i++) {
    const value = bytes(i),
      sha256 = digest(value);
    heads.push(sha256);
    pins.push({ path: `objects/${sha256}`, sha256, size: value.length });
    indexes.set(sha256, i);
  }
  let reads = 0,
    invocationBytes = 0,
    invocations = 0;
  const ctx = {
    runQuery: async (ref, args) => {
      if (getFunctionName(ref) === 'projectObjects:resolve')
        return args.digests.map(id => ({
          projectId: 'project',
          storageId: id,
          digest: id,
          size: pins[indexes.get(id)].size,
        }));
      return {};
    },
    storage: {
      getMetadata: async id => ({ size: pins[indexes.get(id)].size, sha256: id }),
      get: async id => {
        reads++;
        return new Blob([bytes(indexes.get(id))]);
      },
    },
  };
  ctx.runAction = (ref, args) => {
    invocations++;
    invocationBytes = Math.max(
      invocationBytes,
      (args.pins ?? [args.before, args.after]).reduce((sum, pin) => sum + pin.size, 0),
    );
    return ancestry[getFunctionName(ref).split(':')[1]]._handler(ctx, args);
  };
  const data = {
    nativeHead: heads.at(-1),
    intents: [],
    channelMoves: [],
    runs: [],
    views: [
      {
        id: 'view',
        intentId: 'intent',
        base: heads[0],
        head: heads.at(-1),
        status: 'clean',
        at: 'now',
        inputs: [{ laneId: 'lane', head: heads.at(-1) }],
      },
    ],
    lanes: [
      {
        id: 'lane',
        intentId: 'intent',
        base: heads[0],
        head: heads.at(-1),
        checkpoints: heads
          .slice(1)
          .map((head, i) => ({ head, parent: heads[i], at: 'now', message: `save-${i}` })),
      },
    ],
  };
  return {
    ctx,
    data,
    heads,
    manifest: { kind: 'forge-native-work-backup', files: pins },
    backup: { projectId: 'project', _id: 'backup', transport: 'objects' },
    reads: () => reads,
    invocation: () => ({ bytes: invocationBytes, count: invocations }),
  };
}

test('large synthetic history retains parent pins and only changed-path save provenance', async t => {
  const s = synthetic(100, 500),
    budget = 1024 * 1024,
    logical = s.manifest.files.reduce((sum, pin) => sum + pin.size, 0);
  assert(logical > 5 * budget, 'old all-State retention exceeds the scaled test budget');
  const oldParents = await sourceParents(s.ctx, s.backup, s.manifest, s.data, 'owner', true);
  const beforeRetainedBytes = Buffer.byteLength(JSON.stringify([...oldParents.files]));
  assert(beforeRetainedBytes > 5 * budget);
  oldParents.files.clear();
  const parents = await sourceParents(s.ctx, s.backup, s.manifest, s.data, 'owner', false);
  assert.equal(parents.size, 100);
  assert.equal(parents.files.size, 0, 'ancestry keeps no historical file lists');
  const states = await viewStates(s.ctx, s, 'owner', 0);
  assert.equal(states.size, 100);
  assert.equal(
    [...states.values()].reduce((sum, files) => sum + files.length, 0),
    100,
  );
  const retained = Buffer.byteLength(JSON.stringify([...states]));
  assert(retained < budget);
  const files = provenancePlan(s.data, s.data.views[0], states);
  assert.equal(files.length, 1);
  assert.equal(files[0].contributors[0].saves.length, 99);
  assert.equal(files[0].historyComplete, true);
  assert(s.invocation().count >= 6, 'large history is split across action invocations');
  assert(
    s.invocation().bytes <= 2 * 1024 * 1024,
    'each parse invocation stays inside the source-byte budget',
  );
  t.diagnostic(
    JSON.stringify({
      logicalStateBytes: logical,
      beforeRetainedBytes,
      retainedProvenanceBytes: retained,
      rss: process.memoryUsage().rss,
    }),
  );
});

test('hosted action failures expose a typed resumable error and only the Convex request id', () => {
  const error = hostedActionError(
    new Error('[Request ID: a1b2c3] INTERNAL_ERROR secret-token private-source'),
    'source return',
  );
  assert.equal(error.code, 'HOSTED_ACTION_FAILED');
  assert.match(error.message, /a1b2c3/);
  assert.match(error.message, /Push again to resume/);
  assert.doesNotMatch(error.message, /secret-token|private-source|INTERNAL_ERROR/);
  assert.equal(
    hostedActionError(new ConvexError({ code: 'WORK_STALE', message: 'Reconcile current Work.' }), 'return')
      .code,
    'WORK_STALE',
  );
});

test('streamed multi-View projection equals complete source provenance and stable positions', async () => {
  const { workProjection } = await import(moduleUrl('../convex/projectSourceProjection.ts'));
  const { materializeWork } = await import('../dist/work-hosted-index.js');
  const s = synthetic(6, 20);
  Object.assign(s.data, {
    schema: 11,
    revision: 1,
    checks: [],
    planningItems: [],
    planningComments: [],
    hostedEvents: [],
  });
  Object.assign(s.manifest, { head: s.data.nativeHead, revision: 1 });
  s.data.views.push({ ...s.data.views[0], id: 'second-view' });
  const parents = await sourceParents(s.ctx, s.backup, s.manifest, s.data, 'owner');
  const expected = materializeWork(s.data, s.manifest, [], 'objects', parents);
  const projection = await workProjection(s.ctx, s, 'owner'),
    entries = [];
  for await (const batch of projection.batches()) entries.push(...batch);
  const sorted = rows =>
    rows.sort((a, b) =>
      JSON.stringify([a.collection, a.key]).localeCompare(JSON.stringify([b.collection, b.key])),
    );
  assert.deepEqual(sorted(entries), sorted(expected.entries));
  assert.deepEqual(projection.metadata, expected.metadata);
});

test('398-View history exceeds one Node action lifetime even when every child RPC is bounded', async () => {
  const { workProjection } = await import(moduleUrl('../convex/projectSourceProjection.ts'));
  const s = synthetic(120, 500);
  Object.assign(s.data, {
    schema: 11,
    revision: 1,
    checks: [],
    planningItems: [],
    planningComments: [],
    hostedEvents: [],
  });
  Object.assign(s.manifest, { head: s.data.nativeHead, revision: 1 });
  const view = s.data.views[0];
  s.data.views = Array.from({ length: 398 }, (_, i) => ({ ...view, id: `view-${i}` }));
  const indexes = new Map(s.heads.map((head, i) => [head, i]));
  let elapsedMs = 0,
    calls = 0,
    maxInputBytes = 0;
  // Model 300 ms RPC latency plus a 10 MiB/s source transfer. No sleeps or live
  // service calls: this is a deterministic lifetime regression, not a benchmark.
  s.ctx.runAction = async (ref, args) => {
    const pins = args.pins ?? [args.before, args.after];
    const bytes = pins.reduce((sum, p) => sum + p.size, 0);
    maxInputBytes = Math.max(maxInputBytes, bytes);
    elapsedMs += 300 + (bytes / (10 * 1024 * 1024)) * 1000;
    calls++;
    const file = head => ({ path: 'file-0.ts', blob: digest(head), mode: 'file' });
    if (getFunctionName(ref).endsWith(':changedStates'))
      return {
        before: [file(args.before.sha256)],
        after: [file(args.after.sha256)],
        paths: ['file-0.ts'],
      };
    return pins.map(pin => ({
      head: pin.sha256,
      parents: indexes.get(pin.sha256) ? [s.heads[indexes.get(pin.sha256) - 1]] : [],
      ...(args.paths ? { files: [file(pin.sha256)] } : {}),
    }));
  };
  const projection = await workProjection(s.ctx, s, 'owner');
  let exceeded = false;
  for await (const _batch of projection.batches()) {
    if (elapsedMs > 10 * 60 * 1000) {
      exceeded = true;
      break;
    }
  }
  assert(exceeded, `one coordinator crosses the documented ten-minute lifetime: ${elapsedMs}`);
  assert(maxInputBytes <= 2 * 1024 * 1024);
  assert(calls > 1000, 'small child invocations do not bound the parent action lifetime');
});
