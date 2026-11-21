// SPDX-License-Identifier: Apache-2.0
// Public read-only code and history (Item 4c164732): the access matrix. Signed out, a stranger, a reader, a writer and
// the owner read history and source on a public and on a private project through the path each one uses: visitors the
// cached public route (convex/publicHttp.ts), people the Code place's reads. Every answer must match the access
// contract (convex/projectAccessContract.ts, readSource). A private project answers exactly like a missing one, and the
// visitor route only reads: GET only, one budget write, no person, no Lane or Item id.
import test from 'node:test';
import { storageClock } from './storage-clock.mjs';
import assert from 'node:assert/strict';
import { getFunctionName } from 'convex/server';
import { ConvexError } from 'convex/values';
import {
  fixture,
  checkpoint,
  commitValidatedCheckpoint,
  asLegacyRows,
  upload,
} from './project-exchange-fixture.mjs';
import { moduleUrl } from './convex-module.mjs';
import { interceptDefaultR2 } from './default-r2.mjs';
import worker from '../dist/public-code-worker.js';
import {
  PUBLIC_CODE_DELIVERY,
  PUBLIC_CODE_EXPIRY,
  PUBLIC_CODE_INGRESS,
  publicCodeIngressKey,
} from '../dist/public-code-cache.js';

const contract = await import(moduleUrl('../convex/projectAccessContract.ts'));
const projectCode = await import(moduleUrl('../convex/projectCode.ts'));
const projectCodeBrowse = await import(moduleUrl('../convex/projectCodeBrowse.ts'));
const route = await import(moduleUrl('../convex/publicHttp.ts'));
const publicRead = await import(moduleUrl('../convex/publicRead.ts'));
// Absent before this Item; the matrix must still run and fail on behaviour, not on the import.
let publicCode = {};
try {
  publicCode = await import(moduleUrl('../convex/publicCode.ts'));
} catch {
  // Not built yet: the visitor rows below fail on their answers.
}
const own = { projectCode, projectCodeBrowse, publicRead, publicCode };

const KEY = 'synthetic-site-key';
const BASE = '1'.repeat(64);
const hex = path => Buffer.from(path, 'utf8').toString('hex');
const standings = { stranger: 'public', reader: 'read', writer: 'write', owner: 'owner' };

async function setup(t, visibility) {
  const previous = process.env.FORGE_PUBLIC_READ_SECRET;
  process.env.FORGE_PUBLIC_READ_SECRET = KEY;
  t.after(() => {
    if (previous === undefined) delete process.env.FORGE_PUBLIC_READ_SECRET;
    else process.env.FORGE_PUBLIC_READ_SECRET = previous;
  });
  const s = fixture();
  const source = await checkpoint(t, s);
  const backupId = await commitValidatedCheckpoint(s, source);
  await asLegacyRows(s);
  const head = source.manifest.head;
  Object.assign(s.tables.hostedProjects.get('project'), {
    visibility,
    slug: 'atlas',
    work: { generationId: 'gen', backupId, operationId: 'op', initialRevision: 0, revision: 0 },
  });
  for (const [owner, handle] of [
    ['owner', 'ada'],
    ['writer', 'wren'],
    ['reader', 'rook'],
    ['stranger', 'sable'],
  ]) {
    s.tables.forgeAccounts.set(`acct-${owner}`, { _id: `acct-${owner}`, owner, handle });
    s.tables.accountHandles.set(`alias-${owner}`, { _id: `alias-${owner}`, owner, handle });
  }
  s.tables.projectSlugs.set('slug', { _id: 'slug', owner: 'owner', slug: 'atlas', projectId: 'project' });
  s.tables.projectContributors.set('w', { _id: 'w', projectId: 'project', contributor: 'writer' });
  s.tables.projectReaders.set('r', { _id: 'r', projectId: 'project', reader: 'reader' });
  s.tables.projectHostedAcceptances ??= new Map();
  for (const sequence of [1, 2])
    s.tables.projectHostedAcceptances.set(`acc${sequence}`, {
      _id: `acc${sequence}`,
      _creationTime: sequence,
      projectId: 'project',
      sequence,
      value: JSON.stringify({
        id: `0000000${sequence}-0000-4000-8000-000000000000`,
        at: `2026-11-1${sequence}T10:00:00.000Z`,
        message: `Landing ${sequence}\n\nWhy it landed.`,
        actor: { id: 'writer', kind: 'person' },
        laneId: 'lane-secret-id',
        intentId: 'intent-secret-id',
        candidate: { head },
        previous: { head: BASE },
        automatic: false,
      }),
    });
  // Every function the reads run, with whether it may write. Each call crosses a Convex function boundary: as in a
  // deployment, only a ConvexError keeps its code and data on the way back; any other error arrives as a bare Error.
  const ran = [];
  const through = s.ctx.runQuery;
  s.ctx.runAction =
    s.ctx.runQuery =
    s.ctx.runMutation =
      async (ref, args) => {
        const name = getFunctionName(ref);
        const [module, method] = name.split(':');
        const handler = own[module]?.[method];
        ran.push(name);
        if (!handler && module in own) throw new Error(`${name} is not defined`);
        try {
          return await (handler ? handler._handler(s.ctx, args) : through(ref, args));
        } catch (error) {
          throw error instanceof ConvexError ? error : new Error(String(error?.message ?? error));
        }
      };
  return { ...s, head, ran };
}

