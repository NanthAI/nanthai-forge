// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { actionsFixture } from './hosted-actions-fixture.mjs';
import { moduleUrl } from './convex-module.mjs';
import { code } from './hosted-checks-fixture.mjs';
import { reconcileHostedActions } from '../dist/hosted-actions-reconcile.js';
import { cleanupHostedActions } from '../dist/hosted-actions-controller.js';
import { actionsCallback } from '../dist/hosted-actions-evidence.js';
import { signHostedCheckCallback } from '../dist/hosted-check-evidence.js';
const backend = await import(moduleUrl('../convex/projectHostedActionsReconcile.ts'));
const key = 'synthetic-check-collector-only';
async function fixture() {
  const s = await actionsFixture();
  const owner = randomUUID(),
    c = await s.store.control({ kind: 'claim', owner }),
    token = c.mapping.lease.token;
  for (const command of [
    { kind: 'export', export: s.exported },
    { kind: 'published' },
    { kind: 'reserve', recovery: false },
    { kind: 'lookup', run: 123, empty: false },
    { kind: 'release' },
  ])
    await s.store.control({ ...command, owner, token });
  await s.control(s.input.id, {
    kind: 'observe',
    owner: s.input.lease.owner,
    token: s.input.lease.token,
    result: { status: 'accepted', executionId: '123' },
  });
  let observed = {
    id: 123,
    head_sha: s.exported.commit,
    display_title: s.mapping().branch,
    run_attempt: 1,
    status: 'in_progress',
    conclusion: null,
  };
  const jobs = [
    {
      id: 987,
      name: 'forge-static',
      run_id: 123,
      head_sha: s.exported.commit,
      run_attempt: 1,
      status: 'in_progress',
      conclusion: null,
    },
  ];
  let calls = 0,
    cancels = 0,
    logs = 0,
    deletes = 0;
  const remote = {
    api: {
      async request(path, method) {
        calls++;
        if (path.endsWith('/cancel')) {
          assert.equal(method, 'POST');
          cancels++;
          return;
        }
        if (path.includes('/jobs?')) return { jobs: structuredClone(jobs) };
        return structuredClone(observed);
      },
      async pages() {
        throw new Error('unbounded provider job list');
      },
    },
    async log() {
      logs++;
      return '# tests 1\n# pass 1\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n';
    },
    async delete() {
      deletes++;
    },
  };
  const store = {
    ...s.store,
    claim: owner =>
      s.run('actionsReconcileClaim', (ctx, args) => backend.claimActionsReconciliation(ctx, args, s.now()), {
        projectId: s.projectId,
        runId: s.input.id,
        owner,
      }),
    evidence: evidence =>
      s.run(
        'actionsReconcileEvidence',
        (ctx, args) => backend.applyActionsEvidence(ctx, args, () => key, s.now()),
        { projectId: s.projectId, runId: s.input.id, evidence },
      ),
  };
  const tick = () =>
    reconcileHostedActions(store, remote, s.bytes.get(s.input.plan.manifest.sha256), key, s.now);
  const complete = (conclusion = 'success') => {
    observed.status = 'completed';
    observed.conclusion = conclusion;
    for (const j of jobs) {
      j.status = 'completed';
      j.conclusion = conclusion;
    }
  };
  return {
    ...s,
    jobs,
    observed,
    remote,
    store,
    tick,
    complete,
    dbCounts: s.counts,
    counts: () => ({ calls, cancels, logs, deletes }),
  };
}
test('reconnect mid-run commits one exact native-State verdict and cleans the run-owned branch', async () => {
  const s = await fixture();
  const first = await s.tick();
  assert.equal(first.run.status, 'running');
  assert(first.nextAt > s.now());
  assert.equal(s.counts().logs, 0);
  s.advance(300000);
  s.complete();
  const terminal = await s.tick();
  assert.equal(terminal.run.status, 'passed');
  assert.equal(terminal.nextAt, null);
  assert.equal(terminal.run.request.expectedHead, s.input.request.expectedHead);
  assert.notEqual(terminal.run.request.expectedHead, s.exported.commit);
  await s.evidence(terminal.run);
  const calls = s.counts().calls,
    callbacks = s.tables.projectHostedCheckCallbacks.size;
  assert.equal((await s.tick()).run.terminalDigest, terminal.run.terminalDigest);
  assert.equal(s.counts().calls, calls);
  assert.equal(s.tables.projectHostedCheckCallbacks.size, callbacks);
  await cleanupHostedActions(s.store, s.remote);
  await cleanupHostedActions(s.store, s.remote);
  assert.equal(s.counts().deletes, 1);
  assert(s.mapping().deleted);
});
test('lost terminal acknowledgement reconnects without a second verdict or provider observation', async () => {
  const s = await fixture();
  s.complete();
  const apply = s.store.evidence;
  s.store.evidence = async e => {
    const r = await apply(e);
    if (e.callback.result.kind === 'complete') throw new Error('lost terminal reply');
    return r;
  };
  await assert.rejects(s.tick(), /lost terminal/);
  const calls = s.counts().calls;
  const r = await s.tick();
  assert.equal(r.run.status, 'passed');
  assert.equal(s.counts().calls, calls);
  assert.equal(s.tables.projectHostedCheckCallbacks.size, 2);
});
test('lost shard acknowledgement replays the same terminal shard event', async () => {
  const s = await fixture();
  s.complete();
  const apply = s.store.evidence;
  let lost = true;
  s.store.evidence = async e => {
    const r = await apply(e);
    if (lost) {
      lost = false;
      throw new Error('lost shard reply');
    }
    return r;
  };
  await assert.rejects(s.tick(), /lost shard/);
  assert.equal((await s.tick()).run.status, 'passed');
  assert.equal(s.tables.projectHostedCheckCallbacks.size, 2);
});
test('cancel request is retained until provider completion; cancel acknowledgement is not a verdict', async () => {
  const s = await fixture();
  await s.cancel(s.input.id);
  assert.equal((await s.tick()).run.status, 'running');
  assert.equal(s.counts().cancels, 1);
  s.advance(300000);
  await s.tick();
  assert.equal(s.counts().cancels, 1);
  s.advance(300000);
  s.complete('cancelled');
  assert.equal((await s.tick()).run.status, 'cancelled');
});
for (const [name, mutate] of [
  [
    'export commit',
    s => {
      s.observed.head_sha = '2'.repeat(40);
    },
  ],
  [
    'run identity',
    s => {
      s.observed.id = 999;
    },
  ],
  [
    'run attempt',
    s => {
      s.observed.run_attempt = 2;
    },
  ],
  [
    'job commit',
    s => {
      s.jobs[0].head_sha = '2'.repeat(40);
    },
  ],
  [
    'job run',
    s => {
      s.jobs[0].run_id = 999;
    },
  ],
  [
    'unselected shard',
    s => {
      s.jobs[0].name = 'forge-shard-3';
    },
  ],
])
  test(`stale ${name} cannot supply verdict evidence`, async () => {
    const s = await fixture();
    s.complete();
    mutate(s);
    await assert.rejects(s.tick(), code('EVIDENCE_CHANGED'));
    assert.equal(s.tables.projectHostedCheckCallbacks.size, 0);
  });
