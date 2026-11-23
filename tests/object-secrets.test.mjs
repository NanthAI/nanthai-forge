// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { getFunctionName } from 'convex/server';
import { build } from 'esbuild';
import { moduleUrl } from './convex-module.mjs';
import { state } from './hosted-fixture.mjs';

const lifecycle = await import(moduleUrl('../convex/secretLifecycle.ts'));
const secrets = await import(moduleUrl('../convex/secrets.ts')),
  actions = await import(moduleUrl('../convex/secretActions.ts'));

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
