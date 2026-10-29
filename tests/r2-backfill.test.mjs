// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import { backupFields, proposalFields } from './project-backup-fixture.mjs';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getFunctionName } from 'convex/server';
import { moduleUrl } from './convex-module.mjs';
import { setup, client } from './r2-harness.mjs';
import { upload, modules } from './project-exchange-fixture.mjs';
import { digest } from '../dist/hash.js';
import { runR2Backfill, backfillEstimate } from '../dist/r2-backfill.js';
const backend = await import(moduleUrl('../convex/projectR2Backfill.ts'));
const actions = await import(moduleUrl('../convex/projectR2BackfillActions.ts'));
const archive = await import(moduleUrl('../convex/archiveBlobUrl.ts'));
const allRows = s => [...s.tables.projectObjects.values()];
async function harness(t) {
  const { s, fake } = await setup(t),
    dir = mkdtempSync(join(tmpdir(), 'forge-r2-backfill-'));
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  const run = (name, args) => backend[name]._handler(s.ctx, { projectId: 'project', ...args });
  const transport = {
    page: (kind, cursor, verify) => run('page', { kind, cursor, verify }),
    targets: pins => run('targets', { pins }),
    check: (pins, operationId, commit) =>
      actions.check._handler(s.ctx, { projectId: 'project', pins, operationId, commit }),
  };
  const lines = [],
    options = {
      project: 'synthetic/project',
      statePath: join(dir, 'progress.json'),
      progress: line => lines.push(line),
    };
  return { s, fake, transport, options, lines, dir };
}
const seed = async (h, texts) => {
  // Backfill starts with legacy Convex bytes; single-object prepare now honors the opt-in.
  const project = h.s.tables.hostedProjects.get('project'),
    optIn = project.r2Writes;
  project.r2Writes = false;
  try {
    for (const text of texts) await upload(h.s, Buffer.from(text));
  } finally {
    project.r2Writes = optIn;
  }
};
const stored = (s, id) => s.tables.projectObjects.get(id);
const requests = (h, method) => h.fake.requests.filter(r => r.method === method);

test('dry-run counts indexed pages without signing, writes, file reads or local progress', async t => {
  const h = await harness(t);
  await seed(h, ['one', 'second']);
  h.transport.targets = h.transport.check = () => assert.fail('dry-run must not sign/check');
  const result = await runR2Backfill(h.transport, { ...h.options, dryRun: true });
  assert.equal(result.count, 2);
  assert.equal(result.bytes, 9);
  assert.equal(existsSync(h.options.statePath), false);
  assert.equal(h.fake.requests.length, 0);
  assert.equal(h.s.deleted.length, 0);
  assert.ok(allRows(h.s).every(row => !row.location));
});

test('pages of 100 migrate objects, checkpoint roots, recipe leaves and archives; copies stay retained', async t => {
  const h = await harness(t);
  await seed(
    h,
    Array.from({ length: 205 }, (_, i) => `object ${i}`),
  );
  const bytes = Buffer.from('archive bytes'),
    storageId = await h.s.ctx.storage.store(new Blob([bytes]));
  for (const table of ['projectBackups', 'projectProposals'])
    h.s.tables[table].set(table, {
      ...(table === 'projectBackups' ? backupFields() : proposalFields()),
      _id: table,
      _creationTime: 1,
      projectId: 'project',
      status: 'stored',
      storageId,
      digest: digest(bytes),
      size: bytes.length,
    });
  h.s.tables.projectBackups.set('original', {
    ...backupFields(),
    _id: 'original',
    _creationTime: 2,
    projectId: 'project',
    status: 'stored',
    digest: '0'.repeat(64),
    size: 0,
    archiveReceipt: { digest: digest(bytes), size: bytes.length, storageId, at: 0, operationId: 'original' },
  });
  // A logical recipe has no own raw storage bytes; its stored leaves are independent object rows.
  h.s.tables.projectObjects.set('recipe', {
    _id: 'recipe',
    _creationTime: 3,
    projectId: 'project',
    digest: 'f'.repeat(64),
    size: 200,
    recipe: { digest: 'a'.repeat(64), size: 10 },
    removed: false,
  });
  const sizes = [],
    page = h.transport.page;
  h.transport.page = async (...args) => {
    const value = await page(...args);
    sizes.push(value.page.length);
    return value;
  };
  const result = await runR2Backfill(h.transport, h.options);
  assert.equal(result.count, 208);
  assert.equal(result.complete, true);
  assert.ok(Math.max(...sizes) <= 100);
  assert.equal(h.s.deleted.length, 0);
  assert.equal(h.s.files.size, 206);
  assert.ok(
    allRows(h.s)
      .filter(r => r.storageId)
      .every(r => r.location === 'r2' && r.r2Committed),
  );
  for (const table of ['projectBackups', 'projectProposals'])
    assert.equal(h.s.tables[table].get(table).location, 'r2');
  assert.equal(h.s.tables.projectBackups.get('original').archiveReceipt.location, 'r2');
  assert.ok(h.lines.some(line => line.includes('ETA')));
  assert.ok(!readFileSync(h.options.statePath, 'utf8').includes('X-Amz-'));
});

