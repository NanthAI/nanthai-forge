// SPDX-License-Identifier: Apache-2.0
// Synthetic API only: never create a real status or run a benchmark cell.
import test from 'node:test';
import assert from 'node:assert/strict';
import { measureSkew, fromGithub, repository } from '../scripts/bench-t3code/github-arm.mjs';

const sha = 'synthetic-sha';
const epoch = Date.parse('2026-01-01T00:00:00Z');
const created = { id: 42, created_at: new Date(epoch).toISOString() };
const older = { id: 41, created_at: created.created_at };

function fixture(read) {
  const calls = [],
    pauses = [];
  let clock = epoch,
    reads = 0;
  const options = {
    now: () => clock,
    pause: async ms => {
      pauses.push(ms);
      clock += ms;
    },
    api: async (path, ...args) => {
      calls.push({ path, args });
      if (args.includes('POST')) {
        clock += 200;
        return created;
      }
      clock += 100;
      return read(++reads, Number(new URL(path, 'https://example.test').searchParams.get('page')));
    },
  };
  return { calls, pauses, options };
}

test('clock probe: immediate visibility is one POST plus one GET even with 2800 old statuses', async () => {
  const statuses = [created, ...Array.from({ length: 2800 }, (_, i) => ({ ...older, id: -i }))];
  const f = fixture((_, page) => statuses.slice((page - 1) * 100, page * 100));
  const result = await measureSkew(sha, f.options);
  assert.equal(f.calls.length, 2);
  assert.equal(result.skewMs, -100);
  assert.equal(result.createResponseSkewMs, -100);
  assert.equal(result.readAttempts, 1);
  assert.equal(result.readPages, 1);
  assert.equal(result.statusId, 42);
  assert.deepEqual(f.pauses, []);
  assert.equal(f.calls[0].path, `repos/${repository}/statuses/${sha}`);
  assert.ok(f.calls[1].args.includes('Cache-Control: no-cache'));
});

test('clock probe: missing then present recovers without recreating the status', async () => {
  const f = fixture(n => (n === 1 ? [older] : [created, older]));
  const result = await measureSkew(sha, f.options);
  assert.equal(result.readAttempts, 2);
  assert.equal(result.readPages, 2);
  assert.deepEqual(f.pauses, [250]);
  assert.equal(f.calls.filter(c => c.args.includes('POST')).length, 1);
});

test('clock probe: several lagged reads retain the POST midpoint and read-surface offset', async () => {
  const stored = { ...created, created_at: new Date(epoch + 3600_000).toISOString() };
  const f = fixture(n => (n < 4 ? [] : [stored]));
  const result = await measureSkew(sha, f.options);
  assert.deepEqual(f.pauses, [250, 500, 1000]);
  assert.equal(result.skewMs, 3599_900);
  assert.equal(result.createResponseSkewMs, -100);
  assert.equal(result.roundTripMs, 200);
  assert.equal(result.at, new Date(epoch + 200).toISOString());
  assert.equal(fromGithub(stored.created_at), new Date(epoch + 100).toISOString());
});

test('clock probe: concurrent newer statuses push the exact ID onto a later page', async () => {
  const newer = Array.from({ length: 125 }, (_, i) => ({ ...created, id: 1000 - i }));
  const statuses = [...newer, created, older];
  const f = fixture((_, page) => statuses.slice((page - 1) * 100, page * 100));
  const result = await measureSkew(sha, f.options);
  assert.equal(result.readPages, 2);
  assert.equal(result.readAttempts, 1);
  assert.equal(result.skewMs, -100);
  assert.deepEqual(f.pauses, []);
});

test('clock probe: permanent miss is bounded and never uses the valid create timestamp as fallback', async () => {
  const f = fixture(() => [older]);
  await assert.rejects(measureSkew(sha, f.options), error => {
    assert.equal(error.code, 'BENCH_CLOCK_PROBE_NOT_FOUND');
    assert.match(error.message, /status 42 on synthetic-sha after 6 attempts \/ 6 pages/);
    assert.match(error.message, /createResponseSkewMs=-100/);
    return true;
  });
  assert.deepEqual(f.pauses, [250, 500, 1000, 2000, 4000]);
  assert.equal(f.calls.length, 7);
});

test('clock probe: a full page stream has a finite request budget', async () => {
  const f = fixture(() => Array(100).fill(older));
  await assert.rejects(measureSkew(sha, f.options), /after 6 attempts \/ 60 pages/);
  assert.equal(f.calls.length, 61);
  assert.equal(
    f.pauses.reduce((sum, ms) => sum + ms, 0),
    7750,
  );
});

test('clock probe: malformed read timestamp and API failures remain explicit', async () => {
  const invalid = fixture(() => [{ ...created, created_at: 'invalid' }]);
  await assert.rejects(measureSkew(sha, invalid.options), /BENCH_CLOCK_PROBE_INVALID_TIMESTAMP: status 42/);
  const failed = fixture(() => {
    throw Error('synthetic API failure');
  });
  await assert.rejects(measureSkew(sha, failed.options), /synthetic API failure/);
  assert.equal(failed.calls.length, 2);
});
