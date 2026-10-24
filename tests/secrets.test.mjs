// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { moduleUrl } from './convex-module.mjs';
import { state, providers } from './hosted-fixture.mjs';
import { secretKeyring, sealSecret, openSecret, secretInputTag } from '../dist/secret-crypto.js';
const db = await import(moduleUrl('../convex/secrets.ts')),
  actions = await import(moduleUrl('../convex/secretActions.ts'));
const { secretAuditJson } = await import(moduleUrl('../web/src/Secrets.tsx'));
const paginationOpts = { cursor: null, numItems: 20 },
  denied = e => (e.data?.code ?? e.code) === 'SECRET_UNAVAILABLE';
const credential = 'synthetic-forge-secret-not-a-real-github-token',
  head = 'a'.repeat(40);
const configuration = () => ({
  active: 'qa-first',
  keys: { 'qa-first': randomBytes(32).toString('base64') },
});
test('dotenv imports use native literal syntax and original encrypted creation receipts without storing unrelated values or rewriting files/history', async () => {
  const s = state([]),
    qa = setup();
  try {
    const unrelated = 'unrelated-credential-not-for-import',
      literal = `${credential} # $NOT_EXPANDED $(not-executed)`,
      operationId = randomUUID();
    const input = {
      env: `# Private synthetic fixture\r\nexport GITHUB_TOKEN=first\r\nGITHUB_TOKEN="${literal}"\r\nOTHER=${unrelated}\r\n`,
      variable: 'GITHUB_TOKEN',
      repository: 'https://github.com/example/project',
      ref: ' main ',
      operationId,
    };
    const prior = await create(s),
      original = JSON.stringify([...s.tables.secretObjects.values()]),
      events = s.tables.secretEvents.size;
    const mutate = s.ctx.runMutation;
    s.ctx.runMutation = async (fn, args) => {
      const result = await mutate(fn, args);
      if (args.name === 'GITHUB_TOKEN') throw new Error('Lost committed import reply');
      return result;
    };
    await assert.rejects(
      actions.createFromEnv._handler(s.ctx, input),
      e => e.data.code === 'HOSTED_REQUEST_FAILED',
    );
    s.ctx.runMutation = mutate;
    const result = await actions.createFromEnv._handler(s.ctx, input);
    assert.equal(s.tables.secretObjects.size, 2);
    assert.equal(s.tables.secretVersions.size, 2);
    assert.equal(s.tables.secretEvents.size, events + 1);
    assert.equal(JSON.stringify([s.tables.secretObjects.get(prior)]), original);
    assert.deepEqual(JSON.parse(result.manifest), {
      schemaVersion: 1,
      variable: 'GITHUB_TOKEN',
      secretId: result.id,
      creationOperationId: operationId,
      creationVersion: 1,
      broker: 'github-ref',
      repository: 'example/project',
      ref: 'main',
      injectsEnvironment: false,
    });
    const { parseEnv } = await import('node:util');
    assert.deepEqual(parseEnv(result.example), { GITHUB_TOKEN: '' });
    assert.equal(
      (await actions.reveal._handler(s.ctx, { id: result.id, operationId: randomUUID() })).value,
      literal,
    );
    const before = JSON.stringify([...s.tables.secretVersions.values()]);
    assert.deepEqual(
      await actions.createFromEnv._handler(s.ctx, {
        ...input,
        env: input.env.replace(unrelated, 'other-unselected-value'),
      }),
      result,
    );
    assert.equal(JSON.stringify([...s.tables.secretVersions.values()]), before);
    await actions.rotate._handler(s.ctx, {
      id: result.id,
      value: 'later-synthetic-value',
      expectedVersion: 1,
      operationId: randomUUID(),
    });
    assert.deepEqual(await actions.createFromEnv._handler(s.ctx, input), result);
    assert.deepEqual(await actions.envReference._handler(s.ctx, { id: result.id }), result);
    assert.equal(s.tables.secretObjects.get(result.id).version, 2);
    for (const changed of [
      { env: 'GITHUB_TOKEN=different' },
      { variable: 'OTHER' },
      { repository: 'example/other' },
      { ref: 'different' },
    ])
      await assert.rejects(
        actions.createFromEnv._handler(s.ctx, { ...input, ...changed }),
        e => e.data.code === 'BAD_ARGUMENT',
      );
    for (const changed of [
      { variable: 'ABSENT' },
      { variable: 'constructor' },
      { variable: 'INVALID\nINJECTION' },
      { env: 'GITHUB_TOKEN=' },
    ])
      await assert.rejects(
        actions.createFromEnv._handler(s.ctx, { ...input, ...changed, operationId: randomUUID() }),
        e => e.data.code === 'BAD_ARGUMENT',
      );
    const stored = JSON.stringify([
      ...s.tables.secretObjects.values(),
      ...s.tables.secretVersions.values(),
      ...s.tables.secretEvents.values(),
    ]);
    for (const value of [literal, unrelated, 'other-unselected-value']) {
      assert.ok(!stored.includes(value));
      assert.ok(!result.manifest.includes(value));
      assert.ok(!result.example.includes(value));
    }
    assert.equal(qa.calls.length, 0);
    s.caller('other');
    await assert.rejects(db.details._handler(s.ctx, { id: result.id }), denied);
    await assert.rejects(
      actions.reveal._handler(s.ctx, { id: result.id, operationId: randomUUID() }),
      denied,
    );
    await assert.rejects(actions.envReference._handler(s.ctx, { id: result.id }), denied);
    s.caller(undefined);
    await assert.rejects(actions.createFromEnv._handler(s.ctx, input), denied);
    await assert.rejects(actions.envReference._handler(s.ctx, { id: result.id }), denied);
    s.caller('owner');
    await grant(s, result.id, 'reader', ['names']);
    s.caller('reader');
    assert.deepEqual(await actions.envReference._handler(s.ctx, { id: result.id }), result);
    await assert.rejects(
      actions.reveal._handler(s.ctx, { id: result.id, operationId: randomUUID() }),
      denied,
    );
    assert.equal(s.tables.secretObjects.size, 2);
    assert.equal(s.tables.secretVersions.size, 3);
  } finally {
    qa.cleanup();
  }
});
function setup() {
  const previous = process.env.FORGE_SECRET_KEYS,
    cleanup = providers(),
    originalFetch = globalThis.fetch;
  const keys = configuration(),
    calls = [];
  process.env.FORGE_SECRET_KEYS = JSON.stringify(keys);
  globalThis.fetch = async (url, init) => {
    if (new URL(url).hostname === 'api.github.com') {
      calls.push({ url: String(url), init });
      return Response.json({ sha: head, ignoredCredential: credential });
    }
    return originalFetch(url, init);
  };
  return {
    keys,
    calls,
    cleanup: () => {
      cleanup();
      if (previous === undefined) delete process.env.FORGE_SECRET_KEYS;
      else process.env.FORGE_SECRET_KEYS = previous;
    },
  };
}