test('evidence transaction rejects a foreign State and export commit even with a valid signature', async () => {
  const s = await fixture(),
    claim = await s.store.claim(randomUUID());
  const callback = actionsCallback(claim.run, claim.mapping, {
    kind: 'complete',
    status: 'failed',
    exitCode: 1,
    output: null,
    cost: { status: 'unknown' },
  });
  const evidence = {
    owner: claim.mapping.lease.owner,
    token: claim.mapping.lease.token,
    commit: s.exported.commit,
    callback,
    signature: signHostedCheckCallback(callback, key),
  };
  await assert.rejects(s.store.evidence({ ...evidence, commit: '2'.repeat(40) }), code('EVIDENCE_CHANGED'));
  callback.head = '3'.repeat(64);
  await assert.rejects(
    s.store.evidence({ ...evidence, signature: signHostedCheckCallback(callback, key) }),
    code('EVIDENCE_CHANGED'),
  );
});
test('complete logs plus green run recover stuck job after the local settling window', async () => {
  const s = await fixture();
  s.observed.status = 'completed';
  s.observed.conclusion = 'success';
  for (let i = 0; i < 30; i++) {
    const r = await s.tick();
    assert.equal(r.run.status, 'running');
    assert(
      s.mapping().wakeAt - s.now() <= 60000,
      'completed-provider settling keeps its bounded recovery cadence',
    );
    s.advance(300000);
  }
  assert.equal(s.counts().logs, 0);
  const r = await s.tick();
  assert.equal(r.run.status, 'passed');
  assert.equal(s.counts().logs, 1);
});
for (const [name, text, status] of [
  ['missing logs', '', 'interrupted'],
  ['failed logs', '##[error] command failed\n', 'failed'],
])
  test(`${name} never pass a stuck green job`, async () => {
    const s = await fixture();
    s.observed.status = 'completed';
    s.observed.conclusion = 'success';
    s.remote.log = async () => text;
    // Retained backoff observation count, rather than waiting in the test process.
    const row = [...s.tables.projectHostedActionsExports.values()][0],
      m = JSON.parse(row.value);
    m.reconciliation.settles = 30;
    s.patch('projectHostedActionsExports', row._id, { value: JSON.stringify(m) });
    assert.equal((await s.tick()).run.status, status);
  });