test('an existing matching R2 key skips Convex byte transfer and is HEAD-verified', async t => {
  const h = await harness(t);
  await seed(h, ['already uploaded']);
  const row = allRows(h.s)[0];
  h.fake.objects.set(h.fake.key(`v1/p/project/o/${row.digest}`), Buffer.from('already uploaded'));
  let gets = 0;
  const fetch = globalThis.fetch;
  globalThis.fetch = (...args) => {
    if (String(args[0]).startsWith('data:')) gets++;
    return fetch(...args);
  };
  t.after(() => {
    globalThis.fetch = fetch;
  });
  await runR2Backfill(h.transport, h.options);
  assert.equal(gets, 0);
  assert.equal(requests(h, 'PUT').length, 0);
  assert.equal(stored(h.s, row._id).location, 'r2');
});

test('wrong source digest is reported without flipping and can resume after repair', async t => {
  const h = await harness(t);
  await seed(h, ['valid']);
  const row = allRows(h.s)[0],
    original = h.s.files.get(row.storageId);
  h.s.files.set(row.storageId, { blob: new Blob(['wrong']) });
  await assert.rejects(runR2Backfill(h.transport, h.options), e => e.code === 'BACKFILL_ROWS_FAILED');
  assert.equal(stored(h.s, row._id).location, undefined);
  assert.equal(requests(h, 'PUT').length, 0);
  assert.ok(h.lines.some(line => line.includes('BLOB_DIGEST_MISMATCH')));
  h.s.files.set(row.storageId, original);
  assert.equal((await runR2Backfill(h.transport, { ...h.options, resume: true })).count, 1);
});

test('existing corrupt R2 key and missing HEAD checksum never flip a row', async t => {
  const h = await harness(t);
  await seed(h, ['correct']);
  const row = allRows(h.s)[0];
  h.fake.objects.set(h.fake.key(`v1/p/project/o/${row.digest}`), Buffer.from('CORRECT'));
  await assert.rejects(runR2Backfill(h.transport, h.options), e => e.code === 'BACKFILL_ROWS_FAILED');
  assert.equal(stored(h.s, row._id).location, undefined);
  h.fake.objects.set(h.fake.key(`v1/p/project/o/${row.digest}`), Buffer.from('correct'));
  const fetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const response = await fetch(url, init);
    if (init?.method !== 'HEAD') return response;
    const headers = new Headers(response.headers);
    headers.delete('x-amz-checksum-sha256');
    return new Response(null, { status: response.status, headers });
  };
  t.after(() => {
    globalThis.fetch = fetch;
  });
  await assert.rejects(
    runR2Backfill(h.transport, { ...h.options, resume: true }),
    e => e.code === 'BACKFILL_ROWS_FAILED',
  );
  assert.equal(stored(h.s, row._id).location, undefined);
});