test('owner audit exports preserve exact loaded original events across pages without credential values, encrypted versions or completeness claims', async () => {
  const s = state([]),
    qa = setup();
  try {
    const id = await create(s);
    for (let i = 0; i < 23; i++)
      await db.enabled._handler(s.ctx, {
        id,
        enabled: i % 2 === 0,
        expectedPolicyRevision: s.tables.secretObjects.get(id).policyRevision,
        operationId: randomUUID(),
      });
    await grant(s, id, 'reader', ['discover', 'names', 'use'], { expiresAt: Date.now() + 60_000 });
    await use(s, id);
    await actions.reveal._handler(s.ctx, { id, operationId: randomUUID() });
    await actions.rotate._handler(s.ctx, {
      id,
      value: 'another-synthetic-value',
      expectedVersion: 1,
      operationId: randomUUID(),
    });
    const first = await db.audit._handler(s.ctx, { id, paginationOpts }),
      second = await db.audit._handler(s.ctx, {
        id,
        paginationOpts: { ...paginationOpts, cursor: first.continueCursor },
      });
    assert.equal(first.page.length, 20);
    assert.equal(first.isDone, false);
    assert.equal(second.page.length, 8);
    assert.equal(second.isDone, true);
    const before = JSON.stringify([...s.tables.secretEvents.values()]),
      calls = qa.calls.length,
      pages = [first.page, [...first.page, ...second.page]];
    for (const events of pages) {
      const text = secretAuditJson(id, events),
        archive = JSON.parse(text);
      assert.equal(archive.secretId, id);
      assert.equal(archive.scope, 'loaded-observation');
      assert.equal(archive.complete, false);
      assert.deepEqual(archive.events, events);
      assert.ok(!text.includes(credential));
      assert.ok(!text.includes('ciphertext'));
      assert.equal(
        secretAuditJson(id, events),
        text,
        'Identical original records produce identical export bytes.',
      );
    }
    const injected = JSON.parse(
      secretAuditJson(
        id,
        first.page.map(row => ({
          ...row,
          value: credential,
          sealed: [...s.tables.secretVersions.values()][0].sealed,
        })),
      ),
    );
    assert.deepEqual(injected.events, first.page);
    assert.equal(JSON.stringify([...s.tables.secretEvents.values()]), before);
    assert.equal(qa.calls.length, calls);
    for (const actor of [undefined, 'other', 'reader']) {
      s.caller(actor);
      await assert.rejects(db.audit._handler(s.ctx, { id, paginationOpts }), denied);
    }
  } finally {
    qa.cleanup();
  }
});

