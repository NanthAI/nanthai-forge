// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { getFunctionName } from 'convex/server';
import { canonicalPayload } from '../dist/hosted-source-operation.js';
import { capsuleMaintenanceFixture as fixture } from './landing-capsule-maintenance-fixture.mjs';
import { moduleUrl } from './convex-module.mjs';
const backfill = await import(moduleUrl('../convex/projectLandingCapsuleBackfill.ts'));
const store = await import(moduleUrl('../convex/projectLandingCapsuleStore.ts'));
const index = await import(moduleUrl('../convex/projectLandingCapsuleIndex.ts'));

const packName = 'projectLandingCapsuleRun:pack';
const runName = 'projectLandingCapsuleBackfill:run';
/** A landing settled before the S1 writer was deployed: it has no pack wake. */
async function legacy(t) {
  const h = await fixture(t);
  for (const [id, row] of h.f.tables._scheduled_functions)
    if (row.name === packName) h.f.tables._scheduled_functions.delete(id);
  const call = (name, fn, args) => h.f.transaction(name, fn, args).then(JSON.parse);
  const runPage = args => call('capsuleBackfillRun', backfill.run, { projectId: h.f.projectId, ...args });
  const dryRun = args =>
    backfill.dryRun
      ._handler(
        {
          runQuery: (ref, queryArgs) => {
            assert.equal(getFunctionName(ref), 'projectLandingCapsuleBackfill:dryRunPage');
            return h.f.transaction('capsuleBackfillDryRun', backfill.dryRunPage, queryArgs);
          },
        },
        { projectId: h.f.projectId, ...args },
      )
      .then(JSON.parse);
  const tasks = name => [...h.f.tables._scheduled_functions.values()].filter(row => row.name === name);
  const packs = () => tasks(packName).filter(row => row.state.kind === 'pending');
  const chains = () => tasks(runName).filter(row => row.state.kind === 'pending');
  const snapshot = () =>
    canonicalPayload(
      Object.fromEntries(Object.entries(h.f.tables).map(([table, rows]) => [table, [...rows]])),
    );
  const meters = name => h.f.counts.filter(count => count.name === name);
  /** No scan or dry run reads a cold request body: every row here (and every `addOld` copy, which
   * shares the original's body and would fail its ownership check if hydrated) has one. */
  const noBodyReads = () => {
    for (const count of [...meters('capsuleBackfillRun'), ...meters('capsuleBackfillDryRun')])
      assert.equal(
        count.readDocumentsByTable.projectHostedLandingBodies ?? 0,
        0,
        JSON.stringify(count.readDocumentsByTable),
      );
  };
  const original = () =>
    [...h.f.tables.projectHostedLandingRequests.values()].find(r => r.submissionId === h.state.id);
  assert(original().requestBodyId, 'the fixture landing keeps a cold request body');
  /** Older requests with no history of their own: the scan reads only the request row. */
  const addOld = (count, edit = (row, state) => [row, state]) => {
    const ids = [];
    for (let n = 0; n < count; n++) {
      const { _id, _creationTime, ...copy } = original();
      const submissionId = `${h.state.id}-old-${ids.length}-${Math.random().toString(36).slice(2, 8)}`;
      const [row, state] = edit(
        { ...copy, submissionId, operationId: `old-${submissionId}` },
        JSON.parse(copy.value),
      );
      h.f.insert('projectHostedLandingRequests', { ...row, value: canonicalPayload(state) });
      ids.push(submissionId);
    }
    return ids;
  };
  return { h, runPage, dryRun, tasks, packs, chains, snapshot, meters, noBodyReads, addOld };
}

test('b149b16b backfill dry run counts the unpacked landing, its rows and calls, and writes nothing', async t => {
  const b = await legacy(t);
  const before = b.snapshot();
  const dry = await b.dryRun({});
  assert.equal(b.snapshot(), before, 'dry run wrote or scheduled nothing');
  assert.equal(dry.done, true);
  assert.equal(dry.cursor, null);
  assert.equal(dry.landings, 1);
  assert.equal(dry.scheduled, 1);
  assert.equal(dry.packed, 0);
  assert.equal(typeof dry.indexBuilt, 'boolean');
  assert(dry.candidateRows > 0 && dry.candidateBytes > 0, JSON.stringify(dry));
  assert(dry.estimatedPackCalls >= backfill.packCallsPerLanding);
  assert.equal(dry.estimatedScanCalls, 1);
  b.noBodyReads();
  t.diagnostic(JSON.stringify(dry));
});

