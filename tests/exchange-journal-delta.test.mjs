// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { performance } from 'node:perf_hooks';
import { initNative } from '../dist/native-work.js';
import { WorkStore } from '../dist/work-store.js';
import { prepareNativeExchange } from '../dist/native-exchange.js';
import { ConvexExchange } from '../dist/exchange-client.js';
import { reconcileExchange } from '../dist/exchange-reconcile.js';
import { exchangeJournalDelta } from '../dist/exchange-journal-delta.js';
import { digest } from '../dist/hash.js';
import { ForgeError } from '../dist/errors.js';
import { applyHostedEvent, metadataRequest, workDigest } from '../dist/work-metadata.js';
import { hostedEventSchema } from '../dist/work-types.js';
import { moduleUrl } from './convex-module.mjs';
import { state } from './hosted-fixture.mjs';
const journal = await import(moduleUrl('../convex/projectWorkJournal.ts'));

async function fixture(t, { workSize = 0, events = 3, received = 1 } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'forge-journal-delta-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, 'a.ts'), 'export const a = 1;\n');
  initNative(root);
  const store = new WorkStore(root),
    data = store.load();
  const intentId = randomUUID();
  data.intents.push({
    id: intentId,
    base: data.nativeHead,
    outcome: 'Synthetic retained history',
    constraints: '',
    status: 'active',
    createdAt: 'now',
    notes: workSize
      ? [
          ...Array.from({ length: Math.ceil(workSize / 3500) }, () => ({
            kind: 'comment',
            text: 'x'.repeat(3500),
            at: 'now',
          })),
        ]
      : [],
  });
  store.save(data);
  const prepared = await prepareNativeExchange(store, store.revision(), randomUUID(), false),
    manifest = Buffer.from(prepared.json),
    work = readFileSync(join(prepared.directory, 'work.json')),
    s = state([]),
    projectKey = randomUUID(),
    archiveSha256 = digest('synthetic root');
  const initialRevision = prepared.manifest.revision;
  const header = {
    projectKey,
    name: 'Synthetic journal',
    backupId: 'backup',
    archiveSha256,
    manifestSha256: digest(manifest),
    initialRevision,
    revision: initialRevision + events,
    head: prepared.manifest.head,
  };
  s.tables.hostedProjects.set('project', {
    _id: 'project',
    _creationTime: 1,
    owner: 'owner',
    key: projectKey,
    name: header.name,
    revision: 1,
    work: { backupId: 'backup', initialRevision, revision: header.revision, operationId: randomUUID() },
  });
  s.tables.projectBackups.set('backup', {
    _id: 'backup',
    projectId: 'project',
    status: 'stored',
    transport: 'objects',
    digest: archiveSha256,
    preview: { format: 'native', head: header.head, manifestDigest: header.manifestSha256 },
  });
  const operations = [];
  const current = store.load();
  for (let i = 0; i < events; i++) {
    const command = { action: 'note', intentId, kind: 'comment', text: `Hosted note ${i}` },
      event = hostedEventSchema.parse({
        id: randomUUID(),
        projectKey,
        archiveSha256,
        previousRevision: initialRevision + i,
        actor: 'owner',
        at: 'now',
        request: metadataRequest(command),
        command,
      });
    operations.push(event);
    s.tables.projectWorkEvents.set(event.id, {
      _id: event.id,
      _creationTime: i + 1,
      projectId: 'project',
      operationId: event.id,
      revision: event.previousRevision + 1,
      previousRevision: event.previousRevision,
      actor: event.actor,
      at: event.at,
      request: event.request,
      command: JSON.stringify(command),
    });
    if (i < received) applyHostedEvent(current, event);
  }
  store.save(current);
  let pages = 0,
    wireBytes = 0,
    storageReads = 0;
  const get = s.ctx.storage.get;
  s.ctx.storage.get = async (...args) => {
    storageReads++;
    return get(...args);
  };
  const transport = {
    journalPage: async (afterRevision, snapshot) => {
      pages++;
      const json = await journal.page._handler(s.ctx, {
        projectId: 'project',
        ...(afterRevision === undefined ? {} : { afterRevision }),
        ...(snapshot ? { snapshot } : {}),
      });
      wireBytes += Buffer.byteLength(json);
      return JSON.parse(json);
    },
  };
  return {
    root,
    store,
    s,
    header,
    work,
    manifest,
    operations,
    transport,
    counts: () => ({ pages, wireBytes, storageReads }),
  };
}