test('owner Secret Object archiving preserves credentials and delegated capabilities, reconciles original receipts and never changes broker policy', async () => {
  const s = state([]),
    qa = setup();
  try {
    const creation = randomUUID(),
      id = await create(s, { operationId: creation });
    await grant(s, id, 'reader', ['discover', 'names', 'use', 'reveal', 'delegate']);
    const before = structuredClone(s.tables.secretObjects.get(id)),
      versions = JSON.stringify([...s.tables.secretVersions.values()]),
      grants = JSON.stringify([...s.tables.secretGrants.values()]);
    s.caller('reader');
    const readerBefore = await db.details._handler(s.ctx, { id });
    for (const actor of ['reader', 'other', undefined]) {
      s.caller(actor);
      await assert.rejects(
        db.archive._handler(s.ctx, {
          id,
          archived: true,
          expectedArchiveRevision: 0,
          operationId: randomUUID(),
        }),
        denied,
      );
    }
    s.caller('owner');
    const request = { id, archived: true, expectedArchiveRevision: 0, operationId: randomUUID() };
    await db.archive._handler(s.ctx, request);
    await db.archive._handler(s.ctx, request);
    assert.equal((await db.details._handler(s.ctx, { id })).archived, true);
    assert.equal((await db.list._handler(s.ctx, { paginationOpts })).archiveSupported, true);
    assert.deepEqual((await db.list._handler(s.ctx, { paginationOpts })).page, []);
    assert.equal((await db.list._handler(s.ctx, { paginationOpts, archived: true })).page[0].id, id);
    assert.equal(await create(s, { operationId: creation }), id, 'Creation reconciliation never unarchives.');
    assert.equal(s.tables.secretObjects.get(id).archived, true);
    s.caller('reader');
    assert.deepEqual(await db.details._handler(s.ctx, { id }), readerBefore);
    assert.equal((await db.list._handler(s.ctx, { paginationOpts })).page[0].id, id);
    assert.deepEqual((await db.list._handler(s.ctx, { paginationOpts, archived: true })).page, []);
    assert.equal((await use(s, id)).sha, head);
    assert.equal((await actions.reveal._handler(s.ctx, { id, operationId: randomUUID() })).value, credential);
    s.caller('owner');
    await db.archive._handler(s.ctx, {
      id,
      archived: false,
      expectedArchiveRevision: 1,
      operationId: randomUUID(),
    });
    await db.archive._handler(s.ctx, request);
    assert.equal(s.tables.secretObjects.get(id).archived, false, 'Old receipt cannot rearchive.');
    await assert.rejects(
      db.archive._handler(s.ctx, { ...request, archived: false }),
      e => e.data.code === 'BAD_ARGUMENT',
    );
    await assert.rejects(
      db.archive._handler(s.ctx, { ...request, operationId: randomUUID() }),
      e => e.data.code === 'SECRET_CHANGED',
    );
    assert.deepEqual(s.tables.secretObjects.get(id), { ...before, archived: false, archiveRevision: 2 });
    assert.equal(JSON.stringify([...s.tables.secretVersions.values()]), versions);
    assert.equal(JSON.stringify([...s.tables.secretGrants.values()]), grants);
    const audit = (await db.audit._handler(s.ctx, { id, paginationOpts })).page;
    assert.deepEqual(JSON.parse(secretAuditJson(id, audit)).events, audit);
    assert.equal(audit.filter(row => ['archive', 'unarchive'].includes(row.kind)).length, 2);
  } finally {
    qa.cleanup();
  }
});

