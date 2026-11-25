// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import test from 'node:test';
import assert from 'node:assert/strict';
import { getFunctionName } from 'convex/server';
import { moduleUrl } from './convex-module.mjs';
// These checks count and tamper with the R2 reads of raw objects (memo, tampering, availability).
import { fixture, upload } from './project-exchange-fixture.mjs';
import { defaultR2Config, defaultR2Objects, interceptDefaultR2 } from './default-r2.mjs';
import { readHosted } from './hosted-read.mjs';
const { exchangeObjectReader } = await import(moduleUrl('../convex/projectExchangeReader.ts'));
const objectPath = row => `${defaultR2Config.bucket}/${row.r2Key}`;
const code = expected => error => (error.data?.code ?? error.code) === expected;

test('one action reuses verified immutable bytes but preserves current access and storage checks on every use', async () => {
  const s = fixture(),
    bytes = Buffer.from('unchanged metadata'),
    pin = await upload(s, bytes),
    reader = exchangeObjectReader(s.ctx);
  const run = s.ctx.runQuery;
  let resolutions = 0;
  s.ctx.runQuery = async (...args) => {
    if (getFunctionName(args[0]) === 'projectObjects:resolve') resolutions++;
    return run(...args);
  };
  const first = (await reader.read('project', 'owner', [pin]))[0];
  first.fill(0);
  assert.deepEqual(await reader.read('project', 'owner', [pin]), [bytes]);
  assert.equal(s.reads(), 1);
  assert.equal(resolutions, 4);
  assert.deepEqual(await exchangeObjectReader(s.ctx).read('project', 'owner', [pin]), [bytes]);
  assert.equal(s.reads(), 2, 'a new action does not inherit memoized bytes');
  await assert.rejects(reader.read('project', 'stranger', [pin]), code('PROJECT_UNAVAILABLE'));
  s.tables.hostedProjects.get('project').removal = 'deleting';
  await assert.rejects(reader.read('project', 'owner', [pin]), code('PROJECT_UNAVAILABLE'));
});

test('logical State pins use bounded initial and final resolve windows without changing their order', async () => {
  const s = fixture(),
    windows = [],
    bytes = Buffer.alloc(700000, 1);
  const pins = [];
  for (let i = 0; i < 6; i++) {
    bytes[0] = i;
    pins.push(await upload(s, Buffer.from(bytes)));
  }
  const query = s.ctx.runQuery;
  s.ctx.runQuery = (ref, args) => {
    if (getFunctionName(ref) === 'projectObjects:resolve') windows.push(args.digests);
    return query(ref, args);
  };
  const values = await exchangeObjectReader(s.ctx, false, 0).read('project', 'owner', pins);
  assert.deepEqual(
    values.map(b => b[0]),
    [0, 1, 2, 3, 4, 5],
  );
  assert.equal(windows.length, 6);
  assert(windows.every(w => w.length === 2));
  await assert.rejects(
    exchangeObjectReader(s.ctx).read('project', 'stranger', []),
    code('PROJECT_UNAVAILABLE'),
  );
});

test('memoized bytes are isolated by project and exact pin; a removed object is not hidden', async () => {
  const s = fixture(),
    bytes = Buffer.from('shared bytes'),
    pin = await upload(s, bytes),
    reader = exchangeObjectReader(s.ctx);
  await reader.read('project', 'owner', [pin]);
  s.tables.hostedProjects.set('other', { ...s.tables.hostedProjects.get('project'), _id: 'other' });
  await upload(s, bytes, 'other');
  await reader.read('other', 'owner', [pin]);
  assert.equal(s.reads(), 2);
  await assert.rejects(
    reader.read('project', 'owner', [{ ...pin, size: pin.size + 1 }]),
    code('INVALID_WORK_BACKUP'),
  );
  // A different physical key is a different identity: the same bytes at a rebound key are read again.
  const row = [...s.tables.projectObjects.values()].find(row => row.projectId === 'project'),
    path = objectPath(row),
    original = defaultR2Objects.get(path);
  await reader.read('project', 'owner', [pin]);
  assert.equal(s.reads(), 2, 'the same project, pin and key is memoized');
  defaultR2Objects.delete(path);
  await assert.rejects(exchangeObjectReader(s.ctx).read('project', 'owner', [pin]));
  defaultR2Objects.set(path, original);
});

