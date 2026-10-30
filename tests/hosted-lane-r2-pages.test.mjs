// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getFunctionName } from 'convex/server';
import { moduleUrl } from './convex-module.mjs';
import { checkArgs } from './convex-args.mjs';
import { digest } from '../dist/hash.js';
import { ConvexExchange } from '../dist/exchange-client.js';
import { ConvexLaneTransport } from '../dist/hosted-lane-transport.js';
import { checkoutHostedLane } from '../dist/hosted-lane-checkout.js';
const downloads = await import(moduleUrl('../convex/projectObjectDownloads.ts'));
const denied = code => error => (error.data?.code ?? error.code) === code;

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'forge-lane-r2-page-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const config = {
    R2_ACCOUNT_ID: 'lane-page-fixture',
    R2_BUCKET: 'synthetic',
    R2_ACCESS_KEY_ID: 'synthetic-access',
    R2_SECRET_ACCESS_KEY: 'synthetic-secret',
  };
  const saved = Object.fromEntries(Object.keys(config).map(key => [key, process.env[key]]));
  Object.assign(process.env, config);
  t.after(() => {
    for (const [key, value] of Object.entries(saved))
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
  });
  const project = { _id: 'project', owner: 'owner', visibility: 'private' };
  const credential = {
    credentialId: 'device',
    owner: 'owner',
    scope: 'cli',
    expiresAt: Date.now() + 3600000,
    revoked: false,
  };
  const objects = new Map(),
    grants = new Map();
  const counts = { calls: 0, reads: 0, writes: 0, storage: 0, gets: 0, pages: [], selects: 0 };
  let identity = { subject: 'owner', forgeCredential: 'device' };
  const ctx = {
    auth: { getUserIdentity: async () => identity },
    db: {
      get: async id => {
        counts.reads++;
        return id === 'project' ? project : null;
      },
      query: table => ({
        withIndex: (_name, select) => {
          const fields = {};
          const index = {
            eq(key, value) {
              fields[key] = value;
              return index;
            },
          };
          select(index);
          return {
            unique: async () => {
              counts.reads++;
              if (table === 'cliCredentials') return fields.credentialId === 'device' ? credential : null;
              if (table === 'projectObjects')
                return fields.projectId === 'project' ? (objects.get(fields.digest) ?? null) : null;
              return grants.get(JSON.stringify([table, fields])) ?? null;
            },
          };
        },
      }),
      insert: () => {
        counts.writes++;
        throw Error('read endpoint wrote a document');
      },
      patch: () => {
        counts.writes++;
        throw Error('read endpoint wrote a document');
      },
    },
    storage: new Proxy(
      {},
      {
        get: () => () => {
          counts.storage++;
          throw Error('R2 page accessed Convex storage');
        },
      },
    ),
    runQuery: () => {
      counts.calls++;
      throw Error('unexpected nested RPC');
    },
  };
  const exchange = new ConvexExchange('https://fixture.invalid', 'fixture', 'project', 'op', null);
  exchange.client = {
    mutation: async (ref, args) => {
      assert.equal(getFunctionName(ref), 'projectObjectDownloads:lanePage');
      counts.calls++;
      counts.pages.push({ length: args.digests.length, signed: args.signed });
      checkArgs(downloads.lanePage, args, 'lanePage');
      return downloads.lanePage._handler(ctx, args);
    },
    query: async ref => {
      assert.equal(getFunctionName(ref), 'projectHostedLanes:select');
      counts.calls++;
      counts.selects++;
      return JSON.stringify(selection);
    },
    action: () => {
      throw Error('R2 page called a legacy action');
    },
  };
  const put = (bytes, extra = {}) => {
    const sha256 = digest(bytes);
    objects.set(sha256, {
      digest: sha256,
      size: bytes.length,
      removed: false,
      location: 'r2',
      r2Committed: true,
      r2Key: `v1/p/project/o/${sha256}`,
      ...extra,
    });
    return { sha256, size: bytes.length };
  };
  const selection = {
    schema: 2,
    projectId: 'project',
    laneId: randomUUID(),
    intentId: randomUUID(),
    head: '',
    version: 0,
    sourceVersion: 0,
    lifecycleVersion: 0,
    state: 'active',
    base: { head: 'a'.repeat(64), receiptId: 'base' },
    authority: { mode: 'server', epoch: 1 },
  };
  return {
    directory,
    project,
    credential,
    objects,
    grants,
    counts,
    ctx,
    exchange,
    put,
    selection,
    transport: new ConvexLaneTransport(exchange),
    caller: value => {
      identity = value;
    },
  };
}