test('archive filters keep native seek pages and expiry independent, and archiving during a broker read preserves its successful original authority', async () => {
  const s = state([]),
    qa = setup();
  try {
    const ids = [];
    for (let i = 0; i < 23; i++) {
      const id = await create(s);
      ids.push(id);
      if (i % 2 === 0)
        await db.archive._handler(s.ctx, {
          id,
          archived: true,
          expectedArchiveRevision: 0,
          operationId: randomUUID(),
        });
    }
    for (const archived of [false, true]) {
      const first = await db.list._handler(s.ctx, {
        paginationOpts: { cursor: null, numItems: 5 },
        archived,
      });
      const second = await db.list._handler(s.ctx, {
        paginationOpts: { cursor: first.continueCursor, numItems: 20 },
        archived,
      });
      assert.equal(first.page.length, 5);
      assert.equal(first.isDone, false);
      assert.equal(second.isDone, true);
      assert.equal(first.page.length + second.page.length, archived ? 12 : 11);
      assert.ok([...first.page, ...second.page].every(row => row.archived === archived));
    }
    const id = ids[1];
    await grant(s, id, 'reader', ['discover', 'use']);
    s.caller('reader');
    const normal = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
      if (new URL(url).hostname !== 'api.github.com') return normal(url, init);
      s.caller('owner');
      await db.archive._handler(s.ctx, {
        id,
        archived: true,
        expectedArchiveRevision: 0,
        operationId: randomUUID(),
      });
      s.caller('reader');
      return Response.json({ sha: head });
    };
    assert.equal((await use(s, id)).sha, head);
    globalThis.fetch = normal;
    s.caller('owner');
    await grant(s, id, 'reader', ['discover', 'use'], { expiresAt: Date.now() - 1 });
    s.caller('reader');
    assert.deepEqual((await db.list._handler(s.ctx, { paginationOpts })).page, []);
    await assert.rejects(use(s, id), denied);
  } finally {
    qa.cleanup();
  }
});
const create = (s, input = {}) =>
  actions.create._handler(s.ctx, {
    name: 'Deployment ref <img src=x onerror=untrusted>',
    repository: 'example/project',
    ref: 'main',
    value: credential,
    operationId: randomUUID(),
    ...input,
  });
const use = (s, id, operationId = randomUUID()) => actions.use._handler(s.ctx, { id, operationId });
async function grant(s, id, principal, capabilities, extra = {}) {
  const object = s.tables.secretObjects.get(id);
  return actions.grant._handler(s.ctx, {
    id,
    principal,
    capabilities,
    expectedPolicyRevision: object.policyRevision,
    operationId: randomUUID(),
    ...extra,
  });
}