test('concurrent equal reads share only successful bytes, settle failures and recheck grants after retrieval', async () => {
  const s = fixture(),
    bytes = Buffer.from('verified content'),
    pin = await upload(s, bytes),
    reader = exchangeObjectReader(s.ctx);
  await Promise.all([reader.read('project', 'owner', [pin]), reader.read('project', 'owner', [pin])]);
  assert.equal(s.reads(), 1);
  const row = [...s.tables.projectObjects.values()][0],
    broken = exchangeObjectReader(s.ctx),
    path = objectPath(row),
    saved = defaultR2Objects.get(path);
  defaultR2Objects.set(path, Buffer.from('wrong'));
  await assert.rejects(broken.read('project', 'owner', [pin]), code('BLOB_DIGEST_MISMATCH'));
  defaultR2Objects.set(path, saved);
  assert.deepEqual(await broken.read('project', 'owner', [pin]), [bytes]);
  const during = exchangeObjectReader(s.ctx);
  s.tables.projectContributors.set('grant', {
    _id: 'grant',
    projectId: 'project',
    contributor: 'contributor',
  });
  const restore = interceptDefaultR2(async (input, init, serve) => {
    const value = await serve(input, init);
    s.tables.projectContributors.delete('grant');
    return value;
  });
  await assert.rejects(during.read('project', 'contributor', [pin]), code('PROJECT_UNAVAILABLE'));
  restore();
  // Failed authority is never memoized: the current grant is checked again.
  await assert.rejects(during.read('project', 'contributor', [pin]), code('PROJECT_UNAVAILABLE'));
  assert.deepEqual(await during.read('project', 'owner', [pin]), [bytes]);
});

test('action byte memo evicts by bytes without changing exact pins or current access', async () => {
  const s = fixture(),
    a = Buffer.alloc(1024, 1),
    b = Buffer.alloc(1024, 2),
    pa = await upload(s, a),
    pb = await upload(s, b),
    reader = exchangeObjectReader(s.ctx, false, 1024);
  await reader.read('project', 'owner', [pa]);
  await reader.read('project', 'owner', [pb]);
  assert.deepEqual(await reader.read('project', 'owner', [pa]), [a]);
  assert.equal(s.reads(), 3, 'an evicted object is verified again rather than accumulating history');
  await assert.rejects(reader.read('project', 'stranger', [pa]), code('PROJECT_UNAVAILABLE'));
});

test('bounded State actions recheck current source authority and exact content pins', async () => {
  const ancestry = await import(moduleUrl('../convex/projectWorkAncestry.ts'));
  const s = fixture(),
    pin = await upload(
      s,
      Buffer.from(
        JSON.stringify({
          schema: 1,
          kind: 'forge-source-state',
          parents: [],
          files: [{ path: 'a.ts', blob: 'a'.repeat(64), mode: 'file' }],
          message: 'fixture',
          at: 'now',
        }),
      ),
    );
  const input = { projectId: 'project', actor: 'owner', pins: [pin], paths: ['a.ts'] };
  const [state] = await ancestry.stateBatch._handler(s.ctx, input);
  assert.equal(state.head, pin.sha256);
  assert.equal(state.files[0].path, 'a.ts');
  await assert.rejects(
    ancestry.stateBatch._handler(s.ctx, { ...input, actor: 'stranger' }),
    code('PROJECT_UNAVAILABLE'),
  );
  await assert.rejects(
    ancestry.changedStates._handler(s.ctx, {
      projectId: 'project',
      actor: 'stranger',
      before: pin,
      after: pin,
    }),
    code('PROJECT_UNAVAILABLE'),
  );
  await assert.rejects(
    ancestry.stateBatch._handler(s.ctx, { ...input, pins: [{ ...pin, size: pin.size + 1 }] }),
    code('INVALID_WORK_BACKUP'),
  );
});

