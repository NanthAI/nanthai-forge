// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { benchProgress, formatProgress } from '../scripts/bench-t3code/progress.mjs';
import { driverProgress } from '../scripts/bench-t3code/driver-progress.mjs';
import { batches, DESIGN, extraBatch } from '../scripts/bench-t3code/plan.mjs';
import { coordinationBatches } from '../scripts/bench-t3code/cells.mjs';

const start = '2026-01-01T00:00:00.000Z';
const end = '2026-01-01T00:01:40.000Z';
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'bench-progress-synthetic-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  let bytes = 0,
    files = 0;
  const json = (path, value) => {
    const text = JSON.stringify(value) + '\n';
    const file = join(root, path);
    mkdirSync(join(file, '..'), { recursive: true });
    writeFileSync(file, text);
    bytes += Buffer.byteLength(text);
    files++;
  };
  const decisions = () => {
    for (const N of DESIGN.ns) {
      json(`rep3-n${N}.json`, { run: false });
      json(`outlier-n${N}.json`, { extraReps: [] });
    }
  };
  const finish = (b, { attempt = 1, voided = [], failed = false, setupOnly = false } = {}) => {
    const cells = b.cells.map(c => {
      const cellId = `${c.key}-a${attempt}-synthetic`;
      json(`runs/${cellId}/result.json`, {
        cellId,
        key: c.key,
        arm: c.arm,
        N: c.N,
        attempt,
        startedAt: start,
        endedAt: end,
        voided,
        records: Array.from({ length: b.kind ? b.N : 10 }, (_, i) => ({
          task: `synthetic-${i}`,
          landing: { landed: !failed },
          syntheticEvidence: 'x'.repeat(1024),
        })),
      });
      return { key: c.key, cellId, arm: c.arm };
    });
    json(`batches/${b.key}-a${attempt}/batch.json`, {
      key: b.key,
      attempt,
      mode: b.mode,
      cells,
      voided,
      setupOnly,
    });
  };
  return { root, json, decisions, finish, budget: () => ({ bytesRead: bytes, filesRead: files }) };
}

test('progress counts and ETA respect concurrent scored and sequential coordination cells', t => {
  const f = fixture(t);
  f.decisions();
  const base = batches([]),
    coord = coordinationBatches();
  // Two 100-second cells, sequential at N=10: all future cells use that finished-cell estimate.
  f.finish(base[0]);
  const p = benchProgress({ root: f.root, now: end });
  assert.equal(p.total, 40);
  assert.equal(p.done, 2);
  assert.equal(p.rows.find(r => r.group === 'scored forge N=10').done, 1);
  assert.equal(p.rows.find(r => r.group === 'overlap forge-auto N=8').total, 2);
  const expected = [...base.slice(1), ...coord].reduce(
    (n, b) => n + (b.mode === 'concurrent' ? 100 : b.cells.length * 100),
    0,
  );
  assert.equal(p.etaSeconds, expected);
  assert.equal(benchProgress({ root: fixture(t).root }).etaSeconds, null);
});

test('40-cell progress reads only local result/metadata bytes and retains no private inputs in output', t => {
  const f = fixture(t);
  f.decisions();
  for (const b of [...batches([]), ...coordinationBatches()]) f.finish(b);
  // These must never be read: even invalid JSON and file symlinks outside the result tree.
  writeFileSync(join(f.root, 'config.json'), 'PRIVATE_SENTINEL not json');
  mkdirSync(join(f.root, 'secrets'));
  writeFileSync(join(f.root, 'secrets', 'token'), 'PRIVATE_SENTINEL');
  mkdirSync(join(f.root, 'runs', 'ignored'));
  symlinkSync(join(f.root, 'secrets', 'token'), join(f.root, 'runs', 'ignored', 'result.json'));
  symlinkSync(join(f.root, 'secrets'), join(f.root, 'runs', 'linked-directory'));
  const p = benchProgress({ root: f.root, now: end });
  assert.deepEqual({ bytesRead: p.bytesRead, filesRead: p.filesRead }, f.budget());
  assert.equal(p.done, 40);
  assert.equal(p.total, 40);
  assert.equal(p.etaSeconds, 0);
  assert.ok(p.rows.every(r => r.valid === r.total));
  assert.doesNotMatch(JSON.stringify(p) + formatProgress(p), /PRIVATE_SENTINEL/);
  t.diagnostic(`40 cells: ${p.bytesRead} bytes in ${p.filesRead} files; zero network/Convex/R2 operations`);
});

test('progress shows the current cell elapsed and live usage, disk and freeze waits before batch completion', t => {
  const f = fixture(t);
  f.json('runs/forge-n10-r1-a1-synthetic/cell.json', { key: 'forge-n10-r1', startedAt: start });
  const publish = driverProgress(f.root, false);
  for (const reason of [
    'codex 5h usage 90% above 40%',
    'disk 20 GB free < 22 GB',
    'freeze held by someone else',
  ]) {
    publish({ status: 'running', line: `WAIT n10-r1: ${reason}` });
    const p = benchProgress({ root: f.root, now: end });
    assert.equal(p.wait, `WAIT n10-r1: ${reason}`);
    assert.equal(p.current[0].elapsedSeconds, 100);
    assert.match(formatProgress(p), /CURRENT forge-n10-r1: elapsed 100s/);
  }
  publish({ status: 'stopped' });
  assert.equal(benchProgress({ root: f.root }).wait, null);
  publish({ status: 'complete', line: 'ALL DONE' });
  assert.equal(benchProgress({ root: f.root }).driver.status, 'complete');
});

