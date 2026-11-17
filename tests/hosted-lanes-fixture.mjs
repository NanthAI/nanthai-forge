// SPDX-License-Identifier: Apache-2.0
import { assertWorkRecordDomain } from './work-record-domain-fixture.mjs';
import assert from 'node:assert/strict';
import { indexEntriesPerWrite } from './convex-index-cost.mjs';
import { randomUUID } from 'node:crypto';
import { moduleUrl } from './convex-module.mjs';
import { checkArgs, checkDocument, checkReturn, insertedDocument, updatedDocument } from './convex-args.mjs';
import { validateContext } from './convex-context.mjs';
const { finishReadWriter } = await import(moduleUrl('../convex/projectFinishReadWriter.ts'));
const { landingRequestBodies } = await import(moduleUrl('../convex/projectLandingRequestBody.ts'));
const {
  finishReadProjection,
  finishReadFields,
  finishOwnerProjection,
  finishPeerProjection,
  finishAheadQueueProjection,
} = await import(moduleUrl('../convex/projectFinishReadProjection.ts'));
const schema = (await import(moduleUrl('../convex/schema.ts'))).default;
const githubBindings = await import(moduleUrl('../convex/githubBindingStore.ts'));
const bytes = value => Buffer.byteLength(JSON.stringify(value));
const encoded = rows => JSON.stringify(rows);
const fieldValue = (row, path) =>
  path.includes('.') ? path.split('.').reduce((value, part) => value?.[part], row) : row[path];

/** Snapshot transactions with indexed read-range OCC (including missing keys).
 * Concurrent commits retry only when a read document/range actually changed.
 * All counters describe matched provider ranges, never the fake's JS scans. */
