// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { getFunctionName, makeFunctionReference } from 'convex/server';
import { moduleUrl } from './convex-module.mjs';
import { validateContext } from './convex-context.mjs';
import { checkArgs } from './convex-args.mjs';
import { digest } from '../dist/hash.js';
import { convexStoreBlob } from './convex-storage-fake.mjs';
import { sourceWorkerHttp } from '../dist/hosted-source-worker-http.js';

const names = [
  'projectObjects',
  'projectObjectCommit',
  'projectObjectDownloads',
  'projectObjectRecipes',
  'projectObjectRecipeStore',
  'projectHostedSaves',
  'projectHostedSaveJobs',
  'projectSourceJobApi',
  'projectSourceProviderApi',
  'projectHostedSaveTransfers',
  'projectHostedSourceTransferBatch',
  'projectHostedComposeSelection',
  'projectConvexSource',
  'projectConvexSourceStore',
  'projectConvexSourceObjects',
];
export const modules = Object.fromEntries(
  await Promise.all(names.map(async name => [name, await import(moduleUrl(`../convex/${name}.ts`))])),
);
export function environment(t) {
  const env = {
    CONVEX_CLOUD_URL: 'https://example.convex.cloud',
    R2_ACCOUNT_ID: 'synthetic',
    R2_BUCKET: 'synthetic',
    R2_ACCESS_KEY_ID: 'synthetic',
    R2_SECRET_ACCESS_KEY: 'synthetic',
    FORGE_SOURCE_PROVIDER: 'convex',
  };
  const before = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
  Object.assign(process.env, env);
  t.after(() => {
    for (const [key, value] of Object.entries(before)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
}
/** Real function handlers/nested calls and storage checks, with local R2 bytes. */
export function controls(t, s) {
  const calls = [];
  let storageCalls = 0;
  const blobs = new Map();
  const storage = {
    async get(id) {
      storageCalls++;
      return blobs.get(id) ?? null;
    },
    async store(blob, options) {
      storageCalls++;
      const bytes = await convexStoreBlob(blob, options),
        id = `convex-${digest(bytes)}`;
      blobs.set(id, blob);
      s.objects.set(digest(bytes), bytes);
      return id;
    },
    async getMetadata(id) {
      const blob = blobs.get(id);
      return blob ? { size: blob.size, sha256: digest(Buffer.from(await blob.arrayBuffer())) } : null;
    },
    async getUrl(id) {
      return blobs.has(id) ? `https://convex.invalid/${id}` : null;
    },
  };
  const invoke = async (name, args) => {
    calls.push(name);
    const [file, method] = name.split(':');
    const fn = modules[file][method];
    checkArgs(fn, args, name);
    if (file === 'projectConvexSource') return fn._handler(context, args);
    if (
      ['commit', 'commitBatch', 'complete'].includes(method) &&
      [
        'projectObjectCommit',
        'projectObjectRecipes',
        'projectHostedSaveTransfers',
        'projectHostedSourceTransferBatch',
        'projectHostedSaveJobs',
      ].includes(file)
    )
      return fn._handler(context, args);
    return s.transaction(name, fn, args);
  };
  const context = validateContext({
    storage,
    auth: { getUserIdentity: async () => ({ subject: 'owner' }) },
    runQuery: (ref, args) => invoke(getFunctionName(ref), args),
    runMutation: (ref, args) => invoke(getFunctionName(ref), args),
  });
  s.decorateContext(ctx => {
    ctx.storage = storage;
    ctx.db.system = { get: async () => ({ state: { kind: 'pending' } }) };
    ctx.scheduler = { runAfter: async () => 'synthetic-task' };
  });
  const client = {
    query: (ref, args) => invoke(getFunctionName(ref), args),
    mutation: (ref, args) => invoke(getFunctionName(ref), args),
    action: (ref, args) => invoke(getFunctionName(ref), args),
  };
  const fetch = async (url, init = {}) => {
    const parsed = new URL(url);
    if (parsed.hostname === 'convex.invalid') {
      storageCalls++;
      return new Response(blobs.get(parsed.pathname.slice(1)) ?? null);
    }
    if (parsed.hostname === 'control.invalid') {
      const input = JSON.parse(init.body);
      const batch = parsed.pathname.endsWith('-batch');
      const method = parsed.pathname.split('/').at(-1).replace('-batch', '');
      const args = { ...input, projectId: s.projectId, input: JSON.stringify(input.input) };
      const result = await invoke(
        `${batch ? 'projectHostedSourceTransferBatch' : 'projectHostedSaveTransfers'}:${method}`,
        args,
      );
      return Response.json(typeof result === 'string' ? JSON.parse(result) : result);
    }
    const id = parsed.pathname.split('/o/')[1]?.split('/')[0];
    assert(id, `Only synthetic R2 URL: ${parsed.pathname}`);
    if (init.method === 'PUT') {
      const parts = [];
      const body = init.body;
      if (body instanceof Uint8Array) parts.push(body);
      else for await (const part of body) parts.push(part);
      const bytes = Buffer.concat(parts);
      assert.equal(digest(bytes), id);
      s.objects.set(id, bytes);
      return new Response(null);
    }
    const bytes = s.objects.get(id);
    if (!bytes) return new Response(null, { status: 404 });
    if (init.method === 'HEAD')
      return new Response(null, {
        headers: {
          'content-length': String(bytes.length),
          'x-amz-checksum-sha256': Buffer.from(id, 'hex').toString('base64'),
        },
      });
    return new Response(bytes);
  };
  t.mock.method(globalThis, 'fetch', fetch);
  const http = dispatch =>
    sourceWorkerHttp({
      endpoint: 'https://control.invalid/',
      token: 'synthetic',
      input: dispatch,
      executionId: 'synthetic-execution',
      timeoutMs: 10000,
      fetch,
    }).transport;
  const call = (name, args) => invoke(name, args);
  const stats = () => ({
    calls: calls.length,
    documents: s.counts.reduce((n, row) => n + row.documents, 0),
    writes: s.counts.reduce((n, row) => n + row.writes, 0),
  });
  return {
    invoke,
    client,
    http,
    call,
    calls,
    stats,
    context,
    storageCalls: () => storageCalls,
  };
}
export const ref = name => makeFunctionReference(name);