test('native Secret Object encryption authenticates owner/scope/version and supports explicit retained key rotation without plaintext storage', () => {
  const keys = configuration(),
    binding = {
      owner: 'owner',
      operationId: randomUUID(),
      repository: 'example/project',
      ref: 'main',
      version: 1,
    };
  const first = sealSecret(keys, binding, credential),
    second = sealSecret(keys, binding, credential);
  assert.notEqual(first.nonce, second.nonce);
  assert.notEqual(first.ciphertext, second.ciphertext);
  assert.equal(openSecret(keys, binding, first), credential);
  assert.ok(!JSON.stringify(first).includes(credential));
  assert.equal(secretInputTag(keys, binding, credential), secretInputTag(keys, binding, credential));
  for (const change of [
    { owner: 'other' },
    { operationId: randomUUID() },
    { repository: 'other/project' },
    { ref: 'other' },
    { version: 2 },
  ])
    assert.throws(
      () => openSecret(keys, { ...binding, ...change }, first),
      e => e.code === 'SECRET_INVALID',
    );
  assert.throws(
    () => openSecret(keys, binding, { ...first, tag: randomBytes(16).toString('base64') }),
    e => e.code === 'SECRET_INVALID',
  );
  assert.throws(
    () => openSecret(keys, binding, { ...first, ciphertext: first.ciphertext.slice(0, -4) }),
    e => e.code === 'SECRET_INVALID',
  );
  const rotated = {
    active: 'qa-second',
    keys: { ...keys.keys, 'qa-second': randomBytes(32).toString('base64') },
  };
  assert.equal(openSecret(rotated, binding, first), credential);
  assert.equal(sealSecret(rotated, binding, credential).keyId, 'qa-second');
  delete rotated.keys['qa-first'];
  assert.throws(
    () => openSecret(rotated, binding, first),
    e => e.code === 'SECRET_SETUP_REQUIRED',
  );
  for (const value of [undefined, 'invalid', '{}', JSON.stringify({ active: 'unknown', keys: keys.keys })])
    assert.throws(
      () => secretKeyring(value),
      e => e.code === 'SECRET_SETUP_REQUIRED',
    );
});

test('independent Secret Object discover/names/use/reveal/modify/delegate rights deny before credentials or provider reads and keep metadata private', async () => {
  const s = state([]),
    qa = setup();
  try {
    const operationId = randomUUID(),
      id = await create(s, { operationId });
    assert.equal(await create(s, { operationId }), id);
    assert.equal(s.tables.secretObjects.size, 1);
    await assert.rejects(create(s, { operationId, value: 'different' }), e => e.data.code === 'BAD_ARGUMENT');
    assert.ok(!JSON.stringify([...s.tables.secretVersions.values()]).includes(credential));
    await assert.rejects(
      create(s, { repository: 'https://127.0.0.1/private' }),
      e => e.data.code === 'BAD_REPOSITORY',
    );
    const owner = await db.details._handler(s.ctx, { id });
    assert.equal(owner.owned, true);
    assert.equal(owner.capabilities.length, 6);
    assert.ok(!JSON.stringify(owner).includes(credential));
    for (const caller of [undefined, 'other']) {
      s.caller(caller);
      assert.deepEqual((await db.list._handler(s.ctx, { paginationOpts })).page, []);
      await assert.rejects(db.details._handler(s.ctx, { id }), denied);
      await assert.rejects(
        db.authorize._handler(s.ctx, { id, actor: caller ?? 'anonymous', capability: 'use' }),
        e => e.data?.code === 'SECRET_UNAVAILABLE',
      );
      await assert.rejects(actions.names._handler(s.ctx, { id }), denied);
      await assert.rejects(use(s, id), denied);
      await assert.rejects(actions.reveal._handler(s.ctx, { id, operationId: randomUUID() }), denied);
      await assert.rejects(
        actions.rotate._handler(s.ctx, { id, value: 'new', expectedVersion: 1, operationId: randomUUID() }),
        denied,
      );
      await assert.rejects(grant(s, id, 'reader', ['use']), denied);
      await assert.rejects(db.audit._handler(s.ctx, { id, paginationOpts }), denied);
    }
    assert.equal(qa.calls.length, 0);
    s.caller('owner');
    await grant(s, id, 'reader', ['use']);
    s.caller('reader');
    const hiddenList = await db.list._handler(s.ctx, { paginationOpts });
    assert.deepEqual(hiddenList.page, []);
    assert.equal(hiddenList.isDone, true);
    await assert.rejects(db.details._handler(s.ctx, { id }), denied);
    await assert.rejects(actions.reveal._handler(s.ctx, { id, operationId: randomUUID() }), denied);
    await assert.rejects(
      actions.rotate._handler(s.ctx, { id, value: 'new', expectedVersion: 1, operationId: randomUUID() }),
      denied,
    );
    await assert.rejects(grant(s, id, 'other', ['use']), denied);
    const result = await use(s, id);
    assert.equal(result.sha, head);
    assert.ok(!JSON.stringify(result).includes(credential));
    assert.ok(!JSON.stringify(result).includes('example/project'));
    assert.equal(qa.calls[0].url, 'https://api.github.com/repos/example/project/commits/main');
    assert.equal(qa.calls[0].init.redirect, 'error');
    assert.equal(qa.calls[0].init.headers.Authorization, 'Bearer ' + credential);
    await assert.rejects(actions.names._handler(s.ctx, { id }), denied);
    s.caller('owner');
    await grant(s, id, 'reader', ['names']);
    s.caller('reader');
    assert.deepEqual(await actions.names._handler(s.ctx, { id }), {
      name: owner.name,
      repository: 'example/project',
      ref: 'main',
    });
    assert.deepEqual((await db.list._handler(s.ctx, { paginationOpts })).page, []);
    await assert.rejects(db.details._handler(s.ctx, { id }), denied);
    await assert.rejects(use(s, id), denied);
    s.caller('owner');
    await grant(s, id, 'reader', ['discover']);
    s.caller('reader');
    const hidden = await db.details._handler(s.ctx, { id });
    assert.equal(hidden.name, null);
    assert.equal(hidden.repository, null);
    assert.equal(hidden.ref, null);
    await assert.rejects(use(s, id), denied);
    s.caller('owner');
    await grant(s, id, 'reader', ['discover', 'names']);
    s.caller('reader');
    assert.equal((await db.details._handler(s.ctx, { id })).name, owner.name);
    s.caller('owner');
    await grant(s, id, 'reader', []);
    s.caller('reader');
    assert.deepEqual((await db.list._handler(s.ctx, { paginationOpts })).page, []);
    await assert.rejects(use(s, id), denied);
  } finally {
    qa.cleanup();
  }
});

