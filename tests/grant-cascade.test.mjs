// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { moduleUrl } from './convex-module.mjs';
import { state, providers } from './hosted-fixture.mjs';
const secrets = await import(moduleUrl('../convex/secrets.ts'));
const actions = await import(moduleUrl('../convex/secretActions.ts'));
const lifecycle = await import(moduleUrl('../convex/secretLifecycle.ts'));
const { secretAuditJson } = await import(moduleUrl('../web/src/Secrets.tsx'));
const caps = ['discover', 'names', 'use', 'reveal', 'modify', 'delegate'];
const paginationOpts = { cursor: null, numItems: 100 };
const denied = e => (e.data?.code ?? e.code) === 'SECRET_UNAVAILABLE';
const code = expected => e => (e.data?.code ?? e.code) === expected;
async function setup() {
  const s = state([]);
  const id = await secrets.create._handler(s.ctx, {
    owner: 'owner',
    name: 'Synthetic secret',
    repository: 'example/project',
    ref: 'main',
    operationId: randomUUID(),
    inputTag: 'synthetic-tag',
    sealed: { keyId: 'synthetic', nonce: 'synthetic', tag: 'synthetic', ciphertext: 'synthetic' },
  });
  const grant = async (actor, principal, capabilities = caps, extra = {}) => {
    s.caller(actor);
    return secrets.grant._handler(s.ctx, {
      id,
      actor,
      principal,
      capabilities,
      expectedPolicyRevision: s.tables.secretObjects.get(id).policyRevision,
      operationId: randomUUID(),
      ...extra,
    });
  };
  const authorize = (actor, capability = 'use') =>
    secrets.authorize._handler(s.ctx, { id, actor, capability });
  const row = principal => [...s.tables.secretGrants.values()].find(row => row.principal === principal);
  const preview = principal => secrets.revocationPreview._handler(s.ctx, { id, principal });
  return { s, id, grant, authorize, row, preview };
}

test('revoking B in owner → B → C → D previews, marks and audits every descendant without removing independent grants', async () => {
  const { s, id, grant, authorize, row, preview } = await setup();
  await grant('owner', 'B');
  await grant('B', 'C');
  await grant('C', 'D', ['discover', 'use']);
  await grant('B', 'independent', ['use']);
  await grant('owner', 'independent', ['use']);
  await authorize('D');
  s.caller('owner');
  const before = await preview('B');
  assert.deepEqual(
    before.grants.map(row => row.principal),
    ['C', 'D'],
  );
  const affected = await grant('owner', 'B', []);
  assert.deepEqual(affected, before.grants);
  assert.equal(row('B'), undefined);
  assert.equal(typeof row('C').revokedAt, 'number');
  assert.equal(row('C').discover, false);
  assert.equal(row('D').activeUntil, 0);
  await authorize('independent');
  for (const actor of ['B', 'C', 'D']) {
    for (const capability of caps) await assert.rejects(authorize(actor, capability), denied);
    s.caller(actor);
    assert.deepEqual((await secrets.list._handler(s.ctx, { paginationOpts })).page, []);
    await assert.rejects(secrets.details._handler(s.ctx, { id }), denied);
  }
  s.caller('owner');
  assert.deepEqual(
    (await secrets.grants._handler(s.ctx, { id, paginationOpts })).page.map(row => row.principal),
    ['independent', 'owner'],
  );
  const audit = (await secrets.audit._handler(s.ctx, { id, paginationOpts })).page;
  assert.deepEqual(
    audit
      .filter(row => row.kind === 'cascade-revoke')
      .map(row => row.principal)
      .sort(),
    ['C', 'D'],
  );
  assert.ok(
    audit
      .filter(row => row.kind === 'cascade-revoke')
      .every(row => row.actor === 'owner' && row.cascadeFrom === 'B'),
  );
  assert.deepEqual(JSON.parse(secretAuditJson(id, audit)).events, audit);
  const info = await lifecycle.exportInfo._handler(s.ctx, { id });
  const exported = await lifecycle.exportPage._handler(s.ctx, {
    id,
    ...info.pins,
    part: 'grants',
    eventThrough: info.eventThrough,
    eventThroughId: info.eventThroughId,
    paginationOpts,
  });
  assert.equal(exported.page.find(row => row.principal === 'C').revokedAt, row('C').revokedAt);
});

