// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { moduleUrl } from './convex-module.mjs';
import { checkArgs, checkDocument } from './convex-args.mjs';
const api = await import(moduleUrl('../convex/projectSelfMetrics.ts'));
const bills = await import(moduleUrl('../convex/projectSelfMetricBills.ts'));
const placement = await import(moduleUrl('../convex/projectBytePlacement.ts'));
const handlers = {
  'projectSelfMetrics:page': api.page,
  'projectSelfMetricBills:page': bills.page,
  'projectBytePlacement:convexWritten': placement.convexWritten,
};
const schema = (await import(moduleUrl('../convex/schema.ts'))).default;
export const period = { from: '2026-10-28T00:00:00.000Z', to: '2026-11-04T00:00:00.000Z' };
export const seam = '2026-10-28T00:00:00.000Z';
export const at = minutes => new Date(Date.parse(seam) + minutes * 60000).toISOString();
export const empty = () => ({ moves: [], submissions: [], runs: [], receipts: [], gaps: [] });

// Indexed ranges and real registered argument validators; no source, filesystem,
// scheduler or write capability exists in the query context. Count point misses too.
export function fixture() {
  const tables = Object.fromEntries(Object.keys(schema.tables).map(table => [table, []]));
  const meter = { calls: 0, documents: 0, writes: 0, maxPage: 0 };
  const project = {
    _id: 'project',
    _creationTime: 0,
    key: 'synthetic',
    name: 'Synthetic',
    currentBackup: null,
    revision: 1,
    owner: 'owner',
    visibility: 'public',
    sourceAuthority: { mode: 'server', epoch: 2 },
    sourceCutover: { at: seam, minimumCliVersion: '0.3.1' },
  };
  tables.hostedProjects.push(project);
  const documentsById = new Map([[project._id, project]]);
  let actor = 'owner';
  const field = (row, path) => path.split('.').reduce((value, key) => value?.[key], row);
  const put = (table, row, time) => {
    const doc = { ...row, _id: `${table}-${tables[table].length}`, _creationTime: Date.parse(time) };
    checkDocument(schema, table, doc);
    tables[table].push(doc);
    documentsById.set(doc._id, doc);
    return doc;
  };
  const read = rows => {
    meter.documents += Math.max(1, rows.length);
    return structuredClone(rows);
  };
  const ctx = {
    auth: { getUserIdentity: async () => (actor ? { subject: actor } : null) },
    db: {
      // Convex file storage, newest first; nothing writes it, so it is empty.
      system: {
        query: table => {
          assert.equal(table, '_storage');
          return {
            order: () => ({
              paginate: async () => {
                meter.documents++;
                return { page: [], isDone: true, continueCursor: '' };
              },
            }),
          };
        },
      },
      insert: async (table, row) => {
        meter.writes++;
        return put(table, row, new Date().toISOString())._id;
      },
      get: async id => {
        const row =
          documentsById.get(id) ??
          Object.values(tables)
            .flat()
            .find(row => row._id === id);
        return read(row ? [row] : [])[0] ?? null;
      },
      query: table => {
        let selected,
          descending = false;
        const q = {
          withIndex(index, build) {
            const spec = schema.tables[table].export().indexes.find(row => row.indexDescriptor === index);
            assert(spec, `${table}.${index}`);
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
            selected = tables[table]
              .filter(row => predicates.every(predicate => predicate(row)))
              .sort((a, b) => a._creationTime - b._creationTime);
            return q;
          },
          order(direction) {
            descending = direction === 'desc';
            return q;
          },
          async first() {
            assert(selected);
            return read(selected.slice(0, 1))[0] ?? null;
          },
          async unique() {
            assert(selected);
            assert(selected.length <= 1);
            return read(selected)[0] ?? null;
          },
          async paginate(options) {
            assert(selected);
            assert(options.numItems <= 100);
            assert(options.maximumRowsRead <= 100);
            assert(options.maximumBytesRead <= 512 * 1024);
            const rows = descending ? selected.toReversed() : selected;
            const offset = Number(options.cursor ?? 0),
              page = [];
            let bytes = 0;
            for (const row of rows.slice(offset, offset + options.numItems)) {
              const size = Buffer.byteLength(JSON.stringify(row));
              if (page.length && bytes + size > options.maximumBytesRead) break;
              bytes += size;
              page.push(row);
            }
            meter.maxPage = Math.max(meter.maxPage, page.length);
            return {
              page: read(page),
              isDone: offset + page.length >= rows.length,
              continueCursor: String(offset + page.length),
            };
          },
        };
        return q;
      },
    },
  };
  const query = async (name, args) => {
    const handler = handlers[name];
    assert(handler, name);
    meter.calls++;
    const input = { ...args, projectId: project._id };
    checkArgs(handler, input, name);
    return handler._handler(ctx, input);
  };
  // Owner bill writes use the registered mutation and validators.
  const recordBill = async bill => {
    const input = { projectId: project._id, bill: JSON.stringify(bill) };
    checkArgs(bills.record, input, 'projectSelfMetricBills:record');
    return JSON.parse(await bills.record._handler(ctx, input));
  };
  const landing = (id, submitted, accepted, trusted = true) => {
    const request = { id, at: submitted, phase: 'landed', timing: { submittedAt: submitted }, error: null };
    put(
      'projectHostedLandingRequests',
      {
        projectId: project._id,
        channel: 'main',
        submissionId: id,
        operationId: id,
        actor: 'owner',
        sequence: tables.projectHostedLandingRequests.length,
        runnable: false,
        phase: 'landed',
        runId: null,
        attemptId: id,
        value: JSON.stringify(request),
      },
      submitted,
    );
    put(
      'projectHostedLandingAttempts',
      {
        projectId: project._id,
        submissionId: id,
        attemptId: id,
        number: 0,
        value: JSON.stringify({
          actor: { kind: 'agent' },
          policy: { acceptance: { mode: trusted ? 'auto-on-pass' : 'review' } },
        }),
      },
      submitted,
    );
    put(
      'projectHostedAcceptances',
      {
        projectId: project._id,
        receiptId: id,
        submissionId: id,
        attemptId: id,
        sequence: tables.projectHostedAcceptances.length,
        value: JSON.stringify({ id, at: accepted, submissionId: id, attemptId: id, candidate: { head: id } }),
      },
      accepted,
    );
  };
  const run = (id, start, end, seconds = 240) =>
    put(
      'projectHostedCheckRuns',
      {
        projectId: project._id,
        runId: id,
        candidateId: id,
        status: 'passed',
        value: JSON.stringify({
          id,
          at: start,
          endedAt: end,
          status: 'passed',
          request: { expectedHead: id },
          executionId: id,
          retainedPlanAndConfiguration: 'x'.repeat(4096),
          cost: { status: 'observed', seconds },
        }),
      },
      start,
    );
  return {
    tables,
    project,
    meter,
    query,
    recordBill,
    put,
    landing,
    run,
    actor: value => {
      actor = value;
    },
  };
}
