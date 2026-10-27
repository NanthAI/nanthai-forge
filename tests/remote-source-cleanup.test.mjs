// SPDX-License-Identifier: Apache-2.0
import './check-runtime.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  readdirSync,
  renameSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { retentionPlan, RETENTION_MS, LOG_TAIL_BYTES } from '../dist/clean-retention.js';
import { terminalReceipt } from '../dist/clean-terminal-receipt.js';

function fixture(t, backend = 'modal') {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'forge-remote-clean-')));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const run = {
    id: randomUUID(),
    viewId: randomUUID(),
    status: 'passed',
    endedAt: new Date().toISOString(),
    backend: { requested: backend, actual: backend, pin: 'original-pin' },
  };
  const path = join(directory, `check-${run.id}`);
  mkdirSync(path);
  for (const leaf of ['modal-source', 'github-actions-source']) {
    mkdirSync(join(path, leaf));
    writeFileSync(join(path, leaf, 'input.txt'), 'synthetic source');
  }
  for (const leaf of ['stdout.log', 'stderr.log', 'selection.json', 'modal-plan.json', 'github-actions.json'])
    writeFileSync(join(path, leaf), 'retained evidence');
  const receipt = () =>
    writeFileSync(
      join(path, 'result.json'),
      JSON.stringify({
        status: run.status,
        endedAt: run.endedAt,
        backend: run.backend,
        details: 'Synthetic terminal evidence',
      }),
    );
  receipt();
  const views = [];
  const store = {
    directory,
    page: collection => ({
      records: collection === 'runs' ? [run] : collection === 'views' ? views : [],
      nextOffset: null,
    }),
    select: (collection, id) => (collection === 'views' ? views.find(view => view.id === id) : undefined),
  };
  const plan = (processes = { paths: [], unknown: false }, kinds = ['check-workspaces']) =>
    retentionPlan(store, kinds, processes);
  return { directory, path, run, receipt, store, plan, views };
}

for (const backend of ['modal', 'github-actions'])
  test(`${backend}: fresh terminal sources are immediately eligible; evidence bytes stay outside the plan`, t => {
    const p = fixture(t, backend);
    const evidence = Object.fromEntries(
      readdirSync(p.path)
        .filter(name => !name.endsWith('-source'))
        .map(name => [name, readFileSync(join(p.path, name))]),
    );
    for (const kinds of [
      ['check-workspaces'],
      ['check-retention'],
      ['check-workspaces', 'check-retention'],
    ]) {
      const result = p.plan(undefined, kinds);
      assert.equal(result.items.length, 2);
      assert.ok(result.items.every(item => item.path.endsWith('-source') && !item.tail));
    }
    for (const [name, bytes] of Object.entries(evidence))
      assert.deepEqual(readFileSync(join(p.path, name)), bytes);
  });

for (const status of ['queued', 'preparing', 'running'])
  test(`${status} remote sources stay`, t => {
    const p = fixture(t);
    p.run.status = status;
    assert.equal(p.plan().items.length, 0);
    assert.match(p.plan().skipped[0].reason, new RegExp(status));
  });

test('retryable, process-blocked and unknown-coverage remote sources stay', t => {
  const p = fixture(t);
  p.run.backend.retryable = true;
  assert.equal(p.plan().items.length, 0);
  assert.match(p.plan().skipped[0].reason, /resumed/);
  p.run.backend.retryable = false;
  for (const processes of [
    { paths: [join(p.path, 'modal-source')], unknown: false },
    { paths: [], unknown: true },
  ]) {
    assert.equal(p.plan(processes).items.length, 0);
    assert.match(p.plan(processes).skipped[0].reason, /process/);
  }
});

test('run pins, exact source pins and retained exchange manifests protect remote copies', t => {
  const p = fixture(t);
  const pin = join(p.directory, 'pending-export.json');
  writeFileSync(pin, JSON.stringify({ runId: p.run.id }));
  assert.equal(p.plan().items.length, 0);
  writeFileSync(pin, JSON.stringify({ path: `check-${p.run.id}/modal-source/input.txt` }));
  assert.deepEqual(
    p.plan().items.map(item => item.path),
    [join(p.path, 'github-actions-source')],
  );
  const exchangeId = randomUUID(),
    exchange = join(p.directory, `exchange-${exchangeId}`);
  mkdirSync(exchange);
  writeFileSync(
    join(exchange, 'manifest.json'),
    JSON.stringify({ files: [{ path: `check-${p.run.id}/github-actions-source/input.txt` }] }),
  );
  writeFileSync(pin, JSON.stringify({ operationId: exchangeId }));
  assert.deepEqual(
    p.plan().items.map(item => item.path),
    [join(p.path, 'modal-source')],
  );
  writeFileSync(pin, 'unreadable reference');
  assert.equal(p.plan().items.length, 0);
});