test('b149b16b backfill dry run resumes from its returned cursor', async t => {
  const b = await legacy(t);
  b.addOld(backfill.dryRunPageRows + 1);
  const all = await b.dryRun({});
  const first = await b.dryRun({ maxPages: 1 });
  assert.equal(first.done, false);
  assert.equal(first.dryRunQueryCalls, 1);
  assert(first.cursor);
  const rest = await b.dryRun({ cursor: first.cursor });
  assert.equal(rest.done, true);
  assert.equal(rest.indexBuilt, null, 'a resumed dry run does not re-read the index row');
  assert.equal(first.scanned + rest.scanned, all.scanned);
  assert.equal(first.landings + rest.landings, all.landings);
  assert.equal(first.estimatedPackCalls + rest.estimatedPackCalls, all.estimatedPackCalls);
  b.noBodyReads();
});

test('b149b16b backfill packs a legacy landing through the verified packer; readers are byte-identical and a re-run writes nothing', async t => {
  const b = await legacy(t);
  const { h } = b;
  const landings = await import(moduleUrl('../convex/projectHostedLandings.ts'));
  const metrics = await import(moduleUrl('../convex/projectSelfMetrics.ts'));
  const window = {
    projectId: h.f.projectId,
    from: '1970-01-01T00:00:00.000Z',
    to: '2100-01-01T00:00:00.000Z',
  };
  const read = async () => ({
    landings: JSON.parse(await h.f.tx('capsuleLandingsParity', landings.read, window)),
    attempts: JSON.parse(
      await h.f.tx('capsuleAttemptMetricsParity', metrics.page, {
        ...window,
        stream: 'attempts',
        cursor: null,
      }),
    ),
    acceptances: JSON.parse(
      await h.f.tx('capsuleAcceptanceMetricsParity', metrics.page, {
        ...window,
        stream: 'acceptances',
        cursor: null,
      }),
    ),
  });
  const before = await read();
  const first = await b.runPage({});
  assert.equal(first.done, true);
  assert.equal(first.totals.scheduled, 1);
  const [wake] = b.packs();
  assert.equal(wake.args[0].submissionId, h.state.id);
  const packed = await h.packWith(wake.args[0]);
  assert(packed.pointer, JSON.stringify(packed));
  assert.equal(
    h.f.tables.projectHostedLandingAttempts.size,
    0,
    'canonical copies removed after verification',
  );
  assert(h.objects.has(packed.pointer.sha256));
  const after = await read();
  for (const value of [before.attempts, after.attempts]) if (value.isDone) value.continueCursor = null;
  assert.deepEqual(after, before);

  // Idempotent: a finished backfill writes nothing; a fresh pass and a repeat pack change nothing.
  h.f.tables._scheduled_functions.clear();
  h.f.advanceClock(60_000);
  const settled = b.snapshot();
  assert.equal((await b.runPage({})).unchanged, true);
  assert.equal(b.snapshot(), settled, 're-run of a finished backfill writes nothing');
  const again = await b.runPage({ restart: true });
  assert.equal(again.totals.packed, 1);
  assert.equal(b.packs().length, 0, 'a packed landing is never scheduled again');
  assert.equal((await h.packWith(wake.args[0])).replayed, true);
  assert.equal(h.requests.filter(method => method === 'PUT').length, 1);
  const dry = await b.dryRun({});
  assert.equal(dry.landings, 0);
  assert.equal(dry.packed, 1);
  assert.equal(dry.estimatedFromPacked.perLanding.rawBytes, packed.pointer.rawSize);
  b.noBodyReads();
});

test('b149b16b backfill resumes a real interrupted removal through the packer, without another capture or PUT', async t => {
  const b = await legacy(t);
  const { h } = b;
  // As in the writer's lost-removal test, but two 147 KB historical errors: publish removes the first
  // page, the lost response follows the second committed page, and a third page remains.
  const observed = [...h.f.tables.projectHostedLandingObservations.values()].filter(
    row => JSON.parse(row.value).transition,
  );
  assert(observed.length >= 2);
  for (const row of observed.slice(0, 2)) {
    const value = JSON.parse(row.value);
    value.transition.error = { code: 'SYNTHETIC_ERROR', message: randomBytes(110_000).toString('base64') };
    h.f.patch('projectHostedLandingObservations', row._id, { value: canonicalPayload(value) });
  }
  h.loseRemove();
  await assert.rejects(h.pack(), /Synthetic lost removal response/);
  const progress = () =>
    [...h.f.tables.projectFinishReadRows.values()].filter(
      row => row.kind === 'projectLandingCapsuleProgress',
    );
  assert.equal(progress().length, 1, 'the verified removal stopped part-way with its committed offset');
  const dry = await b.dryRun({});
  assert.equal(dry.resumed, 1);
  assert.equal(dry.scheduled, 0);
  assert(dry.resumeRows > 0);
  assert.equal(
    dry.estimatedPackCalls,
    1 + Math.ceil(dry.resumeRows / 64),
    'resume costs begin plus its removal pages',
  );
  const page = await b.runPage({});
  assert.equal(page.totals.resumed, 1);
  const [wake] = b.packs();
  const calls = h.calls.length;
  const result = await h.packWith(wake.args[0]);
  assert(JSON.parse(result.pointer.summary).removalDone);
  assert.equal(h.requests.filter(method => method === 'PUT').length, 1);
  assert(
    !h.calls.slice(calls).some(name => name.startsWith('projectLandingCapsuleCapture:page')),
    'no re-capture',
  );
  assert.equal(progress().length, 0, 'the removal finished from its stored offset');
  assert.equal((await b.dryRun({})).packed, 1);
});

