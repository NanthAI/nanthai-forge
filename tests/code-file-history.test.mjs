// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import test from 'node:test';
import { getFunctionName } from 'convex/server';
import { digest } from '../dist/hash.js';
import { moduleUrl } from './convex-module.mjs';
import { state } from './hosted-fixture.mjs';
import { meterWorkIO } from './hosted-read-set.mjs';

const member = await import(moduleUrl('../convex/projectCode.ts'));
const publicCode = await import(moduleUrl('../convex/publicCode.ts'));
const publicHttp = await import(moduleUrl('../convex/publicHttp.ts'));
const path = 'src/entry.ts';
const before = 'a'.repeat(64);
const after = 'b'.repeat(64);
const fileHistoryUrl = '/public/v1/code/ada/example/file-history/' + Buffer.from(path).toString('hex');

function fixture(visibility = 'public') {
  const f = state([]);
  const query = f.ctx.db.query;
  f.ctx.db.query = table => {
    const builder = query(table);
    if (table === 'projectHostedAcceptances') {
      // The shared fixture caps rows. Model the provider's separate pagination byte boundary here.
      const paginate = builder.paginate;
      builder.paginate = async opts => {
        const result = await paginate(opts);
        let bytes = 0;
        const page = [];
        for (const row of result.page) {
          bytes += Buffer.byteLength(JSON.stringify(row));
          if (page.length && bytes > (opts.maximumBytesRead ?? Infinity)) break;
          page.push(row);
        }
        return { ...result, page, isDone: result.isDone && page.length === result.page.length };
      };
    }
    return builder;
  };
  const put = (table, id, fields) =>
    f.tables[table].set(id, { _id: id, _creationTime: 1, projectId: 'project', ...fields });
  put('hostedProjects', 'project', { owner: 'owner', name: 'Example', slug: 'example', visibility });
  put('forgeAccounts', 'account', { owner: 'owner', handle: 'ada' });
  put('accountHandles', 'handle', { owner: 'owner', handle: 'ada' });
  put('projectSlugs', 'slug', { owner: 'owner', slug: 'example' });
  function add(
    sequence,
    paths,
    {
      candidateId = `candidate-${sequence}`,
      head = after,
      recordHead = head,
      actor = 'owner',
      wrongDigest = false,
      docsResolution,
    } = {},
  ) {
    const receiptId = `00000000-0000-4000-8000-${String(sequence).padStart(12, '0')}`;
    const value = JSON.stringify({
      kind: 'candidate',
      id: candidateId,
      base: { head: before },
      result: { status: 'clean', head: recordHead },
      governance: { paths },
    });
    const pinned =
      paths === undefined
        ? f.tables.projectHostedRecords.get(`record-${candidateId}`)?.digest
        : digest(value);
    if (actor !== 'owner') put('forgeAccounts', `account-${actor}`, { owner: actor, handle: actor });
    put('projectHostedAcceptances', receiptId, {
      _creationTime: sequence,
      sequence,
      receiptId,
      value: JSON.stringify({
        id: receiptId,
        at: '2026-11-01T00:00:00.000Z',
        actor: { id: actor, kind: 'person' },
        message: `Landing ${sequence}`,
        previous: { head: before },
        candidate: { id: candidateId, head, digest: wrongDigest ? '0'.repeat(64) : pinned },
        automatic: false,
        docsResolution,
      }),
    });
    if (paths === undefined) return;
    const bodyId = `body-${candidateId}`;
    put('projectHostedRecordBodies', bodyId, { value });
    put('projectHostedRecords', `record-${candidateId}`, {
      kind: 'candidate',
      key: candidateId,
      version: 0,
      bodyId,
      digest: digest(value),
      bytes: Buffer.byteLength(value),
    });
  }
  const read = async (cursor = null) =>
    JSON.parse(await member.fileHistory._handler(f.ctx, { projectId: 'project', path, before: cursor }));
  const visit = (cursor = '-', url = fileHistoryUrl) =>
    publicHttp.serve._handler(
      f.ctx,
      new Request(`https://origin.test${url}/${cursor}.json`, {
        headers: { 'x-forge-public-key': 'synthetic-site-key' },
      }),
    );
  return { ...f, add, read, visit };
}

test('file history preserves newest-first matches through a shared Candidate and missing exact evidence', async () => {
  const f = fixture('private');
  for (let i = 1; i <= 12; i++)
    f.add(i, i === 3 || i >= 11 ? [path] : ['src/entry.ts.old'], { wrongDigest: i === 10 });
  f.add(13, undefined, { candidateId: 'candidate-12' });
  f.add(14, undefined);
  f.add(15, [path], { recordHead: 'c'.repeat(64) });
  f.add(16, undefined, { head: before });
  const first = await f.read();
  assert.deepEqual(
    first.landings.map(row => row.sequence),
    [13, 12, 11, 3],
  );
  assert.equal(first.missing, 3);
  assert.equal(first.scanned, 16);
  assert.equal(first.nextBefore, null);
  assert.deepEqual(
    (await f.read(4)).landings.map(row => row.sequence),
    [3],
  );
});