test('missing, archived-only, invalid and mismatched receipts have distinct retention reasons', t => {
  const p = fixture(t),
    path = join(p.path, 'result.json');
  rmSync(path);
  assert.match(p.plan().skipped[0].reason, /receipt is missing/);
  writeFileSync(path + '.interrupted-' + randomUUID(), '{}');
  assert.match(p.plan().skipped[0].reason, /Only archived interrupted receipts/);
  writeFileSync(path, '{}');
  assert.match(p.plan().skipped[0].reason, /receipt is invalid/);
  p.receipt();
  p.run.endedAt = new Date(Date.now() + 1000).toISOString();
  assert.match(p.plan().skipped[0].reason, /does not match/);
  p.receipt();
  p.run.backend.pin = 'different-pin';
  assert.match(p.plan().skipped[0].reason, /does not match/);
  assert.equal(p.plan().items.length, 0);
});

test('unresolved and invalid remote execution journals report their own reason', t => {
  const p = fixture(t),
    journal = join(p.path, 'modal-executions.json');
  for (const value of [
    { creating: true, executions: [] },
    { creating: false, executions: [{ id: 'remote' }] },
  ]) {
    writeFileSync(journal, JSON.stringify(value));
    assert.equal(p.plan().items.length, 0);
    assert.match(p.plan().skipped[0].reason, /unresolved launch or execution/);
  }
  writeFileSync(journal, '{');
  assert.match(p.plan().skipped[0].reason, /journal is unreadable or invalid/);
  writeFileSync(journal, JSON.stringify({ creating: false, executions: [{ exitCode: 0 }] }));
  assert.equal(p.plan().items.length, 2);
});

test('an explicitly superseded interrupted run permits source only; archived receipts and old logs stay', t => {
  const p = fixture(t);
  p.run.status = 'interrupted';
  p.run.endedAt = new Date(Date.now() - RETENTION_MS - 1000).toISOString();
  p.run.cancelRequested = true;
  const laneId = randomUUID(),
    intentId = randomUUID(),
    successor = randomUUID();
  p.views.push(
    { id: p.run.viewId, intentId, inputs: [{ laneId }], at: '2026-01-01T00:00:00Z' },
    { id: successor, intentId, inputs: [{ laneId }], at: '2026-01-02T00:00:00Z' },
  );
  p.run.cancellation = { reason: 'superseded', supersededBy: successor };
  p.receipt();
  const archive = join(p.path, `result.json.interrupted-${randomUUID()}`);
  renameSync(join(p.path, 'result.json'), archive);
  const bytes = readFileSync(archive);
  const log = join(p.path, 'stdout.log'),
    old = Date.now() - RETENTION_MS - 1000;
  writeFileSync(log, 'x'.repeat(LOG_TAIL_BYTES * 2));
  utimesSync(log, old / 1000, old / 1000);
  const result = p.plan(undefined, ['check-retention']);
  assert.equal(result.items.length, 2);
  assert.match(result.skipped[0].reason, /explicitly superseded/);
  assert.ok(result.items.every(item => item.path.endsWith('-source')));
  assert.deepEqual(readFileSync(archive), bytes);
  assert.equal(readFileSync(log).length, LOG_TAIL_BYTES * 2);
  p.views[1].intentId = randomUUID();
  assert.equal(p.plan().items.length, 0, 'a different Intent is not supersession proof');
  p.views[1].intentId = intentId;
  p.views[1].inputs = [{ laneId: randomUUID() }];
  assert.equal(p.plan().items.length, 0, 'a different Lane family is not supersession proof');
  p.views[1].inputs = [{ laneId }];
  p.views[1].at = p.views[0].at;
  assert.equal(p.plan().items.length, 0, 'a tied timestamp is ambiguous');
  p.views[1].at = '2026-01-02T00:00:00Z';
  p.run.backend.pin = 'different-provider-pin';
  assert.match(p.plan().skipped[0].reason, /Archived interrupted receipts do not match/);
  assert.equal(p.plan().items.length, 0, 'a prior retry receipt is not current completion proof');
  rmSync(archive);
  assert.equal(p.plan().items.length, 0, 'supersession without terminal evidence stays ambiguous');
});

test('a current mismatched receipt is retained even with an explicit supersession', t => {
  const p = fixture(t);
  p.run.status = 'interrupted';
  p.run.cancelRequested = true;
  p.run.cancellation = { reason: 'superseded', supersededBy: randomUUID() };
  assert.match(terminalReceipt(p.store, p.run, p.path).blocker, /does not match/);
  assert.equal(p.plan().items.length, 0);
});
