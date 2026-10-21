// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { ForgeError } from '../dist/errors.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureActionsDispatch } from '../dist/github-actions-dispatch.js';
import { actionsApi, ActionsApiError, RATE_LIMITED } from '../dist/github-actions-api.js';

function fixture({ invisible = 0, reject = [], runs, cancelled = () => false } = {}) {
  const plan = { runId: 'synthetic-run', groups: [] };
  let journal = { repo: 'synthetic/checks', commit: 'a'.repeat(40) };
  const calls = [],
    waits = [],
    saves = [],
    progress = [];
  let branches = 0,
    dispatches = 0,
    lookups = 0;
  const run = { id: 10, head_sha: journal.commit, display_title: 'forge-check/synthetic-run' };
  const api = {
    async request(endpoint, method = 'GET') {
      calls.push({ endpoint, method });
      if (endpoint.includes('/branches/')) {
        assert.ok(endpoint.endsWith('/branches/forge-check%2Fsynthetic-run'));
        if (++branches <= invisible) throw new ActionsApiError(404);
        return { commit: { sha: journal.commit } };
      }
      assert.ok(endpoint.endsWith('/dispatches'));
      assert.equal(method, 'POST');
      assert.equal(saves.at(-1).dispatching, true, 'intent persisted before mutation');
      assert.equal(saves.at(-1).dispatchOutcome, 'ambiguous');
      const failure = reject[dispatches++];
      if (failure) throw failure;
    },
    async pages() {
      calls.push({ lookup: ++lookups });
      return runs ? runs({ lookups, dispatches, run }) : dispatches ? [run] : [];
    },
    async sleep(ms) {
      waits.push(ms);
    },
  };
  return {
    plan,
    api,
    calls,
    waits,
    saves,
    progress,
    get journal() {
      return journal;
    },
    // Mimic a new controller loading only durable JSON, rather than in-memory state.
    reload() {
      journal = JSON.parse(JSON.stringify(saves.at(-1)));
    },
    control: () =>
      ensureActionsDispatch(
        plan,
        journal,
        () => saves.push(structuredClone(journal)),
        api,
        cancelled,
        line => progress.push(line),
      ),
  };
}

test('branch index lag is polled before the first dispatch, with bounded backoff', async () => {
  const f = fixture({ invisible: 3 });
  await f.control();
  assert.deepEqual(
    f.calls.slice(0, 4).map(call => call.method),
    Array(4).fill('GET'),
  );
  assert.equal(f.calls[4].method, 'POST');
  assert.deepEqual(f.waits, [2_000, 4_000, 8_000]);
  assert.equal(f.journal.runId, 10);
});

test('a branch that never becomes visible gives up before any dispatch', async () => {
  const f = fixture({ invisible: Infinity });
  await assert.rejects(f.control(), error => error.code === 'GITHUB_ACTIONS_BRANCH_UNAVAILABLE');
  assert.equal(f.calls.length, 6);
  assert.equal(
    f.waits.reduce((sum, ms) => sum + ms, 0),
    60_000,
  );
  assert.equal(f.journal.dispatching, undefined);
});

test('a branch naming different source stops before dispatch', async () => {
  const f = fixture();
  f.api.request = async () => ({ commit: { sha: 'other' } });
  await assert.rejects(f.control(), error => error.code === 'EVIDENCE_CHANGED');
  assert.equal(f.journal.dispatching, undefined);
});

test('two definitive 422 dispatch rejections retry and adopt exactly one run', async () => {
  const f = fixture({ reject: [new ActionsApiError(422), new ActionsApiError(422)] });
  await f.control();
  assert.equal(f.calls.filter(call => call.method === 'POST').length, 3);
  assert.equal(f.journal.runId, 10);
  assert.equal(f.journal.dispatchOutcome, 'accepted');
  assert.equal(f.journal.dispatchRejections, 2);
  assert.deepEqual(f.waits, [5_000, 10_000]);
  const rejected = f.saves.filter(save => save.dispatchOutcome === 'rejected');
  assert.equal(rejected.length, 2);
  assert.ok(rejected.every(save => save.dispatching === false && save.dispatchStatus === 422));
});

test('permanent 404 rejection fails clearly after five durable attempts, including on retry', async () => {
  const f = fixture({ reject: Array.from({ length: 5 }, () => new ActionsApiError(404)) });
  const rejected = error =>
    error.code === 'GITHUB_ACTIONS_DISPATCH_REJECTED' && /HTTP 404/.test(error.message);
  await assert.rejects(f.control(), rejected);
  assert.equal(f.journal.dispatching, false);
  assert.equal(f.journal.runId, undefined);
  assert.equal(f.journal.dispatchRejections, 5);
  assert.deepEqual(f.waits, [5_000, 10_000, 20_000, 40_000]);
  f.reload();
  await assert.rejects(f.control(), rejected);
  assert.equal(f.calls.filter(call => call.method === 'POST').length, 5);
});

