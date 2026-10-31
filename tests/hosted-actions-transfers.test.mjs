// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { getFunctionName } from 'convex/server';
import { actionsFixture } from './hosted-actions-fixture.mjs';
import { moduleUrl } from './convex-module.mjs';
import { digest } from '../dist/hash.js';
import { code } from './hosted-checks-fixture.mjs';
const transfer = await import(moduleUrl('../convex/projectHostedActionsTransfers.ts'));
async function fixture(t) {
  const s = await actionsFixture(),
    owner = randomUUID();
  const claim = await s.store.control({ kind: 'claim', owner });
  const identity = {
    kind: 'forge-hosted-actions',
    runId: s.input.id,
    dispatchKey: s.input.dispatchKey,
    owner,
    token: claim.mapping.lease.token,
  };
  const env = {
    CONVEX_CLOUD_URL: 'https://example.convex.cloud',
    R2_ACCOUNT_ID: 'h22-fixture',
    R2_BUCKET: 'synthetic',
    R2_ACCESS_KEY_ID: 'synthetic-id',
    R2_SECRET_ACCESS_KEY: 'synthetic-secret',
  };
  const saved = Object.fromEntries(Object.keys(env).map(k => [k, process.env[k]]));
  Object.assign(process.env, env);
  t.after(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });
  s.patch('hostedProjects', s.projectId, { r2Writes: true });
  return {
    ...s,
    identity,
    args: {
      projectId: s.projectId,
      input: JSON.stringify(identity),
      executionId: owner,
      pin: s.input.plan.manifest,
    },
  };
}
test('exact grants and HEAD commits recheck execution, epoch, project membership and verified checksum', async t => {
  const s = await fixture(t),
    read = await s.call('grant', transfer.grant, { ...s.args, action: 'read' });
  assert.equal(new URL(read.url).protocol, 'https:');
  await assert.rejects(
    s.call('grant', transfer.grant, { ...s.args, executionId: 'forged', action: 'read' }),
    code('SOURCE_JOB_FENCED'),
  );
  await assert.rejects(
    s.call('grant', transfer.grant, {
      ...s.args,
      input: JSON.stringify({ ...s.identity, token: s.identity.token + 1 }),
      action: 'read',
    }),
    code('SOURCE_JOB_FENCED'),
  );
  await assert.rejects(
    s.call('grant', transfer.grant, {
      ...s.args,
      pin: { sha256: digest('foreign'), size: 7 },
      action: 'read',
    }),
    code('SOURCE_UNAVAILABLE'),
  );
  const pin = { sha256: digest('new source state'), size: 16 },
    args = { ...s.args, pin };
  await s.call('grant', transfer.grant, { ...args, action: 'upload' });
  let heads = 0,
    checksum = Buffer.from(pin.sha256, 'hex').toString('base64');
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    assert.equal(init.method, 'HEAD');
    heads++;
    return new Response(null, {
      headers: { 'content-length': String(pin.size), 'x-amz-checksum-sha256': checksum },
    });
  });
  let lostCommit = true;
  const ctx = {
    runMutation: async (ref, args) => {
      const name = getFunctionName(ref);
      const result = await s.call(
        name.endsWith('pending') ? 'pending' : 'verified',
        name.endsWith('pending') ? transfer.pending : transfer.verified,
        args,
      );
      if (name.endsWith('verified') && lostCommit) {
        lostCommit = false;
        throw Error('lost verified commit reply');
      }
      return result;
    },
  };
  await assert.rejects(transfer.commit._handler(ctx, args), /lost verified commit reply/);
  await transfer.commit._handler(ctx, args);
  await transfer.commit._handler(ctx, args);
  assert.equal(heads, 1);
  const second = { ...s.args, pin: { sha256: digest('bad output'), size: 10 } };
  await s.call('grant', transfer.grant, { ...second, action: 'upload' });
  checksum = 'incorrect';
  await assert.rejects(transfer.commit._handler(ctx, second), code('R2_VERIFY_FAILED'));
  const pending = await s.call('pending', transfer.pending, second);
  s.patch('hostedProjects', s.projectId, { sourceAuthority: { mode: 'server', epoch: 2 } });
  await assert.rejects(
    s.call('verified', transfer.verified, { ...second, key: pending.key }),
    code('SOURCE_AUTHORITY_CHANGED'),
  );
  await assert.rejects(
    s.call('grant', transfer.grant, { ...s.args, action: 'read' }),
    code('SOURCE_AUTHORITY_CHANGED'),
  );
  t.diagnostic(
    JSON.stringify({
      HEAD: heads,
      calls: s.traffic.acceptedCalls,
      argumentBytes: s.traffic.acceptedArgumentBytes,
      maxima: Object.fromEntries(
        [...new Set(s.counts.map(c => c.name))].map(name => [
          name,
          Object.fromEntries(
            ['ranges', 'documents', 'readBytes', 'writes', 'writeBytes'].map(k => [
              k,
              Math.max(...s.counts.filter(c => c.name === name).map(c => c[k])),
            ]),
          ),
        ]),
      ),
    }),
  );
});
test('revoked project writes and expired workers cannot obtain or commit transfers', async t => {
  const s = await fixture(t);
  s.patch('hostedProjects', s.projectId, { removal: 'trash' });
  await assert.rejects(
    s.call('grant', transfer.grant, { ...s.args, action: 'read' }),
    code('PROJECT_UNAVAILABLE'),
  );
  s.patch('hostedProjects', s.projectId, { removal: undefined });
  const before = Date.now;
  t.mock.method(Date, 'now', () => before() + 240000);
  await assert.rejects(
    s.call('grant', transfer.grant, { ...s.args, action: 'read' }),
    code('SOURCE_JOB_FENCED'),
  );
});

test('descriptors and already committed bundle reuse require the exact live lease and binding', async t => {
  const s = await fixture(t);
  const args = {
    projectId: s.projectId,
    input: s.args.input,
    executionId: s.args.executionId,
    sha256: s.input.request.expectedHead,
  };
  const descriptor = JSON.parse(await s.call('describe', transfer.describe, args));
  assert.equal(descriptor.object.sha256, args.sha256);
  const grant = await s.call('grant', transfer.grant, { ...s.args, action: 'upload' });
  assert.deepEqual(grant, { stored: true });
  await assert.rejects(
    s.call('grant', transfer.grant, {
      ...s.args,
      action: 'upload',
      pin: { ...s.args.pin, size: s.args.pin.size + 1 },
    }),
    code('SOURCE_HASH_MISMATCH'),
  );
  await assert.rejects(
    s.call('describe', transfer.describe, { ...args, sha256: 'f'.repeat(64) }),
    code('SOURCE_UNAVAILABLE'),
  );
});
