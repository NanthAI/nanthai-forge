// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// Cost guard on change (Issue 3e3f9fe6): the landing check runs a scripted landing mix on the
// in-process Convex fixture and judges each per-landing count against the ledger in
// src/speed-budgets.json (`costs`). Deterministic counts, not live billing: a change that adds work
// per landing fails here, a saving asks the author to ratchet the ledger down.
import { assertCommandWeight } from '../scripts/agent-weight.mjs';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { compactDiscardedChecks } from './landing-ticket-fixture.mjs';
import { randomUUID } from 'node:crypto';
import {
  indexEntriesPerWrite,
  indexStorage,
  measureIndexExportClaims,
  metricAliasIndexStorage,
} from './convex-index-cost.mjs';
const indexSchema = (await import(moduleUrl('../convex/schema.ts'))).default;
import { storageClock as fixedClock } from './storage-clock.mjs';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { inboundCostFixture } from './hosted-github-inbound-cost-fixture.mjs';
import { finishFixture, desired, isFinishWake } from './hosted-finish-fixture.mjs';
import { acceptanceFixture } from './hosted-acceptance-fixture.mjs';
import { seedFullMain, passWithSelection } from './hosted-race-fixture.mjs';
import { batchesFixture, states, synthetic } from './hosted-landing-batches-fixture.mjs';
import { moduleUrl } from './convex-module.mjs';
import { state as databaseFixture } from './hosted-fixture.mjs';
import { canonicalPayload } from '../dist/hosted-source-operation.js';
import { metricRunRow } from '../dist/self-metrics-run.js';
import {
  inflateDogfoodChecks,
  landingStorage,
  fixedProjectStorage,
  assertFixedProjectStorage,
  storageBudgets,
} from './landing-storage-fixture.mjs';
import { speedBudgets } from '../dist/speed-budgets.js';
import { addGuardFailure, ranEvidence } from '../dist/preflight-guard-learning.js';
import { formatCostVerdicts, judgeCost, judgeCosts } from '../dist/cost-budgets.js';
import { captureWriteSites, reportWriteSites } from './landing-cost-write-sites.mjs';