test('the first page finds eight matches beyond the newest eight receipts and resumes at the last examined receipt', async () => {
  const f = fixture('private');
  for (let i = 1; i <= 80; i++) f.add(i, i <= 4 || (i >= 62 && i <= 70) ? [path] : ['other.ts']);
  const first = await f.read();
  assert.deepEqual(
    first.landings.map(row => row.sequence),
    [70, 69, 68, 67, 66, 65, 64, 63],
  );
  assert.equal(first.scanned, 18);
  assert.equal(first.nextBefore, 63);
  // A new acceptance cannot move an in-progress continuation.
  f.add(81, [path]);
  const earlier = await f.read(first.nextBefore);
  assert.deepEqual(
    earlier.landings.map(row => row.sequence),
    [62, 4, 3, 2, 1],
  );
  assert.equal(earlier.nextBefore, null);
});

test('a sparse scan stops at its read budget and resumes without skipping a landing', async t => {
  const f = fixture('private');
  for (let i = 1; i <= 112; i++) f.add(i, i === 16 ? [path] : ['other.ts']);
  const meter = meterWorkIO(f.ctx, f.tables);
  t.after(() => meter.restore());
  let first;
  const io = await meter.cost(async () => {
    first = await f.read();
  });
  assert.deepEqual(first, { landings: [], missing: 0, scanned: 96, nextBefore: 17 });
  assert.ok(io.readDocuments <= 289, `read ${io.readDocuments} documents`);
  assert.ok(io.readBytes <= 1_200_000, `read ${io.readBytes} bytes`);
  assert.equal(io.writeDocuments, 0);
  assert.deepEqual(
    (await f.read(first.nextBefore)).landings.map(row => row.sequence),
    [16],
  );
  t.diagnostic(JSON.stringify(io));
});

test('the first page can find sparse matches through more than 256 KiB of receipt metadata', async t => {
  const f = fixture('private');
  const docsResolution = {
    paths: Array.from({ length: 23 }, (_, index) => `docs/${'a'.repeat(180)}/file-${index}.md`),
    rule: 'keep both sides, main first',
    undo: 'Edit the affected files.',
  };
  for (let i = 1; i <= 90; i++) f.add(i, i <= 20 ? [path] : ['other.ts'], { docsResolution });
  const meter = meterWorkIO(f.ctx, f.tables);
  t.after(() => meter.restore());
  let first;
  const io = await meter.cost(async () => {
    first = await f.read();
  });
  assert.deepEqual(
    first.landings.map(row => row.sequence),
    [20, 19, 18, 17, 16, 15, 14, 13],
  );
  assert.equal(first.scanned, 78);
  assert.equal(first.nextBefore, 13);
  assert.ok(io.readBytes <= 550_000, `read ${io.readBytes} bytes`);
});

test('the expanded receipt byte budget stops a sparse scan before its row ceiling', async t => {
  const f = fixture('private');
  const docsResolution = {
    paths: Array.from({ length: 52 }, (_, index) => `docs/${'a'.repeat(180)}/file-${index}.md`),
    rule: 'keep both sides, main first',
    undo: 'Edit the affected files.',
  };
  for (let i = 1; i <= 80; i++) f.add(i, i === 12 ? [path] : ['other.ts'], { docsResolution });
  const meter = meterWorkIO(f.ctx, f.tables);
  t.after(() => meter.restore());
  let first;
  const io = await meter.cost(async () => {
    first = await f.read();
  });
  assert.deepEqual(first.landings, []);
  assert.ok(first.nextBefore > 12);
  assert.equal(first.scanned, 81 - first.nextBefore);
  assert.ok(io.readBytes <= 580_000, `read ${io.readBytes} bytes`);
  assert.deepEqual(
    (await f.read(first.nextBefore)).landings.map(row => row.sequence),
    [12],
  );
});

test('large receipt metadata stops the scan even before the first batch fills', async t => {
  const f = fixture('private');
  const folders = Array(8).fill('a'.repeat(170)).join('/');
  const docsResolution = {
    paths: Array.from({ length: 100 }, (_, index) => `docs/${folders}/file-${index}.md`),
    rule: 'keep both sides, main first',
    undo: 'Edit the affected files.',
  };
  for (let i = 1; i <= 9; i++) f.add(i, [path], { docsResolution });
  const meter = meterWorkIO(f.ctx, f.tables);
  t.after(() => meter.restore());
  let first;
  const io = await meter.cost(async () => {
    first = await f.read();
  });
  assert.equal(first.scanned, 1);
  assert.equal(first.nextBefore, 9);
  assert.deepEqual(
    first.landings.map(row => row.sequence),
    [9],
  );
  assert.ok(io.readBytes <= 300_000, `read ${io.readBytes} bytes`);
  assert.deepEqual(
    (await f.read(first.nextBefore)).landings.map(row => row.sequence),
    [8],
  );
});

