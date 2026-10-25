// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir, hostname } from 'node:os';
import { join } from 'node:path';
import { initNative, nativeStatus } from '../dist/native-work.js';
import { WorkStore } from '../dist/work-store.js';
import { selectMainAudit } from '../dist/post-accept-selection.js';
import { postAcceptMoves } from '../dist/post-accept-coverage.js';
import { updateModalRun } from '../dist/work-modal-run.js';
import { checkEnvironment } from '../dist/work-run.js';
import { agentClean } from '../dist/agent-clean.js';
import { policyPreset } from '../dist/autonomy-policy.js';
import { pendingStatus } from '../dist/pending-status.js';
import { readMakingOf } from '../dist/making-of-read.js';
import { accountingContext } from '../dist/accounting-records.js';
import { trainAccounting } from '../dist/train-accounting.js';
import { isGreenMain } from '../dist/github-auto-push-state.js';
import { latestCheckCoverage, coverageSourcePath } from '../dist/check-coverage.js';

const at = '2026-01-01T00:00:00.000Z';
const hash = value => createHash('sha256').update(value).digest('hex');
function fixture(t, count = 2) {
  const root = mkdtempSync(join(tmpdir(), 'forge-write-amp-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, 'file.txt'), 'synthetic source\n');
  initNative(root);
  const store = new WorkStore(root),
    data = store.load();
  data.schema = 13;
  data.autonomyPolicy = policyPreset('autonomous');
  data.intents.push({
    id: randomUUID(),
    outcome: 'Synthetic history',
    constraints: '',
    base: data.nativeHead,
    status: 'active',
    notes: [],
    createdAt: at,
  });
  const check = {
    id: randomUUID(),
    name: 'verify',
    executable: process.execPath,
    args: [],
    environmentLabel: 'synthetic',
    definition: hash('check'),
    at,
  };
  data.checks.push(check);
  for (let i = 0; i < count; i++) {
    const view = {
      id: randomUUID(),
      intentId: data.intents[0].id,
      base: data.nativeHead,
      head: data.nativeHead,
      inputs: [],
      dependencies: [],
      status: 'clean',
      details: '',
      at,
    };
    data.views.push(view);
    data.channelMoves.push({
      id: randomUUID(),
      channel: 'main',
      viewId: view.id,
      head: view.head,
      previous: i ? view.head : null,
      at,
      status: 'accepted',
      provenance: 'user-declared-local',
      postAccept: { checkId: check.id, mode: 'full', reason: 'scoped-check' },
    });
  }
  return { root, store, data, check };
}
function terminal(data, selected, status = 'passed') {
  const run = {
    id: selected.runId,
    viewId: selected.view.id,
    head: selected.view.head,
    base: selected.view.base,
    inputs: [],
    dependencies: [],
    check: data.checks[0],
    environment: checkEnvironment(),
    mainCheck: { channel: selected.view.mainCheck.channel },
    status,
    startedAt: at,
    endedAt: at,
    runner: { pid: process.pid, host: hostname() },
    details: 'Synthetic audit',
    backend: { requested: 'modal', actual: 'modal', executionIds: ['synthetic-1'] },
  };
  data.runs.push(run);
  return run;
}
// Original selector behavior: every existing request on the selected channel was
// assigned the new run, including a push's additional latest accepted move.
function legacySelect(data, push) {
  const selected = selectMainAudit(data, push);
  if (!selected || 'wait' in selected) return selected;
  const main = data.channelMoves
    .filter(move => move.channel === selected.view.mainCheck.channel && move.status === 'accepted')
    .at(-1);
  delete main.postAcceptAuditRunId;
  for (const move of data.channelMoves)
    if (move.channel === main.channel && (move.postAccept || (push && move.id === main.id)))
      move.postAcceptRunId = selected.runId;
  return selected;
}

test('derived covering audits equal legacy fan-out through bursts, retries, checks, channels and push', t => {
  const { data } = fixture(t, 6),
    legacy = structuredClone(data);
  for (const rows of [data.channelMoves, legacy.channelMoves]) rows[1].channel = rows[3].channel = 'release';
  const compare = (push, status = 'passed') => {
    const before = structuredClone(data.channelMoves);
    const old = legacySelect(legacy, push),
      next = selectMainAudit(data, push);
    assert.equal(next?.runId, old?.runId);
    assert.deepEqual(postAcceptMoves(data.channelMoves), legacy.channelMoves);
    assert.ok(
      data.channelMoves.filter((move, i) => JSON.stringify(move) !== JSON.stringify(before[i])).length <= 1,
    );
    if (next && !('wait' in next)) {
      terminal(data, next, status);
      terminal(legacy, old, status);
    }
    return next;
  };
  compare(undefined, 'cancelled');
  compare();
  compare();
  assert.equal(compare(), undefined);
  for (const d of [data, legacy]) d.checks[0].definition = hash('changed check');
  compare();
  compare();
  // A later request is pending until a later audit selection covers it.
  const later = { ...data.channelMoves.at(-1), id: randomUUID(), head: hash('new main') };
  delete later.postAcceptRunId;
  delete later.postAcceptAuditRunId;
  data.channelMoves.push(structuredClone(later));
  legacy.channelMoves.push(structuredClone(later));
  assert.deepEqual(postAcceptMoves(data.channelMoves), legacy.channelMoves);
  compare();
  // Full-check acceptances do not request an audit unless push selects one.
  const full = { ...later, id: randomUUID(), head: hash('full main') };
  delete full.postAccept;
  data.channelMoves.push(structuredClone(full));
  legacy.channelMoves.push(structuredClone(full));
  compare();
  compare({ channel: 'main', checkId: data.checks[0].id });
  compare();
});

for (const count of [8, 256])
  test(`${count} main moves add only one move version per new audit`, t => {
    const { store, data } = fixture(t, count);
    store.save(data);
    for (let attempt = 0; attempt < 2; attempt++) {
      const before = new Set(readdirSync(join(store.directory, 'records')));
      const selected = selectMainAudit(data);
      terminal(data, selected, attempt ? 'passed' : 'cancelled');
      data.revision++;
      store.save(data);
      const added = readdirSync(join(store.directory, 'records')).filter(id => !before.has(id));
      const ids = new Set(data.channelMoves.map(move => move.id));
      const moves = added
        .map(id => JSON.parse(readFileSync(join(store.directory, 'records', id))))
        .filter(record => ids.has(record.fields?.id));
      assert.equal(moves.length, 1);
      assert.ok(added.length <= 20, `${added.length} fragments for ${count} moves`);
    }
  });

test('unchanged backend observation and replacement write no record or revision; real execution changes remain', t => {
  const { store, data } = fixture(t),
    selected = selectMainAudit(data),
    run = terminal(data, selected);
  store.save(data);
  const pointer = readFileSync(join(store.directory, 'work.json')),
    files = readdirSync(join(store.directory, 'records'));
  const reordered = {
    ...run,
    backend: { executionIds: [...run.backend.executionIds], actual: 'modal', requested: 'modal' },
  };
  updateModalRun(store, reordered);
  store.locked(() => {
    const tx = store.records();
    tx.patchFields('runs', run.id, { backend: reordered.backend });
    store.commitRecords(tx);
  });
  assert.deepEqual(readFileSync(join(store.directory, 'work.json')), pointer);
  assert.deepEqual(readdirSync(join(store.directory, 'records')), files);
  const stale = store.records();
  run.backend.executionIds.push('synthetic-2');
  updateModalRun(store, run);
  assert.equal(store.revision(), data.revision + 1);
  assert.throws(() => stale.commit(), { code: 'WORK_STALE' }, 'no-op guards retain concurrency checks');
  assert.deepEqual(store.select('runs', run.id).backend.executionIds, ['synthetic-1', 'synthetic-2']);
  store.locked(() => {
    const tx = store.records();
    const revision = tx.revision + 3;
    assert.equal(
      store.commitRecords(tx, revision),
      revision,
      'explicit revision publication stays authoritative',
    );
  });
});

test('empty automatic cleanup writes no action, record or revision', t => {
  const { store, data } = fixture(t);
  store.save(data);
  const pointer = readFileSync(join(store.directory, 'work.json')),
    files = readdirSync(join(store.directory, 'records'));
  const command = { action: 'clean', apply: true, kinds: ['check-workspaces'] },
    automatic = { id: randomUUID(), actor: 'Synthetic cleanup' };
  for (let i = 0; i < 2; i++) assert.equal(agentClean(store, command, automatic).result.totals.count, 0);
  assert.deepEqual(readFileSync(join(store.directory, 'work.json')), pointer);
  assert.deepEqual(readdirSync(join(store.directory, 'records')), files);
  assert.equal(store.select('automaticActions', automatic.id), undefined);
});

test('status, making-of, accounting, push and coverage readers agree with legacy fan-out', t => {
  // Freeze before either selector creates its timestamped audit Candidate, not
  // just before reading: making-of includes those events in its wall-clock span.
  const now = Date.parse(at) + 1_000;
  t.mock.timers.enable({ apis: ['Date'], now });
  const { store, data } = fixture(t),
    legacy = structuredClone(data);
  const selected = selectMainAudit(data),
    old = legacySelect(legacy);
  const run = terminal(data, selected);
  terminal(legacy, old);
  const artifact = { head: run.head },
    bytes = JSON.stringify(artifact);
  run.checkSelection = { scope: 'full', reason: 'Synthetic full audit', tests: [] };
  run.artifacts = [
    {
      status: 'retained',
      sourcePath: coverageSourcePath,
      filename: 'artifact-0.bin',
      size: Buffer.byteLength(bytes),
      sha256: hash(bytes),
    },
  ];
  Object.assign(legacy.runs[0], structuredClone(run));
  const dir = join(store.directory, `check-${run.id}`, 'artifacts');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'artifact-0.bin'), bytes);
  const inspect = d => {
    store.save(d);
    const context = accountingContext(store.root, store.readRecords());
    const entries = d.channelMoves.map(move => ({
      id: move.id,
      status: 'accepted',
      acceptanceId: move.id,
      arrivedAt: at,
    }));
    return {
      moves: nativeStatus(store, store.load(), { compact: true }).channelMoves,
      pending: pendingStatus(d, {}, at),
      makingOf: readMakingOf(store, d.intents[0].id).result,
      accounting: trainAccounting(d.runs, { ...context, entries }, new Date(at)),
      green: isGreenMain(d),
      coverage: latestCheckCoverage(store, run.head),
    };
  };
  const before = inspect(legacy),
    after = inspect(data);
  assert.equal(after.makingOf.lastEventAt, new Date(now).toISOString());
  assert.equal(after.makingOf.wallClockMs, now - Date.parse(at));
  assert.deepEqual(after, before);
});