const prior = Object.fromEntries(Object.keys(synthetic).map(k => [k, process.env[k]]));
test.beforeEach(t => {
  Object.assign(process.env, synthetic);
  fixedClock(t);
});
test.after(() => {
  for (const [key, value] of Object.entries(prior)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

const { costs, costGuard } = speedBudgets;
const { guardReportFoldOrders } = await import('./hosted-report-fold-guard.mjs');
test(
  'S3 event-order and replay cost: uploader, webhook and confirmation ingest once per run',
  guardReportFoldOrders,
);
const finishApi = await import(moduleUrl('../convex/projectHostedFinish.ts'));
const { landingRequestBodies } = await import(moduleUrl('../convex/projectLandingRequestBody.ts'));
const observe = await import(moduleUrl('../convex/projectHostedFinishObserve.ts'));
// Action or not, and which runtime, from the registered function and its module's 'use node'.
const kinds = new Map();
async function kind(name) {
  if (kinds.has(name)) return kinds.get(name);
  const [file, method] = name.split(':');
  const path = new URL(`../convex/${file}.ts`, import.meta.url);
  let value = null;
  if (existsSync(path) && (await import(moduleUrl(`../convex/${file}.ts`)))[method]?.isAction)
    value = /^'use node';$/m.test(readFileSync(path, 'utf8').slice(0, 200)) ? 'node' : 'v8';
  kinds.set(name, value);
  return value;
}
const SOURCE = /^(projectConvexSource|projectHostedResolveChain:run)/;

test('S3 phase transitions write only the ticket; cold bytes fall by the measured S0 indexed-patch fit', async t => {
  // S0: tests/fixtures/indexed-patch-usage.json, document bytes +181+128 per custom index.
  // This predicts execution I/O from fixture documents; it is not a billed S3 measurement.
  const fittedWrite = (row, indexes) => Buffer.byteLength(JSON.stringify(row)) + 181 + 128 * indexes;
  for (const size of [1024, 27648]) {
    const f = databaseFixture([]);
    const ctx = landingRequestBodies(f.ctx);
    const request = { channel: 'main', message: 'x'.repeat(size) };
    const value = {
      projectId: 'project',
      channel: 'main',
      submissionId: 'submission',
      operationId: 'operation',
      actor: 'owner',
      sequence: 1,
      runnable: true,
      phase: 'queued',
      runId: null,
      attemptId: 'attempt',
      batchSelection: canonicalPayload({ files: ['synthetic/path.ts'] }),
      value: canonicalPayload({ id: 'submission', phase: 'queued', request }),
    };
    const id = await ctx.db.insert('projectHostedLandingRequests', value);
    const bodies = structuredClone([...f.tables.projectHostedLandingBodies]);
    let bodyWrites = 0;
    for (const method of ['insert', 'patch', 'replace', 'delete']) {
      const original = f.ctx.db[method];
      f.ctx.db[method] = (...args) => {
        if (
          method === 'insert'
            ? args[0] === 'projectHostedLandingBodies'
            : f.tables.projectHostedLandingBodies.has(args[0])
        )
          bodyWrites++;
        return original(...args);
      };
    }
    const logical = await ctx.db.get(id);
    await ctx.db.patch(id, {
      phase: 'checking',
      value: canonicalPayload({ ...JSON.parse(logical.value), phase: 'checking' }),
    });
    assert.equal(
      bodyWrites,
      0,
      'phase changes issue no cold-body write, including a redundant same-value patch',
    );
    const header = f.tables.projectHostedLandingRequests.get(id);
    assert.deepEqual(
      [...f.tables.projectHostedLandingBodies],
      bodies,
      'a phase change never rewrites either cold body',
    );
    const { requestBodyId, selectionBodyId, ...sameIdentity } = header;
    const legacy = {
      ...sameIdentity,
      batchSelection: value.batchSelection,
      value: canonicalPayload({ ...JSON.parse(header.value), request }),
    };
    const indexes = indexEntriesPerWrite(indexSchema, 'projectHostedLandingRequests');
    const before = fittedWrite(legacy, indexes),
      after = fittedWrite(header, indexes);
    assert(after < before, 'every ticket index operates on the smaller header');
    assert(before - after > size - 256, 'cold request bytes do not return on a phase write');
    assert.deepEqual(JSON.parse((await ctx.db.get(id)).value).request, request);
    t.diagnostic(
      JSON.stringify({
        requestBytes: size,
        predictedBefore: before,
        predictedAfter: after,
        predictedReduction: before - after,
        bodyWritesPerPhase: bodyWrites,
        additionalFunctionCalls: 0,
      }),
    );
  }
});

test('S3 report callbacks retain only a nine-index header and never touch report rows', async t => {
  const { checksFixture } = await import('./hosted-checks-fixture.mjs');
  const { checkReportHeader, checkReportPointer } = await import('../dist/check-file-summary.js');
  const { useObjectReports, storeCheckReports } = await import(
    moduleUrl('../convex/projectHostedCheckReports.ts')
  );
  const f = await checksFixture();
  const original = await f.activate((await f.enqueue(f.selection())).id, 1);
  const fittedWrite = row => Buffer.byteLength(JSON.stringify(row)) + 181 + 128 * 9;
  for (const failed of [false, true]) {
    const reports = Object.fromEntries(
      Array.from({ length: 20000 }, (_, i) => [
        `tests/synthetic-${i}.test.mjs`,
        { failed, durationMs: i, ...(failed ? { firstError: 'synthetic failure' } : {}) },
      ]),
    );
    const run = { ...structuredClone(original), contractReports: reports };
    run.reportPointer = checkReportPointer(reports);
    checkReportHeader(run, 7 * 1024);
    useObjectReports(run);
    // Any report-table read/write here is a failure: callback metadata needs no database I/O.
    const metadata = await storeCheckReports(
      {
        db: new Proxy(
          {},
          {
            get() {
              throw new Error('R2 report callback attempted database I/O');
            },
          },
        ),
      },
      run,
    );
    const { contractReports, ...header } = run;
    const stored = { ...metadata, value: canonicalPayload(header) };
    const legacy = { value: canonicalPayload({ ...original, contractReports }) };
    assert.equal(metadata.reportStorage, 'r2');
    assert(Buffer.byteLength(JSON.stringify(stored)) < 12 * 1024);
    assert(Buffer.byteLength(JSON.stringify(header.testFiles)) <= 8 * 1024);
    assert.equal(header.testFiles.counts.total, 20000);
    assert.equal(header.testFiles.counts.failed, failed ? 20000 : 0);
    assert(fittedWrite(stored) < fittedWrite(legacy));
    t.diagnostic(
      JSON.stringify({
        failed,
        predictedBefore: fittedWrite(legacy),
        predictedAfter: fittedWrite(stored),
        reportRowOperations: 0,
        additionalFunctionCalls: 0,
      }),
    );
  }
});

/** Counts every Convex execution and R2 request from now on: metered transactions (queries and
 * mutations), action executions (scheduled and nested), R2 requests by class and bytes put. */
function meter(
  f,
  {
    extraShard = false,
    extraSetupSeconds = 0,
    extraR2Read = false,
    checksumEcho = false,
    traceWrites = false,
  } = {},
) {
  const writeSites = traceWrites ? captureWriteSites(f) : undefined;
  // Signed synthetic runner usage, including job-side setup, makes shard fanout visible even
  // when the number of check runs is unchanged. No wall-clock measurement or real sleep.
  if (extraShard) f.rawChecks.setPlanOverrides({ shardCount: 3 });
  f.rawChecks.pass = async run => {
    for (let index = 0; index < run.plan.shardCount; index++)
      await f.rawChecks.callback(
        f.rawChecks.shard(run, index, 'passed', {
          execution: {
            startedAt: '2026-01-01T00:00:00.000Z',
            endedAt: new Date(Date.UTC(2026, 0, 1) + (120 + extraSetupSeconds) * 1000).toISOString(),
            seconds: 120 + extraSetupSeconds,
          },
        }),
      );
    return f.rawChecks.callback(f.rawChecks.complete(run));
  };
  const candidatesBefore = new Set(f.tables.projectHostedRecords.keys());
  const from = f.counts.length,
    sourceFrom = f.metrics.convexSourceCalls.length,
    reuseFrom = f.reuseDecisions?.length ?? 0,
    tasks = [],
    r2 = { a: 0, b: 0, bytesPut: 0 },
    inner = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (new URL(url).hostname === 'api.github.com') return inner(url, init);
    // R2 class A: PUT (and LIST); class B: GET and HEAD.
    if (init?.method === 'PUT') {
      r2.a++;
      r2.bytesPut += Buffer.byteLength(init.body);
    } else r2.b++;
    const response = await inner(url, init);
    if (extraR2Read && (!init?.method || init.method === 'GET')) {
      extraR2Read = false;
      r2.b++;
      const repeated = await inner(url, init);
      assert(repeated.ok, 'the seeded extra R2 read executes successfully');
      await repeated.body?.cancel();
    }
    // The legacy fixture omits the checksum acknowledgement. Exercise both the
    // supported no-echo fallback and exact successful-PUT acknowledgement.
    if (checksumEcho && init?.method === 'PUT' && response.status === 200) {
      const headers = new Headers(response.headers);
      headers.set('x-amz-checksum-sha256', init.headers['x-amz-checksum-sha256']);
      return new Response(response.body, { status: response.status, headers });
    }
    return response;
  };
  return {
    tasks,
    async stop() {
      globalThis.fetch = inner;
      for (const row of f.tables.projectHostedRecords.values())
        if (
          !candidatesBefore.has(row._id) &&
          row.kind === 'candidate' &&
          JSON.parse(row.inline ?? f.tables.projectHostedRecordBodies.get(row.bodyId).value).result.status ===
            'clean'
        )
          assert(row.candidateFiles, 'every clean Candidate producer pins its source listing');
      const allCounts = f.counts.slice(from);
      const exports = allCounts.filter(c => c.name === 'fixtureIndexExportClaim');
      const counts = allCounts.filter(c => c.name !== 'fixtureIndexExportClaim');
      const observers = counts.filter(c => c.name === 'observerBudgetPage');
      const reuseCapture = {};
      for (const count of counts) {
        const family =
          count.name === 'projectConvexSourceStore:commit'
            ? 'sourceCommit'
            : count.name === 'observerBudgetPage'
              ? 'observer'
              : ['finishStep', 'finishResume', 'finishDependents', 'batch-step', 'batch-resume'].includes(
                    count.name,
                  )
                ? 'finishController'
                : /^finish(?!Source)/.test(count.name)
                  ? 'finishOther'
                  : null;
        if (!family) continue;
        const capture = (reuseCapture[family] ??= {
          calls: 0,
          reads: 0,
          bytes: 0,
          writes: 0,
          writeBytes: 0,
          duplicateReads: 0,
          duplicateBytes: 0,
          tables: {},
        });
        capture.calls++;
        capture.reads += count.documents;
        capture.bytes += count.readBytes;
        capture.writes += count.writes;
        capture.writeBytes += count.writeBytes;
        capture.duplicateReads += Object.values(count.duplicateReadDocumentsByTable).reduce(
          (n, v) => n + v,
          0,
        );
        capture.duplicateBytes += Object.values(count.duplicateReadBytesByTable).reduce((n, v) => n + v, 0);
        for (const [table, value] of Object.entries(count.duplicateReadBytesByTable))
          capture.tables[table] = (capture.tables[table] ?? 0) + value;
      }

      const sum = key => counts.reduce((total, c) => total + c[key], 0);
      // Source tasks record themselves in convexSourceCalls with their nested actions.
      const actions = [
        ...tasks.filter(name => !SOURCE.test(name)),
        ...f.metrics.convexSourceCalls.slice(sourceFrom),
      ];
      const runtimes = await Promise.all(actions.map(kind));
      return {
        reuseCapture,
        metricAliasWrites: sum('metricAliasWrites'),
        metricAliasReadRanges: counts.reduce((n, c) => n + (c.readRangesByTable.projectMetricFacts ?? 0), 0),
        writeRounds: sum('writeRounds'),
        canonicalWriteRounds: sum('canonicalWriteRounds'),
        readDocuments: sum('documents'),
        dataRecordCalls: counts.filter(c => c.touched.includes('projectWorkDataRecords')).length,
        queries: counts.filter(c => c.query && c.name !== 'observerBudgetPage').length,
        observerQueries: observers.length,
        observerReadBytes: observers.reduce((n, c) => n + c.readBytes, 0),
        mutations: counts.filter(c => !c.query).length,
        v8Actions: runtimes.filter(r => r === 'v8').length + (f.reuseDecisions?.length ?? 0) - reuseFrom,
        nodeActions: runtimes.filter(r => r === 'node').length,
        readBytes: sum('readBytes') - observers.reduce((n, c) => n + c.readBytes, 0),
        readBytesByTable: counts.reduce((tables, c) => {
          for (const [table, bytes] of Object.entries(c.readBytesByTable ?? {}))
            tables[table] = (tables[table] ?? 0) + bytes;
          return tables;
        }, {}),
        writeBytes: sum('writeBytes'),
        writeSites,
        feed: {
          events: f.tables.projectFeedEvents.size,
          arrivalIndexes: indexStorage(
            indexSchema,
            { projectFeedEvents: f.tables.projectFeedEvents },
            index => index.indexDescriptor.endsWith('_commit_ts_and_id'),
          ),
          commitFieldBytes: [...f.tables.projectFeedEvents.values()].reduce(
            (bytes, row) => bytes + Buffer.byteLength(JSON.stringify({ commitTs: String(row.commitTs) })) - 1,
            0,
          ),
          readBytes: counts.reduce((n, c) => n + (c.readBytesByTable.projectFeedEvents ?? 0), 0),
          writeBytes: counts.reduce((n, c) => n + (c.writeBytesByTable.projectFeedEvents ?? 0), 0),
          expiryProbes: counts.reduce((n, c) => n + (c.readRangesByTable.projectFeedEvents ?? 0), 0),
          acceptanceReadBytes: counts.reduce(
            (n, c) =>
              n +
              (c.written.includes('projectFeedEvents')
                ? (c.readBytesByTable.projectHostedAcceptancePages ?? 0)
                : 0),
            0,
          ),
        },
        indexEntriesWritten: sum('indexEntriesWritten'),
        indexEntriesRemoved: sum('indexEntriesRemoved'),
        exportIndexEntriesWritten: exports.reduce((n, c) => n + c.indexEntriesWritten, 0),
        exportClaims: exports.length,
        storedIndexes: indexStorage(indexSchema, f.tables),
        storedMetricAliases: metricAliasIndexStorage(indexSchema, f.tables),
        r2ClassA: r2.a,
        r2ClassB: r2.b,
        r2BytesPut: r2.bytesPut,
        // Whole-row reads of main's path history (Issue 750c5929: 140 KB on Forge, read only by the
        // acceptance write that moves it; landing names and Lanes behind main use the per-landing log).
        mainHistoryReads: counts.reduce(
          (total, c) => total + (c.readDocumentsByTable?.projectHostedOverlapMain ?? 0),
          0,
        ),
      };
    },
  };
}
async function run(f, m, task) {
  m.tasks.push(task.name);
  await f.execute(task);
  await m.refresh?.();
}
/** Convex subscriptions rerun only after a selected read dependency changes. Use the same fake
 * read sets as the observer contract tests; no timer, polling, or forced per-task query. */
function watch(f, m, operationId) {
  let reads,
    version = 0;
  m.refresh = async () => {
    if (reads?.()) return;
    const page = JSON.parse(
      await f.tx('observerBudgetPage', observe.page, {
        projectId: f.projectId,
        operationId,
        nextVersion: version,
      }),
    );
    reads = f.readSet();
    version = page.nextVersion;
  };
  return m.refresh();
}
async function drain(f, m) {
  for (let steps = 0; f.pending().length; steps++) {
    assert(steps < 200, 'finite landing work');
    await run(f, m, f.pending()[0]);
  }
}
/** The cost counts each landed state carries (state.counts): what the live budgets are judged on. */
const stamped = f =>
  [...f.tables.projectHostedLandingRequests.values()].map(r => JSON.parse(r.value).counts ?? null);
const runs = f => [...f.tables.projectHostedCheckRuns.values()].map(r => JSON.parse(r.value));
const runnerMinutes = f =>
  [...f.tables.projectHostedCheckShards.values()].reduce((sum, row) => {
    const shard = JSON.parse(row.value);
    assert(shard.execution, 'every completed fixture shard retains signed runner seconds');
    return sum + shard.execution.seconds / 60;
  }, 0);
function assertRunMetrics(f) {
  for (const row of f.tables.projectHostedCheckRuns.values()) {
    const projection = [...f.tables.projectFinishReadRows.values()].find(
      p => p.kind === 'projectMetricCheckRuns' && p.sourceId === row._id,
    );
    assert(projection, 'every landed run has its metric row from the existing mutation');
    assert.equal(row.metricsProjected, true);
    assert.deepEqual(JSON.parse(projection.value), metricRunRow(JSON.parse(row.value), undefined, row.cause));
  }
}

const landed = f =>
  [...f.tables.projectHostedLandingRequests.values()].filter(r => JSON.parse(r.value).phase === 'landed')
    .length;

/** Review ff347162 finding 3: a project's person-order rows as they stand before its first landing in an hour: the
 * owner plus 150 members (over one 100-row touch run, so the continuation is metered too), all at an older hour. */
const ORDER_MEMBERS = 150;
function seedOrder(f) {
  const owner = f.tables.hostedProjects.get(f.projectId).owner;
  const people = [
    { person: owner, role: 'owner' },
    ...Array.from({ length: ORDER_MEMBERS }, (_, i) => ({ person: `member-${i}`, role: 'write' })),
  ];
  for (const [i, row] of people.entries())
    f.tables.accountProjectOrder.set(`order-${i}`, {
      _id: `order-${i}`,
      _creationTime: 1,
      projectId: f.projectId,
      activityHour: 0,
      ...row,
    });
}

async function resubmissionJourney(t, mode, failedSeconds) {
  Object.assign(process.env, synthetic);
  fixedClock(t);
  const f = await batchesFixture(t, { count: 0, batching: false });
  f.wallClockTables.add('projectHostedAcceptances');
  f.advanceClock(Date.UTC(2026, 10, 10, 23) - Date.now());
  const m = meter(f);
  // The result fold supplies this run-header aggregate; the legacy callback fixture only stores shards.
  const stamp = (run, seconds) => {
    const row = [...f.tables.projectHostedCheckRuns.values()].find(r => JSON.parse(r.value).id === run.id);
    f.patch('projectHostedCheckRuns', row._id, {
      value: JSON.stringify({
        ...JSON.parse(row.value),
        execution: { seconds, shards: run.plan.shardCount },
      }),
    });
  };
  const pass = f.rawChecks.pass;
  f.rawChecks.pass = async run => {
    const result = await pass(run);
    stamp(run, 240);
    return result;
  };
  const original = f.request({ agent: true });
  const base =
    mode === 'direct'
      ? original
      : {
          operationId: original.operationId,
          authorityEpoch: 1,
          composeOperationId: f.selection.request.operationId,
          after: null,
          check: original.check,
        };
  const send = command =>
    mode === 'direct'
      ? f.enqueue(command)
      : f
          .tx('desiredSubmit', desired.submit, {
            projectId: f.projectId,
            request: JSON.stringify(command),
          })
          .then(JSON.parse);
  let command = base;
  let state = await send(command);
  for (let attempt = 0; attempt < 2; attempt++) {
    await drain(f, m);
    const queued = runs(f).filter(r => r.status === 'queued');
    assert.equal(queued.length, 1, JSON.stringify({ mode, attempt, states: states(f), runs: runs(f) }));
    const run = await f.rawChecks.activate(queued[0].id);
    for (let i = 0; i < run.plan.shardCount; i++)
      await f.rawChecks.callback(
        f.rawChecks.shard(run, i, i === 0 ? 'failed' : 'passed', {
          execution: {
            startedAt: '2026-01-01T00:00:00.000Z',
            endedAt: '2026-01-01T00:02:00.000Z',
            seconds: failedSeconds / run.plan.shardCount,
          },
        }),
      );
    stamp(run, failedSeconds);
    await f.rawChecks.callback(
      f.rawChecks.complete(run, 'failed', {
        contractReports: {
          'tests/resubmitted.test.mjs': { failed: true, durationMs: 1, firstError: 'Synthetic failure' },
        },
      }),
    );
    await drain(f, m);
    assert.equal(states(f).find(s => s.id === state.id).phase, 'terminal-failed');
    if (attempt === 1) f.advanceClock(Date.UTC(2026, 10, 10, 23, 59, 50) - Date.now());
    command = { ...base, operationId: randomUUID() };
    state = await send(command);
    assert.equal((await send(command)).id, state.id, 'replay retains the same successor');
    assert.equal(
      (await send({ ...command, operationId: randomUUID() })).id,
      state.id,
      'a live alias joins without adding the predecessor again',
    );
  }
  await drain(f, m);
  assert.equal(state.at.slice(0, 10), '2026-11-10', 'the successor starts before midnight');
  f.advanceClock(Math.max(0, Date.UTC(2026, 10, 11, 0, 1) - Date.now()));
  await f.passChecks();
  await drain(f, m);
  assert.equal(states(f).find(s => s.id === state.id).phase, 'landed');
  const receipt = [...f.tables.projectHostedAcceptances.values()][0];
  assert.equal(
    new Date(receipt._creationTime).toISOString().slice(0, 10),
    '2026-11-11',
    'acceptance crosses midnight',
  );
  f.advanceClock(Date.UTC(2026, 10, 12, 0, 1) - Date.now());
  await f.add(1);
  for (let step = 0; f.pending().length; step++) {
    assert(step < 100, 'the next day landing and close settle');
    await f.passChecks();
    await run(f, m, f.pending()[0]);
  }
  const measured = await m.stop();
  const days = [...f.tables.projectStatsDays.values()].map(row => JSON.parse(row.value));
  const acceptedDay = days.filter(day => day.day === '2026-11-11');
  assert.equal(acceptedDay.length, 1, 'the successor accepted day closes once');
  const [closed] = acceptedDay;
  const closes = f.counts.filter(c => c.name === 'statsClose');

  assert(closes.length <= 2, 'at most one existing close for each crossed active day');
  // A person's day (Item 6a251b23) adds, once per project-day and never per landing: that day's Lanes (one read each)
  // and one read and one write per person active that day, plus one range of the day's Work change rows (planning
  // closes and comments; empty here, billed as one read), and on a first close (its window reaches past the 14 days of
  // change rows Convex keeps) one project read; when that project is older than those 14 days (this fixture's clock
  // starts at 1970) the close is partial and reads the project's writers once to mark them (an empty range here).
  // Here: one person, one Lane started on the closed day.
  const people = new Set([...f.tables.personDays.values()].map(row => row.person)).size;
  assert.equal(people, 1, 'one person landed here');
  // Every check run (Item a61d3c91, review 1240fe03 finding 5): the compact run rows of the day and the run rows not
  // projected yet (one range each, and one empty page that projects legacy ones first), the project's compact attempt index and the attempt rows around the day (one
  // range), and the newest earlier submissions of the landing's Intent until one landed or failed (at most
  // STATS_RESUBMIT_LOOKBACK; here the newest failed, so one). An empty range bills as one document.
  const statsRuns = { projectFinishReadRows: 2, projectHostedCheckRuns: 1, projectHostedLandingAttempts: 1 };
  for (const close of closes) {
    const docs = close.readDocumentsByTable;
    assert(
      // + 2: the project row and its newest policy receipt, for the merge-queue replay's width; + 1: the empty page
      // that projects the day's legacy run rows first (Item 3678767e).
      close.documents <= 6 + 2 + 1 + people + 1 + 1 + 1 + 1 + 4 + 2 && close.readBytes < 16_000,
      `the close reads receipt and ticket/body pages, the Lanes (open and closed), the person row, the change range, the project and its writers, one earlier submission and the day's runs: ${JSON.stringify(docs)}`,
    );
    assert.equal(
      docs.projectHostedLandingRequests,
      1 + 1,
      'the ticket and one earlier same-Intent submission',
    );
    for (const [table, n] of Object.entries(statsRuns)) {
      // The run rows not projected yet: the close's own range, and (a close that starts the day) the empty page that
      // projects legacy ones first (Item 3678767e).
      if (table === 'projectHostedCheckRuns') assert([n, n + 1].includes(docs[table] ?? 0), table);
      else assert.equal(docs[table] ?? 0, n, table);
    }
    assert((docs.projectPolicyChanges ?? 0) <= 1, 'at most one policy receipt for the replay width');
    assert.equal(close.writes, 1 + people);
  }
  assert.equal(closed.landings, 1);
  assert.deepEqual(closed.runner, {
    priced: 1,
    unknown: 0,
    acceptedSeconds: 240,
    discardedSeconds: 2 * failedSeconds,
  });
  assert.equal(
    days.reduce((sum, day) => sum + day.runner.discardedSeconds, 0),
    2 * failedSeconds,
    'pre-midnight failures are charged only once, to the successor accepted day',
  );
  assert.deepEqual(closed.firstTry, { counted: 1, first: 0 });
  // Finish the one hour close armed by the next-day landing before measuring a day without work.
  const hourly = [...f.tables._scheduled_functions.values()].filter(
    task =>
      task.state.kind === 'pending' && task.name === 'projectStats:closeDay' && task.args[0].provisional,
  );
  assert.equal(hourly.length, 1);
  const beforeHourly = f.counts.length;
  await f.execute(hourly[0]);
  assert.deepEqual(
    f.counts.slice(beforeHourly).map(call => call.name),
    ['statsClose'],
  );
  const idle = f.counts.length;
  f.advanceClock(86_400_000);
  await drain(f, m);
  assert.equal(f.counts.length, idle, 'a day idle makes no Convex call');
  return measured;
}

for (const mode of ['direct', 'desired']) {
  test(`resubmitted ${mode} landing carries lost checks across UTC midnight into its accepted day`, async t => {
    let control, measured;
    // Identical failure/retry events on the same current source. Only the reported CI seconds differ.
    // Failure-log or other peer work therefore appears on both sides, without freezing an old base.
    await t.test('zero-second failure control', async sub => {
      control = await resubmissionJourney(sub, mode, 0);
    });
    await t.test('reported lost check usage', async sub => {
      measured = await resubmissionJourney(sub, mode, 240);
    });
    for (const key of ['mutations', 'v8Actions', 'readDocuments'])
      assert.equal(measured[key], control[key], `${mode}: carried usage adds no ${key} versus the control`);
    for (const key of ['readBytes', 'writeBytes'])
      assert(
        measured[key] <= control[key] * 1.01,
        `${mode}: carried scalars stay within 1% ${key} of control`,
      );
    const keys = ['mutations', 'v8Actions', 'readDocuments', 'readBytes', 'writeBytes'];
    t.diagnostic(
      JSON.stringify({
        mode,
        control: Object.fromEntries(keys.map(k => [k, control[k]])),
        measured: Object.fromEntries(keys.map(k => [k, measured[k]])),
      }),
    );
  });
}

/** The land gate an agent CLI sends: save and preflight timing (`durations`) and the guard-set
 * evidence (`guard`, 13ea93bf): `ran` at the measured median of 34 test files, and the Lane's runs. */
const GATE_RAN = ranEvidence(Array.from({ length: 34 }, (_, i) => `tests/synthetic-${i}.test.mjs`));
const landGate = (lane, { durations = false, guard = false }) =>
  JSON.stringify({
    lanes: [
      {
        laneId: lane.laneId,
        head: lane.head,
        preflight: 'passed',
        ...(durations ? { saveMs: 15000, preflightMs: 49779 } : {}),
        ...(guard ? { ran: GATE_RAN, runs: 2 } : {}),
      },
    ],
  });

/** One accepted-Candidate submission through check and acceptance; `moveMain` moves main during
 * the check, so it recomposes on a source job and checks again (the common dogfood case). */
async function solo(
  t,
  {
    moveMain = false,
    extraQuery = false,
    durations = false,
    heldMs,
    guard = false,
    guards,
    indexExports = false,
    ...runner
  } = {},
) {
  const f = await finishFixture(t);
  seedOrder(f);
  // A project that has learned: its speed row carries a guard document (13ea93bf).
  if (guards)
    f.insert('projectLandingSpeed', {
      projectId: f.projectId,
      value: '{"schema":2,"samples":[],"broken":{}}',
      guards,
    });
  const m = meter(f, runner);
  if (indexExports) await measureIndexExportClaims(f);
  const state = await f.enqueue(f.request(), {
    ...(durations || guard ? { gates: landGate(f.lane, { durations, guard }) } : {}),
    ...(heldMs === undefined ? {} : { heldMs }),
  });
  if (extraQuery) {
    // The seeded regression: one more query per landing (a status read on the landing path).
    assert(finishApi.status.isQuery);
    await f.tx('extraStatus', finishApi.status, { projectId: f.projectId, submissionId: state.id });
  }
  await watch(f, m, state.operationId);
  await drain(f, m);
  for (let round = 0; round < (moveMain ? 2 : 1); round++) {
    if (moveMain && round === 0) f.moveMain();
    await f.passChecks();
    await m.refresh();
    await drain(f, m);
  }
  assert.equal(landed(f), 1);
  assert.equal(states(f).find(row => row.id === state.id)?.timing?.heldMs, heldMs);
  assertRunMetrics(f);
  return {
    landings: 1,
    checkRuns: runs(f).length,
    runnerMinutes: runnerMinutes(f),
    stamped: stamped(f),
    ...(await m.stop()),
  };
}
/** Four queued landings composed and checked together under the default batching policy. */
async function batch(t, { extraQuery = false, guard = false, indexExports = false, ...runner } = {}) {
  const f = await batchesFixture(t, { count: 0, batching: 'default', batchMaxSize: null });
  const entries = [];
  for (let i = 0; i < 4; i++)
    entries.push(
      await f.add(
        i,
        guard ? { enqueue: lane => ({ gates: landGate(lane, { durations: true, guard }) }) } : {},
      ),
    );
  seedOrder(f);
  // Measured after enqueue: Candidate composition and the four enqueue mutations are outside it.
  const m = meter(f, runner);
  if (indexExports) await measureIndexExportClaims(f);
  const observers = [];
  for (const state of entries) {
    const observer = {};
    await watch(f, observer, state.operationId);
    observers.push(observer.refresh);
  }
  m.refresh = async () => {
    for (const refresh of observers) await refresh();
  };
  if (extraQuery)
    for (const state of entries)
      await f.tx('extraStatus', finishApi.status, { projectId: f.projectId, submissionId: state.id });
  for (let steps = 0; ; steps++) {
    assert(steps < 400, 'finite batch work');
    if (states(f).every(s => s.phase === 'landed' || s.phase === 'terminal-failed')) break;
    const queued = f.runs().filter(r => r.status === 'queued');
    for (const r of queued) await f.rawChecks.pass(await f.rawChecks.activate(r.id));
    // Event-driven work first; a stall alarm only when nothing else can move.
    await m.refresh();
    const task =
      f.pending().find(x => !x.name.startsWith('projectHostedLandingStall')) ??
      (queued.length ? null : f.pending()[0]);
    if (task) await run(f, m, task);
    else if (!queued.length) break;
  }
  assert.equal(landed(f), 4);
  assertRunMetrics(f);
  return {
    landings: 4,
    checkRuns: f.runs().length,
    runnerMinutes: runnerMinutes(f),
    stamped: stamped(f),
    ...(await m.stop()),
  };
}

/** The scripted mix in `costGuard.scenario`, per accepted landing. */
async function measureLandingCosts(t, { extraR2Read = false, ...options } = {}) {
  // Agent landings carry the guard-set gate evidence: the ledger sees its bytes (13ea93bf).
  options = { guard: true, ...options };
  const scenarios = {
    solo: await solo(t, { ...options, extraR2Read }),
    mainMoved: await solo(t, { ...options, moveMain: true }),
    batchOfFour: await batch(t, options),
  };
  const all = Object.values(scenarios);
  const total = key => all.reduce((sum, s) => sum + s[key], 0);
  const landings = total('landings');
  const per = key => total(key) / landings;
  const { v8, node } = costGuard.actionModel;
  const measured = {
    queries: per('queries'),
    observerQueries: per('observerQueries'),
    observerReadBytes: per('observerReadBytes'),
    mutations: per('mutations'),
    v8Actions: per('v8Actions'),
    nodeActions: per('nodeActions'),
    readBytes: per('readBytes'),
    writeBytes: per('writeBytes'),
    actionGbSeconds: per('v8Actions') * v8.gb * v8.seconds + per('nodeActions') * node.gb * node.seconds,
    r2ClassA: per('r2ClassA'),
    r2ClassB: per('r2ClassB'),
    r2BytesPut: per('r2BytesPut'),
    checkRuns: per('checkRuns'),
    runnerMinutes: per('runnerMinutes'),
    mainHistoryReads: per('mainHistoryReads'),
  };
  return { measured, scenarios, landings };
}

test('one cohort uploads its exact metadata in a single drive and resumes before dispatch', async t => {
  const f = await batchesFixture(t, { startAt: Date.UTC(2026, 0, 1) });
  while (!f.tables.projectHostedLandingBatches.size) await f.execute(f.pending()[0]);
  const batch = () => JSON.parse([...f.tables.projectHostedLandingBatches.values()][0].value);
  const { id, leaderId, composeOperationId } = batch();
  const submitted = () =>
    [...f.tables.projectHostedComposes.values()].some(
      row => row.operationId === composeOperationId && JSON.parse(row.value).status === 'submitted',
    );
  const m = meter(f);
  for (let steps = 0; !submitted(); steps++) {
    assert(steps < 10, 'finite dispatch of the retained compose');
    const task = f
      .pending()
      .find(task => isFinishWake(task.name) && task.args[0].submissionId === (leaderId ?? id));
    assert(task, 'the leader retains its wake through dispatch');
    await run(f, m, task);
  }
  const {
    queries,
    mutations,
    v8Actions,
    nodeActions,
    readBytes,
    writeBytes,
    r2ClassA,
    r2ClassB,
    r2BytesPut,
  } = await m.stop();
  const measured = {
    queries,
    mutations,
    v8Actions,
    nodeActions,
    readBytes,
    writeBytes,
    r2ClassA,
    r2ClassB,
    r2BytesPut,
  };
  t.diagnostic(`cohortMetadata ${JSON.stringify(measured)}`);
  assert.equal(queries + mutations + v8Actions + nodeActions, 5);
  assert.equal(r2ClassA, 2, 'only the missing dependency page and source plan are uploaded');
  assert.equal(r2ClassB, 2, 'each new object is verified once without reading the stored page');
  assert.equal(
    r2BytesPut,
    batch()
      .uploads.slice(1)
      .reduce((bytes, upload) => bytes + upload.pin.size, 0),
  );
});

let baseline;
async function ensureBaseline(t) {
  if (!baseline) {
    fixedClock(t, { elapsed: true });
    baseline = await measureLandingCosts(t, { indexExports: true, traceWrites: true });
  }
  return baseline;
}
test('cost guard: the scripted landing mix stays within its per-landing cost ledger', async t => {
  const wallTime = performance.now.bind(performance);
  const started = wallTime();
  baseline = await ensureBaseline(t);
  const verdicts = judgeCosts(costs, costGuard, 'landing-fixture', baseline.measured);
  const ledgerChanged = verdicts.some(v => v.status !== 'pass');
  const scenarioTotals = Object.fromEntries(
    Object.entries(baseline.scenarios).map(([name, { writeSites: sites, ...totals }]) => {
      reportWriteSites(t, `landing-fixture.${name}`, sites, ledgerChanged);
      return [name, totals];
    }),
  );
  t.diagnostic(`liveLinePairedMix ${JSON.stringify(baseline.measured)}`);
  t.diagnostic(`scenarios ${JSON.stringify(scenarioTotals)}`);
  const mixed = Object.values(baseline.scenarios);
  const calls = mixed.reduce(
    (n, s) => n + s.queries + s.observerQueries + s.mutations + s.v8Actions + s.nodeActions,
    0,
  );
  const feedEvents = mixed.reduce((n, s) => n + s.feed.events, 0);
  // Item 8b7ab7a9: grouping the cohort's metadata IO replaces serial finish hops.
  assert.equal(calls, 248, 'feed writes introduce no Convex call in the current six-landing mix');
  assert.equal(feedEvents, 6, 'one terminal feed row per accepted Lane on the fixture mix');
  // f65d8024: the approved commit cursor adds 33 document bytes and two scoped
  // keys totaling 357 modeled key bytes per event and per fixture landing.
  assert.equal(
    mixed.reduce((n, s) => n + s.feed.commitFieldBytes, 0),
    198,
  );
  assert.equal(
    mixed.reduce((n, s) => n + s.feed.arrivalIndexes.entries, 0),
    12,
  );
  assert.equal(
    mixed.reduce((n, s) => n + s.feed.arrivalIndexes.keyBytes, 0),
    2142,
  );
  assert.equal(
    mixed.reduce((n, s) => n + s.feed.expiryProbes, 0),
    6,
  );
  assert.equal(
    mixed.reduce((n, s) => n + s.feed.readBytes, 0),
    0,
    'no retained feed row is read before it expires',
  );
  assert.equal(
    mixed.reduce((n, s) => n + s.feed.acceptanceReadBytes, 0),
    0,
    'publication reuses staged Lane pins without rereading the acceptance input pages',
  );
  t.diagnostic(
    `feedFixture ${JSON.stringify({
      calls,
      events: feedEvents,
      documentBytes: mixed.reduce((n, s) => n + s.feed.writeBytes, 0),
      commitFieldBytes: mixed.reduce((n, s) => n + s.feed.commitFieldBytes, 0),
      arrivalIndexEntries: mixed.reduce((n, s) => n + s.feed.arrivalIndexes.entries, 0),
      arrivalIndexKeyBytes: mixed.reduce((n, s) => n + s.feed.arrivalIndexes.keyBytes, 0),
      acceptanceReadBytes: mixed.reduce((n, s) => n + s.feed.acceptanceReadBytes, 0),
      wallMs: wallTime() - started,
      peakRssKiB: process.resourceUsage().maxRSS,
    })}`,
  );
  const solo = baseline.scenarios.solo;
  const landServer = {
    calls: solo.queries + solo.observerQueries + solo.mutations + solo.v8Actions + solo.nodeActions,
    reads: solo.readDocuments,
  };
  // 1122c9c9: lead approved solo 492 -> 494 reads; measured +908 B/landing = +$0.0001816/1,000 for pending-only scheduler safety.
  // 9a04d916: compose settle, solo 647 -> 685 reads (owner-approved +$0.02/1,000; ledger reason recorded).
  // f65d8024: 685 -> 686, one empty expiry probe. The loaded acceptance plan holds the exact Lane pins.
  // 67771ca6 (friction 28e84c06): 686 -> 687, the landed reply's one empty stop-row probe, so a
  // stopped GitHub mirror is named; the row changes only on a terminal stop or resume.
  assertCommandWeight('landServerSolo', landServer);
  t.diagnostic(JSON.stringify({ landServerSolo: landServer }));
  const lines = formatCostVerdicts(verdicts);
  // Warnings and ratchet notices go to the check log; only a fail stops the landing.
  for (const line of lines) t.diagnostic(line);
  if (verdicts.some(v => v.status !== 'pass')) console.warn(lines.join('\n'));
  for (const scenario of Object.values(baseline.scenarios)) {
    const commits = scenario.reuseCapture.sourceCommit;
    if (commits)
      assert.equal(
        commits.tables.hostedProjects ?? 0,
        0,
        'reads per landing: a source commit must reuse its unchanged project snapshot',
      );
  }

  // Retain the current six-landing cost mix; extend it by one real batch to
  // measure the brief's ten-landing index workload without changing its ledger.
  const ten = [...Object.values(baseline.scenarios), await batch(t, { indexExports: true })];
  assert(
    ten.some(scenario => scenario.metricAliasWrites > 0),
    'the guard exercises the live alias writers',
  );
  for (const scenario of ten) {
    assert.equal(scenario.writeRounds, scenario.canonicalWriteRounds, 'alias leaves add zero write rounds');
    assert.equal(scenario.metricAliasReadRanges, 0, 'landing never reads metric aliases');
  }
  t.diagnostic(
    `tenLandingIndexes ${JSON.stringify({
      landings: ten.reduce((n, s) => n + s.landings, 0),
      written: ten.reduce((n, s) => n + s.indexEntriesWritten, 0),
      exportClaims: ten.reduce((n, s) => n + s.exportClaims, 0),
      exportWritten: ten.reduce((n, s) => n + s.exportIndexEntriesWritten, 0),
      removed: ten.reduce((n, s) => n + s.indexEntriesRemoved, 0),
      metricAliasWrites: ten.map(s => s.metricAliasWrites),
      writeRounds: ten.map(s => s.writeRounds),
      stored: ten.map(s => s.storedIndexes),
      storedMetricAliases: ten.map(s => s.storedMetricAliases),
      arrivals: ten.map(s => s.feed.arrivalIndexes),
    })}`,
  );
  // Ten-landing index writes 11,736 -> 12,864 (Item 9a04d916, compose settle; owner-approved +$0.02/1k): the scheduler rows of the settle and
  // retry mutations and the drive each one hands IO to.
  // Ten-landing index writes 12,864 -> 13,812 (Item 85f456c1, batch truth gap): the batch scenario's publish now
  // writes main's line snapshot and, as its project's first landing of the hour, runs the person-order touch the single
  // scenarios already run (151 seeded people rewritten once; at most once per project per hour with landings, priced
  // in the mutations ledger below and docs/data-placement.md). The In-queue binding write adds a few entries.
  // Stored keys in the two batch scenarios 150,180 -> 151,690 B: the touch stamps each of the 151 person rows with
  // this hour (about 10 B of key each). Fixed per person and overwritten each hour, so it does not grow with history.
  // f65d8024: commit ordering adds 20 custom index writes across ten events.
  // Stored entries in the two batch scenarios 2,169 -> 2,173 (Item c6615b66): each open Lane keeps one
  // coordination session row while it is open (released with its presence row at close). Fixed per open Lane,
  // not per landing or history.
  // Each adds 357 modeled key bytes to the existing per-project and per-Lane event-time keys.
  // Ten-landing index writes 13,852 -> 13,890 and stored entries +10/+16/+56/+56 (Item 411727ba, Fable verdict
  // 184c7d95): the purge reference proof reads stored-key indexes (by_r2Key on objects, backups, proposals,
  // upload cleanup; by_archive_r2Key), so each object row written carries one more ~110 B index entry. That
  // replaces a scan of every other project's rows per deletion (3.1 GB on 11-22).
  // Stored index key bytes +5/+5/+20/+20 in the four scenarios, and +5 on fresh and dogfood (Item fe2b0a86 part B):
  // by_project_and_intent gains a trailing heldIntent slot, so later held submissions of an Intent find the owner's
  // approval without a second index. That is 1 B per landing row (an undefined component), no extra entry or write.
  const indexBudget = storageBudgets.tenLandingIndexes;
  const aliasWrites = ten.reduce((n, s) => n + s.metricAliasWrites, 0);
  // 0de95ef2: the separately priced aliases must fit their measured budget.
  // The original index ceilings continue to cover the canonical writes.
  assert(aliasWrites <= indexBudget.metricAliases.written, 'ten-landing metric alias write budget');
  assert.equal(
    ten.reduce((n, s) => n + s.landings, 0),
    indexBudget.landings,
  );
  assert(
    ten.reduce((n, s) => n + s.indexEntriesWritten + s.exportIndexEntriesWritten, 0) - aliasWrites <=
      indexBudget.written,
    'ten-landing custom index writes must not exceed the accepted storage budget',
  );
  for (const [i, scenario] of ten.entries())
    for (const metric of ['entries', 'keyBytes']) {
      assert(
        scenario.storedMetricAliases[metric] <= indexBudget.metricAliases.stored[i][metric],
        `scenario ${i}: stored metric alias ${metric} budget`,
      );
      assert(
        scenario.storedIndexes[metric] - scenario.storedMetricAliases[metric] <=
          indexBudget.stored[i][metric],
        `scenario ${i}: stored index ${metric} must not grow without a storage decision`,
      );
    }
  t.diagnostic(`measured in ${Math.round(wallTime() - started)} ms`);
  assert.equal(baseline.landings, 6);
  assert(
    // 167/6: +2 hour-bucket touch runs over 165/6, each fixture project seeding an owner and 150 members (Item 3d5d8839).
    // 185/6 (Item 9a04d916, compose settle; owner-approved +$0.02/1k): every finish wake with no IO in flight is a settle mutation.
    // 187/6 (Item 85f456c1, batch truth gap): the batch scenario's first landing of the hour runs the person-order touch.
    baseline.measured.mutations <= 187 / 6,
    'metrics read projections must share existing landing mutations (90-minute read-cost incident)',
  );
  assert(verdicts.length >= 10, 'every fixture quantity has a ledger entry');
  assert.deepEqual(
    verdicts.filter(v => v.status === 'fail').map(v => v.message),
    [],
    'a per-landing cost rose past its ledger threshold',
  );
});

test('ca19aec0: one additional executed R2 GET fails the exact six-landing request ceiling', async t => {
  const baseline = await ensureBaseline(t);
  const seeded = await measureLandingCosts(t, { extraR2Read: true });
  const before = Object.values(baseline.scenarios).reduce((sum, s) => sum + s.r2ClassB, 0);
  const after = Object.values(seeded.scenarios).reduce((sum, s) => sum + s.r2ClassB, 0);
  assert.equal(after, before + 1, 'the negative control adds exactly one real fixture GET');
  const verdict = judgeCosts(costs, costGuard, 'landing-fixture', seeded.measured).find(
    v => v.metric === 'r2ClassB',
  );
  assert.equal(verdict.status, 'fail');
  assert.match(verdict.message, /exceeds its ceiling/);
});

test('ca19aec0: checksum-acknowledged PUTs remove fallback HEADs without changing landing work', async t => {
  const baseline = await ensureBaseline(t);
  const acknowledged = await measureLandingCosts(t, { checksumEcho: true });
  for (const metric of [
    'queries',
    'observerQueries',
    'mutations',
    'v8Actions',
    'nodeActions',
    'checkRuns',
    'r2ClassA',
    'r2BytesPut',
  ])
    assert.equal(acknowledged.measured[metric], baseline.measured[metric], `${metric}: same work`);
  assert(acknowledged.measured.r2ClassB < baseline.measured.r2ClassB);
  t.diagnostic(
    JSON.stringify({
      fallbackRequests: baseline.measured.r2ClassB * baseline.landings,
      acknowledgedRequests: acknowledged.measured.r2ClassB * acknowledged.landings,
      landings: acknowledged.landings,
    }),
  );
});

test('unconditional Candidate listings keep the landing call ledger and zero legacy data-table access', async t => {
  const baseline = await ensureBaseline(t);
  const unchangedCalls = {
    // Item 9a04d916 (compose settle; owner-approved +$0.02/1,000): a settled solo plan's drive
    // re-reads its bytes in one indexed query (2 in the mix), and every finish wake with no IO in
    // flight is a settle mutation (167 -> 185); V8 actions fall 59 -> 36.
    queries: 2 / 6,
    observerQueries: 53 / 6,
    // +4 over the six-landing mix: each fixture project's first landing opens an hour bucket and schedules
    // accountProjectOrder:touch, one run per 100 stale person rows; the fixtures seed an owner and 150 members, so two
    // runs per project (Item 3d5d8839). In use ceil(people/100) runs, at most once per project per hour with landings.
    // Cost per project-hour = calls (ceil(people/100) x $2/M) + row I/O (each row read and rewritten, ~124 B each way,
    // $0.20/GB); per landing divide by landings per project-hour L. 151 people: $0.000004 + $0.0000075, so
    // $0.0115 per 1,000 landings at worst case L = 1 (0.68% of $1.688); see docs/data-placement.md.
    // 185 -> 187 (Item 85f456c1, batch truth gap): the batch scenario's first landing of the hour now schedules the
    // same person-order touch (two runs for 151 people), since a batch publish moves main's line snapshot too.
    mutations: 187 / 6,
    v8Actions: 36 / 6,
    nodeActions: 3 / 6,
  };
  for (const [metric, limit] of Object.entries(unchangedCalls))
    assert(baseline.measured[metric] <= limit, `listing publication adds no ${metric}`);
  for (const scenario of Object.values(baseline.scenarios))
    assert.equal(
      scenario.dataRecordCalls,
      0,
      'canonical landings never access the legacy per-file data table',
    );
});

test('runner-minute ledger rejects extra shard setup without an increase in check runs', async t => {
  const baseline = await ensureBaseline(t);
  for (const options of [{ extraShard: true }, { extraSetupSeconds: 60 }]) {
    const seeded = await measureLandingCosts(t, options);
    assert.equal(seeded.measured.checkRuns, baseline.measured.checkRuns);
    assert(seeded.measured.runnerMinutes > baseline.measured.runnerMinutes);
    const verdict = judgeCosts(costs, costGuard, 'landing-fixture', seeded.measured).find(
      v => v.metric === 'runnerMinutes',
    );
    assert(verdict, 'runner minutes must be judged by the existing fixture ledger');
    assert.equal(verdict.status, 'fail', 'repeated setup or wider fanout must fail the landing check');
    assert.match(verdict.message, /Decision it protects: Issue 685774ea/);
  }
});

test('seeded regression: one extra query per landing fails the guard, naming the quantity, both values, the decision and the two ways out', async t => {
  const seeded = await measureLandingCosts(t, { extraQuery: true });
  const queries = judgeCosts(costs, costGuard, 'landing-fixture', seeded.measured).find(
    v => v.metric === 'queries',
  );
  assert.equal(queries.status, 'fail');
  assert.equal(queries.after, queries.before + 1);
  assert.match(queries.message, /^Cost budget landing-queries rose: \S+ -> \S+ calls per landing/);
  assert.match(queries.message, /Decision it protects: Issue [0-9a-f]{8}/);
  assert.match(queries.message, /fix the change, or update this entry in src\/speed-budgets\.json/);
});

test('a saving of 10% or more asks the author to lower the ledger value, so it ratchets in', async t => {
  const baseline = await ensureBaseline(t);
  const entry = costs.find(c => c.metric === 'mutations');
  // The ledger as it stood before a change that saved a fifth of the landing mutations.
  const verdict = judgeCost(
    { ...entry, value: baseline.measured.mutations * 1.25 },
    baseline.measured.mutations,
    costGuard,
  );
  assert.equal(verdict.status, 'ratchet');
  assert.match(verdict.message, /fell: .* \(-20%\)/);
  assert.match(verdict.message, /Lower its value to \S+ in src\/speed-budgets\.json/);
  // Between the warn and fail lines it warns; within the floor nothing moves.
  const warn = judgeCost({ ...entry, value: 100, floor: 0 }, 110, costGuard);
  assert.equal(warn.status, 'warn');
  assert.equal(judgeCost({ ...entry, value: 2, floor: 1 }, 3, costGuard).status, 'pass');
  assert.equal(judgeCost({ ...entry, value: 2, floor: 0.5 }, null, costGuard).status, 'fail');
});

for (const mainRace of [false, true])
  test(`cost 298f9675: ${mainRace ? 'main-race' : 'solo'} landing preserves check wall, acceptance delay and zero idle calls`, async t => {
    fixedClock(t);
    const f = await finishFixture(t);
    const state = await f.enqueue(f.request());
    const checkWorkMs = 60_000;
    let completed = 0;
    const current = () =>
      JSON.parse(
        [...f.tables.projectHostedLandingRequests.values()].find(r => r.submissionId === state.id).value,
      );
    for (let step = 0; current().phase !== 'landed'; step++) {
      assert(step < 100, 'finite event-driven landing');
      const queued = runs(f).filter(run => run.status === 'queued');
      if (queued.length) {
        for (const run of queued) {
          const active = await f.rawChecks.activate(run.id);
          if (mainRace && completed === 0) f.moveMain();
          // The fixture owns Date.now: model runner work without sleeping or timing the host.
          f.advanceClock(checkWorkMs);
          await f.rawChecks.pass(active);
          completed++;
        }
      } else await f.execute();
    }
    await f.drain();
    const timing = current().timing;
    const measured = {
      timeToMainMs: Date.parse(timing.committedAt) - Date.parse(timing.submittedAt),
      checkWallMs: runs(f).reduce((sum, run) => sum + Date.parse(run.endedAt) - Date.parse(run.at), 0),
      checks: completed,
    };
    t.diagnostic(JSON.stringify({ mainRace, ...measured }));
    assert.equal(completed, mainRace ? 2 : 1, 'only the necessary exact-source checks run');
    assert.equal(measured.checkWallMs, checkWorkMs * completed);
    assert.equal(
      measured.timeToMainMs,
      measured.checkWallMs + (mainRace ? 250 : 0),
      'only the existing main-race publication debounce delays acceptance',
    );
    assert.equal(f.pending().length, 0, 'terminal landing has no live scheduled work');
    const idle = { calls: f.counts.length, sourceCalls: f.metrics.convexSourceCalls.length };
    f.advanceClock(24 * 60 * 60_000);
    await f.drain();
    assert.deepEqual(
      { calls: f.counts.length, sourceCalls: f.metrics.convexSourceCalls.length },
      idle,
      'a day idle adds no Convex execution',
    );
  });

test('live R2 stamp: a recomposed landing carries the requests its compose signed, never more than the meter saw; a landing with no compose of its own stays unknown', async t => {
  const baseline = await ensureBaseline(t);
  const { solo, mainMoved, batchOfFour } = baseline.scenarios;
  // The solo landing took its Candidate as given (the fixture composes nothing for it).
  assert.deepEqual(solo.stamped, [null]);
  const [counts] = mainMoved.stamped;
  const [a, b, put] = counts.r2;
  assert(a > 0 && b > 0 && put > 0, 'the recompose signed writes, reads and bytes');
  // The meter counts every R2 request of the whole scenario (checks and the begin reads too).
  assert(
    a <= mainMoved.r2ClassA && b <= mainMoved.r2ClassB && put <= mainMoved.r2BytesPut,
    JSON.stringify({ counts, mainMoved }),
  );
  assert.deepEqual(
    batchOfFour.stamped,
    [null, null, null, null],
    'batch members have no compose of their own',
  );
});

// Friction 20e4d273: filtering a single cost-guard test via --test-name-pattern must still configure
// synthetic callback credentials (no RUNNER_UNAVAILABLE) and initialize the shared baseline on demand.
test(
  '20e4d273: filtering a baseline-dependent cost test with --test-name-pattern initializes synthetic callbacks and baseline on demand',
  { skip: process.env.FORGE_COST_GUARD_FILTER_SUBTEST === '1' },
  () => {
    const env = { ...process.env, FORGE_COST_GUARD_FILTER_SUBTEST: '1' };
    delete env.NODE_TEST_CONTEXT;
    for (const key of Object.keys(synthetic)) delete env[key];
    const result = spawnSync(
      process.execPath,
      [
        '--import',
        './tests/check-runtime.mjs',
        '--test',
        '--test-name-pattern',
        '^live R2 stamp:',
        fileURLToPath(import.meta.url),
      ],
      {
        cwd: fileURLToPath(new URL('../', import.meta.url)),
        env,
        encoding: 'utf8',
        maxBuffer: 32 << 20,
      },
    );
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /pass 1/);
  },
);

// Dogfood-sized control path: 1,000 retained test reports, ten completed shards. The runner
// callbacks finish before we enlarge the retained row, so this isolates the landing drivers.
async function dogfoodDriverCosts(t) {
  const f = await finishFixture(t);
  const state = await f.enqueue(f.request());
  await f.drain();
  await f.passChecks();
  const runBytes = inflateDogfoodChecks(f);
  const from = f.counts.length;
  await f.drain();
  assert.equal((await f.current(state.id)).submission.phase, 'landed');
  const calls = f.counts.slice(from).filter(c => c.name === 'finishLandingAdvance');
  const readBytes = calls.reduce((n, c) => n + c.readBytes, 0);
  t.diagnostic(
    JSON.stringify({ runBytes, calls: calls.length, readBytes, tables: calls.map(c => c.readBytesByTable) }),
  );
  return { runBytes, calls: calls.length, readBytes };
}

test('dogfood landing drivers retain exact acceptance with 1,000 reports and ten shards', async t => {
  const measured = await dogfoodDriverCosts(t);
  assert(measured.runBytes >= 250_000 && measured.runBytes < 350_000);
  assert.equal(measured.calls, 1, 'one advance for the passed run, no added RPC');
  const budget = costs.find(c => c.metric === 'landingAdvanceReadBytes');
  assert(budget, 'the dogfood per-function read budget is recorded');
  assert.notEqual(judgeCost(budget, measured.readBytes, costGuard).status, 'fail');
});

test('observer driver bytes include public identity mapping and recheck current membership', async t => {
  const f = await finishFixture(t);
  const state = await f.enqueue(f.request());
  f.patch('hostedProjects', f.projectId, { agentGuidance: 'synthetic'.repeat(2000) });
  f.insert('forgeAccounts', { owner: 'owner', handle: 'synthetic-owner' });
  const member = f.insert('projectContributors', { projectId: f.projectId, contributor: 'viewer' });
  const observe = await import(moduleUrl('../convex/projectHostedFinishObserve.ts'));
  const input = { projectId: f.projectId, operationId: state.operationId, nextVersion: 0 };
  const from = f.counts.length;
  const response = JSON.parse(await f.tx('driverObservePage', observe.page, input, 'viewer'));
  assert.equal(response.submission.actor, 'synthetic-owner');
  const measured = f.counts.at(-1);
  assert.equal(f.counts.length - from, 1, 'one query including public identity mapping');
  t.diagnostic(JSON.stringify({ observerReadBytes: measured.readBytes, tables: measured.readBytesByTable }));
  const budget = costs.find(c => c.metric === 'finishObserveReadBytes');
  assert(budget, 'the public observer byte budget is recorded');
  assert.notEqual(judgeCost(budget, measured.readBytes, costGuard).status, 'fail');
  f.tables.projectContributors.delete(member);
  await assert.rejects(
    f.tx('driverObserveRevoked', observe.page, input, 'viewer'),
    error => error.data?.code === 'PROJECT_UNAVAILABLE',
  );
  f.insert('projectReaders', { projectId: f.projectId, reader: 'viewer' });
  const reader = JSON.parse(await f.tx('driverObserveReader', observe.page, input, 'viewer'));
  assert.equal(reader.submission.actor, undefined, 'a read grant does not disclose another person');
});

async function dogfoodControlTail(t, race) {
  const f = await finishFixture(t);
  f.patch('hostedProjects', f.projectId, { agentGuidance: 'synthetic'.repeat(2000) });
  const state = await f.enqueue(f.request({ agent: true }));
  await f.drain();
  const first = (await f.status(state.id)).attempt;
  const selection = f.c.put(JSON.stringify({ scope: 'full', tests: [] }));
  await passWithSelection(f, first.check.runId, selection);
  if (race) {
    while ((await f.current(state.id)).submission.phase !== 'ready') await f.execute();
    f.moveMain();
    await seedFullMain(f, selection);
  }
  inflateDogfoodChecks(f);
  const from = f.counts.length;
  await f.drain();
  if (race) {
    await f.passChecks();
    inflateDogfoodChecks(f);
    await f.drain();
  }
  assert.equal((await f.current(state.id)).submission.phase, 'landed');
  // Item 9a04d916: a finish step runs in the drive, the settle or the retry mutation; all three
  // are finish steps here.
  const steps = new Set(['finishStep', 'finishSettle', 'finishRetry']);
  return Object.fromEntries(
    ['finishStep', 'finishLandingAdvance', 'reuseComplete'].map(name => {
      const rows = f.counts
        .slice(from)
        .filter(c => (name === 'finishStep' ? steps.has(c.name) : c.name === name));
      return [
        name,
        {
          calls: rows.length,
          readBytes: rows.reduce((sum, c) => sum + c.readBytes, 0),
          runReads: rows.reduce((sum, c) => sum + (c.readDocumentsByTable.projectHostedCheckRuns ?? 0), 0),
        },
      ];
    }),
  );
}

test('dogfood control tails budget finish reads across a completed solo landing and main-race recheck', async t => {
  compactDiscardedChecks(t);
  const scenarios = [await dogfoodControlTail(t, false), await dogfoodControlTail(t, true)];
  const total = (name, key) => scenarios.reduce((sum, s) => sum + s[name][key], 0);
  const measured = {
    finishStepReadBytes: total('finishStep', 'readBytes') / 2,
    reuseCompleteReadBytes: total('reuseComplete', 'readBytes') / 2,
    driverTailReadBytes:
      scenarios.reduce((sum, s) => sum + Object.values(s).reduce((n, c) => n + c.readBytes, 0), 0) / 2,
  };
  t.diagnostic(JSON.stringify({ finishSteps: total('finishStep', 'calls'), ...measured }));
  // 13 -> 19 (Item 9a04d916, compose settle; owner-approved +$0.02/1k): a settle or retry mutation runs the step, and an acceptance page it
  // cannot hand out is stepped once more by its immediate drive (two per landing here).
  assert.equal(total('finishStep', 'calls'), 19, 'no additional finish step at dogfood row sizes');
  assert.equal(total('finishLandingAdvance', 'calls'), 3, 'no additional landing advance');
  assert.equal(total('reuseComplete', 'calls'), 1, 'one proof completion for the main race');
  for (const [metric, bytes] of Object.entries(measured)) {
    const budget = costs.find(c => c.metric === metric);
    assert(budget, `${metric} has a ledger entry`);
    assert.notEqual(judgeCost(budget, bytes, costGuard).status, 'fail');
  }
  t.diagnostic(JSON.stringify({ dogfoodTail: { scenarios, measured } }));
});

test('save/preflight timing keeps landing cost guard bytes within one percent without extra calls', async t => {
  const before = await solo(t, { moveMain: true });
  const after = await solo(t, { moveMain: true, durations: true });
  for (const key of ['queries', 'observerQueries', 'mutations', 'v8Actions', 'nodeActions'])
    assert.equal(after[key], before[key], `${key}: no new call`);
  for (const key of ['readBytes', 'writeBytes', 'observerReadBytes'])
    assert(after[key] <= before[key] * 1.01, `${key}: ${after[key]} <= ${before[key]} + 1%`);
  t.diagnostic(
    `duration bytes: read ${after.readBytes - before.readBytes}, write ${after.writeBytes - before.writeBytes}; baseline ${before.readBytes}/${before.writeBytes}`,
  );
});

test('client hold survives a main-race recheck with no added Convex call or document access', async t => {
  const scenario = { moveMain: true, durations: true };
  let before, after;
  await t.test('legacy submit', async sub => {
    fixedClock(sub);
    before = await solo(sub, scenario);
  });
  await t.test('submit with client hold', async sub => {
    fixedClock(sub);
    after = await solo(sub, { ...scenario, heldMs: 12_750 });
  });
  t.diagnostic(
    `hold timing bytes: read +${after.readBytes - before.readBytes}, write +${after.writeBytes - before.writeBytes}`,
  );
  for (const key of ['queries', 'observerQueries', 'mutations', 'v8Actions', 'nodeActions', 'readDocuments'])
    assert.equal(after[key], before[key], `${key}: no added work`);
  for (const key of ['readBytes', 'writeBytes', 'observerReadBytes'])
    assert(after[key] <= before[key] * 1.01, `${key} stays within one percent`);
});

test('direct and desired submit replays preserve the first client hold and keep legacy replies compatible', async t => {
  for (const mode of ['direct', 'desired'])
    await t.test(mode, async sub => {
      const f = await finishFixture(sub);
      const command = f.request();
      const send =
        mode === 'direct'
          ? metadata => f.enqueue(command, metadata)
          : metadata =>
              f
                .tx('desiredSubmit', desired.submit, {
                  projectId: f.projectId,
                  request: JSON.stringify({
                    operationId: command.operationId,
                    authorityEpoch: command.authorityEpoch,
                    composeOperationId: command.finish.composeOperationId,
                    after: null,
                    check: command.check,
                  }),
                  ...metadata,
                })
                .then(JSON.parse);
      for (const heldMs of [-1, 0.5, 86_400_001])
        await assert.rejects(send({ heldMs }), error => error.data?.code === 'BAD_ARGUMENT');
      const first = await send({ heldMs: 12_750 });
      const legacy = await send({});
      const retry = await send({ heldMs: 0 });
      assert.equal(first.id, legacy.id);
      assert.equal(first.id, retry.id);
      assert.equal(first.timing.heldMs, 12_750);
      assert.equal(legacy.timing.heldMs, undefined);
      assert.equal(retry.timing.heldMs, 12_750);
    });
});

test('guard-set gate evidence (ran, runs) adds no call and a bounded, measured read cost', async t => {
  const before = await solo(t, { moveMain: true, durations: true });
  const after = await solo(t, { moveMain: true, durations: true, guard: true });
  for (const key of ['queries', 'observerQueries', 'mutations', 'v8Actions', 'nodeActions'])
    assert.equal(after[key], before[key], `${key}: no new call`);
  assert(after.writeBytes > before.writeBytes, 'the ledger sees the ran bytes on the landing rows');
  // About 170 B on the landing row (34 files), read about 100 and rewritten about 25 times per
  // main-moved landing: about 18 KB read and 4.4 KB written, +$0.0045 per 1,000 landings at $0.20/GB
  // (13ea93bf). The bounds catch a wider row or more touches.
  assert(after.readBytes - before.readBytes <= 24_000, `read +${after.readBytes - before.readBytes} B`);
  assert(after.writeBytes - before.writeBytes <= 6_000, `write +${after.writeBytes - before.writeBytes} B`);
  assert(after.observerReadBytes <= before.observerReadBytes * 1.01, 'observers do not read it');
  t.diagnostic(
    `guard-set gate bytes: read ${after.readBytes - before.readBytes}, write ${after.writeBytes - before.writeBytes}; baseline ${before.readBytes}/${before.writeBytes}; by table ${JSON.stringify(
      Object.fromEntries(
        Object.entries(after.readBytesByTable)
          .map(([table, bytes]) => [table, bytes - (before.readBytesByTable[table] ?? 0)])
          .filter(([, delta]) => delta),
      ),
    )}`,
  );
});

test('a learned guard document rides on the speed row at a measured cost', async t => {
  // The window's 50 failures, each with 8 skipped files: the document at its 4 KB bound.
  let guards;
  for (let i = 0; i < 50; i++)
    guards = addGuardFailure(
      guards,
      {
        id: randomUUID(),
        testFiles: {
          failed: Array.from({ length: 8 }, (_, n) => ({ file: `tests/guard-${i}-${n}.test.mjs` })),
        },
      },
      { ran: '' },
      Date.now() - i,
    );
  const empty = '{"v":1,"failures":[]}';
  const before = await solo(t, { moveMain: true, durations: true, guard: true, guards: empty });
  const after = await solo(t, { moveMain: true, durations: true, guard: true, guards });
  for (const key of ['queries', 'observerQueries', 'mutations', 'v8Actions', 'nodeActions'])
    assert.equal(after[key], before[key], `${key}: no new call`);
  const read = after.readBytes - before.readBytes;
  const write = after.writeBytes - before.writeBytes;
  t.diagnostic(`guard document ${guards.length} B: read +${read} B, write +${write} B per landing`);
  assert(read <= 8_000 && write <= 8_000, `read +${read} B, write +${write} B`);
});

test('overlap driver bytes include changed peers, presence, board and public identity mapping', async t => {
  const f = await finishFixture(t);
  const project = f.tables.hostedProjects.get(f.projectId);
  f.patch('hostedProjects', f.projectId, {
    agentGuidance: 'synthetic'.repeat(2000),
    autonomyPolicy: {
      ...project.autonomyPolicy,
      agentDefaults: { ...project.autonomyPolicy.agentDefaults, dormantAfterDays: 0 },
    },
  });
  f.insert('forgeAccounts', { owner: 'owner', handle: 'synthetic-owner' });
  const member = f.insert('projectContributors', { projectId: f.projectId, contributor: 'viewer' });
  const peer = await f.c.lane(f.lane.state.object);
  f.insert('projectBoardInboxes', {
    projectId: f.projectId,
    key: `lane:${f.lane.laneId}`,
    latestAt: 10,
    count: 1,
  });
  f.insert('projectBoardMessages', {
    projectId: f.projectId,
    id: 'synthetic-driver-note',
    author: 'owner',
    fromLaneId: peer.laneId,
    targetKey: `lane:${f.lane.laneId}`,
    body: 'Synthetic peer note',
    bytes: 19,
    bodyHash: 'synthetic',
    at: 10,
    expiresAt: Date.now() + 86_400_000,
  });
  const records = await import(moduleUrl('../convex/projectHostedRecords.ts'));
  const tracking = await import(moduleUrl('../convex/projectHostedOverlapStore.ts'));
  const overlaps = await import(moduleUrl('../convex/projectHostedOverlaps.ts'));
  const changes = Array.from({ length: 50 }, (_, i) => ({
    path: `src/synthetic-${i}.ts`,
    before: { blob: 'a'.repeat(64), mode: 'file' },
    after: { blob: 'b'.repeat(64), mode: 'file' },
    evidence: { baseBlob: 'a'.repeat(64), ranges: [{ start: 0, end: 1 }], symbols: [] },
  }));
  await f.tx(
    'seedOverlapDriver',
    {
      _handler: async ctx => {
        for (const entry of [f.lane, peer]) {
          const row = await records.readHostedRecord(ctx, {
            projectId: f.projectId,
            actor: 'owner',
            kind: 'lane',
            key: entry.laneId,
          });
          await tracking.trackHostedOverlapLane(ctx, f.projectId, JSON.parse(row.value), {
            baseSequence: 0,
            intent: 'Synthetic driver changes',
            changes,
          });
        }
      },
    },
    {},
  );
  const input = {
    projectId: f.projectId,
    laneId: f.lane.laneId,
    path: 'src/synthetic-0.ts',
    detail: true,
    presence: {},
    board: { after: 0 },
  };
  const from = f.counts.length;
  const response = JSON.parse(await f.tx('driverOverlapRead', overlaps.read, input, 'viewer'));
  assert.equal(f.counts.length - from, 1, 'one query including all public mapping');
  assert.equal(response.peerEvidence.items.length, 1);
  assert(response.presence);
  assert(response.board);
  const measured = f.counts.at(-1);
  t.diagnostic(JSON.stringify({ overlapReadBytes: measured.readBytes, tables: measured.readBytesByTable }));
  const budget = costs.find(c => c.metric === 'overlapReadBytes');
  assert(budget, 'the full overlap query has a byte budget');
  assert.notEqual(judgeCost(budget, measured.readBytes, costGuard).status, 'fail');
  f.tables.projectContributors.delete(member);
  await assert.rejects(
    f.tx('driverOverlapRevoked', overlaps.read, input, 'viewer'),
    error => error.data?.code === 'PROJECT_UNAVAILABLE',
  );
  f.insert('projectReaders', { projectId: f.projectId, reader: 'viewer' });
  const reader = JSON.parse(await f.tx('driverOverlapReader', overlaps.read, input, 'viewer'));
  assert.equal(reader.presence, undefined);
  assert.equal(reader.board, undefined);
  assert(
    !JSON.stringify(reader).includes('synthetic-owner'),
    'read-only access does not name another person',
  );
});

// GitHub pushes pay both the import and the normal landing, independently of the six-Candidate mix.
test('GitHub inbound cost: one changed blob imports, composes, checks, lands and drains without idle work', async t => {
  const f = await finishFixture(t);
  await f.enqueue(f.request());
  await f.drain();
  await f.passChecks();
  await f.drain();
  const inbound = await inboundCostFixture(t, f);
  const m = meter(f);
  await inbound.receive();
  for (let steps = 0; f.pending().length; steps++) {
    assert(steps < 200, 'one push has finite work');
    await f.passChecks();
    const task = f.pending()[0];
    m.tasks.push(task.name);
    await inbound.execute(task);
  }
  const counts = await m.stop();
  const { v8, node } = costGuard.actionModel;
  const measured = {
    ...counts,
    ...inbound.assertLanded(),
    actionGbSeconds: counts.v8Actions * v8.gb * v8.seconds + counts.nodeActions * node.gb * node.seconds,
    checkRuns: runs(f).length - 1,
  };
  t.diagnostic(`inbound ${JSON.stringify(measured)}`);
  const verdicts = judgeCosts(costs, costGuard, 'github-inbound-fixture', measured);
  for (const line of formatCostVerdicts(verdicts)) t.diagnostic(line);
  assert.equal(verdicts.length, 13, 'every inbound quantity is ratcheted in the shared ledger');
  assert.deepEqual(
    verdicts.filter(v => v.status === 'fail').map(v => v.message),
    [],
  );
  const doubled = judgeCosts(costs, costGuard, 'github-inbound-fixture', {
    ...measured,
    readBytes: measured.readBytes * 2,
  }).find(v => v.metric === 'readBytes');
  assert.equal(doubled.status, 'fail', 'duplicate inbound I/O cannot hide in the outbound mix');
  assert.match(doubled.message, /Decision it protects: Issue 3e3f9fe6/);
});

test('storage per landing ratchets every table on fresh and dogfood-shaped checks before and after exhaust expiry', async t => {
  compactDiscardedChecks(t);
  // Candidate 7 adds one numeric cause to the run row and one copy to its
  // compact metrics projection: 10 + 12 JSON bytes on the fresh dispatch,
  // 20 + 24 across the two immediate dogfood dispatches.
  // e3082c24: compact source diagnostics retain up to 200 B per record. On the dogfood
  // fixture the compose and step copies add 121 B and 104 B respectively. Freeze elapsed
  // time so exact JSON byte ceilings measure fields rather than runner load.
  fixedClock(t, { elapsed: true });
  // Item a2457f95: an explicit recipe adds 33 JSON bytes per opted-in check run.
  const scenarios = {
    fresh: await landingStorage(t, false, { capsules: true, journals: true }),
    dogfood: await landingStorage(t, true, { capsules: true, journals: true }),
  };
  t.diagnostic(`storagePerLanding ${JSON.stringify(scenarios)}`);
  // Index entries written 1,539 -> 1,611 fresh and 2,884 -> 3,028 dogfood (Item 9a04d916, compose
  // settle; owner-approved +$0.02/1,000): the scheduler rows of the settle and retry mutations.
  // Stored entries do not grow: a completed task row is not retained.
  // f65d8024: each accepted event adds 33 retained document bytes and 357 modeled
  // index key bytes to the immediate and retained budgets in both scenarios.
  // 9064e885: the existing queue row retains one 55-byte main-receipt pin per project.
  // The acceptance timing evidence adds 50 B fresh and 21 B dogfood to each request.
  // 5e3c3a3c recompose cap: the dogfood request's one main race stores `mainRaces: 1` (+14 B immediate
  // and retained; the journal S2 scenario measures retained at 2,573 B). The capped list lives on the fixed queue row only while one is live.
  // Item 411727ba: the stored-key purge indexes hold one ~115 B entry per object, backup, proposal and upload
  // cleanup row: stored entries 225 -> 231 fresh and 24,789 -> 28,889 dogfood before landing, plus about 8
  // per landing scenario. Index writes stay within budget. The entry lives and dies with its row.
  // 411727ba row 5: the capsule's attempt and plan pins move from the 11-copy pointer row to a
  // 3-copy body row: retained projectFinishReadRows -3,270 B fresh / -4,023 B dogfood,
  // projectHostedLandingBodies +2,840 / +3,352 (about -34 KB per landing at modelled copies).
  // Item 1018d0f8: the real discarded run count rides existing writes. The request row's runnerAccounting keeps
  // `runs` and the last 8 characters of each distinct run id (+31 B fresh, +42/+35 B dogfood); the landing-speed
  // sample stamps it in counts slot 8 (+7 B). The finish-read copies leave it out, so they do not grow.
  // Item 3abaec5e: the terminal path count adds 20 B fresh and 23/16 B dogfood to the existing
  // request, and 22 B fresh and 14 B dogfood to the immediate observation projection. The S2
  // dogfood journal keeps another 7 B of timing on the retained request, as before.
  for (const [name, scenario] of Object.entries(scenarios)) {
    const indexBudget = storageBudgets[name].indexes;
    const aliasBudget = storageBudgets[name].metricAliases;
    assert(scenario.metricAliases.written <= aliasBudget.written, `${name}: metric alias index write budget`);
    assert(
      scenario.indexes.written - scenario.metricAliases.written <= indexBudget.written,
      `${name}: custom index write budget`,
    );
    for (const phase of ['before', 'immediate', 'retained'])
      for (const metric of ['entries', 'keyBytes']) {
        assert(
          scenario.metricAliases[phase][metric] <= aliasBudget[phase][metric],
          `${name}/${phase}: stored metric alias index ${metric} budget`,
        );
        assert(
          scenario.indexes[phase][metric] - scenario.metricAliases[phase][metric] <=
            indexBudget[phase][metric],
          `${name}/${phase}: stored index ${metric} budget`,
        );
      }
    assert.equal(scenario.capsule.classA, 1, `${name}: one complete capsule PUT`);
    assert(scenario.capsule.compressedBytes < 100_000, `${name}: capsule egress budget`);
    // b149b16b: batched capture, 64-row publish and the V8 runtime cut a pack from 28 serial
    // mutations (live dev, Node) to 9 fresh / 10 dogfood here; a serial page loop must not return.
    assert(scenario.capsule.calls <= 10, `${name}: ${scenario.capsule.calls} capsule pack calls > 10`);
    assert.equal(scenario.capsule.runtime, 'v8', `${name}: the packer stays off the 0.5 GB Node runtime`);
    for (const [phase, tables] of Object.entries(scenario.perProject))
      assertFixedProjectStorage(tables, storageBudgets[name].perProject[phase], `${name}/${phase}`);
    for (const [phase, tables] of Object.entries(scenario.perLanding)) {
      for (const [table, stored] of Object.entries(tables)) {
        assert(
          table in storageBudgets[name][phase],
          `${name}/${phase}/${table}: record the new table's storage decision`,
        );
        assert(
          stored <= storageBudgets[name][phase][table],
          `${name}/${phase}/${table}: ${stored} > ${storageBudgets[name][phase][table]} bytes per landing; fix growth or record the Issue's reason and ratchet`,
        );
      }
    }
  }
});

test('fixed per-project storage cannot hide duplicate rows or landing history behind the accounting split', async () => {
  const f = await acceptanceFixture();
  const { trackHostedOverlapMain } = await import(moduleUrl('../convex/projectHostedOverlapStore.ts'));
  const paths = Array.from({ length: 128 }, (_, i) => `src/file-${i}.ts`);
  const advance = sequence =>
    f.transaction(
      'fixedStorageHistory',
      {
        _handler: ctx => trackHostedOverlapMain(ctx, f.projectId, sequence, paths),
      },
      {},
    );
  await advance(1000);
  const baseline = fixedProjectStorage(f);
  // More than the 64-entry log window, with fixed-width sequence numbers: updating latest
  // touches must not retain another main row or append history inside the singleton.
  for (let sequence = 1001; sequence <= 1128; sequence++) {
    await advance(sequence);
    const current = fixedProjectStorage(f);
    assertFixedProjectStorage(current, storageBudgets.dogfood.perProject.retained, 'history');
    assert.deepEqual(current, baseline, 'the same paths and project retain no per-landing history');
  }
  assert.equal(f.tables.projectHostedOverlapMainLog.size, 64, 'the separate history log stays bounded');
  const row = [...f.tables.projectHostedOverlapMain.values()][0];
  f.patch('projectHostedOverlapMain', row._id, { changes: row.changes + ' '.repeat(100_000) });
  assert.throws(
    () =>
      assertFixedProjectStorage(
        fixedProjectStorage(f),
        storageBudgets.dogfood.perProject.retained,
        'history',
      ),
    /bytes per project/,
    'history appended inside the existing row must fail the byte ratchet',
  );
  f.patch('projectHostedOverlapMain', row._id, { changes: row.changes });
  const { _id, _creationTime, ...duplicate } = row;
  f.insert('projectHostedOverlapMain', duplicate);
  assert.throws(
    () =>
      assertFixedProjectStorage(
        fixedProjectStorage(f),
        storageBudgets.dogfood.perProject.retained,
        'history',
      ),
    /rows per project/,
    'another singleton copy must fail even when both rows fit the byte budget',
  );
});
