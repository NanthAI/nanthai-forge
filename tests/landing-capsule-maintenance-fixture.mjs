// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { getFunctionName } from 'convex/server';
import { randomBytes } from 'node:crypto';
import { canonicalPayload } from '../dist/hosted-source-operation.js';
import { finishFixture } from './hosted-finish-fixture.mjs';
import { synthetic } from './hosted-landing-batches-fixture.mjs';
import { moduleUrl } from './convex-module.mjs';
const run = await import(moduleUrl('../convex/projectLandingCapsuleRun.ts'));
const runNode = await import(moduleUrl('../convex/projectLandingCapsuleRunNode.ts'));
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
  { f: provided, state: providedState, advance = true } = {},
) {
  const prior = Object.fromEntries(Object.keys(synthetic).map(key => [key, process.env[key]]));
  for (const [key, value] of Object.entries(synthetic)) process.env[key] = value;
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
  if (advance) f.advanceClock(8 * 86_400_000);
  const objects = new Map(),
    scheduled = [],
    calls = [],
    transcript = [],
    requests = [];
  let corrupt = false,
    losePublish = false,
    loseRemove = false,
    losePutResponse = false,
    replaced = null;
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
      let value = await f.tx('capsuleWriterPage', modules[file][method], args);
      if (replaced?.name === name && replaced.nth-- === 0) {
        value = replaced.reply(typeof value === 'string' ? JSON.parse(value) : value);
        replaced = null;
      }
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
    scheduler: {
      runAfter: async (_, ref, args) => {
        // Only the Node continuation of an oversized history; a small fixture needs no index continuation.
        assert.equal(getFunctionName(ref), 'projectLandingCapsuleRunNode:pack');
        scheduled.push({ name: getFunctionName(ref), args: structuredClone(args) });
      },
    },
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
    scheduled,
    pack: () => run.pack._handler(ctx, input).then(JSON.parse),
    packNode: () => runNode.pack._handler(ctx, input).then(JSON.parse),
    /** Answer the nth (0-based) call of `name` with reply(realValue), as another run racing it would. */
    replaceReply: (name, nth, reply) => (replaced = { name, nth, reply }),
    /** Spread about `bytes` of schema-valid, incompressible historical error text over this landing's
     * observations, each row well under the 1 MiB document bound. Returns the added bytes. */
    inflate: bytes => {
      const rows = [...f.tables.projectHostedLandingObservations.values()].filter(
        row => row.submissionId === state.id && JSON.parse(row.value).transition,
      );
      const per = Math.ceil(bytes / rows.length);
      assert(rows.length && per < 768 * 1024, `inflate ${bytes} bytes over ${rows.length} observations`);
      for (const row of rows) {
        const value = JSON.parse(row.value);
        value.transition.error = {
          code: 'SYNTHETIC_ERROR',
          message: randomBytes(Math.ceil((per * 3) / 4))
            .toString('base64')
            .slice(0, per),
        };
        f.patch('projectHostedLandingObservations', row._id, { value: canonicalPayload(value) });
      }
      return per * rows.length;
    },
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