test('Secret Object broker observations reconcile unknown successful replies and recheck revocation/policy/version after the provider without returning raw credentials', async () => {
  const s = state([]),
    qa = setup();
  try {
    const id = await create(s),
      operationId = randomUUID();
    await grant(s, id, 'reader', ['use']);
    s.caller('reader');
    const first = await use(s, id, operationId),
      count = qa.calls.length;
    assert.deepEqual(await use(s, id, operationId), first);
    assert.equal(qa.calls.length, count);
    s.caller('owner');
    await grant(s, id, 'reader', []);
    s.caller('reader');
    await assert.rejects(use(s, id, operationId), denied);
    assert.equal(qa.calls.length, count);
    s.caller('owner');
    await grant(s, id, 'reader', ['use']);
    s.caller('reader');
    const normal = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
      if (new URL(url).hostname !== 'api.github.com') return normal(url, init);
      s.caller('owner');
      await grant(s, id, 'reader', []);
      s.caller('reader');
      return Response.json({ sha: head, leaked: credential });
    };
    const before = s.tables.secretEvents.size;
    await assert.rejects(use(s, id), denied);
    assert.equal(
      s.tables.secretEvents.size,
      before + 1,
      'Only the explicit grant removal is recorded; the revoked response is not published.',
    );
    s.caller('owner');
    globalThis.fetch = normal;
    globalThis.fetch = async (url, init) => {
      if (new URL(url).hostname !== 'api.github.com') return normal(url, init);
      await actions.rotate._handler(s.ctx, {
        id,
        value: 'second-synthetic-value',
        expectedVersion: 1,
        operationId: randomUUID(),
      });
      return Response.json({ sha: head });
    };
    await assert.rejects(use(s, id), e => e.data.code === 'SECRET_CHANGED');
    globalThis.fetch = async () => Response.json({ sha: credential, secret: credential });
    await assert.rejects(use(s, id), e => e.data.code === 'GITHUB_RESPONSE');
    for (const malformed of [null, { sha: [head] }, { sha: 123 }]) {
      globalThis.fetch = async () => Response.json(malformed);
      await assert.rejects(use(s, id), e => e.data.code === 'GITHUB_RESPONSE');
    }
    assert.ok(!JSON.stringify([...s.tables.secretEvents.values()]).includes(credential));
  } finally {
    qa.cleanup();
  }
});

