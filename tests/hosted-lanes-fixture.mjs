// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { moduleUrl } from './convex-module.mjs';
import { checkArgs, checkDocument, insertedDocument, updatedDocument } from './convex-args.mjs';
import { validateContext } from './convex-context.mjs';
const { finishReadWriter } = await import(moduleUrl('../convex/projectFinishReadWriter.ts'));
const {
  finishReadProjection,
  finishReadFields,
  finishOwnerProjection,
  finishPeerProjection,
  finishAheadQueueProjection,
} = await import(moduleUrl('../convex/projectFinishReadProjection.ts'));
const schema = (await import(moduleUrl('../convex/schema.ts'))).default;
const { overlapPeerOf } = await import(moduleUrl('../src/hosted-overlap-peer.ts'));
const githubBindings = await import(moduleUrl('../convex/githubBindingStore.ts'));
const bytes = value => Buffer.byteLength(JSON.stringify(value));
const encoded = rows => JSON.stringify(rows);

/** Snapshot transactions with indexed read-range OCC (including missing keys).
 * Concurrent commits retry only when a read document/range actually changed.
 * All counters describe matched provider ranges, never the fake's JS scans. */
export function lanesFixture() {
  const tables = Object.fromEntries(Object.keys(schema.tables).map(name => [name, new Map()]));
  const counts = [];
  let serial = 0,
    decorate,
    lastReadSet;
  /** Direct edits of an overlap row (seeding, aging) keep its slim peer row equal, as every production
   * writer does in its own transaction (convex/projectHostedOverlapPeers.ts). */
  const syncPeer = row => {
    const value = overlapPeerOf(row);
    const old = [...tables.projectHostedOverlapPeers.values()].find(
      peer => peer.projectId === value.projectId && peer.laneId === value.laneId,
    );
    if (old) tables.projectHostedOverlapPeers.set(old._id, updatedDocument(old, value, true));
    else {
      const _id = `projectHostedOverlapPeers-${++serial}`;
      tables.projectHostedOverlapPeers.set(
        _id,
        insertedDocument(schema, 'projectHostedOverlapPeers', value, _id, serial),
      );
    }
  };
  const insert = (table, value) => {
    const _id = `${table}-${++serial}`;
    tables[table].set(_id, insertedDocument(schema, table, value, _id, serial));
    if (table === 'projectHostedOverlapLanes') syncPeer(tables[table].get(_id));
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
        view = table => written[table] ?? baseline[table],
        writable = table => (written[table] ??= new Map(baseline[table])),
        reads = [],
        writes = [];
      // A Convex query function may run one paginate(); a second fails in production only (mutations are exempt).
      let paginations = 0;
      const meter = {
        name,
        retries,
        ranges: 0,
        documents: 0,
        readBytes: 0,
        readDocumentsByTable: {},
        readRangesByTable: {},
        readBytesByTable: {},
        writes: 0,
        writeBytes: 0,
        writeBytesByTable: {},
        touched: [],
        written: [],
      };
      const read = (table, select) => {
        meter.touched.push(table);
        const rows = select(view(table));
        const original = encoded(select(baseline[table]));
        reads.push(() => encoded(select(tables[table])) === original);
        meter.ranges++;
        meter.readRangesByTable[table] = (meter.readRangesByTable[table] ?? 0) + 1;
        meter.documents += Math.max(1, rows.length);
        meter.readDocumentsByTable[table] =
          (meter.readDocumentsByTable[table] ?? 0) + Math.max(1, rows.length);
        const readBytes = rows.reduce((n, row) => n + bytes(row), 0);
        meter.readBytes += readBytes;
        meter.readBytesByTable[table] = (meter.readBytesByTable[table] ?? 0) + readBytes;
        assert(meter.documents <= 4096 && meter.ranges <= 4096, `${name}: Convex read budget`);
        assert(meter.readBytes < 16 * 1024 * 1024, `${name}: Convex read bytes`);
        return structuredClone(rows);
      };
      const put = (table, id, row) => {
        row = checkDocument(schema, table, row);
        assert(bytes(row) < 1024 * 1024, `${name}: document size`);
        writable(table).set(id, structuredClone(row));
        writes.push([table, id, structuredClone(row)]);
        meter.written.push(table);
        meter.writes++;
        meter.writeBytes += bytes(row);
        meter.writeBytesByTable[table] = (meter.writeBytesByTable[table] ?? 0) + bytes(row);
        assert(meter.writes <= 8192 && meter.writeBytes < 16 * 1024 * 1024, `${name}: Convex writes`);
      };
      const locate = id => Object.keys(baseline).find(table => view(table).has(id));
      const ctx = validateContext({
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
              return null;
            }
            return read(table, rows => [rows.get(id) ?? null])[0];
          },
          delete: async id => {
            const table = locate(id);
            if (!table) return;
            writable(table).delete(id);
            writes.push([table, id, null]);
            meter.written.push(table);
            meter.writes++;
          },
          insert: async (table, value) => {
            const id = `${table}-${++serial}`;
            put(table, id, insertedDocument(schema, table, value, id, serial));
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
              descending = false;
            const q = {
              withIndex: (name, build) => {
                const index = schema.tables[table].export().indexes.find(i => i.indexDescriptor === name);
                assert(index, `${table}.${name}`);
                indexFields = index.fields;
                const terms = [];
                let lower = null,
                  upper = null;
                const bounds = {
                  lte(field, value) {
                    assert.equal(field, index.fields[terms.length], 'index upper-bound order');
                    upper = [field, value, true];
                    return bounds;
                  },
                  lt(field, value) {
                    assert.equal(field, index.fields[terms.length], 'index upper-bound order');
                    upper = [field, value, false];
                    return bounds;
                  },
                  gt(field, value) {
                    assert.equal(field, index.fields[terms.length], 'index lower-bound order');
                    lower = [field, value];
                    return bounds;
                  },
                  eq(field, value) {
                    assert.equal(field, index.fields[terms.length], 'index order');
                    terms.push([field, value]);
                    return bounds;
                  },
                };
                build(bounds);
                match = rows =>
                  [...rows.values()]
                    .filter(
                      row =>
                        terms.every(([k, v]) => row[k] === v) &&
                        (!lower || row[lower[0]] > lower[1]) &&
                        (!upper || row[upper[0]] < upper[1] || (upper[2] && row[upper[0]] === upper[1])),
                    )
                    .sort((a, b) => {
                      for (const field of index.fields) {
                        if (a[field] !== b[field]) return a[field] < b[field] ? -1 : 1;
                      }
                      return a._creationTime - b._creationTime;
                    });
                return q;
              },
              order: direction => {
                descending = direction === 'desc';
                return q;
              },
              take: async n => {
                assert(match, 'indexed reads only');
                return read(table, rows =>
                  match(rows)
                    .sort((a, b) => {
                      for (const field of [...indexFields, '_creationTime']) {
                        if (a[field] === b[field]) continue;
                        return (a[field] < b[field] ? -1 : 1) * (descending ? -1 : 1);
                      }
                      return 0;
                    })
                    .slice(0, n),
                );
              },
              first: async () => (await q.take(1))[0] ?? null,
              unique: async () => {
                assert(match, 'indexed reads only');
                const rows = read(table, match);
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
                  read(table, rows => {
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
                const rows = read(table, all => {
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
      try {
        if (decorate) await decorate(ctx, input, name);
        const result = await fn._handler(fn.isQuery ? ctx : finishReadWriter(ctx), input);
        if (reads.every(unchanged => unchanged())) {
          for (const [table, id, row] of writes) {
            if (row === null) tables[table].delete(id);
            else tables[table].set(id, row);
          }
          // Build-failing guard: no production write of an overlap row may leave its slim peer row
          // behind (convex/projectHostedOverlapPeers.ts); every test through this fixture checks it.
          for (const id of new Set(
            writes.filter(([table]) => table === 'projectHostedOverlapLanes').map(w => w[1]),
          )) {
            const row = tables.projectHostedOverlapLanes.get(id);
            if (!row) continue;
            const peer = [...tables.projectHostedOverlapPeers.values()].find(
              r => r.projectId === row.projectId && r.laneId === row.laneId,
            );
            assert(peer, `${name}: overlap row ${row.laneId} written without its slim peer row`);
            const { _id, _creationTime, ...stored } = peer;
            assert.deepEqual(
              stored,
              overlapPeerOf(row),
              `${name}: slim peer row differs from its overlap row`,
            );
          }
          if (name === 'observerBudgetPage') lastReadSet = () => reads.every(unchanged => unchanged());
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
      installationId,
      state,
      verifier: 'synthetic-owner-proof',
      authorizeUrl: `https://github.com/login/oauth/authorize?state=${state}`,
    });
    await call('githubBindingConsume', githubBindings.consume, { state });
    await call('githubBindingComplete', githubBindings.complete, {
      state,
      repoId,
      fullName: repository,
    });
  }
  return {
    bindRepository,
    tables,
    counts,
    insert,
    call,
    transaction: call,
    readSet: () => lastReadSet,
    decorateContext(fn) {
      decorate = fn;
    },
    patch(table, id, value) {
      const row = checkDocument(schema, table, updatedDocument(tables[table].get(id), value));
      tables[table].set(id, row);
      if (table === 'projectHostedOverlapLanes') syncPeer(row);
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