const outcome = async run => {
  try {
    return { ok: true, value: await run() };
  } catch (error) {
    return {
      ok: false,
      code: error?.data?.code ?? error?.code,
      message: error?.data?.message ?? error.message,
    };
  }
};
const memberReads = {
  history: (s, projectId = 'project') => projectCode.history._handler(s.ctx, { projectId, cursor: null }),
  source: (s, projectId = 'project') =>
    projectCodeBrowse.read._handler(s.ctx, { projectId, state: s.head, want: 'open', path: '' }),
};

test('signed-in Code opens a registered exact State without loading its stale Work backup', async t => {
  const s = await setup(t, 'private');
  const project = s.tables.hostedProjects.get('project');
  project.sourceAuthority = { mode: 'server', epoch: 1 };
  const blob = await upload(s, Buffer.from('export const current = true;\n'));
  const bytes = Buffer.from(
    JSON.stringify({
      schema: 1,
      kind: 'forge-source-state',
      parents: [s.head],
      files: [{ path: 'src/current.ts', mode: 'file', blob: blob.sha256 }],
      message: '',
      at: '2026-01-01T00:00:00Z',
    }),
  );
  const pin = await upload(s, bytes);
  const read = (input = {}) =>
    projectCodeBrowse.read._handler(s.ctx, {
      projectId: 'project',
      state: pin.sha256,
      want: 'open',
      path: '',
      ...input,
    });
  s.caller('reader');
  assert.equal((await outcome(read)).code, 'SOURCE_UNAVAILABLE', 'a stored digest alone is insufficient');
  s.tables.projectHostedStates.set('current', { projectId: 'project', head: pin.sha256, size: pin.size });
  const historical = JSON.parse(await read({ state: s.head }));
  assert.equal(
    historical.dirs[0].entries[0].name,
    'a.ts',
    'unregistered retained States still use the backup',
  );
  project.visibility = 'public';
  s.caller(null);
  assert.equal((await outcome(read)).code, 'SOURCE_UNAVAILABLE', 'visitors keep the checkpoint boundary');
  project.visibility = 'private';
  s.caller('reader');
  const received = [];
  let onRead = response => response;
  t.after(
    interceptDefaultR2(async (url, init, serve) => {
      const result = await serve(url, init);
      if ((init.method ?? 'GET') === 'GET') {
        received.push(Number(result.headers.get('content-length')));
        return onRead(result);
      }
      return result;
    }),
  );
  const from = s.ran.length;
  const root = JSON.parse(await read());
  assert.equal(root.state, pin.sha256);
  assert.equal(root.files, 1);
  assert.equal(root.dirs[0].entries[0].name, 'src');
  assert.deepEqual(received, [bytes.length], 'only the registered State reaches storage');
  assert.deepEqual(s.ran.slice(from), ['projectCode:checkpoint', 'projectCode:checkpoint']);
  const folder = JSON.parse(await read({ want: 'more', path: 'src' }));
  assert.equal(folder.dirs[0].entries[0].path, 'src/current.ts');
  assert.deepEqual(received, [bytes.length], 'the next listing can use existing verified State bytes');
  const beforeFile = s.ran.length;
  const file = JSON.parse(await read({ want: 'page', path: 'src/current.ts' }));
  assert.equal(file.file.page.text, 'export const current = true;\n');
  assert.deepEqual(s.ran.slice(beforeFile), [
    'projectCode:checkpoint',
    'projectObjects:resolve',
    'projectCode:checkpoint',
  ]);
  // Each distinct registered State forces fresh storage IO around the same access checks.
  const publish = async day => {
    s.caller('owner');
    const later = await upload(s, Buffer.from(bytes.toString().replace('2026-01-01', day)));
    s.tables.projectHostedStates.set(day, { projectId: 'project', head: later.sha256, size: later.size });
    s.caller('reader');
    return later.sha256;
  };
  const corrupt = await publish('2026-01-02');
  onRead = response => new Response(Buffer.alloc(bytes.length), { headers: response.headers });
  assert.equal((await outcome(() => read({ state: corrupt }))).code, 'BLOB_DIGEST_MISMATCH');

  const moved = await publish('2026-01-03');
  onRead = response => {
    s.tables.projectHostedStates.delete('2026-01-03');
    return response;
  };
  assert.equal((await outcome(() => read({ state: moved }))).code, 'SOURCE_CHANGED');

  const revoked = await publish('2026-01-04');
  onRead = response => {
    s.tables.projectReaders.delete('r');
    return response;
  };
  assert.equal((await outcome(() => read({ state: revoked }))).code, 'PROJECT_UNAVAILABLE');
});