test('read-time authority refuses descendants before any row cascade, including discovery and in-flight finish', async () => {
  for (const change of ['delete', 'revoke', 'delegate', 'capability']) {
    const { s, id, grant, authorize, row } = await setup();
    await grant('owner', 'B');
    await grant('B', 'C');
    const snapshot = await authorize('C');
    if (change === 'delete') s.tables.secretGrants.delete(row('B')._id);
    else if (change === 'revoke') row('B').revokedAt = Date.now();
    else
      row('B').capabilities = row('B').capabilities.filter(
        cap => cap !== (change === 'delegate' ? 'delegate' : 'use'),
      );
    assert.equal(row('C').revokedAt, undefined);
    await assert.rejects(authorize('C'), denied);
    await assert.rejects(
      secrets.finish._handler(s.ctx, {
        id,
        actor: 'C',
        operationId: randomUUID(),
        capability: 'use',
        version: snapshot.object.version,
        policyRevision: snapshot.object.policyRevision,
        sha: 'a'.repeat(40),
      }),
      denied,
    );
    if (change !== 'capability') {
      s.caller('C');
      assert.deepEqual((await secrets.list._handler(s.ctx, { paginationOpts })).page, []);
      await assert.rejects(secrets.details._handler(s.ctx, { id }), denied);
    }
  }
});

test('expiry cascades at read time before scheduled cleanup and cleanup audits descendants only once', async () => {
  const { s, id, grant, authorize, row } = await setup(),
    clock = Date.now;
  try {
    const expiresAt = clock() + 10000;
    await grant('owner', 'B', caps, { expiresAt: expiresAt + 10000 });
    await grant('B', 'C', caps, { expiresAt: expiresAt + 10000 });
    await grant('C', 'D', ['use'], { expiresAt: expiresAt + 10000 });
    await grant('owner', 'B', caps, { expiresAt });
    const task = s.scheduled.at(-1);
    Date.now = () => expiresAt + 1;
    for (const actor of ['C', 'D']) await assert.rejects(authorize(actor), denied);
    assert.equal(row('C').revokedAt, undefined);
    s.caller('C');
    assert.deepEqual((await secrets.list._handler(s.ctx, { paginationOpts })).page, []);
    await secrets.expire._handler(s.ctx, task.args);
    const count = s.tables.secretEvents.size;
    await secrets.expire._handler(s.ctx, task.args);
    assert.equal(s.tables.secretEvents.size, count);
    assert.equal(row('B'), undefined);
    assert.equal(typeof row('C').revokedAt, 'number');
    assert.equal([...s.tables.secretEvents.values()].filter(row => row.kind === 'cascade-revoke').length, 2);
    await grant('owner', 'B');
    await authorize('B');
    await assert.rejects(authorize('C'), denied);
  } finally {
    Date.now = clock;
  }
});

test('re-granting an expired delegate before its scheduled cleanup preserves new access without restoring descendants', async () => {
  const { s, grant, authorize, row } = await setup(),
    clock = Date.now;
  try {
    const expiresAt = clock() + 10000;
    await grant('owner', 'B', caps, { expiresAt });
    await grant('B', 'C', ['use'], { expiresAt });
    const old = s.scheduled.find(task => task.args.principal === 'B');
    Date.now = () => expiresAt + 1;
    await grant('owner', 'B');
    await secrets.expire._handler(s.ctx, old.args);
    await authorize('B');
    await assert.rejects(authorize('C'), denied);
    assert.equal(typeof row('C').revokedAt, 'number');
    await grant('B', 'C', ['use']);
    await authorize('C');
  } finally {
    Date.now = clock;
  }
});