for (const [count, totalBytes] of [
  [3000, 100000000],
  [28000, 512 * 1024 * 1024],
]) {
  test(`${count}-file cold Lane checkout obeys the constant plus page call budget`, async t => {
    const s = fixture(t),
      byDigest = new Map(),
      length = Math.floor(totalBytes / count);
    const body = i => {
      const bytes = Buffer.alloc(length, 120);
      bytes.writeUInt32LE(i);
      return bytes;
    };
    const rss = process.memoryUsage().rss,
      started = performance.now();
    const files = Array.from({ length: count }, (_, i) => {
      const pin = s.put(body(i));
      byDigest.set(pin.sha256, i);
      return { path: `src/${i}.txt`, blob: pin.sha256, mode: 'file' };
    });
    const state = Buffer.from(
      JSON.stringify({
        schema: 1,
        kind: 'forge-source-state',
        parents: [],
        files,
        message: 'synthetic',
        at: '2026-01-01T00:00:00Z',
      }),
    );
    s.selection.head = s.put(state).sha256;
    t.mock.method(globalThis, 'fetch', async url => {
      assert.equal(new URL(url).hostname, 'lane-page-fixture.r2.cloudflarestorage.com');
      const id = new URL(url).pathname.split('/').at(-1);
      s.counts.gets++;
      return new Response(id === s.selection.head ? state : body(byDigest.get(id)));
    });
    const root = join(s.directory, 'checkout');
    const result = await checkoutHostedLane(
      root,
      {
        url: 'https://fixture.invalid',
        projectId: 'project',
        laneId: s.selection.laneId,
        operationId: randomUUID(),
      },
      s.transport,
    );
    assert.equal(result.downloadedObjects, count + 1);
    assert.deepEqual(readFileSync(join(root, `src/${count - 1}.txt`)), body(count - 1));
    const pages = Math.ceil(count / 500);
    assert.equal(s.counts.calls, 2 * pages + 4);
    assert.equal(s.counts.reads, 2 * (count + 1) + 4 * (pages + 1));
    assert.equal(s.counts.writes, 0);
    assert.equal(s.counts.storage, 0);
    assert.equal(s.counts.gets, count + 1);
    assert.equal(s.counts.selects, 2);
    assert(s.counts.pages.every(page => page.length <= 500));
    assert.equal(s.counts.pages.filter(page => page.signed).length, pages + 1);
    t.diagnostic(
      JSON.stringify({
        files: count,
        calls: s.counts.calls,
        documentReads: s.counts.reads,
        writes: 0,
        convexStorageCalls: 0,
        directGets: s.counts.gets,
        bytes: result.downloadedBytes,
        wallMs: Math.round(performance.now() - started),
        rssGrowth: process.memoryUsage().rss - rss,
        peakRss: process.resourceUsage().maxRSS * 1024,
      }),
    );
  });
}

test('Lane pages preserve access, credential scope, removal and project binding checks', async t => {
  const s = fixture(t),
    pin = s.put(Buffer.from('guarded'));
  const read = () => s.transport.objects([pin.sha256]);
  assert.equal((await read()).length, 1);
  for (const [change, code] of [
    [
      () => {
        s.credential.revoked = true;
      },
      'AUTH_REVOKED',
    ],
    [
      () => {
        s.credential.revoked = false;
        s.credential.scope = 'coordination';
      },
      'AUTH_SCOPE_DENIED',
    ],
    [
      () => {
        s.credential.scope = 'cli';
        s.credential.expiresAt = 0;
      },
      'AUTH_REVOKED',
    ],
    [
      () => {
        s.credential.expiresAt = Date.now() + 60000;
        s.caller({ subject: 'stranger' });
      },
      'PROJECT_UNAVAILABLE',
    ],
    [
      () => {
        s.caller(null);
      },
      'PROJECT_UNAVAILABLE',
    ],
    [
      () => {
        s.caller({ subject: 'owner' });
        s.project.removal = 'deleting';
      },
      'PROJECT_UNAVAILABLE',
    ],
    [
      () => {
        delete s.project.removal;
        s.objects.get(pin.sha256).removed = true;
      },
      'SOURCE_UNAVAILABLE',
    ],
    [
      () => {
        s.objects.get(pin.sha256).removed = false;
        s.objects.get(pin.sha256).r2Key = 'v1/p/foreign/o/' + pin.sha256;
      },
      'INVALID_WORK_BACKUP',
    ],
  ]) {
    change();
    await assert.rejects(read(), denied(code));
  }
  await assert.rejects(s.transport.objects([digest('foreign-only')]), denied('SOURCE_UNAVAILABLE'));
  assert.equal(s.counts.storage, 0);
});

