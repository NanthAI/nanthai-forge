// SPDX-License-Identifier: Apache-2.0
import { randomUUID } from 'node:crypto';
import { getFunctionName } from 'convex/server';
import { moduleUrl } from './convex-module.mjs';
import { digest } from '../dist/hash.js';
import { workSchema } from '../dist/work-types.js';
import { buildWorkRecords } from '../dist/work-exchange-records.js';
const { projectSummaries } = await import(moduleUrl('../convex/projectWorkIndexBuildSummaries.ts'));
const { exchangeObjectReader } = await import(moduleUrl('../convex/projectExchangeReader.ts'));
const ancestry = await import(moduleUrl('../convex/projectWorkAncestry.ts'));
const diffstats = await import(moduleUrl('../convex/projectDiffstats.ts'));

/** Exact synthetic dogfood counts; source bytes are generated on demand so the
 * fake does not retain thousands of full trees in the coordinator's heap. */
export function callsFixture(scale = 1) {
  const n = count => Math.max(1, Math.ceil(count * scale));
  const objects = new Map(),
    generators = new Map(),
    files = [];
  const put = bytes => {
    const sha256 = digest(bytes);
    objects.set(sha256, bytes);
    return { sha256, size: bytes.length };
  };
  const old = put(Buffer.from('before\n'));
  const changed = Array.from({ length: 40 }, (_, i) => put(Buffer.from(`after ${i}\n`)));
  const tree = Array.from({ length: 3000 }, (_, i) => ({
    path: `src/file-${i}.ts`,
    blob: old.sha256,
    mode: 'file',
  }));
  const heads = [];
  for (let i = 0; i < n(2494); i++) {
    const make = () =>
      Buffer.from(
        JSON.stringify({
          schema: 1,
          kind: 'forge-source-state',
          parents: [],
          files: i ? tree.map((f, j) => (j < 40 ? { ...f, blob: changed[j].sha256 } : f)) : tree,
          message: `Synthetic ${i}`,
          at: 'now',
        }),
      );
    const bytes = make(),
      sha256 = digest(bytes);
    generators.set(sha256, make);
    files.push({ path: `objects/${sha256}`, sha256, size: bytes.length });
    heads.push(sha256);
  }
  for (const [sha256, bytes] of objects)
    files.push({ path: `objects/${sha256}`, sha256, size: bytes.length });
  const intentId = randomUUID();
  const base = heads[0],
    at = '2026-01-01T00:00:00.000Z';
  const data = workSchema.parse({
    schema: 17,
    revision: 1,
    nativeHead: base,
    intents: [],
    lanes: [],
    views: [],
  });
  data.intents.push({
    id: intentId,
    outcome: 'Synthetic Work',
    constraints: '',
    base,
    status: 'active',
    createdAt: at,
    notes: [],
  });
  let saves = 0;
  for (let i = 0; i < n(555); i++) {
    const head = heads[1 + (i % (heads.length - 1))],
      checkpoints = [];
    const count = Math.floor(n(2789) / n(555)) + Number(i < n(2789) % n(555));
    for (let j = 0; j < count; j++) {
      checkpoints.push({ head, parent: base, message: `Save ${saves++}`, at });
    }
    data.lanes.push({
      id: randomUUID(),
      intentId,
      name: `Lane ${i}`,
      base,
      head,
      assignment: '',
      target: '',
      state: 'active',
      checkpoints,
    });
  }
  for (let i = 0; i < n(2167); i++) {
    const lane = data.lanes[i % data.lanes.length];
    data.views.push({
      id: randomUUID(),
      intentId,
      base,
      head: heads[1 + (i % (heads.length - 1))],
      inputs: [{ laneId: lane.id, head: lane.head }],
      dependencies: [],
      status: 'clean',
      details: '',
      at,
    });
  }
  const check = {
    id: randomUUID(),
    name: 'Synthetic',
    executable: 'node',
    args: [],
    environmentLabel: 'fake',
    definition: base,
    at,
  };
  data.checks.push(check);
  for (let i = 0; i < n(1471); i++) {
    const view = data.views[i % data.views.length];
    data.runs.push({
      id: randomUUID(),
      viewId: view.id,
      base,
      head: view.head,
      check,
      inputs: view.inputs,
      dependencies: [],
      environment: {
        platform: 'synthetic',
        arch: 'fake',
        os: 'fake',
        node: '24.22.1',
        env: {},
        fingerprint: base,
      },
      runner: { pid: 1, host: 'fake' },
      details: '',
      status: 'passed',
      startedAt: at,
    });
  }
  const built = buildWorkRecords(data);
  for (const [key, bytes] of built.objects) objects.set(key, bytes);
  const bytes = key => objects.get(key) ?? generators.get(key)?.();
  const sizes = new Map(files.map(p => [p.sha256, p.size]));
  for (const [key, value] of objects) sizes.set(key, value.length);
  const metrics = { calls: {}, storageReads: 0, storageBytes: 0, maxPins: 0, maxBatchBytes: 0 };
  const ctx = {
    runQuery: async (ref, args) => {
      const name = getFunctionName(ref);
      metrics.calls[name] = (metrics.calls[name] ?? 0) + 1;
      if (name === 'projectObjects:resolve') {
        metrics.maxPins = Math.max(metrics.maxPins, args.digests.length);
        metrics.maxBatchBytes = Math.max(
          metrics.maxBatchBytes,
          args.digests.reduce((n, key) => n + sizes.get(key), 0),
        );
        return args.digests.map(key => ({
          projectId: 'project',
          digest: key,
          size: sizes.get(key),
          storageId: key,
        }));
      }
      if (name === 'projectWorkIndexBuildStore:lookup') return null;
      if (name === 'projectWorkIndexBuildStore:rows') return [];
      if (name === 'projectWorkIndexBuildStore:rowBatch') return args.requests.map(() => []);
      if (name === 'projectWorkIndexStore:current') return null;
      if (name === 'projectBackups:get') return {};
      throw new Error(`Unexpected query ${name}`);
    },
    runAction: async (ref, args) => {
      const name = getFunctionName(ref);
      metrics.calls[name] = (metrics.calls[name] ?? 0) + 1;
      if (name === 'projectWorkAncestry:changedStates') return ancestry.changedStates._handler(ctx, args);
      if (name === 'projectWorkAncestry:stateBatch') return ancestry.stateBatch._handler(ctx, args);
      if (name === 'projectDiffstats:compare') return diffstats.compare._handler(ctx, args);
      throw new Error(`Unexpected action ${name}`);
    },
    storage: {
      getMetadata: async key => ({ sha256: key, size: sizes.get(key) }),
      get: async key => {
        const value = bytes(key);
        metrics.storageReads++;
        metrics.storageBytes += value.length;
        return new Blob([value]);
      },
    },
  };
  const exchange = {
    records: built.root,
    manifest: { kind: 'forge-native-work-backup', head: base, files },
    read: async pin => (await exchangeObjectReader(ctx, false, 0).read('project', 'owner', [pin]))[0],
  };
  const selected = { projectId: 'project', owner: 'owner', generationId: 'generation' };
  const backup = { _id: 'backup', projectId: 'project', transport: 'objects' };
  return {
    data,
    metrics,
    async page(cursor) {
      return projectSummaries(ctx, selected, exchange, backup, cursor);
    },
  };
}
