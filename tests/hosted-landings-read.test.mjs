// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { moduleUrl } from './convex-module.mjs';
import { checkArgs } from './convex-args.mjs';

const api = await import(moduleUrl('../convex/projectHostedLandings.ts'));
const schema = (await import(moduleUrl('../convex/schema.ts'))).default;
const start = Date.parse('2026-11-05T21:00:00.000Z');
const minute = n => start + n * 60000;
const iso = ms => new Date(ms).toISOString();
const id = (kind, n) => `${kind}-${String(n).padStart(8, '0')}`;

/** Indexed ranges only: every query names a real index, equality fields in index order, and
 * the context has no insert, patch, scheduler or table scan. Reads are metered per document and byte. */
function fixture() {
  const tables = Object.fromEntries(Object.keys(schema.tables).map(table => [table, []]));
  const meter = { queries: 0, documents: 0 };
  tables.hostedProjects.push({ _id: 'project', _creationTime: 0, owner: 'owner', visibility: 'public' });
  const field = (row, key) => row[key];
  const ctx = {
    auth: { getUserIdentity: async () => ({ subject: 'owner' }) },
    db: {
      get: async key => tables.hostedProjects.find(row => row._id === key) ?? null,
      query: table => {
        meter.queries++;
        let selected,
          descending = false;
        const q = {
          withIndex(index, build) {
            const spec = schema.tables[table].export().indexes.find(row => row.indexDescriptor === index);
            assert(spec, `${table}.${index} is a real index`);
            let equality = 0;
            const predicates = [];
            const bounds = {
              eq(key, value) {
                assert.equal(key, spec.fields[equality++]);
                predicates.push(row => field(row, key) === value);
                return bounds;
              },
              gte(key, value) {
                assert.equal(key, [...spec.fields, '_creationTime'][equality]);
                predicates.push(row => field(row, key) >= value);
                return bounds;
              },
              lt(key, value) {
                assert.equal(key, [...spec.fields, '_creationTime'][equality]);
                predicates.push(row => field(row, key) < value);
                return bounds;
              },
            };
            build(bounds);
            const order = spec.fields.includes('number') ? 'number' : '_creationTime';
            selected = tables[table]
              .filter(row => predicates.every(p => p(row)))
              .sort((a, b) => a[order] - b[order]);
            return q;
          },
          order: direction => ((descending = direction === 'desc'), q),
          async take(n) {
            const rows = (descending ? selected.toReversed() : selected).slice(0, n);
            meter.documents += rows.length;
            return structuredClone(rows);
          },
          async first() {
            return (await q.take(1))[0] ?? null;
          },
          async unique() {
            assert(selected.length <= 1);
            return (await q.take(1))[0] ?? null;
          },
        };
        return q;
      },
    },
  };
  const put = (table, row, time = 0) =>
    tables[table].push({ ...row, _id: `${table}-${tables[table].length}`, _creationTime: time });
  const read = async (input = {}) => {
    const args = { projectId: 'project', from: iso(minute(0)), to: iso(minute(600)), ...input };
    checkArgs(api.read, args, 'projectHostedLandings:read');
    const raw = await api.read._handler(ctx, args);
    return { raw, ...JSON.parse(raw) };
  };
  /** One landed submission: attempts[i] = [number, mainReceipt, runId|null]. */
  const landing = (
    n,
    {
      at,
      base = 'R0',
      landedOn = base,
      attempts = [[1, base, `adm-${n}`]],
      admitted = true,
      pad = 0,
      revert,
    } = {},
  ) => {
    const sub = id('sub', n),
      intent = id('intent', n),
      lane = id('lane', n);
    put(
      'projectHostedLandingRequests',
      {
        projectId: 'project',
        channel: 'main',
        submissionId: sub,
        operationId: sub,
        actor: 'someone',
        sequence: n,
        runnable: false,
        phase: 'landed',
        runId: null,
        attemptId: sub,
        ...(revert ? { revertOf: revert } : {}),
        ...(admitted
          ? { admission: { runId: `adm-${n}`, status: 'passed', endedAt: minute(at - 20), full: true } }
          : {}),
        value: JSON.stringify({
          id: sub,
          at: iso(minute(at - 30)),
          timing: { submittedAt: iso(minute(at - 30)), committedAt: iso(minute(at)) },
          pad: 'x'.repeat(pad),
        }),
      },
      minute(at - 30),
    );
    for (const [number, receipt, runId] of attempts)
      put('projectHostedLandingAttempts', {
        projectId: 'project',
        submissionId: sub,
        attemptId: `${sub}-a${number}`,
        number,
        value: JSON.stringify({
          number,
          main: { head: `h-${receipt}`, receiptId: receipt },
          check: runId ? { runId } : null,
        }),
      });
    put('projectHostedFinishes', {
      projectId: 'project',
      submissionId: sub,
      composeOperationId: null,
      parentSubmissionId: null,
      waiting: false,
      wake: null,
      value: JSON.stringify({ source: { intentId: intent } }),
    });
    put('projectHostedRecordHeads', { projectId: 'project', kind: 'lane', key: lane, parent: intent });
    put(
      'projectHostedAcceptances',
      {
        projectId: 'project',
        receiptId: id('receipt', n),
        submissionId: sub,
        attemptId: `${sub}-a1`,
        sequence: n,
        value: JSON.stringify({
          id: id('receipt', n),
          at: iso(minute(at)),
          submissionId: sub,
          previous: { head: `h-${landedOn}`, receiptId: landedOn },
          candidate: { head: `landed-${n}` },
          check: { runId: `final-${n}` },
          ...(landedOn === base ? { firstCheck: { landedOn: 'admission-run', mainMoved: false } } : {}),
        }),
      },
      minute(at),
    );
  };
  return { tables, meter, read, landing };
}