async function visitor(s, path, method = 'GET') {
  s.caller(null);
  const response = await route.serve._handler(
    s.ctx,
    new Request(`https://backend.test/public/v1/code/${path}`, {
      method,
      headers: { 'x-forge-public-key': KEY },
    }),
  );
  return { status: response.status, body: await response.text(), headers: response.headers };
}

// Run the real Worker with one cache per location, a shared private R2 binding and the real Convex route.
async function publicR2Fixture(t, readOrigin, now) {
  const replica = new Map();
  const calls = { edgeHits: 0, r2Gets: 0, r2Puts: 0, r2BytesRead: 0, r2BytesWritten: 0, origin: 0 };
  const ingress = await publicCodeIngressKey(KEY);
  const bindings = {
    FORGE_CONVEX_SITE_URL: 'https://backend.test',
    FORGE_PUBLIC_READ_SECRET: KEY,
    FORGE_PUBLIC_CODE_WORKER_KEY: ingress,
    REPLICA: {
      async get(key) {
        calls.r2Gets++;
        const stored = replica.get(key);
        if (!stored) return null;
        calls.r2BytesRead += Buffer.byteLength(stored.body);
        return { body: new Response(stored.body).body, customMetadata: stored.customMetadata };
      },
      async put(key, body, { customMetadata }) {
        calls.r2Puts++;
        calls.r2BytesWritten += Buffer.byteLength(body);
        replica.set(key, { body, customMetadata });
      },
    },
  };
  const cacheStorage = {};
  const originalCaches = Object.getOwnPropertyDescriptor(globalThis, 'caches');
  Object.defineProperty(globalThis, 'caches', { configurable: true, value: cacheStorage });
  t.after(() => {
    if (originalCaches) Object.defineProperty(globalThis, 'caches', originalCaches);
    else delete globalThis.caches;
  });
  t.mock.method(Date, 'now', now);
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(new URL(url).origin, bindings.FORGE_CONVEX_SITE_URL);
    assert.deepEqual(options.headers, { 'x-forge-public-key': KEY });
    assert.equal(options.cache, 'no-store');
    assert.equal(options.redirect, 'manual', 'Workerd only supports manual rejection of redirects');
    calls.origin++;
    const reply = await readOrigin(new URL(url).pathname.slice('/public/v1/code/'.length));
    return new Response(reply.body, { status: reply.status, headers: reply.headers });
  });

  function edge() {
    const cache = new Map();
    return async (path, credential = ingress) => {
      cacheStorage.default = {
        async match(request) {
          const entry = cache.get(request.url);
          return entry && new Response(entry.body, { headers: entry.headers });
        },
        async put(request, response) {
          cache.set(request.url, { body: await response.text(), headers: response.headers });
        },
      };
      const writes = [];
      const response = await worker.fetch(
        new Request(`https://worker.test/public/v1/code/${path}`, {
          headers: { [PUBLIC_CODE_INGRESS]: credential },
        }),
        bindings,
        { waitUntil: promise => writes.push(promise) },
      );
      if (response.headers.get(PUBLIC_CODE_DELIVERY) === 'edge') calls.edgeHits++;
      const body = await response.text();
      await Promise.all(writes);
      return { status: response.status, body, expiry: response.headers.get(PUBLIC_CODE_EXPIRY) };
    };
  }
  return { calls, edge };
}