test('an unreadable older Candidate does not block a page already filled by newer matches', async () => {
  const f = fixture('private');
  for (let i = 1; i <= 20; i++) f.add(i, i > 12 ? ['other.ts'] : [path]);
  f.tables.projectHostedRecords.set('duplicate', {
    ...f.tables.projectHostedRecords.get('record-candidate-4'),
    _id: 'duplicate',
  });
  const first = await f.read();
  assert.deepEqual(
    first.landings.map(row => row.sequence),
    [12, 11, 10, 9, 8, 7, 6, 5],
  );
  assert.equal(first.nextBefore, 5);
  await assert.rejects(f.read(first.nextBefore));
});

test('public file history uses the same matches and rechecks visibility on every page', async t => {
  const key = process.env.FORGE_PUBLIC_READ_SECRET;
  process.env.FORGE_PUBLIC_READ_SECRET = 'synthetic-site-key';
  t.after(() => {
    if (key === undefined) delete process.env.FORGE_PUBLIC_READ_SECRET;
    else process.env.FORGE_PUBLIC_READ_SECRET = key;
  });
  const f = fixture();
  f.add(1, [path]);
  const signed = await f.read();
  const calls = [];
  f.ctx.runQuery = async (ref, args) => {
    const name = getFunctionName(ref);
    calls.push(name);
    assert.ok(name === 'publicCode:fileHistory' || name === 'publicCode:history');
    return publicCode[name.split(':')[1]]._handler(f.ctx, args);
  };
  f.caller(null);
  const first = await f.visit();
  assert.equal(first.status, 200);
  const visitor = await first.json();
  assert.deepEqual(
    visitor.landings,
    signed.landings.map(({ actor: _person, ...row }) => row),
  );
  assert.equal(visitor.scanned, signed.scanned);
  assert.deepEqual(calls, ['publicCode:fileHistory'], 'one nested query per public HTTP call');
  assert.equal((await f.visit('0')).status, 404);
  assert.equal((await f.visit('-', fileHistoryUrl.replace(/[^/]+$/, '2e2e'))).status, 404);
  assert.equal(calls.length, 1, 'malformed paths never run the query');
  const receiptId = signed.landings[0].receiptId;
  const receipt = await f.visit(receiptId, '/public/v1/code/ada/example/history');
  assert.deepEqual((await receipt.json()).landings, visitor.landings);
  f.caller('owner');
  const memberReceipt = JSON.parse(
    await member.history._handler(f.ctx, { projectId: 'project', cursor: null, receiptId }),
  );
  assert.deepEqual(memberReceipt.landings, signed.landings);
  f.caller(null);
  f.tables.hostedProjects.get('project').visibility = 'private';
  const revoked = await f.visit('2');
  const missing = await f.visit('2', fileHistoryUrl.replace('/example/', '/unknown/'));
  assert.equal(revoked.status, 404);
  assert.equal(missing.status, 404);
  assert.equal(await revoked.text(), await missing.text());
  f.caller('stranger');
  await assert.rejects(f.read(2), error => error.data?.code === 'PROJECT_UNAVAILABLE');
});

for (const files of [3_000, 29_000])
  test(`file history pages at ${files} files bound database I/O, replies, call count and round-trip depth`, async t => {
    const f = fixture('private');
    const all = Array.from({ length: files - 1 }, (_, i) => `src/generated/part-${i}.ts`);
    for (let i = 1; i <= 16; i++) f.add(i, [path, ...all], { actor: `builder-${i}` });
    const meter = meterWorkIO(f.ctx, f.tables);
    t.after(() => meter.restore());
    for (const method of ['runQuery', 'runAction', 'runMutation'])
      f.ctx[method] = () => assert.fail('member pages run in a single transaction');
    t.mock.method(globalThis, 'fetch', () => assert.fail('the reader never downloads source'));
    const seen = [];
    let cursor = null;
    const budgets = [];
    do {
      let page;
      const io = await meter.cost(async () => {
        page = await f.read(cursor);
      });
      const replyBytes = Buffer.byteLength(JSON.stringify(page));
      budgets.push({ documents: io.readDocuments, bytes: io.readBytes, replyBytes });
      assert.ok(io.readDocuments <= 34, `read ${io.readDocuments} documents`);
      assert.ok(io.readBytes <= 1_200_000, `read ${io.readBytes} bytes`);
      assert.equal(io.writeDocuments, 0);
      assert.ok(replyBytes <= 5_000, `returned ${replyBytes} bytes`);
      assert.ok(page.landings.length > 0, 'the byte boundary must advance past a large Candidate');
      seen.push(...page.landings.map(row => row.sequence));
      cursor = page.nextBefore;
    } while (cursor !== null && seen.length <= 16);
    assert.deepEqual(
      seen,
      Array.from({ length: 16 }, (_, i) => 16 - i),
    );
    t.diagnostic(JSON.stringify(budgets[0]));
  });