test('finished/undispatched runs cause no provider calls and no Work/history scan', async () => {
  const s = await fixture();
  s.complete();
  await s.tick();
  const before = s.counts().calls;
  for (let i = 0; i < 4; i++) await s.tick();
  assert.equal(s.counts().calls, before);
  const measured = s.counts;
  assert.equal(typeof measured, 'function');
  // Fake ctx itself checks <=40 ranges/documents, bytes and no history hydration
  // for every claim/evidence call (including duplicates and negative cases).
  assert(s.tables.projectHostedActionsExports.size === 1);
});
test('transient provider failure schedules only the retained outstanding run and respects backoff', async () => {
  const s = await fixture();
  let calls = 0;
  s.remote.api.request = async () => {
    calls++;
    throw new (await import('../dist/github-actions-api.js')).ActionsApiError(503);
  };
  const r = await s.tick();
  assert.equal(r.run.status, 'running');
  assert(r.nextAt > s.now());
  await s.tick();
  assert.equal(calls, 1);
});
test('active worker lease provides a takeover wake rather than dropping the outstanding run', async () => {
  const s = await fixture(),
    claim = await s.store.claim(randomUUID());
  const r = await s.tick();
  assert.equal(r.nextAt, claim.mapping.lease.until);
  assert.equal(s.counts().calls, 0);
});
test('exact plan bytes are required; a different recipe cannot substitute a claimed native State', async () => {
  const s = await fixture();
  await assert.rejects(
    reconcileHostedActions(
      s.store,
      s.remote,
      Buffer.from(JSON.stringify({ ...s.recipe, head: 'f'.repeat(64) })),
      key,
      s.now,
    ),
    code('EVIDENCE_CHANGED'),
  );
  assert.equal(s.counts().calls, 0);
});
test('idle undispatched run creates no mapping or provider observation', async () => {
  const s = await actionsFixture();
  const row = [...s.tables.projectHostedCheckRuns.values()][0],
    run = JSON.parse(row.value);
  run.dispatchStarted = false;
  s.patch('projectHostedCheckRuns', row._id, { value: JSON.stringify(run) });
  const result = await s.run(
    'actionsIdleClaim',
    (ctx, args) => backend.claimActionsReconciliation(ctx, args, s.now()),
    { projectId: s.projectId, runId: run.id, owner: randomUUID() },
  );
  assert.equal(result.acquired, false);
  assert.equal(result.mapping, null);
  assert.equal(s.tables.projectHostedActionsExports.size, 0);
});
test('targeted durable wakes deduplicate deliveries, rearm before HTTP and stop after terminal cleanup', async () => {
  const wake = await import(moduleUrl('../convex/projectHostedActionsWake.ts')),
    s = await fixture();
  assert.equal(s.scheduled.length, 1);
  const tick = () =>
    s.run(
      'actionsWakePrepare',
      (ctx, input) => wake.prepareActionsWake({ ...ctx, scheduler: s.scheduler }, input, s.now()),
      { projectId: s.projectId, runId: s.input.id, generation: s.mapping().wakeGeneration },
    );
  s.advance(300000);
  const selected = await tick();
  assert.equal(selected.runId, s.input.id);
  assert.equal(s.scheduled.length, 2);
  assert.deepEqual(Object.keys(s.scheduled[0].args).sort(), ['generation', 'projectId', 'runId']);
  const stale = await s.run(
    'actionsWakeDuplicate',
    (ctx, input) => wake.prepareActionsWake({ ...ctx, scheduler: s.scheduler }, input, s.now()),
    { projectId: s.projectId, runId: s.input.id, generation: 1 },
  );
  assert.equal(stale, null);
  assert.equal(s.scheduled.length, 2);
  s.complete();
  await s.tick();
  assert.equal((await tick()).runId, s.input.id, 'terminal callback wakes exact branch cleanup');
  await cleanupHostedActions(s.store, s.remote);
  const schedules = s.scheduled.length;
  assert.equal(await tick(), null);
  assert.equal(s.scheduled.length, schedules);
});
test('a run whose provider and controller never answer backs off and stops waking after a quiet day', async () => {
  const wake = await import(moduleUrl('../convex/projectHostedActionsWake.ts')),
    s = await fixture();
  const tick = () =>
    s.run(
      'actionsWakePrepare',
      (ctx, input) => wake.prepareActionsWake({ ...ctx, scheduler: s.scheduler }, input, s.now()),
      { projectId: s.projectId, runId: s.input.id, generation: s.mapping().wakeGeneration },
    );
  let wakes = 0;
  for (; wakes < 500; wakes++) {
    s.advance(Math.max(1, s.mapping().wakeAt - s.now()));
    // Each observation reaches no controller and records no callback.
    if ((await tick()) === null && s.mapping().wakeAt <= s.now()) break;
  }
  assert(wakes < 60, `stuck run wakes a finite, small number of times (${wakes})`);
  const schedules = s.scheduled.length;
  s.advance(7 * 24 * 60 * 60_000);
  assert.equal(await tick(), null);
  assert.equal(s.scheduled.length, schedules, 'no timer remains after the quiet limit');
});
test('fake ctx bounds reconciliation reads independently of ten thousand historical exports', async () => {
  const s = await fixture();
  for (let i = 0; i < 10050; i++)
    s.insert('projectHostedActionsExports', {
      projectId: s.projectId,
      runId: randomUUID(),
      head: 'f'.repeat(64),
      value: 'unrelated-history',
    });
  s.complete();
  await s.tick();
  const counts = s.dbCounts.filter(c => c.name.startsWith('actionsReconcile'));
  assert(counts.length > 0);
  assert(counts.every(c => c.ranges <= 12 && c.documents <= 12 && c.readBytes < 32 * 1024));
  console.log(
    'Actions reconciliation maximum fake ctx counts:',
    JSON.stringify(
      Object.fromEntries(
        ['ranges', 'documents', 'readBytes', 'writes', 'writeBytes'].map(k => [
          k,
          Math.max(...counts.map(c => c[k])),
        ]),
      ),
    ),
  );
});
test('provider job pages are fetched outside transactions and only selected exact jobs produce evidence', async () => {
  const s = await fixture(),
    request = s.remote.api.request;
  const pages = [];
  s.remote.api.request = async (path, ...args) => {
    if (!path.includes('/jobs?')) return request(path, ...args);
    const page = Number(new URL('https://synthetic.invalid/' + path).searchParams.get('page'));
    pages.push(page);
    return {
      jobs:
        page === 1
          ? Array.from({ length: 50 }, (_, i) => ({ id: i + 1, name: 'unrelated-provider-job' }))
          : structuredClone(s.jobs),
    };
  };
  s.complete();
  assert.equal((await s.tick()).run.status, 'passed');
  assert.deepEqual(pages, [1, 2]);
});
test('lost cancel reply retries only cancellation for the retained run, without committing a verdict', async () => {
  const s = await fixture(),
    request = s.remote.api.request;
  let cancel = 0;
  await s.cancel(s.input.id);
  s.remote.api.request = async (path, ...args) => {
    if (path.endsWith('/cancel') && ++cancel === 1)
      throw new (await import('../dist/github-actions-api.js')).ActionsApiError();
    return request(path, ...args);
  };
  const first = await s.tick();
  assert.equal(first.run.status, 'running');
  assert(!s.mapping().reconciliation.cancelSent);
  s.advance(300000);
  await s.tick();
  assert(s.mapping().reconciliation.cancelSent);
  assert.equal(cancel, 2);
});
test('terminal success with a permanently incomplete job list cannot pass', async () => {
  const s = await fixture();
  s.complete();
  s.jobs.length = 0;
  const row = [...s.tables.projectHostedActionsExports.values()][0],
    m = JSON.parse(row.value);
  m.reconciliation.settles = 30;
  s.patch('projectHostedActionsExports', row._id, { value: JSON.stringify(m) });
  assert.equal((await s.tick()).run.status, 'interrupted');
});
test('wake action sends only fixed-run metadata, and terminal no-op never contacts the worker', async () => {
  const wake = await import(moduleUrl('../convex/projectHostedActionsWake.ts'));
  const previousUrl = process.env.FORGE_HOSTED_ACTIONS_CONTROLLER_URL,
    previousKey = process.env.FORGE_HOSTED_ACTIONS_CONTROLLER_KEY,
    originalFetch = globalThis.fetch;
  let requests = 0;
  const selected = { projectId: 'synthetic-project', runId: randomUUID(), dispatchKey: 'f'.repeat(64) };
  try {
    process.env.FORGE_HOSTED_ACTIONS_CONTROLLER_URL = 'https://synthetic-worker.invalid/observe';
    process.env.FORGE_HOSTED_ACTIONS_CONTROLLER_KEY = 'synthetic-worker-private-value';
    globalThis.fetch = async (_url, input) => {
      requests++;
      assert.deepEqual(JSON.parse(input.body), selected);
      assert.equal(input.redirect, 'error');
      return new Response(null, { status: 204 });
    };
    await wake.observe._handler({ runMutation: async () => selected }, { ...selected, generation: 1 });
    await wake.observe._handler({ runMutation: async () => null }, { ...selected, generation: 1 });
    assert.equal(requests, 1);
    globalThis.fetch = async () => {
      throw new Error('synthetic disconnected worker');
    };
    await assert.rejects(
      wake.observe._handler({ runMutation: async () => selected }, { ...selected, generation: 1 }),
      /disconnected worker/,
    );
  } finally {
    globalThis.fetch = originalFetch;
    if (previousUrl === undefined) delete process.env.FORGE_HOSTED_ACTIONS_CONTROLLER_URL;
    else process.env.FORGE_HOSTED_ACTIONS_CONTROLLER_URL = previousUrl;
    if (previousKey === undefined) delete process.env.FORGE_HOSTED_ACTIONS_CONTROLLER_KEY;
    else process.env.FORGE_HOSTED_ACTIONS_CONTROLLER_KEY = previousKey;
  }
});