test('1,000 public Code file views: edge and fresh R2 hits serve exact bytes without Convex', async t => {
  const s = await setup(t, 'public');
  const path = `ada/atlas/${s.head}/page/${hex('a.ts')}/0.json`;
  const delivery = await publicR2Fixture(
    t,
    path => visitor(s, path),
    () => 0,
  );
  const read = delivery.edge();
  const beforeFill = s.ran.length;
  const { meterWorkIO } = await import('./hosted-read-set.mjs');
  const meter = meterWorkIO(s.ctx, s.tables);
  t.after(() => meter.restore());
  let first;
  const start = performance.now();
  const coldDb = await meter.cost(async () => {
    first = await read(path);
  });
  assert.equal(first.status, 200);
  assert.equal(JSON.parse(first.body).file.page.text, 'export const a = 1;\n');
  const coldCalls = s.ran.slice(beforeFill);
  const beforeHits = s.ran.length;
  const edgeDb = await meter.cost(async () => {
    for (let view = 1; view < 1_000; view++) assert.deepEqual(await read(path), first);
  });
  const wallMs = performance.now() - start;
  const bodyBytes = Buffer.byteLength(first.body);
  assert.equal(s.ran.length, beforeHits);
  assert.deepEqual(delivery.calls, {
    edgeHits: 999,
    r2Gets: 1,
    r2Puts: 1,
    r2BytesRead: 0,
    r2BytesWritten: bodyBytes,
    origin: 1,
  });
  assert.deepEqual(edgeDb, {
    readDocuments: 0,
    readBytes: 0,
    writeDocuments: 0,
    writeBytes: 0,
    migrationWrites: 0,
  });

  const replicaDb = await meter.cost(async () => {
    assert.deepEqual(await delivery.edge()(path), first, 'edge in a new location reads the shared replica');
  });
  assert.deepEqual(replicaDb, edgeDb);
  assert.equal(delivery.calls.r2Gets, 2);
  assert.equal(delivery.calls.r2BytesRead, bodyBytes);
  assert.equal(delivery.calls.origin, 1);
  assert.equal(s.ran.length, beforeHits);

  t.diagnostic(
    JSON.stringify({
      views: 1_000,
      bodyBytes,
      visitorBodyBytes: 1_000 * bodyBytes,
      coldConvexFunctions: ['publicHttp:serve', ...coldCalls],
      coldDb,
      maxRssKiB: process.resourceUsage().maxRSS,
      wallMs: Math.round(wallMs * 100) / 100,
    }),
  );
});