test('State windows batch parent/provenance reads and retain the diff when an optional save disappears', async () => {
  const ancestry = await import(moduleUrl('../convex/projectWorkAncestry.ts'));
  const s = fixture(),
    resolutions = [];
  const make = async (name, blob) =>
    upload(
      s,
      Buffer.from(
        JSON.stringify({
          schema: 1,
          kind: 'forge-source-state',
          parents: [],
          files: [{ path: 'a.ts', blob, mode: 'file' }],
          message: name,
          at: 'now',
        }),
      ),
    );
  const before = await make('before', 'a'.repeat(64)),
    after = await make('after', 'b'.repeat(64)),
    save = await make('save', 'c'.repeat(64));
  const run = s.ctx.runQuery;
  s.ctx.runQuery = async (ref, args) => {
    if (getFunctionName(ref) === 'projectObjects:resolve') resolutions.push(args.digests);
    return run(ref, args);
  };
  await ancestry.stateBatch._handler(s.ctx, {
    projectId: 'project',
    actor: 'owner',
    pins: [before, after, save],
    paths: ['a.ts'],
  });
  assert.equal(resolutions.length, 2);
  resolutions.length = 0;
  const input = { projectId: 'project', actor: 'owner', before, after, pins: [save] };
  const result = await ancestry.changedStates._handler(s.ctx, input);
  assert.equal(resolutions.length, 2);
  assert.deepEqual(result.paths, ['a.ts']);
  assert.equal(result.states[0].files[0].blob, 'c'.repeat(64));
  const malformed = await upload(s, Buffer.from('not a State'));
  const withMalformed = await ancestry.changedStates._handler(s.ctx, { ...input, pins: [malformed] });
  assert.deepEqual(withMalformed.paths, ['a.ts']);
  assert.deepEqual(withMalformed.states, []);
  s.tables.projectObjects.forEach(row => {
    if (row.digest === save.sha256) row.removed = true;
  });
  const partial = await ancestry.changedStates._handler(s.ctx, input);
  assert.deepEqual(partial.paths, ['a.ts']);
  assert.deepEqual(partial.states, []);
  await assert.rejects(
    ancestry.changedStates._handler(s.ctx, { ...input, actor: 'stranger' }),
    code('PROJECT_UNAVAILABLE'),
  );
});

test('return metadata resolves 1000 small pins in two bounded authority calls and rejects a mid-read revocation', async () => {
  const s = fixture(),
    pins = [];
  for (let i = 0; i < 1000; i++) pins.push(await upload(s, Buffer.from(`Synthetic metadata ${i}`)));
  const query = s.ctx.runQuery,
    windows = [];
  s.ctx.runQuery = async (ref, args) => {
    if (getFunctionName(ref) === 'projectObjects:resolve') windows.push(args.digests.length);
    return query(ref, args);
  };
  const reader = exchangeObjectReader(s.ctx, false, 0, 1000);
  const values = await reader.read('project', 'owner', pins);
  assert.equal(values.length, 1000);
  assert.deepEqual(windows, [1000, 1000]);
  assert.equal(values[999].toString(), 'Synthetic metadata 999');
  let revoked = false;
  const restore = interceptDefaultR2(async (input, init, serve) => {
    const result = await serve(input, init);
    if (!revoked && (init?.method ?? 'GET') === 'GET') {
      revoked = true;
      s.tables.hostedProjects.get('project').owner = 'replacement';
    }
    return result;
  });
  await assert.rejects(reader.read('project', 'owner', pins), code('PROJECT_UNAVAILABLE'));
  restore();
});