test('b149b16b backfill skips active and in-grace landings and schedules a terminal-failed one past its grace', async t => {
  const b = await legacy(t);
  const now = Date.now();
  const [active] = b.addOld(1, (row, state) => [
    { ...row, phase: 'queued' },
    { ...state, phase: 'queued' },
  ]);
  const [young] = b.addOld(1, (row, state) => [
    row,
    { ...state, timing: { ...state.timing, settledAt: new Date(now - 60_000).toISOString() } },
  ]);
  const [failed] = b.addOld(1, (row, state) => [
    { ...row, phase: 'terminal-failed' },
    { ...state, phase: 'terminal-failed' },
  ]);
  const page = await b.runPage({});
  const scheduled = b.packs().map(row => row.args[0].submissionId);
  assert.deepEqual(scheduled.sort(), [b.h.state.id, failed].sort());
  assert(!scheduled.includes(active) && !scheduled.includes(young));
  assert.equal(page.totals.active, 1);
  assert.equal(page.totals.inGrace, 1);
  assert.equal(page.totals.scheduled, 2);
  b.noBodyReads();
});

test('b149b16b backfill pages are bounded and resume from the stored cursor; one chain survives restart and overlapping calls', async t => {
  const b = await legacy(t);
  const old = b.addOld(3);
  const order = [b.h.state.id, ...old];
  const scheduled = () => b.packs().map(row => row.args[0].submissionId);
  const page1 = await b.runPage({ limit: 1 });
  assert.equal(page1.done, false);
  assert.equal(page1.generation, 1);
  assert.deepEqual(scheduled(), order.slice(0, 1));
  for (const count of b.meters('capsuleBackfillRun'))
    assert.equal(
      count.readDocumentsByTable.projectHostedLandingRequests,
      1,
      'one request per page at limit 1',
    );
  // An overlapping operator call (or a retried CLI call) while this page's packs start writes nothing.
  const overlap = b.snapshot();
  const busy = await b.runPage({ limit: 1 });
  assert.equal(busy.busy, true);
  assert(busy.retryAfterMs > 0);
  assert.equal(b.snapshot(), overlap);
  // Crash, then a fresh operator call after the window: it resumes after the committed page.
  b.h.f.advanceClock(busy.retryAfterMs);
  const page2 = await b.runPage({ limit: 1, pages: 3 });
  assert.equal(page2.generation, 2);
  assert.deepEqual(scheduled(), order.slice(0, 2));
  assert.equal(b.chains().length, 1);
  const pendingChain = b.chains()[0];
  assert.equal(pendingChain.args[0].from, page2.cursor);
  assert.equal(pendingChain.args[0].generation, 2);
  assert.equal(pendingChain._id, page2.nextTaskId);
  // While that chain is pending, a plain operator call is refused, not a second chain.
  b.h.f.advanceClock(60_000);
  assert.equal((await b.runPage({ limit: 1 })).busy, true);
  // Restart while the chain is pending: it is cancelled and its generation retired, even though a
  // fresh pass reaches the identical cursor.
  // Two rows in one page reach exactly the cursor the old chain holds (Gemini bb1ec126 scenario).
  const restart = await b.runPage({ limit: 2, pages: 2, restart: true });
  assert.equal(restart.generation, 3);
  assert.equal(restart.cursor, pendingChain.args[0].from, 'the fresh pass holds the old chain cursor');
  assert.equal(b.h.f.tables._scheduled_functions.get(pendingChain._id).state.kind, 'canceled');
  const stale = b.snapshot();
  assert.equal((await b.runPage(pendingChain.args[0])).stale, true, 'the old chain stops at its first page');
  assert.equal(b.snapshot(), stale);
  assert.equal(b.chains().length, 1);
  // The surviving chain finishes the pass; it schedules only the landings the old pass had not reached.
  for (let guard = 0; b.chains().length && guard < 10; guard++) {
    const [next] = b.chains();
    b.h.f.patch('_scheduled_functions', next._id, { state: { kind: 'success' } });
    await b.runPage({ ...next.args[0], pages: 4 });
  }
  const last = JSON.parse(
    [...b.h.f.tables.projectFinishReadRows.values()].find(row => row.kind === backfill.capsuleBackfillKind)
      .value,
  );
  assert.equal(last.done, true);
  assert.equal(b.chains().length, 0, 'a finished chain schedules no further page');
  for (const id of order) assert(scheduled().includes(id), id);
  // The restart pass re-schedules page 1-2 landings that are still unpacked (packing is idempotent).
  assert.equal(scheduled().length, order.length + 2);
  const starts = b
    .packs()
    .map(row => row.scheduledTime)
    .sort((x, y) => x - y);
  for (let n = 1; n < starts.length; n++)
    assert(starts[n] - starts[n - 1] >= backfill.backfillStaggerMs, 'packs never start together');
  for (const count of b.meters('capsuleBackfillRun'))
    assert(
      count.documents <= 2 * 2 + 8 * 2 + 4,
      `a limit-1 or limit-2 page reads ${count.documents} documents`,
    );
  b.noBodyReads();
});