test('landings: one row per landing with times, bases, main move, runs and recomposes', async () => {
  const f = fixture();
  f.landing(1, { at: 60 });
  f.landing(2, {
    at: 90,
    base: 'R0',
    landedOn: 'R1',
    attempts: [
      [1, 'R0', 'adm-2'],
      [2, 'R1', 'run-2b'],
    ],
  });
  f.landing(3, { at: 120, admitted: false, attempts: [[1, 'R1', null]], landedOn: 'R1', revert: 'x' });
  f.landing(4, { at: 700 }); // outside the window
  const page = await f.read();
  assert.equal(page.landings.length, 3);
  assert.equal(page.nextCursor, null);
  const [a, b, c] = page.landings;
  assert.deepEqual(
    {
      receiptId: a.receiptId,
      laneId: a.laneId,
      intentId: a.intentId,
      submittedAt: a.submittedAt,
      admittedAt: a.admittedAt,
      committedAt: a.committedAt,
    },
    {
      receiptId: id('receipt', 1),
      laneId: id('lane', 1),
      intentId: id('intent', 1),
      submittedAt: iso(minute(30)),
      admittedAt: iso(minute(40)),
      committedAt: iso(minute(60)),
    },
  );
  assert.deepEqual([a.admissionBase.receiptId, a.landedBase.receiptId, a.mainMoved], ['R0', 'R0', false]);
  assert.deepEqual(a.checkRunIds, ['adm-1', 'final-1']);
  assert.equal(a.recomposeCount, 0);
  assert.deepEqual(
    [b.admissionBase.receiptId, b.landedBase.receiptId, b.mainMoved, b.recomposeCount],
    ['R0', 'R1', true, 1],
  );
  assert.deepEqual(b.checkRunIds, ['adm-2', 'run-2b', 'final-2']);
  // Not stored today: the earlier generation's text-conflict paths. Never invented.
  assert.equal(b.conflictPaths, null);
  assert.equal(c.admittedAt, null, 'an unadmitted landing has no admission time');
  assert.equal(c.kind, 'compensating');
  assert.equal(b.firstCheck, null);
  assert.deepEqual(a.firstCheck, { landedOn: 'admission-run', mainMoved: false });
});

test('landings: pages resume exactly, stay under limit, and read nothing outside indexed ranges', async () => {
  const f = fixture();
  for (let n = 1; n <= 45; n++) f.landing(n, { at: n * 10 });
  const seen = [];
  let cursor,
    pages = 0;
  do {
    const before = f.meter.queries;
    const page = await f.read({ limit: 20, ...(cursor ? { cursor } : {}) });
    pages++;
    assert(Buffer.byteLength(page.raw) < 64 * 1024, 'page under 64 KB');
    assert(page.landings.length <= 20);
    // Receipt range, then request, attempts, finish and Lane per landing (plus the account lookup): no scans.
    assert(f.meter.queries - before <= 1 + page.landings.length * 4, `queries ${f.meter.queries - before}`);
    seen.push(...page.landings.map(row => row.receiptId));
    cursor = page.nextCursor;
  } while (cursor);
  assert.equal(pages, 3);
  assert.deepEqual(
    seen,
    Array.from({ length: 45 }, (_, i) => id('receipt', i + 1)),
    'every landing once, oldest first',
  );
});

test('landings: the read budget ends a page early and the cursor resumes at the next landing', async () => {
  const f = fixture();
  for (let n = 1; n <= 6; n++) f.landing(n, { at: n * 10, pad: 300 * 1024 });
  const first = await f.read({ limit: 30 });
  assert(first.landings.length >= 1 && first.landings.length < 6, `${first.landings.length}`);
  assert(first.nextCursor);
  const second = await f.read({ limit: 30, cursor: first.nextCursor });
  assert.equal(second.landings[0].receiptId, id('receipt', first.landings.length + 1));
});

test('landings: refuses a bad window, a foreign cursor and an over-limit page without reading', async () => {
  const f = fixture();
  f.landing(1, { at: 60 });
  await assert.rejects(f.read({ from: iso(minute(10)), to: iso(minute(5)) }), /finite window/);
  await assert.rejects(f.read({ cursor: String(minute(900)) }), /does not belong to this window/);
  const capped = await f.read({ limit: 1000 });
  assert(capped.landings.length <= 30);
});
