// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { ConvexError } from 'convex/values';
import { getFunctionName } from 'convex/server';
import { moduleUrl } from './convex-module.mjs';
import { fakeSourceR2 } from './convex-source-r2-fixture.mjs';
import { digest } from '../dist/hash.js';
import { initialSourceStep } from '../dist/hosted-source-step.js';
import { saveSourceProgress } from '../dist/hosted-source-step-progress.js';
import { storeTaskData } from '../dist/hosted-source-task-data.js';
import { buildSavePages, saveBytes } from '../dist/hosted-save.js';
const task = await import(moduleUrl('../convex/projectConvexSourceTask.ts'));
const node = await import(moduleUrl('../convex/projectConvexSourceNode.ts'));
const small = await import(moduleUrl('../convex/projectConvexSource.ts'));
const { sourceStorage } = await import(moduleUrl('../convex/projectConvexSourceStorage.ts'));
export const identity = { projectId: 'project', jobId: 'job', step: 3, index: 2, generation: 4 };
const at = '2026-01-01T00:00:00.000Z';
export async function failureFixture(t, kind, wrapper = 'task') {
  const r2 = fakeSourceR2(t),
    calls = [],
    logs = [];
  t.mock.method(console, 'warn', line => logs.push(JSON.parse(line)));
  const ctx = {
    storage: {
      get() {
        assert.fail('no Convex byte read');
      },
    },
  };
  const durable = sourceStorage(ctx, identity.projectId);
  const put = bytes => {
    bytes = Buffer.from(bytes);
    const pin = { sha256: digest(bytes), size: bytes.length };
    r2.objects.set(`/synthetic/v1/p/project/o/${pin.sha256}`, bytes);
    return pin;
  };
  const json = value => put(saveBytes(value));
  const state = (files = []) =>
    json({ schema: 1, kind: 'forge-source-state', parents: [], files, message: '', at });
  const bytes =
    kind === 'states'
      ? Buffer.from(
          JSON.stringify({ schema: 1, kind: 'forge-source-state', parents: [], files: [], message: '', at }),
        )
      : Buffer.from('hello\n');
  const object = put(bytes),
    ref = { object, recipe: null };
  const request = {
    key: 'key',
    kind: 'conflict',
    item: { path: 'a.txt', left: { path: 'a.txt', mode: 'file', blob: object.sha256 } },
    order: 'right-first',
    channel: 'main',
  };
  const input = {
    kind,
    refs: [ref],
    ...(kind === 'states' ? { files: false } : {}),
    ...(kind === 'markers' ? { request: { ...request, kind: 'markers' } } : {}),
    ...(kind === 'calculate' ? { requests: [request] } : {}),
  };
  let loaded = { input: JSON.stringify(input), progress: null };
  if (wrapper !== 'task') {
    const baseline = state();
    const pages = buildSavePages([
      { path: 'a.txt', before: null, after: { blob: object.sha256, mode: 'file', content: ref } },
    ]);
    for (const page of pages.pages) json(page.value);
    const plan = json({
      schema: 1,
      kind: 'forge-hosted-save-input',
      baseline: { object: baseline, recipe: null },
      pages: pages.root,
      pageCount: pages.pages.length,
      changeCount: 1,
      message: '',
      at,
    });
    loaded = { input: plan, jobKind: 'save', cursor: null, locations: [], batchId: null };
  }
  let mode = null,
    hits = 0;
  const serve = globalThis.fetch;
  t.mock.method(globalThis, 'fetch', async (url, init = {}) => {
    if (!init.method || init.method === 'GET') {
      if (
        mode === 'headers' ||
        mode === 'progress' ||
        (mode === 'progress-section' && !String(url).includes(loaded.cursor.split(':')[1]))
      ) {
        hits++;
        throw new DOMException('secret-url?token=private-response', 'TimeoutError');
      }
      if (mode === 'body') {
        hits++;
        return new Response(
          new ReadableStream({
            start(c) {
              c.enqueue(bytes.subarray(0, 1));
              c.error(Object.assign(new TypeError('private-body'), { code: 'ECONNRESET' }));
            },
          }),
        );
      }
      if (typeof mode === 'number') {
        hits++;
        return new Response('private-response', { status: mode });
      }
    }
    return serve(url, init);
  });
  ctx.runMutation = async (ref, args) => {
    const name = getFunctionName(ref);
    calls.push({ name, args });
    if (name.endsWith(':begin')) return JSON.stringify(loaded);
    if (name === 'projectConvexSourceObjects:resolve') {
      if (mode === 'rpc-syntax') {
        hits++;
        throw new SyntaxError('private RPC parse failure');
      }
      if (mode === 'rpc') {
        hits++;
        throw Error('private nested RPC payload');
      }
      if (mode === 'rpc-timeout') {
        hits++;
        throw new ConvexError({ code: 'EXCHANGE_REQUEST_TIMEOUT', message: 'private RPC timeout' });
      }
      if (mode === 'absent')
        throw new ConvexError({ code: 'SOURCE_UNAVAILABLE', message: 'Exact source object is absent.' });
      return JSON.stringify(
        args.digests.map(id => {
          const key = `/synthetic/v1/p/project/o/${id}`,
            bytes = r2.objects.get(key);
          assert(bytes);
          return {
            descriptor: { object: { sha256: id, size: bytes.length }, recipe: null },
            storageId: null,
            url: `https://synthetic.r2.cloudflarestorage.com${key}?signature=private`,
          };
        }),
      );
    }
    assert(
      [
        'projectConvexSourceFanout:failed',
        'projectConvexSourceStore:failed',
        'projectConvexSourceFanout:complete',
        'projectConvexSourceStore:commit',
        'projectConvexSourceStore:stage',
      ].includes(name),
      name,
    );
    return null;
  };
  ctx.runAction = async (ref, args) => {
    assert.equal(getFunctionName(ref), 'projectConvexSourceNode:step');
    return node.step._handler(ctx, args);
  };
  const run = () =>
    wrapper === 'task'
      ? task.run._handler(ctx, identity)
      : (wrapper === 'node' ? node : small).step._handler(ctx, {
          projectId: identity.projectId,
          jobId: identity.jobId,
          step: identity.step,
        });
  return {
    run,
    ctx,
    calls,
    logs,
    loaded,
    input,
    object,
    put,
    r2,
    durable,
    fault: value => {
      mode = value;
    },
    hits: () => hits,
    async progress() {
      if (wrapper === 'task')
        loaded.progress = await storeTaskData({ index: 0, states: [], verify: null }, durable.store);
      else {
        const cursor = initialSourceStep(loaded.input);
        cursor.parents = Object.fromEntries(
          Array.from({ length: 200 }, (_, i) => [String(i).padStart(64, '0'), []]),
        );
        loaded.cursor = (await saveSourceProgress(cursor, null, durable.store)).id;
      }
    },
    completions: () => calls.filter(c => c.name.endsWith(':complete') || c.name.endsWith(':commit')),
  };
}