function mockExchange(t, f, changePage) {
  const methods = ['journalPage', 'manifest', 'download', 'journal'],
    originals = methods.map(name => ConvexExchange.prototype[name]),
    token = process.env.FORGE_AUTH_TOKEN;
  process.env.FORGE_AUTH_TOKEN = 'synthetic';
  t.after(() => {
    methods.forEach((name, i) => {
      ConvexExchange.prototype[name] = originals[i];
    });
    if (token === undefined) delete process.env.FORGE_AUTH_TOKEN;
    else process.env.FORGE_AUTH_TOKEN = token;
  });
  let downloads = 0,
    exports = 0,
    manifests = 0;
  ConvexExchange.prototype.journalPage = async (...args) => {
    const page = await f.transport.journalPage(...args);
    return changePage ? changePage(page, args) : page;
  };
  ConvexExchange.prototype.manifest = async () => {
    manifests++;
    return {
      json: f.manifest.toString(),
      digest: digest(f.manifest),
      size: f.manifest.length,
      sourceDigest: f.header.archiveSha256,
    };
  };
  ConvexExchange.prototype.download = async () => {
    downloads++;
    return f.work;
  };
  ConvexExchange.prototype.journal = async () => {
    exports++;
    const data = JSON.parse(f.work);
    for (const event of f.operations) applyHostedEvent(data, event);
    return JSON.stringify({
      schema: 1,
      kind: 'forge-hosted-work-journal',
      projectKey: f.header.projectKey,
      name: f.header.name,
      source: { backupId: 'backup' },
      base: {
        archiveSha256: f.header.archiveSha256,
        manifestSha256: digest(f.manifest),
        workSha256: digest(f.work),
      },
      events: f.operations,
      revision: data.revision,
      workSha256: workDigest(data),
      coverage: 'Synthetic',
    });
  };
  return () => ({ downloads, exports, manifests });
}
const request = f => ({
  url: 'https://fixture.invalid',
  projectId: 'project',
  backupId: 'backup',
  operationId: randomUUID(),
  revision: f.store.revision(),
  preserveLocalSource: true,
});

test('large Work reconcile transfers only new journal events and preserves retry/CAS', async t => {
  const f = await fixture(t, { workSize: 52_000_000, events: 122, received: 85 });
  const calls = mockExchange(t, f),
    progress = [],
    originalRequest = request(f),
    started = performance.now();
  const result = await reconcileExchange(f.root, originalRequest, {
    onProgress: text => progress.push(text),
  });
  assert.equal(result.result.status, 'reconciled');
  assert.equal(result.result.receipt.eventIds.length, 37);
  assert.deepEqual(calls(), { downloads: 0, exports: 0, manifests: 0 });
  assert.equal(f.counts().storageReads, 0);
  assert.equal(f.counts().pages, 2);
  assert(f.counts().wireBytes < 64 * 1024);
  const counts = f.counts();
  await reconcileExchange(f.root, originalRequest);
  assert.deepEqual(f.counts(), counts, 'retained request retry needs no hosted read');
  await assert.rejects(
    reconcileExchange(f.root, { ...originalRequest, revision: originalRequest.revision + 1 }),
    error => error.code === 'WORK_OPERATION_CHANGED',
  );
  t.diagnostic(
    JSON.stringify({
      beforeWorkBytes: f.work.length,
      beforeWorkDownloads: 1,
      afterWorkBytes: 0,
      ...counts,
      elapsedMs: Math.round(performance.now() - started),
    }),
  );
});

test('previous-event hash mismatch logs fallback and reuses retained Work', async t => {
  const f = await fixture(t),
    calls = mockExchange(t, f, (page, args) => {
      if (args[0] > f.header.initialRevision) page.previousEventSha256 = 'a'.repeat(64);
      return page;
    }),
    progress = [];
  const result = await reconcileExchange(f.root, request(f), { onProgress: text => progress.push(text) });
  assert.equal(result.result.status, 'reconciled');
  assert(
    progress.some(
      text =>
        text.includes('journal delta fallback: INVALID_WORK_JOURNAL') && text.includes('previous-event hash'),
    ),
  );
  assert.deepEqual(calls(), { downloads: 0, exports: 0, manifests: 1 });
});

