// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { getFunctionName, makeFunctionReference } from 'convex/server';
import { moduleUrl } from './convex-module.mjs';
import { digest } from '../dist/hash.js';
import { canonicalPayload } from '../dist/hosted-source-operation.js';
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
  'projectModalSource',
  'projectHostedSaveTransfers',
  'projectHostedSourceTransferBatch',
  'projectHostedComposeSelection',
];
export const modules = Object.fromEntries(
  await Promise.all(names.map(async name => [name, await import(moduleUrl(`../convex/${name}.ts`))])),
);
export function environment(t) {
  const env = {
    FORGE_BLOBS: 'r2',
    R2_ACCOUNT_ID: 'synthetic',
    R2_BUCKET: 'synthetic',
    R2_ACCESS_KEY_ID: 'synthetic',
    R2_SECRET_ACCESS_KEY: 'synthetic',
    FORGE_SOURCE_WORKER: 'fixed-worker',
    FORGE_SOURCE_RUNTIME: 'a'.repeat(64),
    FORGE_SOURCE_KEY_ID: 'SYNTHETIC',
    FORGE_SOURCE_JOB_KEY_SYNTHETIC: 'synthetic-key',
    FORGE_SOURCE_MODAL_URL: 'https://bridge.invalid/',
    FORGE_SOURCE_MODAL_TOKEN: 'synthetic',
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
  let dispatch;
  const invoke = async (name, args) => {
    calls.push(name);
    const [file, method] = name.split(':');
    const fn = modules[file][method];
    if (file === 'projectModalSource') return fn._handler(context, args);
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
  const context = {
    auth: { getUserIdentity: async () => ({ subject: 'owner' }) },
    runQuery: (ref, args) => invoke(getFunctionName(ref), args),
    runMutation: (ref, args) => invoke(getFunctionName(ref), args),
  };
  s.decorateContext(ctx => {
    ctx.scheduler = { runAfter: async () => 'synthetic-task' };
  });
  const client = {
    query: (ref, args) => invoke(getFunctionName(ref), args),
    mutation: (ref, args) => invoke(getFunctionName(ref), args),
    action: (ref, args) => invoke(getFunctionName(ref), args),
  };
  const fetch = async (url, init = {}) => {
    const parsed = new URL(url);
    if (parsed.hostname === 'bridge.invalid') {
      dispatch = JSON.parse(init.body).input;
      const args = {
        projectId: s.projectId,
        jobId: dispatch.jobId,
        input: JSON.stringify(dispatch),
        token: crypto.randomUUID(),
      };
      const reservation = JSON.parse(await invoke('projectSourceProviderApi:reserve', args));
      assert(reservation.create);
      await invoke('projectSourceProviderApi:created', { ...args, executionId: 'synthetic-execution' });
      return Response.json({
        dispatchKey: dispatch.dispatchKey,
        input: canonicalPayload(dispatch),
        result: { status: 'accepted', executionId: 'synthetic-execution' },
      });
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
  return { invoke, client, http, call, calls, stats, context, dispatch: () => dispatch };
}
export const ref = name => makeFunctionReference(name);