test('the replica never extends public file visibility and private member Code still reads the bytes', async t => {
  const s = await setup(t, 'public');
  const path = `ada/atlas/${s.head}/page/${hex('a.ts')}/0.json`;
  let clock = 0;
  const delivery = await publicR2Fixture(
    t,
    path => visitor(s, path),
    () => clock,
  );
  const first = await delivery.edge()(path);
  assert.equal(first.status, 200);
  assert.equal(JSON.parse(first.body).file.page.text, 'export const a = 1;\n');
  s.tables.hostedProjects.get('project').visibility = 'private';

  clock = 29_999;
  const second = delivery.edge();
  assert.deepEqual(await second(path), first, 'fresh replica can only use the original window');
  clock = 30_000;
  for (const denied of [await second(path), await delivery.edge()(path)]) {
    assert.equal(denied.status, 404, 'neither cache extends visibility');
    assert.deepEqual(JSON.parse(denied.body), { found: false });
  }
  assert.equal(delivery.calls.r2Puts, 1, 'the origin denial creates no replica');

  s.caller('reader');
  const member = JSON.parse(
    await projectCodeBrowse.read._handler(s.ctx, {
      projectId: 'project',
      state: s.head,
      want: 'page',
      path: 'a.ts',
      offset: 0,
    }),
  );
  assert.equal(member.file.page.text, 'export const a = 1;\n');
});

test('a public reply arriving after its original deadline cannot fill the edge or replica', async t => {
  const s = await setup(t, 'public');
  const path = `ada/atlas/${s.head}/page/${hex('a.ts')}/0.json`;
  let clock = 0;
  const delivery = await publicR2Fixture(
    t,
    async path => {
      const reply = await visitor(s, path);
      clock = 30_000;
      s.tables.hostedProjects.get('project').visibility = 'private';
      return reply;
    },
    () => clock,
  );
  const read = delivery.edge();

  assert.equal((await read(path)).status, 200, 'the first reply was already authorized');
  assert.equal((await read(path)).status, 404);
  assert.equal((await delivery.edge()(path)).status, 404);
  assert.equal(delivery.calls.edgeHits, 0);
  assert.equal(delivery.calls.r2Puts, 0);
});

test('an unauthenticated Worker request cannot serve warm bytes or cause an origin read', async t => {
  const s = await setup(t, 'public');
  const path = `ada/atlas/${s.head}/open/${hex('a.ts')}.json`;
  const delivery = await publicR2Fixture(
    t,
    path => visitor(s, path),
    () => 0,
  );
  const read = delivery.edge();
  assert.equal((await read(path)).status, 200);
  assert.equal((await read(path, 'x'.repeat(64))).status, 401);
  assert.equal((await read(path + '?variant')).status, 404);
  assert.equal((await read(`ada/atlas/${s.head}/open/-.json`)).status, 404);
  assert.equal(delivery.calls.edgeHits, 0);
  assert.equal(delivery.calls.r2Gets, 1);
  assert.equal(delivery.calls.origin, 1);
});

test('a public Code origin redirect is refused within one attempt and never cached', async t => {
  const delivery = await publicR2Fixture(
    t,
    async () => ({ status: 302, body: '', headers: { location: 'https://elsewhere.example/' } }),
    () => 0,
  );
  const read = delivery.edge();
  const path = `ada/atlas/${'1'.repeat(64)}/page/${hex('a.ts')}/0.json`;
  assert.deepEqual(await read(path), { status: 502, body: '', expiry: null });
  assert.equal(delivery.calls.origin, 1);
  assert.equal(delivery.calls.r2Puts, 0);
});

for (const visibility of ['public', 'private'])
  test(`access matrix on a ${visibility} project: every signed-in standing gets the contract's answer`, async t => {
    for (const [who, standing] of Object.entries(standings))
      for (const [read, run] of Object.entries(memberReads)) {
        const s = await setup(t, visibility);
        s.caller(who);
        const expected = contract.projectMay(standing, 'readSource', 'person', visibility) === 'yes';
        const got = await outcome(() => run(s));
        assert.equal(got.ok, expected, `${who} ${read} on ${visibility}: ${got.code ?? 'allowed'}`);
        if (!expected) {
          // Refused exactly as a missing project is: same code, same words.
          const missing = await outcome(() => run(s, 'gone'));
          assert.deepEqual(
            { code: got.code, message: got.message },
            { code: missing.code, message: missing.message },
          );
          assert.equal(got.code, 'PROJECT_UNAVAILABLE');
        }
      }
  });