test('b149b16b backfill builds an unbuilt capsule index before it schedules any pack', async t => {
  const b = await legacy(t);
  const { h } = b;
  for (const [id, row] of h.f.tables.projectFinishReadRows)
    if (row.kind === index.capsuleIndexKind) h.f.tables.projectFinishReadRows.delete(id);
  // More attempt rows than one call's bootstrap pages cover (4 per page).
  const attempt = [...h.f.tables.projectHostedLandingAttempts.values()][0];
  for (let n = 0; n < 4 * backfill.backfillIndexPages + 1; n++) {
    const { _id, _creationTime, ...copy } = attempt;
    h.f.insert('projectHostedLandingAttempts', { ...copy, submissionId: `index-filler-${n}` });
  }
  const first = await b.runPage({});
  assert.equal(first.indexing, true);
  assert.equal(b.packs().length, 0, 'no pack races the unbuilt index');
  assert.equal(b.chains().length, 1);
  const [next] = b.chains();
  assert.equal(next.scheduledTime, Date.now());
  assert.equal(next.args[0].from, null);
  h.f.patch('_scheduled_functions', next._id, { state: { kind: 'success' } });
  const second = await b.runPage(next.args[0]);
  assert.equal(second.done, true);
  assert.equal(b.packs().length, 1);
  const built = [...h.f.tables.projectFinishReadRows.values()].find(
    row => row.kind === index.capsuleIndexKind,
  );
  assert.equal(JSON.parse(built.value).done, true);
});

test('b149b16b backfill dry-run page stops at its byte bound and marks the count partial', async t => {
  const b = await legacy(t);
  const added = b.h.inflate(2 * 1024 * 1024);
  assert(added > backfill.dryRunPageBytes, `inflated ${added}`);
  const dry = await b.dryRun({});
  assert.equal(dry.partialPages, 1);
  const [count] = b.meters('capsuleBackfillDryRun');
  // The byte stop plus at most one inflated row (each about 300 KiB here) and the small request page.
  assert(count.readBytes < backfill.dryRunPageBytes + 384 * 1024, `read ${count.readBytes} bytes`);
  assert(count.readBytes < added, 'the page did not read the whole inflated history');
  assert(count.documents < 4096);
});

test('b149b16b shared classification keeps begin and the read-through rules', () => {
  const at = '2026-01-01T00:00:00.000Z';
  const settled = Date.parse(at);
  assert.equal(store.landingCapsuleDueAt({ at }), settled + 7 * 86_400_000);
  assert.equal(
    store.landingCapsuleDueAt({ at, timing: { settledAt: '2026-01-02T00:00:00.000Z' } }),
    settled + 8 * 86_400_000,
  );
  assert.equal(store.landingCapsuleInGrace({ at }, settled + 1), true);
  assert.equal(store.landingCapsuleInGrace({ at }, settled + 7 * 86_400_000), false);
  assert.equal(
    store.landingCapsuleInGrace({ at: 'not a time' }, settled),
    false,
    'unchanged: never inside the grace',
  );
  assert.deepEqual(
    ['queued', 'checking', 'ready', 'terminal-failed', 'landed'].map(store.isCapsuleTerminal),
    [false, false, false, true, true],
  );
});