test('ambiguous timeout observes an eventually visible run without another dispatch', async () => {
  const f = fixture({
    reject: [new Error('synthetic timeout secret')],
    runs: ({ lookups, run }) => (lookups < 4 ? [] : [run]),
  });
  await f.control();
  assert.equal(f.journal.runId, 10);
  assert.equal(f.calls.filter(call => call.method === 'POST').length, 1);
  assert.doesNotMatch(JSON.stringify(f.saves) + f.progress.join(''), /secret/);
});

for (const legacy of [false, true]) {
  test(`zero runs permits one recovery dispatch only on a later retry (legacy=${legacy})`, async () => {
    const f = fixture({ reject: [new ActionsApiError(503), new Error('timeout')], runs: () => [] });
    if (legacy) f.journal.dispatching = true;
    else {
      await assert.rejects(f.control(), error => error.code === 'GITHUB_ACTIONS_UNKNOWN');
      assert.equal(f.journal.dispatchOutcome, 'ambiguous');
      assert.equal(f.journal.dispatchLookupExhausted, true);
      assert.equal(f.calls.filter(call => call.method === 'POST').length, 1);
      f.reload();
    }
    const before = f.calls.length;
    await assert.rejects(f.control(), error => error.code === 'GITHUB_ACTIONS_UNKNOWN');
    assert.equal(f.journal.dispatchRecoveryUsed, true);
    const newCalls = f.calls.slice(before);
    const post = newCalls.findIndex(call => call.method === 'POST');
    assert.equal(
      newCalls.slice(0, post).filter(call => call.lookup).length,
      13,
      'window plus fresh empty lookup precede recovery',
    );
    const dispatches = f.calls.filter(call => call.method === 'POST').length;
    f.reload();
    await assert.rejects(f.control(), error => error.code === 'GITHUB_ACTIONS_UNKNOWN');
    assert.equal(f.calls.filter(call => call.method === 'POST').length, dispatches);
  });
}

test('a stranded legacy operation recovers successfully with the same run identity', async () => {
  const f = fixture();
  f.journal.dispatching = true;
  await f.control();
  assert.equal(f.journal.runId, 10);
  assert.equal(f.journal.dispatchRecoveryUsed, true);
  assert.equal(f.calls.filter(call => call.method === 'POST').length, 1);
});

test('a run appearing at the fresh recovery lookup is adopted without dispatch', async () => {
  const f = fixture({ runs: ({ lookups, run }) => (lookups === 13 ? [run] : []) });
  f.journal.dispatching = true;
  await f.control();
  assert.equal(f.journal.runId, 10);
  assert.equal(f.journal.dispatchRecoveryUsed, undefined);
  assert.equal(f.calls.filter(call => call.method === 'POST').length, 0);
});

test('a different run on the branch prevents recovery, even without an exact match', async () => {
  const f = fixture({ runs: ({ run }) => [{ ...run, display_title: 'other' }] });
  f.journal.dispatching = true;
  await assert.rejects(f.control(), error => error.code === 'GITHUB_ACTIONS_UNKNOWN');
  assert.equal(f.journal.dispatchRecoveryUsed, undefined);
  assert.equal(f.calls.filter(call => call.method === 'POST').length, 0);
});

test('an acknowledged dispatch with zero runs is never redispatched on retry', async () => {
  const f = fixture({ runs: () => [] });
  await assert.rejects(f.control(), error => error.code === 'GITHUB_ACTIONS_UNKNOWN');
  f.reload();
  await assert.rejects(f.control(), error => error.code === 'GITHUB_ACTIONS_UNKNOWN');
  assert.equal(f.journal.dispatchOutcome, 'accepted');
  assert.equal(f.calls.filter(call => call.method === 'POST').length, 1);
});

test('duplicate matching runs still fail with EVIDENCE_CHANGED', async () => {
  const f = fixture({ runs: ({ run }) => [run, { ...run, id: 11 }] });
  await assert.rejects(f.control(), error => error.code === 'EVIDENCE_CHANGED');
  assert.equal(f.journal.runId, undefined);
  assert.equal(f.calls.filter(call => call.method === 'POST').length, 1);
});

test('cancellation during branch indexing prevents dispatch', async () => {
  let cancelled = false;
  const f = fixture({ invisible: 1, cancelled: () => cancelled });
  f.api.sleep = async () => {
    cancelled = true;
  };
  await f.control();
  assert.equal(f.calls.filter(call => call.method === 'POST').length, 0);
});