for (const step of ['targets', 'before-put', 'after-put', 'after-flip'])
  test(`crash at ${step} resumes the original page without repeat successful Convex downloads`, async t => {
    const h = await harness(t);
    await seed(h, ['resumable content']);
    let downloads = 0,
      crash = true;
    const fetch = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
      if (String(url).startsWith('data:')) downloads++;
      if (crash && init?.method === 'PUT' && step === 'before-put') throw new Error('synthetic disconnected');
      const response = await fetch(url, init);
      if (crash && init?.method === 'PUT' && step === 'after-put') throw new Error('synthetic reply lost');
      return response;
    };
    t.after(() => {
      globalThis.fetch = fetch;
    });
    if (step === 'targets') {
      const targets = h.transport.targets;
      h.transport.targets = async pins => {
        const value = await targets(pins);
        if (crash) throw new Error('synthetic targets lost');
        return value;
      };
    }
    if (step === 'after-flip') {
      const check = h.transport.check;
      h.transport.check = async (...args) => {
        const value = await check(...args);
        if (crash && value.some(r => r.status === 'verified')) throw new Error('synthetic commit lost');
        return value;
      };
    }
    await assert.rejects(runR2Backfill(h.transport, h.options));
    const previous = JSON.parse(readFileSync(h.options.statePath, 'utf8'));
    crash = false;
    const result = await runR2Backfill(h.transport, { ...h.options, resume: true });
    assert.equal(result.count, 1);
    assert.equal(result.operationId, previous.operationId);
    assert.equal(downloads, 1);
    assert.equal(h.s.deleted.length, 0);
  });

test('partial source transfer is never published; resume downloads and hashes complete bytes', async t => {
  const h = await harness(t);
  await seed(h, ['complete content']);
  const fetch = globalThis.fetch;
  let broken = true;
  globalThis.fetch = (url, init) =>
    broken && String(url).startsWith('data:')
      ? Promise.resolve(
          new Response(
            new ReadableStream({
              start(c) {
                c.enqueue(new TextEncoder().encode('partial'));
                c.error(new Error('synthetic stream loss'));
              },
            }),
          ),
        )
      : fetch(url, init);
  t.after(() => {
    globalThis.fetch = fetch;
  });
  await assert.rejects(runR2Backfill(h.transport, h.options));
  assert.equal(allRows(h.s)[0].location, undefined);
  broken = false;
  assert.equal((await runR2Backfill(h.transport, { ...h.options, resume: true })).count, 1);
});

test('a concurrent push stays in R2 while a backfill row flips', async t => {
  const h = await harness(t);
  await seed(h, ['old source']);
  const targets = h.transport.targets;
  let pushed = false;
  h.transport.targets = async pins => {
    if (!pushed) {
      pushed = true;
      const bytes = Buffer.from('concurrent');
      await client(h.s).uploadBatch([{ pin: { sha256: digest(bytes), size: bytes.length }, bytes }]);
    }
    return targets(pins);
  };
  await runR2Backfill(h.transport, h.options);
  assert.equal(allRows(h.s).length, 2);
  assert.ok(allRows(h.s).every(row => row.location === 'r2' && row.r2Committed));
});

test('CAS lost after HEAD safely skips the changed storage id', async t => {
  const h = await harness(t);
  await seed(h, ['old']);
  const row = allRows(h.s)[0],
    run = h.s.ctx.runMutation;
  h.s.ctx.runMutation = async (reference, args) => {
    if (getFunctionName(reference) === 'projectR2Backfill:flip')
      h.s.tables.projectObjects.get(row._id).storageId = 'replacement';
    return run(reference, args);
  };
  await assert.rejects(runR2Backfill(h.transport, h.options), e => e.code === 'BACKFILL_REMAINS');
  assert.equal(stored(h.s, row._id).location, undefined);
  assert.equal(stored(h.s, row._id).storageId, 'replacement');
  assert.equal(h.s.deleted.length, 0);
});