test('missing local base downloads once and subsequent fallbacks reuse it', async t => {
  const f = await fixture(t);
  // Drop the disposable outgoing cache, leaving the local owner intact.
  for (const name of (await import('node:fs')).readdirSync(f.store.directory))
    if (name.startsWith('exchange-')) rmSync(join(f.store.directory, name), { recursive: true });
  const calls = mockExchange(t, f);
  await reconcileExchange(f.root, request(f));
  assert.equal(calls().downloads, 1);
  // Exercise the old-server fallback against the retained receive/download directories.
  ConvexExchange.prototype.journalPage = async () => {
    throw new ForgeError('JOURNAL_PAGING_UNAVAILABLE', 'Synthetic old server');
  };
  await reconcileExchange(f.root, request(f));
  assert.equal(calls().downloads, 1, 'same logical Work is never downloaded twice');
});

test('paging spans rows, rejects gaps, stale snapshots and revoked authority', async t => {
  const f = await fixture(t, { events: 122, received: 1 });
  const delta = await exchangeJournalDelta(f.store, f.transport, 'backup');
  assert.equal(JSON.parse(delta.journal).events.length, 122);
  assert.equal(f.counts().pages, 4);
  const header = await f.transport.journalPage();
  f.s.tables.projectWorkHeads.set('head', {
    _id: 'head',
    projectId: 'project',
    backupId: 'backup',
    revision: f.header.revision + 1,
  });
  await assert.rejects(
    f.transport.journalPage(f.header.initialRevision, header.snapshot),
    /Hosted source or Work changed/,
  );
  f.s.tables.projectWorkHeads.clear();
  f.s.tables.projectWorkEvents.delete(f.operations[2].id);
  await assert.rejects(
    exchangeJournalDelta(f.store, f.transport, 'backup'),
    error => error.code === 'INVALID_WORK_JOURNAL',
  );
  f.s.caller('stranger');
  await assert.rejects(f.transport.journalPage(), /project/i);
});

test('authority failures and source races never invoke full-download fallback', async t => {
  for (const code of ['PROJECT_UNAVAILABLE', 'AUTH_REVOKED', 'WORK_STALE']) {
    await t.test(code, async t => {
      const f = await fixture(t),
        calls = mockExchange(t, f);
      ConvexExchange.prototype.journalPage = async () => {
        throw new ForgeError(code, 'Synthetic');
      };
      await assert.rejects(reconcileExchange(f.root, request(f)), error => error.code === code);
      assert.deepEqual(calls(), { downloads: 0, exports: 0, manifests: 0 });
    });
  }
});

test('paged journal stays bounded for 100 MiB Work in a 128 MiB heap process', t => {
  const child = spawnSync(
    process.execPath,
    ['--max-old-space-size=128', '--expose-gc', 'tests/journal-page-memory-worker.mjs'],
    { encoding: 'utf8' },
  );
  assert.equal(child.status, 0, child.stderr);
  const result = JSON.parse(child.stdout.trim());
  assert.equal(result.calls, 3);
  assert.equal(result.storageReads, 0);
  t.diagnostic(JSON.stringify(result));
});

test('metadata fallback reuses large downloads across transports and validates current authority', async t => {
  const { buildExchangeRoot } = await import('../dist/native-exchange-tree.js');
  const f = await fixture(t, { workSize: 3 * 1024 * 1024, received: 0 });
  const tree = buildExchangeRoot(f.manifest, f.work);
  const cache = join(f.root, 'cache');
  mkdirSync(cache);
  let downloaded = 0,
    checkpointReads = 0,
    denied = false;
  const transport = () => {
    const result = new ConvexExchange('https://fixture.invalid', 'synthetic', 'project', randomUUID(), null);
    result.metadataCacheDirectory = cache;
    result.client = {
      action: async () => {
        checkpointReads++;
        if (denied) throw new ForgeError('PROJECT_UNAVAILABLE', 'Revoked');
        return { json: tree.bytes.toString(), digest: digest(tree.bytes), size: tree.bytes.length };
      },
    };
    result.downloadBatch = async pins =>
      pins.map(pin => {
        downloaded += pin.size;
        return tree.objects.get(pin.sha256);
      });
    return result;
  };
  const first = transport(),
    manifest = await first.manifest('backup');
  assert(downloaded > 0, 'cold fallback fetches metadata chunks');
  const before = downloaded;
  const second = transport();
  assert.deepEqual(await second.manifest('backup'), manifest);
  assert.equal(downloaded, before, 'new transport reads the persisted large metadata cache');
  assert.equal(checkpointReads, 2, 'every reuse rechecks checkpoint authority');
  denied = true;
  await assert.rejects(transport().manifest('backup'), error => error.code === 'PROJECT_UNAVAILABLE');
  assert.equal(downloaded, before);
});