test('lost revocation reply retries return the original affected list and never revoke later independent re-grants', async () => {
  const { s, id, grant, authorize } = await setup();
  await grant('owner', 'B');
  await grant('B', 'C');
  const input = {
    id,
    principal: 'B',
    capabilities: [],
    expectedPolicyRevision: s.tables.secretObjects.get(id).policyRevision,
    operationId: randomUUID(),
  };
  s.caller('owner');
  const original = s.ctx.runMutation;
  s.ctx.runMutation = async (fn, args) => {
    const result = await original(fn, args);
    if (args.principal === 'B' && Array.isArray(args.capabilities)) throw new Error('Synthetic lost reply');
    return result;
  };
  await assert.rejects(actions.grant._handler(s.ctx, input), code('HOSTED_REQUEST_FAILED'));
  s.ctx.runMutation = original;
  assert.equal(
    [...s.tables.secretGrants.values()].some(row => row.principal === 'B'),
    false,
  );
  const afterCommit = s.tables.secretEvents.size;
  const first = await actions.grant._handler(s.ctx, input);
  assert.equal(s.tables.secretEvents.size, afterCommit);
  assert.deepEqual(
    first.map(row => row.principal),
    ['C'],
  );
  await grant('owner', 'B');
  await grant('owner', 'C');
  const events = s.tables.secretEvents.size,
    revision = s.tables.secretObjects.get(id).policyRevision;
  assert.deepEqual(await actions.grant._handler(s.ctx, input), first);
  assert.equal(s.tables.secretEvents.size, events);
  assert.equal(s.tables.secretObjects.get(id).policyRevision, revision);
  await authorize('B');
  await authorize('C');
  for (const change of [
    { principal: 'C' },
    { expectedPolicyRevision: input.expectedPolicyRevision + 1 },
    { capabilities: ['use'] },
  ])
    await assert.rejects(
      secrets.grant._handler(s.ctx, { ...input, actor: 'owner', ...change }),
      code('BAD_ARGUMENT'),
    );
  await assert.rejects(
    secrets.grant._handler(s.ctx, { ...input, actor: 'owner', operationId: randomUUID() }),
    code('SECRET_CHANGED'),
  );
});

test('legacy grants use retained audit attribution without rewriting rows and invalid chains fail closed', async () => {
  const { s, grant, authorize, preview, row } = await setup();
  await grant('owner', 'B');
  await grant('B', 'C');
  for (const row of s.tables.secretGrants.values()) {
    delete row.grantedBy;
    delete row.parentGrantId;
  }
  const before = JSON.stringify([...s.tables.secretGrants.values()]);
  await authorize('C');
  s.caller('owner');
  assert.deepEqual(
    (await preview('B')).grants.map(row => row.principal),
    ['C'],
  );
  assert.equal(JSON.stringify([...s.tables.secretGrants.values()]), before);
  s.tables.secretGrants.delete(row('B')._id);
  await assert.rejects(authorize('C'), denied);
  await grant('owner', 'B');
  // New grants bind to the current parent row, so replacing that row cannot revive them.
  await grant('B', 'C');
  const prior = row('B')._id;
  s.tables.secretGrants.delete(prior);
  await grant('owner', 'B');
  await assert.rejects(authorize('C'), denied);
  row('B').grantedBy = 'C';
  row('B').parentGrantId = row('C')._id;
  await assert.rejects(authorize('B'), denied);
});

