// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { getFunctionName } from 'convex/server';
import { ConvexError } from 'convex/values';
import { moduleUrl } from './convex-module.mjs';
import { fakeSourceR2 } from './convex-source-r2-fixture.mjs';
import { digest } from '../dist/hash.js';
import speedBudgets from '../src/speed-budgets.json' with { type: 'json' };
import { encodePhysicalEntries, physicalBucket } from '../dist/physical-manifest-codec.js';

const { convexSourceTransport } = await import(moduleUrl('../convex/projectConvexSourceTransport.ts'));
const { sourceStorage } = await import(moduleUrl('../convex/projectConvexSourceStorage.ts'));
const budget = id => speedBudgets.budgets.find(value => value.id === id).max;

// The source graph prefetches ancestor descriptors. Their physical manifests describe file
// members, not other States, and must not become a search path for every subsequent lookup.
async function fixture(t, history = 60, provided = true, split = false) {
  const r2 = fakeSourceR2(t),
    calls = [],
    content = Buffer.from('selected file bytes\n'),
    member = { sha256: digest(content), size: content.length },
    other = { sha256: digest('other selected file'), size: 19 },
    storage = sourceStorage({}, 'project'),
    rows = [];
  const put = async bytes => {
    await storage.store(bytes);
    return { sha256: digest(bytes), size: bytes.length };
  };
  for (let i = 0; i < history; i++) {
    const state = digest(`State ${i}`),
      entry = split && i === 0 ? other : member,
      chunk = await put(encodePhysicalEntries([{ ...entry }])),
      root = await put(
        Buffer.from(
          JSON.stringify({
            schema: 1,
            kind: 'forge-physical-manifest',
            state,
            chunks:
              i === history - 1 || (split && i === 0)
                ? [{ ...chunk, bucket: physicalBucket(entry.sha256) }]
                : [],
          }),
        ),
      );
    rows.push({
      descriptor: { object: { sha256: state, size: 4_900_000 }, recipe: null },
      statePhysical: root,
      stateParents: [],
      storageId: null,
      url: null,
    });
  }
  let refused = false;
  const ctx = {
    async runMutation(ref, args) {
      assert.equal(getFunctionName(ref), 'projectConvexSourceObjects:resolve');
      calls.push(args.digests);
      if (refused)
        throw new ConvexError({ code: 'PROJECT_UNAVAILABLE', message: 'current source access was revoked' });
      const selected = args.digests.map(
        id =>
          rows.find(row => row.descriptor.object.sha256 === id) ?? {
            descriptor: { object: { sha256: id, size: 123 }, recipe: null },
            storageId: null,
            url: null,
          },
      );
      return JSON.stringify(args.probe ? { rows: selected, unavailable: [] } : selected);
    },
  };
  const transport = convexSourceTransport(
    ctx,
    { projectId: 'project', jobId: 'job', step: 0 },
    provided ? rows : [],
  );
  r2.requests.length = 0;
  return { ...transport, rows, r2, calls, member, other, revoke: () => (refused = true) };
}

test('State descriptor lookup never searches file manifests, regardless of cached ancestry', async t => {
  const f = await fixture(t),
    id = digest('selected merge base');
  f.io.expectState(id);
  await f.io.describeBatch([id]);
  assert.equal(f.calls.length, 1, 'one existing catalog page resolves the exact State');
  assert(
    f.r2.requests.length <= budget('source-state-manifest-probes'),
    `State lookup made ${f.r2.requests.length} unrelated R2 probes`,
  );
});

test('file lookup searches selected State manifests without walking every cached ancestor', async t => {
  const f = await fixture(t);
  f.io.expectState(f.rows[0].descriptor.object.sha256);
  f.io.expectState(f.rows.at(-1).descriptor.object.sha256);
  const [ref] = await f.io.describeBatch([f.member.sha256]);
  assert.deepEqual(ref.object, f.member);
  assert.equal(f.calls.length, 0, 'the selected State supplies its existing verified binding');
  assert(
    f.r2.requests.length <= budget('source-selected-manifest-probes'),
    `one file lookup made ${f.r2.requests.length} R2 probes across 60 cached ancestors`,
  );
});

test('missing selected-manifest membership retains the catalog access fence', async t => {
  const f = await fixture(t),
    id = digest('new edited file');
  f.io.expectState(f.rows.at(-1).descriptor.object.sha256);
  f.revoke();
  await assert.rejects(f.io.describeBatch([id]), { code: 'PROJECT_UNAVAILABLE' });
  assert.equal(f.calls.length, 1);
});

test('a directly supplied State root serves file bindings before the worker declares its interpretation', async t => {
  const f = await fixture(t, 1);
  const [ref] = await f.io.describeBatch([f.member.sha256]);
  assert.deepEqual(ref.object, f.member);
  assert.equal(f.calls.length, 0, 'direct source selection needs no catalog fallback');
});

test('metadata-only ancestry hints never become implicit file-manifest selections', async t => {
  const f = await fixture(t, 60, false);
  await f.io.probeStates(f.rows.map(row => row.descriptor.object.sha256));
  f.calls.length = 0;
  await f.io.describeBatch([f.member.sha256]);
  assert.equal(f.calls.length, 1, 'unknown file selection keeps the ordinary catalog lookup');
  assert.equal(f.r2.requests.length, 0, 'cached ancestry adds no R2 probes');
});

test('a merge resolves file bindings across its selected States without a redundant catalog call', async t => {
  const f = await fixture(t, 2, true, true);
  for (const row of f.rows) f.io.expectState(row.descriptor.object.sha256);
  const refs = await f.io.describeBatch([f.member.sha256, f.other.sha256]);
  assert.deepEqual(
    refs.map(ref => ref.object),
    [f.member, f.other],
  );
  assert.equal(f.calls.length, 0, 'base and changed file bindings may belong to different selected States');
  assert(f.r2.requests.length <= 2 * budget('source-selected-manifest-probes'));
});