test('metadata fallback reuses older receive directories, and corrupt bytes are refetched', async t => {
  const { buildExchangeRoot } = await import('../dist/native-exchange-tree.js');
  const f = await fixture(t, { workSize: 3 * 1024 * 1024, received: 0 }),
    tree = buildExchangeRoot(f.manifest, f.work);
  const directory = join(f.store.directory, `exchange-receive-${randomUUID()}`);
  mkdirSync(directory);
  writeFileSync(join(directory, 'manifest.json'), f.manifest);
  writeFileSync(join(directory, 'work.json'), f.work);
  const transport = new ConvexExchange('https://fixture.invalid', 'synthetic', 'project', randomUUID(), null);
  transport.metadataCacheDirectory = f.store.directory;
  transport.client = {
    action: async () => ({
      json: tree.bytes.toString(),
      digest: digest(tree.bytes),
      size: tree.bytes.length,
    }),
  };
  let downloads = 0;
  transport.downloadBatch = async pins => {
    downloads++;
    return pins.map(pin => tree.objects.get(pin.sha256));
  };
  await transport.manifest('backup');
  assert.equal(downloads, 0);
  // Corrupt every retained Work copy, so neither hash-verified fallback can reuse it.
  for (const name of (await import('node:fs')).readdirSync(f.store.directory))
    if (name.startsWith('exchange-')) writeFileSync(join(f.store.directory, name, 'work.json'), 'corrupt');
  await transport.manifest('backup');
  assert(downloads > 0);
});

test('journal pages honor byte budgets without dropping the next event', async t => {
  const f = await fixture(t, { events: 70, received: 0 });
  for (const row of f.s.tables.projectWorkEvents.values()) {
    const command = JSON.parse(row.command);
    command.text = '界'.repeat(4000);
    row.command = JSON.stringify(command);
    row.request = metadataRequest(command);
  }
  let after = f.header.initialRevision,
    events = 0,
    calls = 0;
  while (true) {
    const page = await f.transport.journalPage(after);
    calls++;
    events += page.events.length;
    assert(Buffer.byteLength(JSON.stringify(page)) < 260 * 1024);
    after = page.nextRevision;
    if (page.isDone) break;
  }
  assert.equal(events, 70);
  assert.equal(calls, 4);
});

test('old deployment detection preserves legacy journal export and never exposes platform errors', async () => {
  const transport = new ConvexExchange('https://fixture.invalid', 'synthetic', 'project', randomUUID(), null);
  transport.client = {
    query: async () => {
      throw new Error(
        "Could not find public function for 'projectWorkJournal:page'. Did you forget to run convex dev?",
      );
    },
  };
  await assert.rejects(transport.journalPage(), error => error.code === 'JOURNAL_PAGING_UNAVAILABLE');
  transport.client = {
    query: async () => {
      throw new Error('Synthetic private platform payload');
    },
  };
  await assert.rejects(
    transport.journalPage(),
    error => error.code === 'HOSTED_ACTION_FAILED' && !error.message.includes('private platform payload'),
  );
});

test('a failed old-server journal export retains the large download for the original retry', async t => {
  const f = await fixture(t);
  for (const name of (await import('node:fs')).readdirSync(f.store.directory))
    if (name.startsWith('exchange-')) rmSync(join(f.store.directory, name), { recursive: true });
  const calls = mockExchange(t, f),
    original = ConvexExchange.prototype.journal;
  ConvexExchange.prototype.journalPage = async () => {
    throw new ForgeError('JOURNAL_PAGING_UNAVAILABLE', 'Synthetic old server');
  };
  let failed = false;
  ConvexExchange.prototype.journal = async function () {
    if (!failed) {
      failed = true;
      throw new ForgeError('EXCHANGE_REQUEST_TIMEOUT', 'Synthetic export failure');
    }
    return original.call(this);
  };
  const input = request(f);
  await assert.rejects(reconcileExchange(f.root, input), error => error.code === 'EXCHANGE_REQUEST_TIMEOUT');
  assert.equal(calls().downloads, 1);
  assert.equal((await reconcileExchange(f.root, input)).result.status, 'reconciled');
  assert.equal(calls().downloads, 1);
});