test('full verification HEAD-checks every migrated row and samples downloaded SHA-256, then dates 14 days', async t => {
  const h = await harness(t);
  await seed(h, ['a', 'b', 'c']);
  await runR2Backfill(h.transport, h.options);
  const before = requests(h, 'HEAD').length;
  const result = await runR2Backfill(h.transport, {
    ...h.options,
    verify: true,
    statePath: join(h.dir, 'verify.json'),
  });
  assert.equal(requests(h, 'HEAD').length - before, 3);
  assert.equal(result.samples, 1);
  assert.equal(Date.parse(result.safeToPurgeAfter) - Date.parse(result.verifiedAt), 14 * 86400_000);
  assert.equal(h.s.deleted.length, 0);
});

test('verification corrupt sample or an unflipped row produces no safe-to-purge date', async t => {
  const h = await harness(t);
  await seed(h, ['sample']);
  await runR2Backfill(h.transport, h.options);
  h.fake.corrupt.add(h.fake.key(`v1/p/project/o/${allRows(h.s)[0].digest}`));
  const statePath = join(h.dir, 'verify.json');
  await assert.rejects(
    runR2Backfill(h.transport, { ...h.options, verify: true, statePath }),
    e => e.code === 'BACKFILL_ROWS_FAILED',
  );
  assert.equal(JSON.parse(readFileSync(statePath, 'utf8')).safeToPurgeAfter, undefined);
  h.fake.corrupt.clear();
  await seed(h, ['late convex']);
  await assert.rejects(
    runR2Backfill(h.transport, { ...h.options, verify: true, statePath, resume: true }),
    e => e.code === 'BACKFILL_ROWS_FAILED',
  );
});

test('owner checks, opt-in and page bounds protect every maintenance route', async t => {
  const h = await harness(t);
  await seed(h, ['guarded']);
  const pins = (await h.transport.page('objects', null, false)).page;
  h.s.caller('stranger');
  await assert.rejects(h.transport.page('objects', null, false));
  await assert.rejects(h.transport.targets(pins));
  await assert.rejects(h.transport.check(pins, 'op', true));
  h.s.caller('owner');
  h.s.tables.hostedProjects.get('project').r2Writes = false;
  await assert.rejects(runR2Backfill(h.transport, h.options), e => e.code === 'R2_NOT_ENABLED');
  h.s.tables.hostedProjects.get('project').r2Writes = true;
  await assert.rejects(h.transport.targets(Array(101).fill(pins[0])), e => e.data?.code === 'BAD_ARGUMENT');
  await assert.rejects(
    h.transport.check(Array(101).fill(pins[0]), 'op', true),
    e => e.data?.code === 'BAD_ARGUMENT',
  );
});

test('flip mutation has a constant read budget below 4096 even with 100 pins', async t => {
  const h = await harness(t);
  await seed(
    h,
    Array.from({ length: 100 }, (_, i) => `budget ${i}`),
  );
  const pins = (await h.transport.page('objects', null, false)).page,
    get = h.s.ctx.db.get;
  let reads = 0;
  h.s.ctx.db.get = async (...args) => {
    reads++;
    return get(...args);
  };
  await h.transport.targets(pins);
  assert.equal(reads, 101);
  reads = 0;
  const result = await backend.flip._handler(h.s.ctx, {
    projectId: 'project',
    actor: 'owner',
    operationId: 'synthetic',
    pins,
  });
  assert.equal(result.length, 100);
  assert.equal(reads, 101);
  assert.ok(reads < 4096);
  assert.equal(
    (
      await backend.flip._handler(h.s.ctx, {
        projectId: 'project',
        actor: 'owner',
        operationId: 'synthetic',
        pins,
      })
    ).length,
    100,
  );
  assert.equal(h.s.deleted.length, 0);
});

test('archived bytes resolve through R2 after migration and current authority is rechecked', async t => {
  const h = await harness(t),
    bytes = Buffer.from('old backup'),
    storageId = await h.s.ctx.storage.store(new Blob([bytes]));
  h.s.tables.projectBackups.set('backup', {
    ...backupFields(),
    _id: 'backup',
    _creationTime: 1,
    projectId: 'project',
    status: 'stored',
    storageId,
    digest: digest(bytes),
    size: bytes.length,
  });
  await runR2Backfill(h.transport, h.options);
  const url = await archive.archiveBlobUrl(h.s.ctx, storageId);
  assert.ok(url.includes('r2.cloudflarestorage.com'));
  assert.equal(await (await fetch(url)).text(), 'old backup');
  h.s.caller('stranger');
  await assert.rejects(archive.archiveBlobUrl(h.s.ctx, storageId));
});

