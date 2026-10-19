// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { getFunctionName } from 'convex/server';
import { build } from 'esbuild';
import { moduleUrl } from './convex-module.mjs';
import { state } from './hosted-fixture.mjs';
import { recoverSecretArchive } from '../dist/secretArchive.js';
const lifecycle = await import(moduleUrl('../convex/secretLifecycle.ts'));
const secrets = await import(moduleUrl('../convex/secrets.ts')),
  actions = await import(moduleUrl('../convex/secretActions.ts'));
const { secretObjectArchive } = await import(moduleUrl('../web/src/SecretLifecycle.tsx'));
const denied = e => (e.data?.code ?? e.code) === 'SECRET_UNAVAILABLE';
const changed = e => (e.data?.code ?? e.code) === 'SECRET_CHANGED';
function setup() {
  const s = state([]),
    previous = process.env.FORGE_SECRET_KEYS;
  const keys = { active: 'first', keys: { first: randomBytes(32).toString('base64') } };
  process.env.FORGE_SECRET_KEYS = JSON.stringify(keys);
  const client = {
    query: (fn, input) => {
      const [module, name] = getFunctionName(fn).split(':');
      return { secretLifecycle: lifecycle }[module][name]._handler(s.ctx, input);
    },
  };
  const create = (operationId = randomUUID(), value = 'synthetic-value-one') =>
    actions.create._handler(s.ctx, {
      name: 'Synthetic owned credential',
      repository: 'example/project',
      ref: 'main',
      value,
      operationId,
    });
  const request = id => {
    const object = s.tables.secretObjects.get(id);
    return {
      id,
      operationId: randomUUID(),
      version: object.version,
      policyRevision: object.policyRevision,
      archiveRevision: object.archiveRevision ?? 0,
    };
  };
  return {
    s,
    keys,
    client,
    create,
    request,
    cleanup: () =>
      previous === undefined
        ? delete process.env.FORGE_SECRET_KEYS
        : (process.env.FORGE_SECRET_KEYS = previous),
  };
}
async function drain(s) {
  for (let index = 0; index < s.scheduled.length; index++) {
    const task = s.scheduled[index];
    s.tasks.set(task.id, { state: { kind: 'inProgress' } });
    const [module, name] = getFunctionName(task.fn).split(':');
    if (module === 'secretLifecycle') await lifecycle[name]._handler(s.ctx, task.args);
    s.tasks.set(task.id, { state: { kind: 'success' } });
  }
}
test('owner encrypted portable export spans all pages and recovers exact rotated versions offline without copying live authority', async () => {
  const qa = setup(),
    { s, create, keys, client } = qa;
  try {
    const id = await create(),
      unrelated = await create();
    for (let i = 2; i <= 54; i++)
      await actions.rotate._handler(s.ctx, {
        id,
        value: `synthetic-value-${i}`,
        expectedVersion: i - 1,
        operationId: randomUUID(),
      });
    for (let i = 0; i < 56; i++) {
      const object = s.tables.secretObjects.get(id);
      await secrets.grant._handler(s.ctx, {
        id,
        actor: 'owner',
        principal: `reader-${i}`,
        capabilities: ['discover', 'use'],
        expectedPolicyRevision: object.policyRevision,
        operationId: randomUUID(),
      });
    }
    await secrets.archive._handler(s.ctx, {
      id,
      archived: true,
      expectedArchiveRevision: 0,
      operationId: randomUUID(),
    });
    const before = JSON.stringify(
      Object.fromEntries(Object.entries(s.tables).map(([name, table]) => [name, [...table.values()]])),
    );
    const text = await secretObjectArchive(client, id),
      archive = JSON.parse(text),
      recovered = recoverSecretArchive(text, keys);
    assert.equal(archive.versions.length, 54);
    assert.equal(archive.grants.length, 57);
    assert.equal(archive.events.length, 111);
    assert.equal(recovered.versions[0].value, 'synthetic-value-one');
    assert.equal(recovered.versions.at(-1).value, 'synthetic-value-54');
    assert.equal(recovered.grantsAuthority, 'historical-only');
    assert.equal(recovered.object._id, id);
    assert.ok(!text.includes('synthetic-value-'));
    assert.ok(!text.includes(keys.keys.first));
    assert.ok(
      [...archive.versions, ...archive.grants, ...archive.events].every(row => row.secretId !== unrelated),
    );
    assert.equal(await secretObjectArchive(client, id), text);
    assert.equal(
      JSON.stringify(
        Object.fromEntries(Object.entries(s.tables).map(([name, table]) => [name, [...table.values()]])),
      ),
      before,
    );
    assert.throws(
      () =>
        recoverSecretArchive(text, { active: 'other', keys: { other: randomBytes(32).toString('base64') } }),
      e => e.code === 'SECRET_SETUP_REQUIRED',
    );
    const retained = { active: 'next', keys: { ...keys.keys, next: randomBytes(32).toString('base64') } };
    assert.deepEqual(recoverSecretArchive(text, retained).versions, recovered.versions);
    for (const mutate of [
      a => a.versions.pop(),
      a => (a.versions[0].sealed.tag = randomBytes(16).toString('base64')),
      a => (a.object.owner = 'other'),
      a => (a.versions[0].secretId = unrelated),
      a => (a.grantsAuthority = 'live'),
      a => a.events.pop(),
    ]) {
      const altered = structuredClone(archive);
      mutate(altered);
      assert.throws(() => recoverSecretArchive(JSON.stringify(altered), keys));
    }
    for (const actor of [undefined, 'reader-0', 'other']) {
      s.caller(actor);
      await assert.rejects(secretObjectArchive(client, id), denied);
    }
  } finally {
    qa.cleanup();
  }
});
test('export pages and final assembly reject concurrent value, grant, archive or audit changes without downloading mixed state', async () => {
  const qa = setup(),
    { s, create, client } = qa;
  try {
    const id = await create();
    for (const change of [
      async () =>
        actions.rotate._handler(s.ctx, {
          id,
          value: 'next-synthetic',
          expectedVersion: s.tables.secretObjects.get(id).version,
          operationId: randomUUID(),
        }),
      async () =>
        secrets.grant._handler(s.ctx, {
          id,
          actor: 'owner',
          principal: 'reader',
          capabilities: ['use'],
          expectedPolicyRevision: s.tables.secretObjects.get(id).policyRevision,
          operationId: randomUUID(),
        }),
      async () =>
        secrets.archive._handler(s.ctx, {
          id,
          archived: true,
          expectedArchiveRevision: s.tables.secretObjects.get(id).archiveRevision ?? 0,
          operationId: randomUUID(),
        }),
      async () => actions.reveal._handler(s.ctx, { id, operationId: randomUUID() }),
    ]) {
      const info = await lifecycle.exportInfo._handler(s.ctx, { id });
      await change();
      await assert.rejects(
        lifecycle.exportPage._handler(s.ctx, {
          id,
          ...info.pins,
          eventThrough: info.eventThrough,
          eventThroughId: info.eventThroughId,
          part: 'versions',
          paginationOpts: { numItems: 50, cursor: null },
        }),
        changed,
      );
      assert.ok(JSON.parse(await secretObjectArchive(client, id)).complete);
    }
    let changedFinal = false;
    const original = client.query;
    client.query = async (fn, input) => {
      if (getFunctionName(fn) === 'secretLifecycle:exportPage' && input.part === 'events' && !changedFinal) {
        const result = await original(fn, input);
        changedFinal = true;
        await actions.reveal._handler(s.ctx, { id, operationId: randomUUID() });
        return result;
      }
      return original(fn, input);
    };
    await assert.rejects(secretObjectArchive(client, id), changed);
  } finally {
    qa.cleanup();
  }
});
test('explicit owner deletion immediately ends reads, resumes failed purge, reconciles lost replies and preserves unrelated objects', async () => {
  const qa = setup(),
    { s, create, client, request, keys } = qa;
  try {
    const creation = randomUUID(),
      id = await create(creation),
      other = await create(),
      otherBefore = structuredClone(s.tables.secretObjects.get(other));
    for (let i = 2; i <= 54; i++)
      await actions.rotate._handler(s.ctx, {
        id,
        value: `synthetic-value-${i}`,
        expectedVersion: i - 1,
        operationId: randomUUID(),
      });
    await secrets.grant._handler(s.ctx, {
      id,
      actor: 'owner',
      principal: 'reader',
      capabilities: ['discover', 'reveal'],
      expectedPolicyRevision: 1,
      operationId: randomUUID(),
    });
    const text = await secretObjectArchive(client, id),
      input = request(id),
      received = await lifecycle.permanentlyDelete._handler(s.ctx, input);
    assert.equal(received.status, 'deleting');
    assert.equal(s.scheduled.length, 1);
    assert.deepEqual(await lifecycle.permanentlyDelete._handler(s.ctx, input), received);
    assert.equal(s.scheduled.length, 1);
    for (const actor of ['owner', 'reader', 'other', undefined]) {
      s.caller(actor);
      await assert.rejects(secrets.details._handler(s.ctx, { id }), denied);
      await assert.rejects(actions.reveal._handler(s.ctx, { id, operationId: randomUUID() }), denied);
      await assert.rejects(secretObjectArchive(client, id), denied);
    }
    s.caller('other');
    await assert.rejects(lifecycle.permanentlyDelete._handler(s.ctx, input), denied);
    assert.equal(await lifecycle.deletion._handler(s.ctx, input), null);
    assert.deepEqual(
      (await lifecycle.deletions._handler(s.ctx, { paginationOpts: { numItems: 20, cursor: null } })).page,
      [],
    );
    s.caller('owner');
    await assert.rejects(lifecycle.permanentlyDelete._handler(s.ctx, { ...input, version: 1 }), changed);
    const old = s.scheduled[0];
    await lifecycle.purge._handler(s.ctx, old.args);
    s.tasks.set(s.scheduled.at(-1).id, { state: { kind: 'failed' } });
    const tasks = s.scheduled.length;
    await lifecycle.permanentlyDelete._handler(s.ctx, input);
    assert.equal(s.scheduled.length, tasks + 1);
    await drain(s);
    const complete = await lifecycle.permanentlyDelete._handler(s.ctx, input);
    assert.equal(complete.status, 'deleted');
    assert.deepEqual(await lifecycle.deletion._handler(s.ctx, input), complete);
    assert.equal(s.tables.secretObjects.has(id), false);
    for (const table of ['secretVersions', 'secretGrants', 'secretEvents'])
      assert.ok([...s.tables[table].values()].every(row => row.secretId !== id));
    assert.deepEqual(s.tables.secretObjects.get(other), otherBefore);
    assert.equal(
      recoverSecretArchive(text, keys).versions.length,
      54,
      'Original privately saved archive remains usable after live deletion.',
    );
    await assert.rejects(create(creation), denied);
    assert.equal(s.tables.secretObjects.size, 1, 'Old creation UUID cannot recreate deleted data.');
    const page = await lifecycle.deletions._handler(s.ctx, {
      paginationOpts: { numItems: 20, cursor: null },
    });
    assert.equal(page.page[0].operationId, input.operationId);
    assert.equal(page.page[0].status, 'deleted');
    const receipt = [...s.tables.secretDeletions.values()][0];
    assert.ok(!JSON.stringify(receipt).includes('Synthetic owned'));
    assert.ok(!JSON.stringify(receipt).includes('sealed'));
    await assert.rejects(
      lifecycle.permanentlyDelete._handler(s.ctx, { ...input, operationId: randomUUID() }),
      changed,
    );
  } finally {
    qa.cleanup();
  }
});
test('deletion refuses stale inputs and blocks a late authorized broker reply or expiry without affecting other grants', async () => {
  const qa = setup(),
    { s, create, request } = qa;
  try {
    const id = await create(),
      input = request(id);
    await actions.rotate._handler(s.ctx, {
      id,
      value: 'rotated',
      expectedVersion: 1,
      operationId: randomUUID(),
    });
    await assert.rejects(lifecycle.permanentlyDelete._handler(s.ctx, input), changed);
    assert.equal(s.tables.secretDeletions.size, 0);
    const current = request(id),
      original = globalThis.fetch;
    try {
      globalThis.fetch = async () => {
        await lifecycle.permanentlyDelete._handler(s.ctx, current);
        return Response.json({ sha: 'a'.repeat(40) });
      };
      await assert.rejects(actions.use._handler(s.ctx, { id, operationId: randomUUID() }), denied);
    } finally {
      globalThis.fetch = original;
    }
    const before = s.tables.secretEvents.size;
    await secrets.expire._handler(s.ctx, {
      id,
      principal: 'owner',
      expiresAt: Date.now() - 1,
      operationId: randomUUID(),
    });
    assert.equal(s.tables.secretEvents.size, before);
    await drain(s);
  } finally {
    qa.cleanup();
  }
});
test('portable transfer and deletion handle an object larger than one response using original retained keys across key rotation', async () => {
  const qa = setup(),
    { s, create, keys, client, request } = qa;
  try {
    const value = 'synthetic-large-value-'.padEnd(480 * 1024, 'z'),
      id = await create(randomUUID(), value);
    keys.keys.second = randomBytes(32).toString('base64');
    keys.active = 'second';
    process.env.FORGE_SECRET_KEYS = JSON.stringify(keys);
    for (let version = 2; version <= 26; version++)
      await actions.rotate._handler(s.ctx, {
        id,
        value,
        expectedVersion: version - 1,
        operationId: randomUUID(),
      });
    const text = await secretObjectArchive(client, id);
    assert.ok(Buffer.byteLength(text) > 16 * 1024 * 1024);
    const restored = recoverSecretArchive(text, keys);
    assert.equal(restored.versions.length, 26);
    assert.ok(restored.versions.every(row => row.value === value));
    assert.equal(JSON.parse(text).versions[0].sealed.keyId, 'first');
    assert.equal(JSON.parse(text).versions.at(-1).sealed.keyId, 'second');
    await lifecycle.permanentlyDelete._handler(s.ctx, request(id));
    await lifecycle.purge._handler(s.ctx, s.scheduled[0].args);
    assert.equal([...s.tables.secretVersions.values()].filter(row => row.secretId === id).length, 25);
    await drain(s);
    assert.equal(s.tables.secretVersions.size, 0);
    assert.equal(s.tables.secretObjects.size, 0);
    assert.equal(recoverSecretArchive(text, keys).versions[0].value.length, value.length);
  } finally {
    qa.cleanup();
  }
});
test('SecretObject lifecycle queries and mutations bundle at the actual non-Node runtime boundary', async () => {
  const result = await build({
    entryPoints: ['convex/secretLifecycle.ts', 'convex/secrets.ts', 'convex/schema.ts'],
    bundle: true,
    platform: 'browser',
    target: 'es2022',
    format: 'esm',
    write: false,
    outdir: 'unused-secret-runtime',
    logLevel: 'silent',
  });
  assert.equal(result.outputFiles.length, 3);
  assert.ok(result.outputFiles.every(file => file.contents.length > 0));
});