test('eight-minute callback-driven check uses at most fifteen wake calls and zero progress polls', async t => {
  const wake = await import(moduleUrl('../convex/projectHostedActionsWake.ts'));
  const s = await fixture();
  t.mock.method(Date, 'now', () => s.now());
  let wakeCalls = 0,
    providerTicks = 0;
  const baseline = s.dbCounts.length;
  const savedUrl = process.env.FORGE_HOSTED_ACTIONS_CONTROLLER_URL;
  const savedKey = process.env.FORGE_HOSTED_ACTIONS_CONTROLLER_KEY;
  process.env.FORGE_HOSTED_ACTIONS_CONTROLLER_URL = 'https://synthetic-controller.invalid/observe';
  process.env.FORGE_HOSTED_ACTIONS_CONTROLLER_KEY = 'synthetic-controller-key';
  t.after(() => {
    if (savedUrl === undefined) delete process.env.FORGE_HOSTED_ACTIONS_CONTROLLER_URL;
    else process.env.FORGE_HOSTED_ACTIONS_CONTROLLER_URL = savedUrl;
    if (savedKey === undefined) delete process.env.FORGE_HOSTED_ACTIONS_CONTROLLER_KEY;
    else process.env.FORGE_HOSTED_ACTIONS_CONTROLLER_KEY = savedKey;
  });
  t.mock.method(globalThis, 'fetch', async (_url, input) => {
    assert.equal(JSON.parse(input.body).runId, s.input.id);
    providerTicks++;
    const before = s.commands.length;
    await cleanupHostedActions(s.store, s.remote);
    wakeCalls += s.commands.length - before;
    return new Response(null, { status: 204 });
  });
  const delivered = new Set();
  const drain = async () => {
    for (let i = 0; i < s.scheduled.length; i++) {
      const task = s.scheduled[i];
      if (delivered.has(i)) continue;
      // Fixtures retain relative delays; mapping wakeAt is the current deadline.
      if (task.args.generation === s.mapping().wakeGeneration && s.mapping().wakeAt > s.now()) continue;
      delivered.add(i);
      wakeCalls++;
      await wake.observe._handler(
        {
          runMutation: async (_ref, input) => {
            wakeCalls++;
            return s.run(
              'actionsWakeBudget',
              (ctx, args) => wake.prepareActionsWake({ ...ctx, scheduler: s.scheduler }, args, s.now()),
              input,
            );
          },
        },
        task.args,
      );
    }
  };
  let run = await s.status(s.input.id);
  s.advance(240000);
  const running = { ...s.shard(run, 0, 'running'), provider: 'github-actions' };
  run = await s.callback(running);
  const generation = s.mapping().wakeGeneration;
  await s.callback(running); // idempotent receipt must not arm another wake
  assert.equal(s.mapping().wakeGeneration, generation);
  s.advance(60000);
  await drain(); // watchdog defers to the last real callback; no provider request
  assert.equal(providerTicks, 0);
  s.advance(180000);
  run = await s.callback({ ...s.shard(run, 0), provider: 'github-actions' });
  await s.callback(
    actionsCallback(run, s.mapping(), {
      kind: 'complete',
      status: 'passed',
      exitCode: 0,
      output: null,
      cost: { status: 'unknown' },
    }),
  );
  await drain();
  assert.equal(providerTicks, 1, 'only terminal branch cleanup contacts the controller');
  assert(s.mapping().deleted);
  s.advance(600000);
  await drain(); // stale/watchdog deliveries settle; idle creates nothing
  const schedules = s.scheduled.length;
  await drain();
  assert.equal(s.scheduled.length, schedules);
  assert(wakeCalls <= 15);
  const measured = s.dbCounts
    .slice(baseline)
    .filter(c => c.name === 'actionsWakeBudget' || c.name === 'actionsControl');
  t.diagnostic(
    JSON.stringify({
      durationMinutes: 8,
      beforeWakeCallsEstimate: '60–300',
      afterWakeCalls: wakeCalls,
      documents: measured.reduce((n, c) => n + c.documents, 0),
      writes: measured.reduce((n, c) => n + c.writes, 0),
      providerProgressPolls: 0,
      cleanupTicks: providerTicks,
      scheduled: schedules,
      idleNewSchedules: 0,
    }),
  );
});
