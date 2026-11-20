// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { policyPreset } from '../dist/autonomy-policy.js';
import { digest } from '../dist/hash.js';
import { readHostedLaneCheckout } from '../dist/hosted-lane-checkout-marker.js';
import { protectedPathNotice } from '../dist/public-governance.js';
import { checkoutProtectedPathNotice } from '../dist/hosted-changed-paths.js';
import { agentFixture } from './hosted-agent-fixture.mjs';
import { clientCacheRoot } from '../dist/root-paths.js';
import { effectiveAgentDefaults } from '../dist/agent-parallel-defaults.js';
import { slimReceipt } from '../dist/receipt-slim.js';
import { compactReplyDetail } from '../dist/receipt-detail.js';

const policy = (acceptance = {}, checkEntries = []) => ({
  acceptance: { ...policyPreset('trusted').acceptance, ...acceptance },
  checkEntries,
});

test('netlify incident: default, configured and check-entry paths name their existing approver; unrelated paths do not warn', () => {
  assert.match(protectedPathNotice(policy(), ['netlify.toml']).message, /project owner/);
  assert.equal(protectedPathNotice(policy(), ['src/plain.ts']), undefined);
  const configured = policy({ ownerApprovalPaths: ['deploy/**'], protectedPaths: ['src/guarded.*'] }, [
    'tools/check.mjs',
  ]);
  assert.equal(protectedPathNotice(configured, ['netlify.toml']), undefined);
  assert.deepEqual(protectedPathNotice(configured, ['deploy/job.yml']).paths, ['deploy/job.yml']);
  assert.match(protectedPathNotice(configured, ['src/guarded.ts']).message, /a person allowed to accept/);
  assert.match(protectedPathNotice(configured, ['tools/check.mjs']).message, /project owner/);
  assert.equal(protectedPathNotice(policy({ ownerApprovalPaths: [] }), ['netlify.toml']), undefined);
  assert.equal(protectedPathNotice(policy({ ownerApprovalPaths: [], protectedPaths: [] }), null), undefined);
  assert.equal(protectedPathNotice(policy({ ownerApprovalPaths: [] }), null).coverage, 'unavailable');
  assert.equal(protectedPathNotice(policy(), null).coverage, 'unavailable');
});

test('a large change caps only the approval notice and reports omitted paths', () => {
  const paths = Array.from({ length: 1000 }, (_, i) => `netlify/${i}.ts`);
  const notice = protectedPathNotice(policy(), paths);
  assert.equal(notice.paths.length, 10);
  assert.equal(notice.more, 990);
  const long = protectedPathNotice(policy(), ['netlify/' + 'x'.repeat(1500)]);
  assert.equal(long.paths.length, 0);
  assert.equal(long.more, 1);
});

async function fixture(t, path = 'netlify.toml', configured = policy()) {
  const s = agentFixture(t, { base: { [path]: 'Before\n' }, lane: { [path]: 'After\n' } });
  if (configured) {
    s.caps.features = ['protected-path-notice'];
    s.caps.protectedPathPolicy = configured;
  }
  s.caps.agentDefaults = effectiveAgentDefaults({ preflight: 'off' });
  await s.transport().dispatch('open', { laneId: s.lane.laneId });
  const cache = join(clientCacheRoot(s.root), 'objects');
  mkdirSync(cache, { recursive: true });
  writeFileSync(join(cache, s.main.head), s.objects.get(s.main.head));
  return s;
}

test('the first save replies with approval before checking, while unrelated saves and older servers keep their reply and call count', async t => {
  const calls = [];
  for (const [path, configured, expected] of [
    ['netlify.toml', policy(), true],
    ['ordinary.txt', policy(), false],
    ['netlify.toml', policy({ ownerApprovalPaths: [] }), false],
    ['netlify.toml', null, false],
  ]) {
    const s = await fixture(t, path, configured);
    const before = s.calls.length;
    const response = await s
      .transport()
      .dispatch('save', { operationId: randomUUID(), message: 'Save configuration' });
    const notice = response.result.protectedPathNotice;
    assert.equal(Boolean(notice), expected);
    if (expected) {
      assert.deepEqual(notice.paths, ['netlify.toml']);
      assert.deepEqual(compactReplyDetail('save', response.result).protectedPathNotice, notice);
      assert.deepEqual(slimReceipt(response).result.protectedPathNotice, notice);
    }
    assert(!s.calls.slice(before).some(call => /Check|Landing|Compose/.test(call.name)));
    calls.push(s.calls.slice(before).map(call => call.name));
  }
  for (const names of calls.slice(1)) assert.deepEqual(names, calls[0], 'notice adds zero calls');
});