test('a stranger cannot tell a private project without stored source from a missing one', async t => {
  const s = await setup(t, 'private');
  delete s.tables.hostedProjects.get('project').work;
  // A stranger signed in, and a visitor signed out calling the source read directly: both answers equal a missing one.
  for (const who of ['stranger', null]) {
    s.caller(who);
    const privateOne = await outcome(() => memberReads.source(s));
    const missing = await outcome(() => memberReads.source(s, 'gone'));
    assert.equal(privateOne.ok, false, String(who));
    assert.deepEqual(privateOne, missing, String(who));
    assert.equal(privateOne.code, 'PROJECT_UNAVAILABLE', String(who));
  }
});

test('signed out, a public project reads its history, folders and file pages through the cached public route', async t => {
  const s = await setup(t, 'public');
  const first = await visitor(s, 'ada/atlas/history.json');
  assert.equal(first.status, 200);
  assert.equal(
    first.headers.get('netlify-cdn-cache-control'),
    'public, durable, s-maxage=30, must-revalidate',
  );
  const history = JSON.parse(first.body);
  assert.equal(history.project.name, 'Synthetic exchange');
  assert.deepEqual(
    history.landings.map(row => row.title),
    ['Landing 2', 'Landing 1'],
  );
  assert.equal(history.nextBefore, null);
  const earlier = JSON.parse((await visitor(s, 'ada/atlas/history/2.json')).body);
  assert.deepEqual(
    earlier.landings.map(row => row.sequence),
    [1],
  );
  const root = await visitor(s, `ada/atlas/${s.head}/open/-.json`);
  assert.equal(root.status, 200);
  assert.deepEqual(
    JSON.parse(root.body).dirs[0].entries.map(entry => entry.path),
    ['a.ts'],
  );
  const file = JSON.parse((await visitor(s, `ada/atlas/${s.head}/open/${hex('a.ts')}.json`)).body);
  assert.equal(file.kind, 'file');
  assert.equal(file.file.page.text, 'export const a = 1;\n');
  const page = JSON.parse((await visitor(s, `ada/atlas/${s.head}/page/${hex('a.ts')}/0.json`)).body);
  assert.equal(page.file.page.text, 'export const a = 1;\n');
});

test('signed out, a private project and a missing one get the same 404 on every code address', async t => {
  const s = await setup(t, 'private');
  const addresses = slug => [
    `ada/${slug}/history.json`,
    `ada/${slug}/history/2.json`,
    `ada/${slug}/${s.head}/open/-.json`,
    `ada/${slug}/${s.head}/page/${hex('a.ts')}/0.json`,
  ];
  for (const [index, path] of addresses('atlas').entries()) {
    const privateOne = await visitor(s, path);
    const missing = await visitor(s, addresses('nothing')[index]);
    assert.equal(privateOne.status, 404, path);
    assert.deepEqual([privateOne.status, privateOne.body], [missing.status, missing.body], path);
  }
  // A malformed address is missing too, never a read.
  for (const path of [
    'ada/atlas/history/x.json',
    `ada/atlas/${s.head}/open/zz.json`,
    `ada/atlas/${s.head}/open/${'61'.repeat(1025)}.json`,
    'ada/atlas/nothing/open/-.json',
  ])
    assert.equal((await visitor(s, path)).status, 404, path);
});