test('progress discloses void attempts and failures without counting an invalid batch as valid', t => {
  const f = fixture(t);
  const b = batches([])[0];
  f.finish(b, { voided: ['synthetic infrastructure failure'], failed: true });
  let p = benchProgress({ root: f.root });
  assert.equal(p.done, 0);
  assert.equal(p.voids.length, 2);
  assert.equal(p.failures.length, 2);
  f.finish(b, { attempt: 2 });
  p = benchProgress({ root: f.root });
  assert.equal(p.done, 2);
  assert.equal(p.voids.length, 2);
  assert.equal(p.rows.find(r => r.group === 'scored forge N=10').valid, 1);
});

test('progress treats exhausted void retries as settled and excludes dry/model-check runs', t => {
  const f = fixture(t);
  const b = batches([])[0];
  f.finish(b, { attempt: 1, voided: ['void'] });
  f.finish(b, { attempt: 2, voided: ['void'] });
  f.json('runs/forge-n10-r1-dry-a1-synthetic/result.json', { dry: true, crashed: 'dry' });
  f.json('runs/forge-modelcheck-a1-synthetic/result.json', { modelCheck: true, crashed: 'model' });
  const p = benchProgress({ root: f.root });
  assert.equal(p.done, 2);
  assert.equal(p.voids.length, 4);
  assert.equal(p.rows.find(r => r.group === 'scored forge N=10').valid, 0);
  assert.equal(p.failures.length, 0);
});

test('progress includes registered rep-3 and outlier decisions without deriving new decisions', t => {
  const f = fixture(t);
  f.json('rep3-n3.json', { run: true });
  f.json('outlier-n3.json', { extraReps: [1] });
  f.finish(extraBatch([], 3, 1));
  const p = benchProgress({ root: f.root });
  assert.equal(p.total, 44);
  assert.equal(p.done, 2);
  assert.equal(p.rows.find(r => r.group === 'scored forge N=3').total, 4);
});

test('progress discloses a partially written result and keeps its last recorded start visible', t => {
  const f = fixture(t);
  f.json('runs/forge-n3-r1-a1-synthetic/cell.json', { key: 'forge-n3-r1', startedAt: start });
  writeFileSync(join(f.root, 'runs/forge-n3-r1-a1-synthetic/result.json'), '{');
  const p = benchProgress({ root: f.root, now: end });
  assert.deepEqual(p.unreadable, ['runs/forge-n3-r1-a1-synthetic/result.json']);
  assert.equal(p.current.length, 1);
  assert.equal(p.done, 0);
});

test('progress ETA does not count a finished sibling again while its batch is settling', t => {
  const f = fixture(t);
  const b = batches([])[0];
  f.finish(b);
  rmSync(join(f.root, `batches/${b.key}-a1/batch.json`));
  const p = benchProgress({ root: f.root, now: end });
  const full = benchProgress({ root: fixture(t).root, now: end });
  assert.equal(p.done, 0);
  assert.equal(p.etaSeconds, 3200); // Six concurrent batches, one sequential scored batch, 24 coordination cells.
  assert.equal(full.etaSeconds, null);
});

test('a status publication failure preserves driver execution and discloses the local IO failure', t => {
  const f = fixture(t);
  const messages = [];
  mkdirSync(join(f.root, 'drive-progress.json'));
  const publish = driverProgress(f.root, false, message => messages.push(message));
  assert.equal(publish({ status: 'complete', line: 'ALL DONE' }).status, 'complete');
  assert.match(messages.join('\n'), /progress snapshot unavailable/);
  assert.equal(benchProgress({ root: f.root }).driver, null);
});

test('diagnostic batches and running cells do not enter scored progress or ETA', t => {
  const f = fixture(t);
  f.decisions();
  const before = benchProgress({ root: f.root, now: end });
  f.json('batches/replay/batch.json', {
    key: 'replay-conflict-n10-late-third-r1',
    diagnostic: { scored: false },
    voided: ['synthetic diagnostic failure'],
  });
  f.json('runs/diagnostic/result.json', {
    key: 'replay-conflict-n10-late-third-r1',
    diagnostic: { scored: false },
    startedAt: start,
    endedAt: end,
    records: [],
  });
  f.json('runs/running/cell.json', {
    key: 'replay-clean-n10-late-third-r1',
    diagnostic: { scored: false },
    startedAt: start,
  });
  const after = benchProgress({ root: f.root, now: end });
  assert.equal(after.done, before.done);
  assert.equal(after.total, before.total);
  assert.equal(after.etaSeconds, before.etaSeconds);
  assert.deepEqual(after.current, []);
});
