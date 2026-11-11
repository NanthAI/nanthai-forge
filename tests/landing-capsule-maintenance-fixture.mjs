// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { getFunctionName } from 'convex/server';
import { finishFixture } from './hosted-finish-fixture.mjs';
import { synthetic } from './hosted-landing-batches-fixture.mjs';
import { moduleUrl } from './convex-module.mjs';
const run = await import(moduleUrl('../convex/projectLandingCapsuleRun.ts'));
const modules = Object.fromEntries(
  await Promise.all(
    [
      'projectLandingCapsuleCapture',
      'projectLandingCapsuleIndex',
      'projectLandingCapsuleRefs',
      'projectLandingCapsulePublish',
      'projectLandingCapsuleRemove',
      'projectOperationalExpiry',
    ].map(async name => [name, await import(moduleUrl(`../convex/${name}.ts`))]),
  ),
);

export async function capsuleMaintenanceFixture(
  t,
  { f: provided, state: providedState, advance = true, enabled = false } = {},
) {
  const settings = { ...synthetic, FORGE_LANDING_CAPSULES: enabled ? '1' : undefined };
  const prior = Object.fromEntries(Object.keys(settings).map(key => [key, process.env[key]]));
  for (const [key, value] of Object.entries(settings))
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  t.after(() => {
    for (const [key, value] of Object.entries(prior))
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
  });
  const f = provided ?? (await finishFixture(t));
  const state = providedState ?? (await f.enqueue(f.request()));
  if (!provided) {
    await f.drain();
    await f.passChecks();
    await f.drain();
  }
  assert.equal((await f.current(state.id)).submission.phase, 'landed');
  process.env.FORGE_LANDING_CAPSULES = '1';
  if (advance) f.advanceClock(8 * 86_400_000);
  const objects = new Map(),
    calls = [],
    transcript = [],
    requests = [];
  let corrupt = false,
    losePublish = false,
    loseRemove = false,
    losePutResponse = false;
  const previousFetch = globalThis.fetch;
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    const path = new URL(url).pathname;
    if (!path.includes('/landing-capsules/')) return previousFetch(url, init);
    const sha = path.split('/').at(-1),
      method = init?.method ?? 'GET';
    requests.push(method);
    if (method === 'PUT') {
      if (objects.has(sha)) return new Response(null, { status: 412 });
      objects.set(sha, Buffer.from(init.body));
      if (losePutResponse) {
        losePutResponse = false;
        throw new TypeError('Synthetic lost capsule PUT response');
      }
      return new Response(null, { status: 200 });
    }
    const body = objects.get(sha);
    if (!body) return new Response(null, { status: 404 });
    const bytes = Buffer.from(body);
    if (corrupt) bytes[bytes.length - 1] ^= 1;
    return new Response(bytes);
  });
  const ctx = {
    runMutation: async (ref, args) => {
      const name = getFunctionName(ref),
        [file, method] = name.split(':');
      assert(modules[file]?.[method], name);
      calls.push(name);
      const value = await f.tx('capsuleWriterPage', modules[file][method], args);
      transcript.push({ name, args: structuredClone(args), value: structuredClone(value) });
      if (losePublish && name === 'projectLandingCapsulePublish:publish') {
        losePublish = false;
        throw Object.assign(new Error('Synthetic lost published response'), {
          code: 'EXCHANGE_REQUEST_FAILED',
        });
      }
      if (loseRemove && name === 'projectLandingCapsuleRemove:page') {
        loseRemove = false;
        throw new Error('Synthetic lost removal response');
      }
      return value;
    },
    scheduler: { runAfter: async () => assert.fail('small fixture needs no index continuation') },
  };
  const input = { projectId: f.projectId, submissionId: state.id, dueAt: 0 };
  return {
    f,
    state,
    input,
    objects,
    calls,
    transcript,
    requests,
    pack: () => run.pack._handler(ctx, input).then(JSON.parse),
    corrupt: () => {
      corrupt = true;
    },
    losePut: () => {
      losePutResponse = true;
    },
    loseRemove: () => {
      loseRemove = true;
    },
    losePublish: () => {
      losePublish = true;
    },
  };
}