test('cost estimate uses supplied Convex rate and R2 Class A planning rate', () => {
  const estimate = backfillEstimate(22800, 1475814506);
  assert.equal(estimate.egressGB, 1.475814506);
  assert.ok(estimate.totalUSD > 0.29 && estimate.totalUSD < 0.3);
});

test('a concurrent backfill invalidates verification and resume restarts the whole pass', async t => {
  const h = await harness(t);
  await seed(h, ['first migration']);
  await runR2Backfill(h.transport, h.options);
  const page = h.transport.page;
  let injected = false;
  h.transport.page = async (kind, cursor, verify) => {
    const value = await page(kind, cursor, verify);
    if (verify && kind === 'archives' && !injected) {
      injected = true;
      await seed(h, ['late migration']);
      await runR2Backfill(h.transport, { ...h.options, statePath: join(h.dir, 'late.json') });
    }
    return value;
  };
  const options = { ...h.options, verify: true, statePath: join(h.dir, 'verify-changed.json') };
  await assert.rejects(runR2Backfill(h.transport, options), e => e.code === 'BACKFILL_CHANGED');
  const interrupted = JSON.parse(readFileSync(options.statePath, 'utf8'));
  assert.equal(interrupted.safeToPurgeAfter, undefined);
  assert.equal(interrupted.kind, 0);
  assert.equal((await runR2Backfill(h.transport, { ...options, resume: true })).count, 2);
});

test('a row deleted concurrently after HEAD is skipped by CAS', async t => {
  const h = await harness(t);
  await seed(h, ['removed concurrently']);
  const row = allRows(h.s)[0],
    run = h.s.ctx.runMutation;
  h.s.ctx.runMutation = async (reference, args) => {
    if (getFunctionName(reference) === 'projectR2Backfill:flip') h.s.tables.projectObjects.delete(row._id);
    return run(reference, args);
  };
  const result = await runR2Backfill(h.transport, h.options);
  assert.equal(result.count, 0);
  assert.equal(result.complete, true);
  assert.equal(h.s.deleted.length, 0);
});

test('verification checks the R2 pointer used by readers, not only the derived key', async t => {
  const h = await harness(t);
  await seed(h, ['pointer']);
  await runR2Backfill(h.transport, h.options);
  const row = allRows(h.s)[0];
  h.s.tables.projectObjects.get(row._id).r2Key = 'wrong-key';
  const statePath = join(h.dir, 'verify-pointer.json');
  await assert.rejects(
    runR2Backfill(h.transport, { ...h.options, statePath, verify: true }),
    e => e.data?.code === 'R2_VERIFY_FAILED',
  );
  assert.equal(JSON.parse(readFileSync(statePath, 'utf8')).safeToPurgeAfter, undefined);
});

test('transfer failures report fixed messages without echoing signed URLs', async t => {
  const { spoolBackfill, sampleBackfill } = await import('../dist/r2-backfill-transfer.js');
  const dir = mkdtempSync(join(tmpdir(), 'forge-r2-error-'));
  const original = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error('synthetic-sensitive-link');
  };
  t.after(() => {
    globalThis.fetch = original;
    rmSync(dir, { recursive: true, force: true });
  });
  const pin = { digest: digest('bytes'), size: 5 };
  for (const run of [
    () => spoolBackfill('https://fixture.invalid/signed', join(dir, 'object'), pin),
    () => sampleBackfill('https://fixture.invalid/signed', pin),
  ])
    await assert.rejects(run(), error => error.code && !error.message.includes('synthetic-sensitive-link'));
});