test('credential rotation and owner broker enable/disable retain original versions, key IDs and concurrent newer policy on stale retries', async () => {
  const s = state([]),
    qa = setup();
  try {
    const id = await create(s),
      operationId = randomUUID(),
      request = { id, value: 'rotated-synthetic-value', expectedVersion: 1, operationId };
    const rotationMutation = s.ctx.runMutation;
    let lose = true;
    s.ctx.runMutation = async (fn, args) => {
      const result = await rotationMutation(fn, args);
      if (lose && args.expectedVersion === 1) {
        lose = false;
        throw new Error('Lost rotation reply');
      }
      return result;
    };
    await assert.rejects(actions.rotate._handler(s.ctx, request));
    assert.equal(s.tables.secretObjects.get(id).version, 2);
    assert.equal(await actions.rotate._handler(s.ctx, request), 2);
    await actions.rotate._handler(s.ctx, {
      id,
      value: 'third-value',
      expectedVersion: 2,
      operationId: randomUUID(),
    });
    assert.equal(await actions.rotate._handler(s.ctx, request), 2);
    assert.equal(s.tables.secretObjects.get(id).version, 3);
    await assert.rejects(
      actions.rotate._handler(s.ctx, { ...request, value: 'changed retry' }),
      e => e.data.code === 'BAD_ARGUMENT',
    );
    await assert.rejects(
      actions.rotate._handler(s.ctx, { ...request, operationId: randomUUID() }),
      e => e.data.code === 'SECRET_CHANGED',
    );
    assert.equal(
      (await actions.reveal._handler(s.ctx, { id, operationId: randomUUID() })).value,
      'third-value',
    );
    const disable = {
      id,
      enabled: false,
      expectedPolicyRevision: s.tables.secretObjects.get(id).policyRevision,
      operationId: randomUUID(),
    };
    await db.enabled._handler(s.ctx, disable);
    const count = qa.calls.length;
    await assert.rejects(use(s, id), denied);
    assert.equal(qa.calls.length, count);
    await db.enabled._handler(s.ctx, {
      id,
      enabled: true,
      expectedPolicyRevision: s.tables.secretObjects.get(id).policyRevision,
      operationId: randomUUID(),
    });
    await db.enabled._handler(s.ctx, disable);
    assert.equal(s.tables.secretObjects.get(id).disabled, false);
    const next = {
      active: 'qa-second',
      keys: { ...qa.keys.keys, 'qa-second': randomBytes(32).toString('base64') },
    };
    process.env.FORGE_SECRET_KEYS = JSON.stringify(next);
    await actions.rotate._handler(s.ctx, {
      id,
      value: 'fourth-value',
      expectedVersion: 3,
      operationId: randomUUID(),
    });
    assert.equal([...s.tables.secretVersions.values()].at(-1).sealed.keyId, 'qa-second');
    const original = [...s.tables.secretVersions.values()][0];
    assert.equal(
      openSecret(
        next,
        {
          owner: 'owner',
          operationId: s.tables.secretObjects.get(id).operationId,
          repository: 'example/project',
          ref: 'main',
          version: 1,
        },
        original.sealed,
      ),
      credential,
    );
    const audit = await db.audit._handler(s.ctx, { id, paginationOpts });
    assert.ok(audit.page.some(item => item.kind === 'disable'));
    assert.ok(audit.page.some(item => item.kind === 'rotate'));
    assert.ok(!JSON.stringify(audit).includes(credential));
  } finally {
    qa.cleanup();
  }
});