export function lanesFixture({ legacyWorkRecords = false } = {}) {
  const wallClockTables = new Set(['projectHostedOperations']);
  const tables = Object.fromEntries(Object.keys(schema.tables).map(name => [name, new Map()]));
  const counts = [];
  const scheduled = [];
  let serial = 0,
    decorate,
    lastReadSet;
  const insert = (table, value) => {
    assertWorkRecordDomain(table, value, legacyWorkRecords);
    const _id = `${table}-${++serial}`;
    tables[table].set(_id, insertedDocument(schema, table, value, _id, serial));
    return _id;
  };
  async function call(name, fn, input, actor = 'owner') {
    if (fn.exportArgs) checkArgs(fn, input, name);
    let retries = 0;
    for (;;) {
      // Rows are immutable once committed: reads return clones and writes replace the row
      // object, so a snapshot copies the row index, never the documents. Deep-cloning every
      // table per transaction made each call cost the whole database (quadratic in a queue run).
      // The transaction's own writes copy a table's index on first write only.
      const baseline = Object.fromEntries(
          Object.entries(tables).map(([table, rows]) => [table, new Map(rows)]),
        ),
        written = {},
        equalityIndexes = new WeakMap(),
        view = table => written[table] ?? baseline[table],
        writable = table => (written[table] ??= new Map(baseline[table])),
        reads = [],
        writes = [],
        observedRows = new WeakSet();
      // A Convex query function may run one paginate(); a second fails in production only (mutations are exempt).
      let paginations = 0;
      const meter = {
        name,
        // Query or mutation, for per-kind call counts (the landing cost guard).
        query: !!fn.isQuery,
        retries,
        ranges: 0,
        documents: 0,
        returnedDocuments: 0,
        readBytes: 0,
        readDocumentsByTable: {},
        readRangesByTable: {},
        readBytesByTable: {},
        duplicateReadDocumentsByTable: {},
        duplicateReadBytesByTable: {},
        writes: 0,
        indexEntriesWritten: 0,
        indexEntriesRemoved: 0,
        writeBytes: 0,
        writeBytesByTable: {},
        touched: [],
        written: [],
        cancelledRuns: [],
        liveLine: {
          metaReads: 0,
          metaRanges: 0,
          metaReadBytes: 0,
          metaWrites: 0,
          metaWriteBytes: 0,
          markReads: 0,
          markRanges: 0,
          markReadBytes: 0,
          markWrites: 0,
          markWriteBytes: 0,
        },
      };
      const lineKind = (table, row, hint) =>
        table === 'projectLiveLineLanes'
          ? 'mark'
          : table === 'projectFinishReadRows' && String(row?.kind ?? hint ?? '').startsWith('projectLiveLine')
            ? 'meta'
            : null;
      const lineWrite = (table, row, size = 0) => {
        const kind = lineKind(table, row);
        if (kind) {
          meter.liveLine[`${kind}Writes`]++;
          meter.liveLine[`${kind}WriteBytes`] += size;
        }
      };
      const read = (table, select, hint) => {
        meter.touched.push(table);
        const current = view(table),
          rows = select(current);
        for (const kind of ['mark', 'meta']) {
          const selected = rows.filter(row => row && lineKind(table, row) === kind);
          if (selected.length || (!rows.filter(Boolean).length && lineKind(table, null, hint) === kind)) {
            meter.liveLine[`${kind}Reads`] += Math.max(1, selected.length);
            meter.liveLine[`${kind}Ranges`]++;
            meter.liveLine[`${kind}ReadBytes`] += selected.reduce((n, row) => n + bytes(row), 0);
          }
        }
        const original = encoded(current === baseline[table] ? rows : select(baseline[table]));
        reads.push(() => encoded(select(tables[table])) === original);
        meter.ranges++;
        meter.readRangesByTable[table] = (meter.readRangesByTable[table] ?? 0) + 1;
        meter.returnedDocuments += rows.filter(Boolean).length;
        meter.documents += Math.max(1, rows.length);
        meter.readDocumentsByTable[table] =
          (meter.readDocumentsByTable[table] ?? 0) + Math.max(1, rows.length);
        // The immutable snapshot object changes after a write. Only identical versions
        // read again in this transaction count as potentially reusable snapshots.
        for (const row of rows.filter(Boolean)) {
          if (observedRows.has(row)) {
            meter.duplicateReadDocumentsByTable[table] =
              (meter.duplicateReadDocumentsByTable[table] ?? 0) + 1;
            meter.duplicateReadBytesByTable[table] =
              (meter.duplicateReadBytesByTable[table] ?? 0) + bytes(row);
          }
          observedRows.add(row);
        }
        const readBytes = rows.reduce((n, row) => n + bytes(row), 0);
        meter.readBytes += readBytes;
        meter.readBytesByTable[table] = (meter.readBytesByTable[table] ?? 0) + readBytes;
        assert(meter.documents <= 4096 && meter.ranges <= 4096, `${name}: Convex read budget`);
        assert(meter.readBytes < 16 * 1024 * 1024, `${name}: Convex read bytes`);
        return structuredClone(rows);
      };
      // Cache repeated equality prefixes per immutable transaction snapshot. A
      // single lookup scans once without allocating a whole-table group index.
      // Provider counters still count every real lookup, including misses and OCC reads.
      // Own writes invalidate the writable view; OCC evaluates live tables only
      // synchronously at commit, so it sees concurrent changes afresh.
      const equalRows = (rows, terms) => {
        if (!terms.length || terms.some(([, value]) => value !== null && typeof value === 'object'))
          return [...rows.values()];
        let indexes = equalityIndexes.get(rows);
        if (!indexes) equalityIndexes.set(rows, (indexes = new Map()));
        const fields = terms.map(([field]) => field),
          key = JSON.stringify(fields);
        const prior = indexes.get(key) ?? 0;
        if (typeof prior === 'number' && prior < 8) {
          indexes.set(key, prior + 1);
          return [...rows.values()];
        }
        if (typeof prior === 'number') {
          const groups = new Map();
          for (const row of rows.values()) {
            let group = groups;
            for (const [at, field] of fields.entries()) {
              const value = fieldValue(row, field);
              if (!group.has(value)) group.set(value, at === fields.length - 1 ? [] : new Map());
              group = group.get(value);
            }
            group.push(row);
          }
          indexes.set(key, groups);
        }
        let group = indexes.get(key);
        for (const [, value] of terms) {
          group = group.get(value);
          if (!group) return [];
        }
        return group;
      };
      const runStatus = row => {
        try {
          return JSON.parse(row?.value ?? 'null')?.status;
        } catch {
          return undefined;
        }
      };
      const put = (table, id, row) => {
        row = checkDocument(schema, table, row);
        if (
          table === 'projectHostedCheckRuns' &&
          runStatus(row) === 'cancelled' &&
          runStatus(view(table).get(id)) !== 'cancelled'
        )
          meter.cancelledRuns.push({
            attributed: !!row.cancelledUsage,
            members: row.cancelledUsage?.submissions.length ?? 0,
          });
        assert(bytes(row) < 1024 * 1024, `${name}: document size`);
        equalityIndexes.delete(writable(table));
        writable(table).set(id, structuredClone(row));
        writes.push([table, id, structuredClone(row)]);
        meter.written.push(table);
        meter.indexEntriesWritten += indexEntriesPerWrite(schema, table);
        meter.writes++;
        meter.writeBytes += bytes(row);
        lineWrite(table, row, bytes(row));
        // Keep real totals intact; controller-only guards account for delayed retention
        // allocations separately. The landing cost guard still prices all of these bytes.
        if (table === '_scheduled_functions' && row.name?.startsWith('projectOperationalExpiry:')) {
          meter.maintenanceWrites = (meter.maintenanceWrites ?? 0) + 1;
          meter.maintenanceWriteBytes = (meter.maintenanceWriteBytes ?? 0) + bytes(row);
        }
        meter.writeBytesByTable[table] = (meter.writeBytesByTable[table] ?? 0) + bytes(row);
        assert(meter.writes <= 8192 && meter.writeBytes < 16 * 1024 * 1024, `${name}: Convex writes`);
      };
      const locate = id => Object.keys(baseline).find(table => view(table).has(id));
      const ctx = validateContext({
        meta: {
          getRequestMetadata: async () => ({ scheduledFunctionId: null }),
          getTransactionMetrics: async () => ({
            databaseQueries: { used: meter.ranges, remaining: 4096 - meter.ranges },
            bytesRead: { used: meter.readBytes, remaining: 16 * 1024 * 1024 - meter.readBytes },
          }),
        },
        // Scheduled work is recorded, never run (a save's trial merge, flip 4): tests read `scheduled`.
        scheduler: {
          runAfter: async (delay, fn, args) => {
            scheduled.push({ fn, args, delay });
            return `scheduled-${scheduled.length}`;
          },
          runAt: async (at, fn, args) => {
            scheduled.push({ fn, args, at });
            return `scheduled-${scheduled.length}`;
          },
          cancel: async () => {},
        },
        auth: {
          getUserIdentity: async () =>
            actor === null ? null : typeof actor === 'object' ? actor : { subject: actor },
        },
        db: {
          normalizeId: (table, id) => (id.startsWith(`${table}-`) ? id : null),
          get: async id => {
            const table = locate(id);
            if (!table) {
              meter.documents++;
              meter.ranges++;
              assert(meter.documents <= 4096 && meter.ranges <= 4096, `${name}: Convex read budget`);
              return null;
            }
            return read(table, rows => [rows.get(id) ?? null])[0];
          },
          delete: async id => {
            const table = locate(id);
            if (!table) return;
            lineWrite(table, view(table).get(id));
            equalityIndexes.delete(writable(table));
            writable(table).delete(id);
            meter.indexEntriesRemoved += indexEntriesPerWrite(schema, table);
            writes.push([table, id, null]);
            meter.written.push(table);
            meter.writes++;
          },
          insert: async (table, value) => {
            assertWorkRecordDomain(table, value, legacyWorkRecords);
            const id = `${table}-${++serial}`;
            // Real creation times are wall-clock; retention checks (Issue b78ca196) compare them with Date.now().
            // Operation receipts (expiry at 90 days) get wall-clock times, or every receipt would look
            // expired. Calendar tests opt their receipt tables in; others keep serial order.
            const at = wallClockTables.has(table);
            put(
              table,
              id,
              insertedDocument(schema, table, value, id, at ? Date.now() + serial / 1000 : serial),
            );
            return id;
          },
          replace: async (id, value) => {
            const table = locate(id),
              old = view(table).get(id);
            put(table, id, updatedDocument(old, value, true));
          },
          patch: async (id, value) => {
            const table = locate(id);
            put(table, id, updatedDocument(view(table).get(id), value));
          },
          query: table => {
            let match,
              indexFields,
              kindHint,
              descending = false;
            const queryRead = select => read(table, select, kindHint);
            const q = {
              withIndex: (name, build) => {
                const index =
                  name === 'by_creation_time'
                    ? { fields: [] }
                    : schema.tables[table].export().indexes.find(i => i.indexDescriptor === name);
                assert(index, `${table}.${name}`);
                indexFields = index.fields;
                // Provider indexes end in implicit creation time and id, including exact tie cursors.
                const keyFields = [...index.fields, '_creationTime', '_id'];
                const terms = [];
                let lower = null,
                  upper = null;
                const bounds = {
                  lte(field, value) {
                    assert.equal(field, keyFields[terms.length], 'index upper-bound order');
                    upper = [field, value, true];
                    return bounds;
                  },
                  lt(field, value) {
                    assert.equal(field, keyFields[terms.length], 'index upper-bound order');
                    upper = [field, value, false];
                    return bounds;
                  },
                  gt(field, value) {
                    assert.equal(field, keyFields[terms.length], 'index lower-bound order');
                    lower = [field, value, false];
                    return bounds;
                  },
                  gte(field, value) {
                    assert.equal(field, keyFields[terms.length], 'index lower-bound order');
                    lower = [field, value, true];
                    return bounds;
                  },
                  eq(field, value) {
                    assert.equal(field, keyFields[terms.length], 'index order');
                    terms.push([field, value]);
                    return bounds;
                  },
                };
                build(bounds);
                kindHint = terms.find(([field]) => field === 'kind')?.[1];
                match = rows =>
                  equalRows(rows, terms)
                    .filter(
                      row =>
                        terms.every(([k, v]) => fieldValue(row, k) === v) &&
                        (!lower ||
                          fieldValue(row, lower[0]) > lower[1] ||
                          (lower[2] && fieldValue(row, lower[0]) === lower[1])) &&
                        (!upper ||
                          fieldValue(row, upper[0]) < upper[1] ||
                          (upper[2] && fieldValue(row, upper[0]) === upper[1])),
                    )
                    .sort((a, b) => {
                      for (const field of index.fields) {
                        if (fieldValue(a, field) !== fieldValue(b, field))
                          return fieldValue(a, field) < fieldValue(b, field) ? -1 : 1;
                      }
                      return a._creationTime - b._creationTime;
                    });
                return q;
              },
              filter: build => {
                const predicate = build({
                  field: name => row => row[name],
                  neq: (value, expected) => row => value(row) !== expected,
                });
                const indexed = match;
                match = rows => indexed(rows).filter(predicate);
                return q;
              },
              order: direction => {
                descending = direction === 'desc';
                return q;
              },
              take: async n => {
                assert(match, 'indexed reads only');
                return queryRead(rows =>
                  match(rows)
                    .sort((a, b) => {
                      for (const field of [...indexFields, '_creationTime']) {
                        if (fieldValue(a, field) === fieldValue(b, field)) continue;
                        return (fieldValue(a, field) < fieldValue(b, field) ? -1 : 1) * (descending ? -1 : 1);
                      }
                      return 0;
                    })
                    .slice(0, n),
                );
              },
              first: async () => (await q.take(1))[0] ?? null,
              unique: async () => {
                assert(match, 'indexed reads only');
                const rows = queryRead(match);
                assert(rows.length <= 1, 'unique index');
                return rows[0] ?? null;
              },
              [Symbol.asyncIterator]: async function* () {
                assert(match, 'indexed reads only');
                const ordered = match(view(table));
                if (descending) ordered.reverse();
                let consumed = 0;
                try {
                  for (const row of ordered) {
                    consumed++;
                    yield structuredClone(row);
                  }
                } finally {
                  // Lazy like Convex: only the rows the loop consumed are read and metered.
                  queryRead(rows => {
                    const all = match(rows);
                    if (descending) all.reverse();
                    return all.slice(0, consumed);
                  });
                }
              },
              paginate: async ({ cursor, numItems, maximumRowsRead, maximumBytesRead }) => {
                assert(match, 'indexed reads only');
                assert(
                  !fn.isQuery || ++paginations === 1,
                  'This query function ran multiple paginated queries. Convex only supports a single paginated query in each query function.',
                );
                const start = Number(cursor ?? 0);
                const rows = queryRead(all => {
                  const result = [];
                  let total = 0;
                  for (const row of match(all).slice(
                    start,
                    start + Math.min(numItems, maximumRowsRead ?? numItems),
                  )) {
                    if (result.length && total + bytes(row) > maximumBytesRead) break;
                    result.push(row);
                    total += bytes(row);
                  }
                  return result;
                });
                const length = match(view(table)).length;
                return {
                  page: rows,
                  isDone: start + rows.length >= length,
                  continueCursor: String(start + rows.length),
                };
              },
            };
            return q;
          },
        },
      });
      // System task reads use the same metered transaction snapshot as ordinary rows.
      // Scheduler decorators with a separate task store override this alongside scheduling.
      ctx.db.system = { get: ctx.db.get };
      const unchanged = () => {
        // A retained read set can be checked again after later transactions.
        // Rebuild each live-table equality index once for this validation.
        for (const table of new Set(meter.touched)) equalityIndexes.delete(tables[table]);
        return reads.every(unchanged => unchanged());
      };
      try {
        if (decorate) await decorate(ctx, input, name);
        const result = await fn._handler(
          landingRequestBodies(fn.isQuery ? ctx : finishReadWriter(ctx)),
          input,
        );
        // Convex rejects an oversized return value, which rolls the mutation back.
        if (fn.exportArgs) checkReturn(result, name);
        if (unchanged()) {
          for (const [table, id, row] of writes) {
            if (row === null) tables[table].delete(id);
            else tables[table].set(id, row);
          }
          if (name === 'observerBudgetPage') lastReadSet = unchanged;
          counts.push(meter);
          return result;
        }
      } catch (error) {
        counts.push(meter);
        throw error;
      }
      counts.push(meter);
      assert(++retries < 5, 'bounded fake OCC retries');
    }
  }
  // Synthetic owner proof uses the same retained operation and store as github connect.
  // Merely creating a Lane store leaves it unbound, including refusal-test fixtures.
  async function bindRepository(projectId, { repository, repoId, installationId = 9 }) {
    const state = randomUUID();
    await call('githubBindingStart', githubBindings.start, {
      projectId,
      operationId: randomUUID(),
      repository: repository.toLowerCase(),
      githubAccounts: ['1001'],
      state,
      verifier: 'synthetic-owner-proof',
      authorizeUrl: `https://github.com/login/oauth/authorize?state=${state}`,
    });
    await call('githubBindingConsume', githubBindings.consume, { state });
    await call('githubBindingPin', githubBindings.pin, { state, installationId });
    await call('githubBindingComplete', githubBindings.complete, {
      state,
      repoId,
      fullName: repository,
    });
  }
  return {
    wallClockTables,
    bindRepository,
    scheduled,
    tables,
    counts,
    insert,
    call,
    transaction: call,
    readSet: () => lastReadSet,
    decorateContext(fn) {
      decorate = fn;
    },
    extendContext(fn) {
      const previous = decorate;
      decorate = async (...args) => {
        await previous?.(...args);
        return fn(...args);
      };
    },
    patch(table, id, value) {
      const row = checkDocument(schema, table, updatedDocument(tables[table].get(id), value));
      tables[table].set(id, row);
      if (table in finishReadFields) {
        const projection = finishReadProjection(table, row);
        const old = [...tables.projectFinishReadRows.values()].find(
          r => r.kind === table && r.sourceId === id,
        );
        if (old) tables.projectFinishReadRows.set(old._id, { ...old, ...projection });
        else insert('projectFinishReadRows', projection);
        if (table === 'projectHostedLandingRequests') {
          const peer = finishPeerProjection(row);
          const oldPeer = [...tables.projectFinishReadRows.values()].find(
            r => r.kind === peer.kind && r.sourceId === id,
          );
          if (oldPeer) tables.projectFinishReadRows.set(oldPeer._id, { ...oldPeer, ...peer });
          else insert('projectFinishReadRows', peer);
        }
        if (table === 'projectHostedLandingQueues') {
          const ahead = finishAheadQueueProjection(row);
          const oldAhead = [...tables.projectFinishReadRows.values()].find(
            r => r.kind === ahead.kind && r.sourceId === id,
          );
          if (oldAhead) tables.projectFinishReadRows.set(oldAhead._id, { ...oldAhead, ...ahead });
          else insert('projectFinishReadRows', ahead);
        }
        if (table === 'projectHostedFinishes') {
          const owner = finishOwnerProjection(row);
          const oldOwner = [...tables.projectFinishReadRows.values()].find(
            r => r.kind === owner.kind && r.sourceId === id,
          );
          if (oldOwner) tables.projectFinishReadRows.set(oldOwner._id, { ...oldOwner, ...owner });
          else insert('projectFinishReadRows', owner);
        }
      }
    },
  };
}