for (const mode of ['revoked', 'removed', 'rebound', 'corrupt', 'expired']) {
  test(`R2 GET ${mode} is reconciled before Lane bytes are exposed`, async t => {
    const s = fixture(t),
      bytes = Buffer.from('exact source'),
      pin = s.put(bytes),
      path = join(s.directory, 'file');
    let gets = 0;
    t.mock.method(globalThis, 'fetch', async () => {
      gets++;
      if (mode === 'expired' && gets === 1) return new Response(null, { status: 403 });
      if (mode === 'revoked') s.credential.revoked = true;
      if (mode === 'removed') s.objects.get(pin.sha256).removed = true;
      if (mode === 'rebound') s.objects.get(pin.sha256).size++;
      return new Response(mode === 'corrupt' ? Buffer.from('wrong source') : bytes);
    });
    await s.transport.objects([pin.sha256]);
    const result = s.transport.downloadFiles([{ pin, path }]);
    if (mode === 'expired') {
      await result;
      assert.deepEqual(readFileSync(path), bytes);
      assert.equal(gets, 2);
      assert.equal(s.counts.calls, 3);
    } else {
      const code = {
        revoked: 'AUTH_REVOKED',
        removed: 'SOURCE_UNAVAILABLE',
        rebound: 'INVALID_WORK_BACKUP',
        corrupt: 'BLOB_DIGEST_MISMATCH',
      }[mode];
      await assert.rejects(result, denied(code));
      assert.equal(existsSync(path), false);
    }
  });
}

test('mixed R2 and Convex-only Lane pages keep the real legacy byte path', async t => {
  const { setup, client } = await import('./r2-harness.mjs');
  const { s, fake } = await setup(t, { flag: '', optIn: false });
  const exchange = client(s),
    values = [Buffer.from('legacy'), Buffer.from('modern'), Buffer.alloc(0)];
  const pins = values.map(bytes => ({ sha256: digest(bytes), size: bytes.length }));
  await exchange.uploadBatch([{ pin: pins[0], bytes: values[0] }]);
  process.env.FORGE_BLOBS = 'r2';
  await exchange.uploadBatch(pins.slice(1).map((pin, index) => ({ pin, bytes: values[index + 1] })));
  const directory = mkdtempSync(join(tmpdir(), 'forge-lane-mixed-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const files = pins.map((pin, index) => ({ pin, path: join(directory, String(index)) }));
  const run = exchange.client.action,
    actions = [];
  exchange.client.action = (ref, args) => {
    actions.push(getFunctionName(ref));
    return run(ref, args);
  };
  const transport = new ConvexLaneTransport(exchange);
  await transport.objects(pins.map(pin => pin.sha256));
  await transport.downloadFiles(files);
  assert.deepEqual(
    files.map(file => readFileSync(file.path)),
    values,
  );
  assert.deepEqual(actions, ['projectExchangeActions:downloadBatch']);
  assert.equal(fake.requests.filter(request => request.method === 'GET').length, 2);
});

test('removing a reader during an R2 GET prevents exposing the downloaded page', async t => {
  const s = fixture(t),
    bytes = Buffer.from('reader source'),
    pin = s.put(bytes),
    path = join(s.directory, 'file');
  s.caller({ subject: 'reader' });
  const grant = JSON.stringify(['projectReaders', { projectId: 'project', reader: 'reader' }]);
  s.grants.set(grant, { projectId: 'project', reader: 'reader' });
  await s.transport.objects([pin.sha256]);
  t.mock.method(globalThis, 'fetch', async () => {
    s.grants.delete(grant);
    return new Response(bytes);
  });
  await assert.rejects(s.transport.downloadFiles([{ pin, path }]), denied('PROJECT_UNAVAILABLE'));
  assert.equal(existsSync(path), false);
});