test('Secret Object grant expiry, capability bounds, recorded attribution and paginated discovery exclude hidden or expired grants before page counts', async () => {
  const s = state([]),
    qa = setup();
  try {
    const id = await create(s),
      expiry = Date.now() + 60_000;
    await grant(s, id, 'delegator', ['use', 'delegate'], { expiresAt: expiry });
    s.caller('delegator');
    await assert.rejects(grant(s, id, 'reader', ['reveal'], { expiresAt: expiry }), denied);
    await assert.rejects(grant(s, id, 'reader', ['use']), denied);
    await grant(s, id, 'reader', ['use'], { expiresAt: expiry });
    s.caller('reader');
    assert.equal((await use(s, id)).sha, head);
    s.caller('owner');
    await grant(s, id, 'reader', ['discover', 'names', 'use'], { expiresAt: Date.now() - 1 });
    s.caller('reader');
    const expiredList = await db.list._handler(s.ctx, { paginationOpts });
    assert.deepEqual(expiredList.page, []);
    assert.equal(expiredList.isDone, true);
    await assert.rejects(use(s, id), denied);
    s.caller('owner');
    for (let i = 0; i < 23; i++) {
      const item = await create(s, { name: 'Secret ' + i });
      await grant(s, item, 'reader', i % 2 ? ['use'] : ['discover']);
    }
    s.caller('reader');
    const first = await db.list._handler(s.ctx, { paginationOpts: { numItems: 5, cursor: null } }),
      second = await db.list._handler(s.ctx, {
        paginationOpts: { numItems: 20, cursor: first.continueCursor },
      });
    assert.equal(first.page.length, 5);
    assert.equal(second.page.length, 7);
    assert.equal(second.isDone, true);
    assert.ok([...first.page, ...second.page].every(item => item.name === null && item.repository === null));
    s.caller('owner');
    await grant(s, first.page[0].id, 'reader', ['discover'], { expiresAt: Date.now() - 1 });
    s.caller('reader');
    const retained = await db.list._handler(s.ctx, {
      paginationOpts: { numItems: 20, cursor: first.continueCursor },
    });
    assert.deepEqual(
      retained,
      second,
      'Expiry and policy updates preserve seek continuation without leaking expired rows or resetting cursors.',
    );
    s.caller('owner');
    const audit = await db.audit._handler(s.ctx, { id, paginationOpts });
    assert.ok(
      audit.page.some(
        item => item.kind === 'grant' && item.actor === 'delegator' && item.principal === 'reader',
      ),
    );
  } finally {
    qa.cleanup();
  }
});

test('native scheduled grant expiry invalidates metadata, records service attribution and cannot remove a newer grant', async () => {
  const s = state([]),
    qa = setup(),
    clock = Date.now;
  try {
    const id = await create(s),
      expiresAt = clock() + 30_000;
    await grant(s, id, 'reader', ['discover', 'names', 'use'], { expiresAt });
    const task = s.scheduled.at(-1);
    assert.equal(task.at, expiresAt);
    await grant(s, id, 'reader', ['use']);
    Date.now = () => expiresAt + 1;
    await db.expire._handler(s.ctx, task.args);
    s.caller('reader');
    assert.equal((await use(s, id)).sha, head);
    s.caller('owner');
    await grant(s, id, 'reader', ['discover', 'names', 'use'], { expiresAt: expiresAt + 10_000 });
    const current = s.scheduled.at(-1);
    Date.now = () => expiresAt + 10_001;
    s.caller('reader');
    await assert.rejects(
      db.authorize._handler(s.ctx, { id, actor: 'reader', capability: 'use' }),
      e => e.data?.code === 'SECRET_UNAVAILABLE',
    );
    await db.expire._handler(s.ctx, current.args);
    await db.expire._handler(s.ctx, current.args);
    assert.deepEqual((await db.list._handler(s.ctx, { paginationOpts })).page, []);
    s.caller('owner');
    const audit = await db.audit._handler(s.ctx, { id, paginationOpts });
    const expiry = audit.page.filter(row => row.kind === 'expire');
    assert.equal(expiry.length, 1);
    assert.equal(expiry[0].actor, 'forge:expiry');
    assert.equal(expiry[0].principal, 'reader');
    assert.equal((await db.grants._handler(s.ctx, { id, paginationOpts })).page.length, 1);
  } finally {
    Date.now = clock;
    qa.cleanup();
  }
});
