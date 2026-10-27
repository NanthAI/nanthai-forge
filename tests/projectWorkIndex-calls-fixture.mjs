// SPDX-License-Identifier: Apache-2.0
import { gzipSync, gunzipSync } from 'node:zlib';
import { recipeObjects } from './projectObjectRecipe-fixture.mjs';
import { randomUUID } from 'node:crypto';
import { getFunctionName } from 'convex/server';
import { moduleUrl } from './convex-module.mjs';
import { checkArgs } from './convex-args.mjs';
import { digest } from '../dist/hash.js';
import { viewIndexEntries } from '../dist/view-hosted-index.js';
import { ownerDiffstatPages } from '../dist/owner-diffstats.js';
import { workSchema } from '../dist/work-types.js';
import { buildWorkRecords } from '../dist/work-exchange-records.js';
const { projectSummaries } = await import(moduleUrl('../convex/projectWorkIndexBuildSummaries.ts'));
const { exchangeObjectReader } = await import(moduleUrl('../convex/projectExchangeReader.ts'));
const buildDiffstats = await import(moduleUrl('../convex/projectWorkIndexBuildDiffstats.ts'));
const states = await import(moduleUrl('../convex/projectWorkIndexBuildStates.ts'));
const ancestry = await import(moduleUrl('../convex/projectWorkAncestry.ts'));
const diffstats = await import(moduleUrl('../convex/projectDiffstats.ts'));

/** Exact synthetic dogfood counts; source bytes are generated on demand so the
 * fake does not retain thousands of full trees in the coordinator's heap. */
export function callsFixture(scale = 1, ownerStats = true) {
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
  const companion = ownerDiffstatPages({
    work: built.root.work.sha256,
    stats: data.views.map(v => [`${v.base}:${v.head}`, { files: 40, add: 40, del: 40 }]),
  });
  for (const [key, bytes] of companion.objects) objects.set(key, bytes);
  const stateFiles = {
    has: head => heads.includes(head),
    get: head =>
      head === base ? tree : tree.map((f, j) => (j < 40 ? { ...f, blob: changed[j].sha256 } : f)),
  };
  const ownerViews = data.views.map((view, index) => {
    const make = () =>
      Buffer.from(
        JSON.stringify({
          work: built.root.work.sha256,
          view: [
            view.id,
            'f'.repeat(64),
            viewIndexEntries(data, stateFiles, { index, positions: new Map() }),
          ],
        }),
      );
    const bytes = make(),
      sha256 = digest(bytes);
    const compressed = Buffer.from(gzipSync(bytes));
    generators.set(sha256, () => gunzipSync(compressed));
    return { key: view.id, sha256, size: bytes.length };
  });

  for (const [key, bytes] of built.objects) objects.set(key, bytes);
  const sizes = new Map(files.map(p => [p.sha256, p.size]));
  ownerViews.forEach(p => sizes.set(p.sha256, p.size));
  for (const [key, value] of objects) sizes.set(key, value.length);
  const stored = new Map(objects);
  const storedGet = stored.get.bind(stored);
  stored.get = key => storedGet(key) ?? generators.get(key)?.();
  const recipeStore = recipeObjects(stored, sizes, new Set(heads));
  const metrics = {
    sourceFileReads: 0,
    calls: {},
    storageReads: 0,
    storageBytes: 0,
    maxPins: 0,
    maxBatchBytes: 0,
  };
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
        return args.digests.map(key => recipeStore.row(key));
      }
      if (name === 'projectWorkIndexBuildStore:lookups') return args.keys.map(() => null);
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
      const action = {
        'projectWorkIndexBuildDiffstats:compare': buildDiffstats.compare,
        'projectWorkIndexBuildStates:batch': states.batch,
        'projectWorkAncestry:changedStates': ancestry.changedStates,
        'projectWorkAncestry:stateBatch': ancestry.stateBatch,
        'projectDiffstats:compare': diffstats.compare,
      }[name];
      if (!action) throw new Error(`Unexpected action ${name}`);
      // Convex rejects arguments its validator does not describe; so does this fake.
      checkArgs(action, args, name);
      return action._handler(ctx, args);
    },
    storage: {
      getMetadata: async key => ({ sha256: key, size: sizes.get(key) }),
      get: async key => {
        const value = stored.get(key);
        if ([old.sha256, ...changed.map(p => p.sha256)].includes(key)) metrics.sourceFileReads++;
        metrics.storageReads++;
        metrics.storageBytes += value.length;
        return new Blob([value]);
      },
    },
  };
  const exchange = {
    root: { schema: 2, ownerViews, ...(ownerStats ? { ownerDiffstats: companion.pages } : {}) },
    records: built.root,
    manifest: {
      kind: 'forge-native-work-backup',
      head: base,
      files: [{ path: 'work.json', ...built.root.work }, ...files],
    },
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