test('full digest mode downloads every row across pages and all four kinds with bounded concurrency', async t => {
  const h = await harness(t);
  await seed(
    h,
    Array.from({ length: 105 }, (_, i) => `full ${i}`),
  );
  for (const [kind, table] of [
    ['backups', 'projectBackups'],
    ['proposals', 'projectProposals'],
    ['archives', 'projectBackups'],
  ]) {
    const bytes = Buffer.from(kind),
      storageId = await h.s.ctx.storage.store(new Blob([bytes]));
    const source = { storageId, digest: digest(bytes), size: bytes.length };
    h.s.tables[table].set(kind, {
      ...(table === 'projectBackups' ? backupFields() : proposalFields()),
      _id: kind,
      _creationTime: 1,
      projectId: 'project',
      status: 'stored',
      ...(kind === 'archives' ? { archiveReceipt: { ...source, operationId: 'archive', at: 0 } } : source),
    });
  }
  await runR2Backfill(h.transport, h.options);
  const before = requests(h, 'GET').length,
    original = globalThis.fetch;
  let active = 0,
    max = 0;
  globalThis.fetch = async (...args) => {
    if (args[1]?.method === 'HEAD') return original(...args);
    max = Math.max(max, ++active);
    try {
      await new Promise(resolve => setTimeout(resolve, 1));
      return await original(...args);
    } finally {
      active--;
    }
  };
  t.after(() => {
    globalThis.fetch = original;
  });
  const result = await runR2Backfill(h.transport, {
    ...h.options,
    verify: true,
    fullDigest: true,
    statePath: join(h.dir, 'full.json'),
  });
  assert.equal(result.fullDigest, true);
  assert.equal(result.count, 108);
  assert.equal(result.digestChecks, 108);
  assert.equal(requests(h, 'GET').length - before, 108);
  assert.equal(result.kind, 4);
  assert.deepEqual(result.failures, []);
  assert.ok(result.verifiedAt);
  assert.ok(max > 1 && max <= 8);
  assert.equal(h.s.deleted.length, 0);
});

test('full digest failure on an unsampled row resumes the original page and rejects mode changes', async t => {
  const h = await harness(t);
  await seed(
    h,
    Array.from({ length: 102 }, (_, i) => `resume digest ${i}`),
  );
  await runR2Backfill(h.transport, h.options);
  const secondPageRow = allRows(h.s)[101],
    key = h.fake.key(`v1/p/project/o/${secondPageRow.digest}`);
  h.fake.corrupt.add(key);
  const options = { ...h.options, verify: true, fullDigest: true, statePath: join(h.dir, 'full.json') };
  await assert.rejects(runR2Backfill(h.transport, options), e => e.code === 'BACKFILL_ROWS_FAILED');
  const saved = JSON.parse(readFileSync(options.statePath, 'utf8'));
  assert.equal(saved.count, 100);
  assert.equal(saved.digestChecks, 100);
  assert.equal(saved.complete, false);
  assert.equal(saved.verifiedAt, undefined);
  assert.equal(saved.failures[0].id, secondPageRow._id);
  await assert.rejects(
    runR2Backfill(h.transport, { ...options, resume: true, fullDigest: false }),
    e => e.code === 'BACKFILL_STATE_CHANGED',
  );
  h.fake.corrupt.clear();
  const before = requests(h, 'GET').length;
  const result = await runR2Backfill(h.transport, { ...options, resume: true });
  assert.equal(result.operationId, saved.operationId);
  assert.equal(result.digestChecks, 102);
  assert.equal(requests(h, 'GET').length - before, 2);
  assert.deepEqual(result.failures, []);
});

test('full digest verification rejects a body of the wrong size even with a matching HEAD', async t => {
  const h = await harness(t);
  await seed(h, ['size bound']);
  await runR2Backfill(h.transport, h.options);
  const original = globalThis.fetch;
  globalThis.fetch = (url, init) =>
    init?.method === 'HEAD' ? original(url, init) : Promise.resolve(new Response('oversized corrupt body'));
  t.after(() => {
    globalThis.fetch = original;
  });
  await assert.rejects(
    runR2Backfill(h.transport, {
      ...h.options,
      verify: true,
      fullDigest: true,
      statePath: join(h.dir, 'size.json'),
    }),
    e => e.code === 'BACKFILL_ROWS_FAILED',
  );
});