test('gh classifies only sanitized HTTP status and never retains account diagnostics', async t => {
  const root = mkdtempSync(join(tmpdir(), 'forge-actions-status-'));
  const previous = process.env.PATH;
  t.after(() => {
    process.env.PATH = previous;
    rmSync(root, { recursive: true, force: true });
  });
  writeFileSync(
    join(root, 'gh'),
    `#!${process.execPath}\nprocess.stderr.write(process.argv[3]);process.exit(1);\n`,
    { mode: 0o755 },
  );
  process.env.PATH = `${root}:${previous}`;
  for (const [text, status, outcome] of [
    ['gh: synthetic account secret (HTTP 404)', 404, 'rejected'],
    ['gh: synthetic account secret (HTTP 422)', 422, 'rejected'],
    ['HTTP/2 503: synthetic account secret', 503, 'ambiguous'],
    ['HTTP 500: synthetic account secret', 500, 'ambiguous'],
    ['HTTP 503: rate limit synthetic account secret', 503, 'ambiguous'],
    ['HTTP 422: rate limit synthetic account secret', 422, 'rejected'],
    ['rate limit synthetic account secret', undefined, 'ambiguous'],
    ['HTTP 401: synthetic account secret', 401, 'ambiguous'],
    ['HTTP 403: synthetic account secret', 403, 'ambiguous'],
    ['timeout: synthetic account secret', undefined, 'ambiguous'],
    ['network EOF: synthetic account secret', undefined, 'ambiguous'],
  ]) {
    await assert.rejects(actionsApi.request(text), error => {
      assert.ok(error instanceof ActionsApiError);
      assert.equal(error.httpStatus, status);
      assert.equal(error.outcome, outcome);
      if (status !== undefined) assert.match(error.message, new RegExp(`HTTP ${status}`));
      assert.doesNotMatch(JSON.stringify(error) + error.message, /synthetic account secret/);
      return true;
    });
  }
});

test('branch visibility polling preserves rate-limit budget recovery', async () => {
  const f = fixture();
  const request = f.api.request;
  let limited = false;
  f.api.request = async (...args) => {
    if (!limited && args[0].includes('/branches/')) {
      limited = true;
      throw new ForgeError(RATE_LIMITED, 'synthetic budget rejection');
    }
    return request(...args);
  };
  await f.control();
  assert.deepEqual(f.waits, [60_000]);
  assert.equal(f.journal.runId, 10);
  assert.equal(f.calls.filter(call => call.method === 'POST').length, 1);
});

test('reopening a stranded batch restores all interrupted members and retains original pins', async () => {
  const { reopenActionsLanding } = await import('../dist/github-actions-recovery.js');
  const batch = { id: 'batch', status: 'completed', prefixes: [{ runId: 'run', head: 'source' }] };
  const entries = [
    { id: 'a', batchId: 'batch', runId: 'run', status: 'interrupted' },
    { id: 'b', batchId: 'batch', runId: 'run', status: 'interrupted' },
    { id: 'c', batchId: 'other', runId: 'other', status: 'cancelled' },
  ];
  const rows = { landingEntries: entries, landingBatches: [batch] };
  const tx = {
    manifest: { collections: { landingEntries: { count: entries.length } } },
    at: (collection, position) => structuredClone(rows[collection][position]),
    find: (collection, id) => {
      const position = rows[collection].findIndex(row => row.id === id);
      return position < 0 ? undefined : { position, record: structuredClone(rows[collection][position]) };
    },
    replace: (collection, position, row) => {
      rows[collection][position] = row;
    },
  };
  reopenActionsLanding(tx, { id: 'run' });
  assert.deepEqual(
    rows.landingEntries.map(entry => entry.status),
    ['checking', 'checking', 'cancelled'],
  );
  assert.equal(rows.landingBatches[0].status, 'checking');
  assert.deepEqual(rows.landingBatches[0].prefixes, batch.prefixes);
});

test('same-op recovery excludes completed outcomes, cancellation and changed dispatch evidence', async t => {
  const { strandedActionsRun } = await import('../dist/github-actions-recovery.js');
  const root = mkdtempSync(join(tmpdir(), 'forge-actions-recovery-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const { mkdirSync } = await import('node:fs');
  const path = join(root, 'check-run');
  mkdirSync(path);
  const run = { id: 'run', status: 'interrupted', backend: { actual: 'github-actions', pin: 'pin' } };
  const journal = {
    pin: 'pin',
    pushed: true,
    commit: 'a'.repeat(40),
    dispatching: true,
    dispatchOutcome: 'ambiguous',
  };
  const set = (changes = {}, receipt = run) => {
    writeFileSync(join(path, 'github-actions.json'), JSON.stringify({ ...journal, ...changes }));
    writeFileSync(join(path, 'result.json'), JSON.stringify(receipt));
  };
  const store = { directory: root };
  set();
  assert.equal(strandedActionsRun(store, run), true);
  for (const status of ['passed', 'failed', 'cancelled', 'running'])
    assert.equal(strandedActionsRun(store, { ...run, status }), false);
  assert.equal(strandedActionsRun(store, { ...run, cancelRequested: true }), false);
  assert.equal(strandedActionsRun(store, { ...run, backend: { ...run.backend, actual: 'local' } }), false);
  for (const changes of [
    { pin: 'other' },
    { pushed: false },
    { dispatching: false },
    { runId: 10 },
    { dispatchOutcome: 'accepted' },
    { dispatchOutcome: 'rejected' },
  ]) {
    set(changes);
    assert.equal(strandedActionsRun(store, run), false, JSON.stringify(changes));
  }
  set({ dispatchRecoveryUsed: true });
  assert.equal(
    strandedActionsRun(store, run),
    true,
    'used recovery still permits observation, never another dispatch',
  );
  set({}, { ...run, status: 'passed' });
  assert.equal(strandedActionsRun(store, run), false, 'a newer passed receipt cannot be replaced');
});