test('direct preflight and land without prior explicit save both explain approval before work is submitted', async t => {
  const s = await fixture(t);
  const preflight = await s.transport().dispatch('preflight', { laneId: s.lane.laneId, run: false });
  assert.deepEqual(preflight.result.protectedPathNotice.paths, ['netlify.toml']);
  const printed = [];
  const write = process.stderr.write.bind(process.stderr);
  t.mock.method(process.stderr, 'write', (text, ...args) => {
    printed.push(String(text));
    return write(text, ...args);
  });
  const mutation = s.exchange.client.mutation;
  s.exchange.client.mutation = async (ref, args) => {
    if (args.request && JSON.parse(args.request).candidateId)
      assert(printed.some(line => line.includes('Landing will need approval')));
    return mutation(ref, args);
  };
  const land = await s
    .transport()
    .dispatch('finish', { operationId: randomUUID(), message: 'Land protected edit', accept: true });
  assert.deepEqual(land.result.protectedPathNotice.paths, ['netlify.toml']);
});

test('ad80e037: a protected file whose saved bytes equal main (merged in by a sync, or reverted) needs no approval notice, with no added call', async t => {
  const names = [];
  for (const known of [false, true, 'uncached']) {
    const s = await fixture(t);
    const saved = readHostedLaneCheckout(s.root).state.files.find(file => file.path === 'netlify.toml');
    // Main moved after the Lane's base and now holds exactly the Lane's bytes for the file.
    const main = JSON.parse(s.objects.get(s.main.head));
    main.files = main.files.filter(file => file.path !== 'netlify.toml').concat(saved);
    const bytes = Buffer.from(JSON.stringify(main));
    const head = digest(bytes);
    if (known !== 'uncached') writeFileSync(join(clientCacheRoot(s.root), 'objects', head), bytes);
    if (known) s.caps.main = { ...s.main, head };
    const before = s.calls.length;
    const save = await s
      .transport()
      .dispatch('save', { operationId: randomUUID(), message: 'Save configuration' });
    const preflight = await s.transport().dispatch('preflight', { laneId: s.lane.laneId, run: false });
    names.push(s.calls.slice(before).map(call => call.name));
    if (known === true) {
      assert.equal(save.result.protectedPathNotice, undefined, 'saved bytes equal main: no approval');
      assert.equal(preflight.result.protectedPathNotice, undefined);
    } else {
      // No main manifest on this machine: the notice stays (a missing observation never hides it).
      assert.deepEqual(save.result.protectedPathNotice.paths, ['netlify.toml']);
      assert.deepEqual(preflight.result.protectedPathNotice.paths, ['netlify.toml']);
    }
  }
  for (const list of names.slice(1)) assert.deepEqual(list, names[0], 'the main comparison adds zero calls');
  // Unit: a path whose saved bytes differ from main's keeps the notice.
  const s = await fixture(t);
  const marker = readHostedLaneCheckout(s.root);
  assert.deepEqual(
    checkoutProtectedPathNotice(s.root, marker, policy(), s.main.head).paths,
    ['netlify.toml'],
    'the Lane changes the file against main: notice kept',
  );
});

test('current and doubled manifests explain approval locally with constant server calls and bounded replies', async t => {
  const s = await fixture(t);
  for (const size of [3000, 6000]) {
    const marker = structuredClone(readHostedLaneCheckout(s.root));
    const base = JSON.parse(s.objects.get(s.main.head));
    base.files.push(
      ...Array.from({ length: size - 1 }, (_, i) => ({
        path: `src/f${i}.txt`,
        blob: base.files[0].blob,
        mode: 'file',
      })),
    );
    const bytes = Buffer.from(JSON.stringify(base));
    marker.selection.base.head = digest(bytes);
    writeFileSync(join(clientCacheRoot(s.root), 'objects', marker.selection.base.head), bytes);
    marker.state.files.push(...base.files.slice(1));
    const calls = s.calls.length,
      start = performance.now(),
      heap = process.memoryUsage().heapUsed;
    const notice = checkoutProtectedPathNotice(s.root, marker, policy());
    assert.deepEqual(notice.paths, ['netlify.toml']);
    assert.equal(s.calls.length, calls);
    t.diagnostic(
      JSON.stringify({
        files: size,
        manifestBytes: bytes.length,
        wallMs: performance.now() - start,
        heapDelta: process.memoryUsage().heapUsed - heap,
        peakRssKiB: process.resourceUsage().maxRSS,
      }),
    );
  }
});

test('a prepared Candidate explains its protected approval before the landing check is enqueued', async t => {
  const s = await fixture(t);
  s.candidate.governance = { version: 1, paths: ['netlify.toml'], ownerInputs: true };
  const result = await s.transport().dispatch('finish', {
    candidateId: s.candidate.id,
    composeOperationId: randomUUID(),
    operationId: randomUUID(),
    accept: true,
  });
  assert.deepEqual(result.result.protectedPathNotice.paths, ['netlify.toml']);
});