test('the visitor route only reads: GET only, no person, no Lane or Item id, and no write but the read budget', async t => {
  const s = await setup(t, 'public');
  const before = s.ran.length;
  for (const method of ['POST', 'PUT', 'DELETE']) {
    const refused = await visitor(s, 'ada/atlas/history.json', method);
    assert.equal(refused.status, 405, method);
  }
  assert.equal(s.ran.length, before, 'a refused method runs nothing');
  const bodies = [
    (await visitor(s, 'ada/atlas/history.json')).body,
    (await visitor(s, `ada/atlas/${s.head}/open/-.json`)).body,
    (await visitor(s, `ada/atlas/${s.head}/changes/${BASE}.json`)).body,
  ];
  for (const body of bodies)
    assert.doesNotMatch(
      body,
      /wren|"actor"|lane-secret-id|intent-secret-id|"owner"/,
      'no person, Lane or Item',
    );
  const mutations = new Set(
    s.ran.filter(name => {
      const [module, method] = name.split(':');
      return own[module]?.[method]?.isMutation;
    }),
  );
  assert.deepEqual([...mutations], [], 'the route itself runs no mutation of its own');
  const writes = s.ran.filter(name => /Store:checkpoint$|:noteActivity$/.test(name));
  assert.ok(
    writes.every(name => name === 'projectSourceReviewStore:checkpoint'),
    writes.join(),
  );
});

test('signed out, a failing read says what happened: over budget 429, no source yet 409, made private mid-read 404', async t => {
  storageClock(t);
  const { ANONYMOUS_READ_BUDGET } = await import(moduleUrl('../convex/abuseLimits.ts'));
  const folder = s => `ada/atlas/${s.head}/open/-.json`;
  // Over the project's signed-out read budget: an uncached 429 any page may read.
  const busy = await setup(t, 'public');
  const { windowMs, calls, shards } = ANONYMOUS_READ_BUDGET;
  const windowStart = Date.now() - (Date.now() % windowMs);
  busy.tables.projectReadBudgets ??= new Map();
  for (let shard = 0; shard < shards; shard++)
    busy.tables.projectReadBudgets.set(`budget${shard}`, {
      _id: `budget${shard}`,
      projectId: 'project',
      shard,
      windowStart,
      count: calls,
    });
  const limited = await visitor(busy, folder(busy));
  assert.equal(limited.status, 429);
  assert.equal(JSON.parse(limited.body).code, 'RATE_LIMITED');
  assert.equal(limited.headers.get('cache-control'), 'no-store');
  assert.equal(limited.headers.get('access-control-allow-origin'), '*');
  // A public project with no stored source yet: an uncached 409 that says so.
  const empty = await setup(t, 'public');
  delete empty.tables.hostedProjects.get('project').work;
  const none = await visitor(empty, folder(empty));
  assert.equal(none.status, 409);
  assert.equal(JSON.parse(none.body).code, 'SOURCE_UNAVAILABLE');
  // Made private between the lookup and the source read: the same 404 as a missing project.
  const flips = await setup(t, 'public');
  const run = flips.ctx.runQuery;
  flips.ctx.runQuery = async (ref, args) => {
    const value = await run(ref, args);
    if (getFunctionName(ref) === 'publicCode:resolve')
      flips.tables.hostedProjects.get('project').visibility = 'private';
    return value;
  };
  const gone = await visitor(flips, folder(flips));
  const missing = await visitor(flips, `ada/nothing/${flips.head}/open/-.json`);
  assert.deepEqual([gone.status, gone.body], [missing.status, missing.body]);
  assert.equal(gone.status, 404);
});

test('signed out, a failed hosted request or an uncoded failure is a server error, never a cached or coded answer', async t => {
  for (const failure of [
    new ConvexError({ code: 'HOSTED_REQUEST_FAILED', message: 'The hosted request failed.' }),
    new Error('Something broke.'),
  ]) {
    const s = await setup(t, 'public');
    const run = s.ctx.runAction;
    s.ctx.runAction = async (ref, args) => {
      if (getFunctionName(ref) === 'projectCodeBrowse:visitorRead') throw failure;
      return run(ref, args);
    };
    // The route rethrows: Convex answers a 500 that the CDN never stores, not a 404, 409 or 429 body.
    await assert.rejects(visitor(s, `ada/atlas/${s.head}/open/-.json`), error => error === failure);
  }
});

test('signed out, an address the source read would refuse is a 404 before any function runs', async t => {
  const s = await setup(t, 'public');
  const before = s.ran.length;
  for (const path of [
    `ada/atlas/${s.head}/open/${hex('../outside')}.json`,
    `ada/atlas/${s.head}/open/${hex('/abs')}.json`,
    `ada/atlas/${s.head}/open/${hex(Array(30).fill('d').join('/'))}.json`,
    `ada/atlas/${s.head}/page/-/0.json`,
    `ada/atlas/${s.head}/touched/-/${s.head}${s.head}.json`,
  ])
    assert.equal((await visitor(s, path)).status, 404, path);
  assert.deepEqual(s.ran.slice(before), [], 'no function ran');
});