test('preview and name lookups require current delegate authority, reject owner revocation and recheck after identity reads', async () => {
  const { s, id, grant, preview } = await setup(),
    cleanup = providers();
  try {
    await grant('owner', 'B');
    await grant('B', 'C', ['use']);
    for (const actor of [undefined, 'other', 'C']) {
      s.caller(actor);
      await assert.rejects(preview('B'), denied);
      await assert.rejects(actions.revocationNames._handler(s.ctx, { id, principal: 'B' }), denied);
    }
    s.caller('owner');
    await assert.rejects(preview('owner'), denied);
    await assert.rejects(
      secrets.revocationPreview._handler(s.ctx, { id: 'missing', principal: 'B' }),
      denied,
    );
    const names = await actions.revocationNames._handler(s.ctx, { id, principal: 'B' });
    assert.deepEqual(
      names.map(row => row.principal),
      ['B', 'C'],
    );
    s.caller('B');
    const normal = globalThis.fetch;
    let changed = false;
    globalThis.fetch = async (...args) => {
      const response = await normal(...args);
      if (!changed) {
        changed = true;
        await grant('owner', 'B', []);
        s.caller('B');
      }
      return response;
    };
    await assert.rejects(actions.revocationNames._handler(s.ctx, { id, principal: 'C' }), denied);
  } finally {
    cleanup();
  }
});

test('stale scheduled expiry with the same timestamp cannot delete a replacement grant', async () => {
  const { s, grant, row } = await setup(),
    clock = Date.now;
  try {
    const expiresAt = clock() + 10000;
    await grant('owner', 'B', ['use'], { expiresAt });
    const old = s.scheduled.at(-1);
    await grant('owner', 'B', ['discover'], { expiresAt });
    Date.now = () => expiresAt + 1;
    await secrets.expire._handler(s.ctx, old.args);
    assert.deepEqual(row('B').capabilities, ['discover']);
  } finally {
    Date.now = clock;
  }
});

test('self-updates preserve the original delegation chain and retained capabilities survive ordinary ancestor updates', async () => {
  const { s, grant, authorize, row } = await setup();
  await grant('owner', 'B');
  await grant('B', 'C');
  await grant('C', 'C', ['discover', 'use', 'delegate']);
  assert.equal(row('C').grantedBy, 'B');
  await grant('C', 'D', ['use']);
  await grant('owner', 'B', ['discover', 'use', 'delegate']);
  await authorize('D');
  await assert.rejects(authorize('C', 'reveal'), denied);
  await assert.rejects(grant('C', 'D', ['reveal']), denied);
  s.caller('owner');
  const result = await grant('owner', 'B', []);
  assert.deepEqual(
    result.map(row => row.principal),
    ['C', 'D'],
  );
  await grant('owner', 'B');
  await assert.rejects(authorize('D'), denied);
  await grant('B', 'C', ['use']);
  await authorize('C');
  await assert.rejects(authorize('D'), denied);
});

test('display-name results are discarded if policy changes while the revoker still has access', async () => {
  const { s, id, grant } = await setup(),
    cleanup = providers();
  try {
    await grant('owner', 'B');
    const normal = globalThis.fetch;
    let changed = false;
    globalThis.fetch = async (...args) => {
      const response = await normal(...args);
      if (!changed) {
        changed = true;
        await grant('owner', 'other', ['use']);
      }
      return response;
    };
    await assert.rejects(
      actions.revocationNames._handler(s.ctx, { id, principal: 'B' }),
      code('SECRET_CHANGED'),
    );
  } finally {
    cleanup();
  }
});

test('re-granting an intermediate delegate after upstream expiry cannot revive its old descendants before cleanup', async () => {
  const { s, grant, authorize, row } = await setup(),
    clock = Date.now;
  try {
    const expiresAt = clock() + 10000;
    await grant('owner', 'B', caps, { expiresAt: expiresAt + 10000 });
    await grant('B', 'C', caps, { expiresAt: expiresAt + 10000 });
    await grant('C', 'D', ['use'], { expiresAt: expiresAt + 10000 });
    await grant('owner', 'B', caps, { expiresAt });
    Date.now = () => expiresAt + 1;
    await assert.rejects(authorize('D'), denied);
    await grant('owner', 'C');
    await authorize('C');
    await assert.rejects(authorize('D'), denied);
    assert.equal(typeof row('D').revokedAt, 'number');
    await grant('C', 'D', ['use']);
    await authorize('D');
  } finally {
    Date.now = clock;
  }
});
