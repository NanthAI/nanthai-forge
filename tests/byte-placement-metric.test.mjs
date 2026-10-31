// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './project-exchange-fixture.mjs';
import { moduleUrl } from './convex-module.mjs';
import { readPlacement, calculatePlacementMetrics } from '../dist/self-metrics-placement.js';
const placement = await import(moduleUrl('../convex/projectBytePlacement.ts'));

const day = Date.parse('2026-10-30T00:00:00Z');
const period = { from: '2026-10-30T00:00:00.000Z', to: '2026-10-31T00:00:00.000Z' };
const empty = () => ({ moves: [], submissions: [], runs: [], receipts: [], gaps: [] });
const read = (s, cursor = null) =>
  placement.convexWritten._handler(s.ctx, { projectId: 'project', ...period, cursor });
/** `_storage` rows newest first, with a page counter. */
function storage(s, files) {
  const pages = { count: 0 };
  s.ctx.db.system = {
    query: table => {
      assert.equal(table, '_storage');
      return {
        order: direction => {
          assert.equal(direction, 'desc');
          return {
            paginate: async ({ cursor, numItems }) => {
              pages.count++;
              const rows = files.toSorted((a, b) => b._creationTime - a._creationTime),
                offset = Number(cursor ?? 0),
                page = rows.slice(offset, offset + numItems);
              return {
                page,
                isDone: offset + page.length >= rows.length,
                continueCursor: String(offset + page.length),
              };
            },
          };
        },
      };
    },
  };
  return pages;
}

test('Convex bytes written in a window: one page when none, sums only the window, owners only', async () => {
  const s = fixture();
  // Legacy copies only, all older than the window: one page, then stop.
  const legacy = Array.from({ length: 500 }, (_, i) => ({ _creationTime: day - 1000 - i, size: 10 }));
  let pages = storage(s, legacy);
  assert.deepEqual(await read(s), { count: 0, bytes: 0, isDone: true, cursor: '64' });
  assert.equal(pages.count, 1);
  pages = storage(s, [
    ...legacy,
    { _creationTime: day + 5, size: 7 },
    { _creationTime: day + 6, size: 3 },
    { _creationTime: day + 86_400_000, size: 1000 },
  ]);
  const first = await read(s);
  assert.deepEqual([first.count, first.bytes, first.isDone], [2, 10, true]);
  s.caller('stranger');
  await assert.rejects(read(s), e => e.data?.code === 'PROJECT_UNAVAILABLE');
});

test('the metric reads every page of writes and warns on any Convex byte', async () => {
  let calls = 0;
  const records = empty();
  await readPlacement(
    async (name, args) => {
      assert.equal(name, 'projectBytePlacement:convexWritten');
      calls++;
      return args.cursor === null
        ? { count: 2, bytes: 40, isDone: false, cursor: 'next' }
        : { count: 1, bytes: 2, isDone: true, cursor: '' };
    },
    period,
    records,
  );
  assert.equal(calls, 2);
  const result = calculatePlacementMetrics(records);
  assert.equal(result.convexBytes, 42);
  assert.equal(result.convexObjects, 3);
  assert.match(result.warning, /Convex file storage received 42 bytes/);
  const clean = empty();
  await readPlacement(async () => ({ count: 0, bytes: 0, isDone: true, cursor: '' }), period, clean);
  assert.deepEqual(
    [calculatePlacementMetrics(clean).convexBytes, calculatePlacementMetrics(clean).warning],
    [0, null],
  );
});

test('an older deployment without the placement query leaves the metric unknown, not zero', async () => {
  const records = empty();
  await readPlacement(
    async () => {
      throw Error('Could not find public function');
    },
    period,
    records,
  );
  const result = calculatePlacementMetrics(records);
  assert.equal(result.partial, true);
  assert.equal(result.convexBytes, null);
  assert.match(records.gaps[0], /Bytes by location are unavailable/);
});