test("signed out, history names main's head before the first landing too (a new or imported project)", async t => {
  const s = await setup(t, 'public');
  s.tables.projectHostedAcceptances.clear();
  s.tables.projectHostedChannels ??= new Map();
  s.tables.projectHostedChannels.set('main', {
    _id: 'main',
    projectId: 'project',
    name: 'main',
    selection: JSON.stringify({ head: s.head }),
  });
  const history = JSON.parse((await visitor(s, 'ada/atlas/history.json')).body);
  assert.equal(history.main, s.head);
  assert.deepEqual(history.landings, []);
});

// Cost of one visitor cache miss (Done-when 4). A cache hit never reaches Convex; a miss runs these functions once. The
// counts are the fixture's (calls, database bytes sized as tests/hosted-read-set.mjs sizes them, reply bytes, stored
// object reads); prices for the same functions come from the dev spend meter (docs/operations/cost-to-serve.md,
// "Public code views"). A change that adds work to a visitor read fails here.
test('one visitor cache miss: the calls, database bytes, reply bytes and object reads it costs', async t => {
  const { meterWorkIO } = await import('./hosted-read-set.mjs');
  const s = await setup(t, 'public');
  const meter = meterWorkIO(s.ctx, s.tables);
  t.after(() => meter.restore());
  let objects = 0;
  const get = s.ctx.storage.get.bind(s.ctx.storage);
  s.ctx.storage.get = async id => {
    objects++;
    return get(id);
  };
  const miss = async path => {
    const from = s.ran.length;
    objects = 0;
    let reply;
    const io = await meter.cost(async () => {
      reply = await visitor(s, path);
    });
    assert.equal(reply.status, 200, path);
    // The HTTP action itself, then every function it ran.
    return {
      functions: ['GET /public/v1/*', ...s.ran.slice(from)],
      ...io,
      replyBytes: reply.body.length,
      objects,
    };
  };
  const views = {
    history: await miss('ada/atlas/history.json'),
    folder: await miss(`ada/atlas/${s.head}/open/-.json`),
    file: await miss(`ada/atlas/${s.head}/open/${hex('a.ts')}.json`),
  };
  t.diagnostic(JSON.stringify(views));
  const tally = names =>
    Object.fromEntries([...new Set(names)].map(name => [name, names.filter(n => n === name).length]));
  // History: the HTTP action and one query (the public identity rule runs inside it).
  assert.deepEqual(tally(views.history.functions), { 'GET /public/v1/*': 1, 'publicCode:history': 1 });
  // A folder or deep-linked file shares one authorized checkpoint read. A file adds only its blob lookup.
  const source = lookups => ({
    'GET /public/v1/*': 1,
    'publicCode:resolve': 1,
    'projectCodeBrowse:visitorRead': 1,
    'projectCode:checkpoint': 1,
    'projectSourceReviewStore:checkpoint': 2,
    'projectObjects:resolve': lookups,
  });
  assert.deepEqual(tally(views.folder.functions), source(6));
  assert.deepEqual(tally(views.file.functions), source(8));
  for (const [name, view] of Object.entries(views)) {
    // Reads stay inside the history page's 256 KB and the source checkpoints' own rows; the only writes are the
    // anonymous read budget's (two checkpoint rows at most) and nothing at all for history.
    assert.ok(view.readBytes <= 256 * 1024, `${name} reads ${view.readBytes} B`);
    assert.ok(view.writeDocuments <= (name === 'history' ? 0 : 1), `${name} writes ${view.writeDocuments}`);
    assert.ok(view.replyBytes <= 64 * 1024, `${name} replies ${view.replyBytes} B`);
  }
  assert.equal(views.history.objects, 0, 'history reads receipts only, no stored object');
});
