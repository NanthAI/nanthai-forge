// SPDX-License-Identifier: Apache-2.0
// Local synthetic fixtures only; never import or execute the cell/benchmark driver.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, access, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { driveForge, printedCommand, keepBoth, callForge } from './forge-protocol.mjs';
import { archiveThenRemove, removeWorkspace } from './evidence.mjs';
import { forgeArm, diffFromBase } from './forge-arm.mjs';
import { captureChanges } from './hunks.mjs';
import { scriptedForge } from './scripted.mjs';
import { operationsOf, cliError } from './receipts.mjs';

const root = '/synthetic/any project';
const draft = '/synthetic/other draft';
const next = (action, operationId, extra = {}) => ({ action, operationId, ...extra });
const response = result => ({ result });
const pending = action =>
  response({ status: 'submitted', jobId: 'job', next: next(action, action + '-op', { laneId: 'lane' }) });
const conflict = response({
  recovery: {
    conflict: {
      root: draft,
      paths: ['arbitrary.txt'],
      next: next('resolve', 'resolve-op', { laneId: 'draft' }),
    },
  },
});
const resolved = response({
  source: { outcome: { status: 'completed' } },
  applied: { head: 'resolved' },
  next: next('finish', 'finish-op', { inputs: [{ laneId: 'draft' }], accept: true }),
});
const landed = response({ submission: { phase: 'landed' } });
async function fixture(replies, options = {}) {
  const calls = [],
    edits = [],
    pauses = [];
  const result = await driveForge({
    root,
    laneId: 'lane',
    message: 'dry',
    call: async command => {
      calls.push(command);
      assert.ok(replies.length);
      return replies.shift();
    },
    edit: async value => edits.push(value),
    pause: async () => pauses.push(true),
    ...options,
  });
  return { result, calls, edits, pauses };
}

const operationId = 'requested-landing';
const waitNext = { action: 'wait', operationIds: [operationId], until: 'acceptance', timeoutSeconds: 7080 };
const waitCommand = `nforge agent '${root}' wait '${JSON.stringify({
  operationIds: waitNext.operationIds,
  until: waitNext.until,
  timeoutSeconds: waitNext.timeoutSeconds,
})}'`;
const submitted = {
  action: 'finish',
  operationId,
  result: {
    phase: 'finish',
    next: waitNext,
    command: waitCommand,
    waitCommand,
    wake: { delivery: 'background-exit', command: waitCommand, budgetSeconds: 7080 },
  },
};
const entry = (operationId, state, extra = {}) => ({
  submission: {
    operationId,
    phase: ['cancelled', 'superseded'].includes(state) ? 'terminal-failed' : state,
    observation: { state: ['composing', 'queued', 'checking', 'ready'].includes(state) ? 'pending' : state },
    ...(state === 'landed' ? { acceptance: { receiptId: operationId + '-receipt', head: 'accepted' } } : {}),
  },
  ...extra,
});
const observed = (entries, extra = {}) => ({
  action: 'observe',
  operationId: null,
  result: {
    status: 'terminal',
    successful: entries.every(e => e.submission.observation.state === 'landed'),
    submissions: entries,
    ...extra,
  },
});

test('async wake wait accepts its terminal observe envelope without replaying the landing', async () => {
  const f = await fixture([submitted, observed([entry(operationId, 'landed')])], { maxLandAttempts: 1 });
  assert.deepEqual(
    f.calls.map(c => c.action),
    ['land', 'wait'],
  );
  assert.deepEqual(f.calls[1].body, {
    operationIds: [operationId],
    until: 'acceptance',
    timeoutSeconds: 7080,
  });
  assert.equal(f.result.landAttempts, 1);
  assert.equal(f.pauses.length, 0);
});

// Exercise the actual reset consumer with a CLI process, including nonzero wait-budget exits.
async function resetFixture(t, replies) {
  const directory = await local(t),
    workspace = join(directory, 'reset'),
    callsFile = join(directory, 'calls.json'),
    cli = join(directory, 'cli.mjs');
  await mkdir(workspace);
  const waitBody = { operationIds: [operationId], until: 'acceptance' };
  const waiting = {
    action: 'observe',
    result: {
      status: 'IN_PROGRESS',
      submissions: [entry('unrelated', 'landed'), entry(operationId, 'checking')],
      next: { action: 'wait', ...waitBody },
      command: `nforge agent '${workspace}' wait '${JSON.stringify(waitBody)}'`,
    },
  };
  await writeFile(callsFile, '[]');
  await writeFile(
    cli,
    `import { readFileSync, writeFileSync } from 'node:fs';
const file = ${JSON.stringify(callsFile)};
const calls = JSON.parse(readFileSync(file));
const [, root, action, ...args] = process.argv.slice(2);
calls.push({ root, action, flags: args.slice(0, -1), body: JSON.parse(args.at(-1)) });
writeFileSync(file, JSON.stringify(calls));
const replies = ${JSON.stringify(replies(waiting))};
const reply = replies[calls.length - 1];
// Blocking land normalizes its own observation as a direct finish submission.
if (calls.length === 1 && reply?.value.result.submissions) {
  const result = reply.value.result;
  Object.assign(result, result.submissions.find(entry => entry.submission.operationId === ${JSON.stringify(operationId)}));
  delete result.submissions;
  reply.value.action = 'finish';
  reply.value.operationId = ${JSON.stringify(operationId)};
}
if (!reply) throw Error('Unexpected reset call ' + action);
console.log(JSON.stringify(reply.value));
process.exitCode = reply.code ?? 0;
`,
  );
  const arm = forgeArm({ cli }, { ws: directory, callLog: join(directory, 'unused') });
  let abandoned = 0,
    removed = 0,
    diffs = 0;
  arm.startLane = async root => {
    await mkdir(join(root, '.forge'), { recursive: true });
    await writeFile(
      join(root, '.forge', 'hosted-lane.json'),
      JSON.stringify({ selection: { base: { head: 'accepted' } } }),
    );
    return 'reset-lane';
  };
  arm.diffFromBase = async () => (++diffs === 1 ? [{ status: 'A', path: 'old-file' }] : []);
  arm.observe = async () => assert.fail('Reset must consume its public wait, not poll observations');
  arm.abandon = async () => abandoned++;
  arm.removeRoot = async () => removed++;
  return {
    run: () => arm.reset({ meta: directory, baseCommit: 'synthetic-base', root: workspace }),
    calls: async () => JSON.parse(await readFile(callsFile, 'utf8')),
    cleanup: () => ({ abandoned, removed }),
  };
}

test('reset consumes nonzero IN PROGRESS through the original operation and verifies accepted main', async t => {
  const f = await resetFixture(t, waiting => [
    { value: waiting, code: 2 },
    { value: waiting, code: 2 },
    { value: observed([entry('unrelated', 'terminal-failed'), entry(operationId, 'landed')]) },
  ]);
  const result = await f.run(),
    calls = await f.calls();
  assert.equal(result.phase, 'landed');
  assert.equal(result.verifiedMainHead, 'accepted');
  assert.deepEqual(
    calls.map(call => call.action),
    ['land', 'wait', 'wait'],
  );
  assert.equal(calls[0].body.laneId, 'reset-lane');
  assert.deepEqual(calls[1], calls[2]);
  assert.deepEqual(calls[1].body.operationIds, [operationId]);
  assert.deepEqual(f.cleanup(), { abandoned: 2, removed: 2 });
});

for (const state of ['terminal-failed', 'cancelled', 'superseded'])
  test(`reset records ${state} after a pending wait and keeps its evidence`, async t => {
    const failed = entry(operationId, state);
    failed.submission.error = { code: 'ORIGINAL_RESET_FAILURE', message: 'retained failure' };
    const f = await resetFixture(t, waiting => [
      { value: waiting, code: 2 },
      { value: observed([entry('unrelated', 'landed'), failed]), code: 1 },
    ]);
    await assert.rejects(f.run(), /BENCH_PRODUCT_FAILURE:.*ORIGINAL_RESET_FAILURE/);
    assert.deepEqual(
      (await f.calls()).map(call => call.action),
      ['land', 'wait'],
    );
    assert.deepEqual(f.cleanup(), { abandoned: 0, removed: 0 });
  });

test('reset accepts a healthy blocking landing without an additional CLI call', async t => {
  const f = await resetFixture(t, () => [{ value: response(entry(operationId, 'landed')) }]);
  assert.equal((await f.run()).phase, 'landed');
  assert.deepEqual(
    (await f.calls()).map(call => call.action),
    ['land'],
  );
});

test('blocking finish accepts the direct landed submission without a separate wait', async () => {
  const f = await fixture([
    {
      action: 'finish',
      operationId,
      result: { phase: 'finish', ...entry(operationId, 'landed') },
    },
  ]);
  assert.deepEqual(
    f.calls.map(c => c.action),
    ['land'],
  );
  assert.equal(f.result.landAttempts, 1);
});

for (const state of ['terminal-failed', 'cancelled', 'superseded'])
  test(`async wait retains ${state} as an unsuccessful outcome with its original error`, async () => {
    const failed = entry(operationId, state === 'cancelled' ? 'terminal-failed' : state);
    const code = state === 'cancelled' ? 'LANDING_CANCELLED' : 'RETAINED_FAILURE';
    failed.submission.error = { code, message: 'original failure evidence' };
    await assert.rejects(fixture([submitted, observed([failed])]), error => {
      assert.match(error.message, /BENCH_PRODUCT_FAILURE:/);
      assert.ok(error.message.includes(code));
      assert.match(error.message, /original failure evidence/);
      assert.doesNotMatch(error.message, /no terminal result or continuation/);
      return true;
    });
  });

test('mixed operations select requested success even when an unrelated entry failed first', async () => {
  const f = await fixture([
    submitted,
    observed([
      entry('unrelated', 'terminal-failed', { recovery: { next: next('sync', 'unrelated-sync') } }),
      entry(operationId, 'landed'),
    ]),
  ]);
  assert.deepEqual(
    f.calls.map(c => c.action),
    ['land', 'wait'],
  );
});

test('mixed operations cannot replace the requested failure with an unrelated landed receipt or alias', async () => {
  const other = entry('unrelated', 'landed');
  await assert.rejects(
    fixture([
      submitted,
      observed([other, entry(operationId, 'terminal-failed')], { ...other, successful: true }),
    ]),
    /BENCH_PRODUCT_FAILURE:/,
  );
  await assert.rejects(
    fixture([submitted, observed([other])]),
    /Terminal wait omitted a requested operation/,
  );
});

test('summary successful alone never invents a landed receipt for a pending operation', async () => {
  const queued = entry(operationId, 'ready');
  queued.submission.observation.state = 'pending';
  await assert.rejects(
    fixture([submitted, observed([queued], { successful: true })]),
    /BENCH_PRODUCT_FAILURE:/,
  );
});

for (const status of ['timeout', 'changed', 'message', 'cancelled', 'IN_PROGRESS'])
  test(`async ${status} continues the original wait then lands without spending a landing attempt`, async () => {
    const f = await fixture(
      [
        submitted,
        observed([entry(operationId, 'checking')], {
          status,
          successful: false,
          inProgress: true,
          next: waitNext,
          command: waitCommand,
        }),
        observed([entry(operationId, 'landed')]),
      ],
      { maxLandAttempts: 1 },
    );
    assert.deepEqual(
      f.calls.map(c => c.action),
      ['land', 'wait', 'wait'],
    );
    assert.deepEqual(f.calls[1], f.calls[2]);
    assert.equal(f.result.landAttempts, 1);
    assert.equal(f.pauses.length, 0);
  });

test('pending CLI wait without submission entries follows its exact printed continuation', async () => {
  const f = await fixture(
    [
      submitted,
      response({ status: 'IN_PROGRESS', reason: 'budget', next: waitNext, command: waitCommand }),
      observed([entry(operationId, 'landed')]),
    ],
    { maxLandAttempts: 1 },
  );
  assert.deepEqual(f.calls[1], f.calls[2]);
});

test('pending wait cannot replace the original operation with another advertised landing', async () => {
  await assert.rejects(
    fixture([
      submitted,
      observed([entry(operationId, 'checking')], {
        status: 'IN_PROGRESS',
        next: { ...waitNext, operationIds: ['unrelated'] },
      }),
    ]),
    /Pending wait continuation changed operation identity/,
  );
});

test('async wait failure follows only its matching entry recovery through resolve and finish', async () => {
  const failed = entry(operationId, 'terminal-failed', { recovery: conflict.result.recovery });
  const f = await fixture([submitted, observed([entry('unrelated', 'landed'), failed]), resolved, landed]);
  assert.deepEqual(
    f.calls.map(c => c.action),
    ['land', 'wait', 'resolve', 'finish'],
  );
  assert.equal(f.edits.length, 1);
  assert.equal(f.calls[2].root, draft);
  assert.equal(f.result.landAttempts, 2);
});

test('single-target wait aliases preserve recovery and advertised terminal retry parameters', async () => {
  const retry = { inputs: [{ laneId: 'lane', expected: { head: 'pinned' } }], retry: true, message: 'dry' };
  const failed = entry(operationId, 'terminal-failed');
  const f = await fixture([
    submitted,
    observed([failed], { ...failed, next: { action: 'finish', ...retry } }),
    landed,
  ]);
  assert.deepEqual(f.calls[2].body, retry);
  assert.equal(f.result.landAttempts, 2);
});

test('multiple requested operations require every selected operation to land, independent of entry order', async () => {
  const multiple = { action: 'wait', operationIds: [operationId, 'also-requested'], until: 'acceptance' };
  const start = response({ next: multiple });
  const f = await fixture([
    start,
    observed([
      entry('also-requested', 'landed'),
      entry('unrelated', 'terminal-failed'),
      entry(operationId, 'landed'),
    ]),
  ]);
  assert.equal(f.result.landAttempts, 1);
  await assert.rejects(
    fixture([start, observed([entry(operationId, 'landed'), entry('also-requested', 'terminal-failed')])]),
    /BENCH_PRODUCT_FAILURE:/,
  );
});

for (const count of [575, 1150])
  test(`wait decoding ${count} requested operations stays local and requires every receipt`, async t => {
    const operationIds = Array.from({ length: count }, (_, i) => `selected-${i}`);
    const replies = [
      response({ next: { action: 'wait', operationIds, until: 'acceptance' } }),
      observed(operationIds.map(id => entry(id, 'landed')).reverse()),
    ];
    const started = performance.now();
    const f = await fixture(replies, { maxLandAttempts: 1 });
    assert.equal(f.calls.length, 2, 'only the advertised land and wait, with no per-entry calls');
    assert.equal(f.result.landAttempts, 1);
    t.diagnostic(
      JSON.stringify({
        targets: count,
        elapsedMs: performance.now() - started,
        addedConvexCalls: 0,
        addedDbReads: 0,
        addedDbWrites: 0,
        addedR2Bytes: 0,
        idleCalls: 0,
      }),
    );
  });

test('pending source continues the same sync beyond land budget; resolve applies then exact finish', async () => {
  const recovery = response({ recovery: { next: next('sync', 'sync-op', { laneId: 'lane' }) } });
  const f = await fixture(
    [
      recovery,
      ...Array.from({ length: 12 }, () => pending('sync')),
      conflict,
      pending('resolve'),
      resolved,
      landed,
    ],
    { maxLandAttempts: 2 },
  );
  assert.equal(f.result.landAttempts, 2);
  assert.deepEqual(
    f.calls.map(c => c.action),
    ['land', ...Array(13).fill('sync'), 'resolve', 'resolve', 'finish'],
  );
  assert.ok(f.calls.filter(c => c.action === 'sync').every(c => c.body.operationId === 'sync-op'));
  assert.equal(f.calls.at(-1).root, draft);
  assert.deepEqual(f.calls.at(-1).body.inputs, [{ laneId: 'draft' }]);
  assert.equal(f.edits.length, 1);
  assert.equal(f.pauses.length, 1);
});

test('returned conflict root takes precedence over old sync continuation', async () => {
  const reply = structuredClone(conflict);
  reply.result.recovery.next = next('sync', 'obsolete');
  const f = await fixture([reply, resolved, landed]);
  assert.deepEqual(
    f.calls.map(c => c.action),
    ['land', 'resolve', 'finish'],
  );
});

test('failed source is terminal, never follows a new operation or spends land budget', async () => {
  let calls = 0;
  await assert.rejects(
    driveForge({
      root,
      laneId: 'lane',
      message: 'dry',
      call: async () => {
        calls++;
        return response({
          recovery: {
            source: {
              outcome: { status: 'failed', error: { code: 'SOURCE_FAILED' } },
            },
            next: next('sync', 'new'),
          },
        });
      },
    }),
    /BENCH_PRODUCT_FRICTION: Source failed/,
  );
  assert.equal(calls, 1);
});

test('completed server source with pending local resolve never jumps to finish', async () => {
  const applying = response({
    source: { outcome: { status: 'completed' } },
    next: next('resolve', 'resolve-op', { laneId: 'draft' }),
  });
  const f = await fixture([conflict, applying, resolved, landed]);
  assert.deepEqual(
    f.calls.map(c => c.action),
    ['land', 'resolve', 'resolve', 'finish'],
  );
  assert.equal(f.edits.length, 1);
});

test('interrupted resolve retries identical advertised parameters through local apply', async () => {
  const interrupted = {
    error: {
      code: 'WORK_CONFLICT',
      message:
        'Existing Forge metadata is preserved. Retry the original hosted agent action and parameters to reconcile its retained operation.',
    },
  };
  const f = await fixture([conflict, interrupted, resolved, landed]);
  assert.deepEqual(f.calls[1], f.calls[2]);
  await assert.rejects(fixture([conflict, interrupted, interrupted]), /Action resolve failed/);
});

test('ambiguous continuation, missing apply and changed pending identity surface friction', async () => {
  await assert.rejects(
    fixture([response({ recovery: { status: 'submitted' } })]),
    /no terminal result or continuation/,
  );
  await assert.rejects(
    fixture([conflict, response({ next: resolved.result.next })]),
    /without a local apply/,
  );
  await assert.rejects(
    fixture([response({ next: next('sync', 'sync-op') }), response({ next: next('sync', 'replacement') })]),
    /changed operation identity/,
  );
});

test('printed command retains quoting, root, flags and complete parameters', () => {
  const body = { operationId: 'op', message: "keep 'both'", accept: true };
  const quote = text => "'" + text.replaceAll("'", "'\\''") + "'";
  assert.deepEqual(printedCommand(`nforge agent ${quote(root)} finish ${quote(JSON.stringify(body))}`, '/'), {
    root,
    action: 'finish',
    flags: [],
    body,
  });
});

async function local(t) {
  const dir = await mkdtemp(join(tmpdir(), 'forge-bench-fixture-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}
async function put(file, bytes) {
  await mkdir(join(file, '..'), { recursive: true });
  await writeFile(file, bytes);
}
async function evidenceTree(root) {
  await put(join(root, '.forge', 'hosted-lane.json'), '{"scope":["x"]}');
  await put(root + '.forge-client/agent/original.json', '{"operationId":"original"}');
  await put(root + '.forge-client/sync-handoff.json', '{"operationId":"resolve"}');
  await put(root + '.forge-metrics.jsonl', '{"phase":"first"}\n{"phase":"last"}\n');
  const nested = root + '.forge-client/lanes/arbitrary';
  await put(join(nested, '.forge', 'hosted-lane.json'), '{}');
  await put(nested + '.forge-client/agent/resolve.json', '{"operationId":"resolve"}');
  await put(nested + '.forge-client/sync-handoff.json', '{}');
  await put(nested + '.forge-metrics.jsonl', '{"nested":1}\n{"nested":2}\n');
  return nested;
}

test('archive precedes every Forge removeRoot, with complete nested journals and metrics bytes', async t => {
  const dir = await local(t),
    root = join(dir, 'workspace', 'task');
  await evidenceTree(root);
  await put(root + '.forge-client/objects/not-evidence.json', 'source cache');
  const cellDir = join(dir, 'cell');
  const arm = forgeArm({}, { ws: join(dir, 'workspace'), callLog: join(cellDir, 'calls'), cellDir });
  const capture = await arm.removeRoot(root, 'task-done');
  assert.equal(capture.complete, true);
  assert.equal(capture.files.length, 8);
  const metrics = capture.files.filter(f => f.path.endsWith('.forge-metrics.jsonl'));
  assert.equal(metrics.length, 2);
  for (const file of metrics)
    assert.equal(
      (await readFile(join(capture.dir, 'files', file.path), 'utf8')).trim().split('\n').length,
      2,
    );
  await assert.rejects(access(root));
  await assert.rejects(access(root + '.forge-client'));
  assert.equal(JSON.parse(await readFile(join(capture.dir, 'capture.json'))).reason, 'task-done');
});

test('removal callback observes archive on disk; abnormal exit captures unregistered and orphan roots', async t => {
  const dir = await local(t),
    ws = join(dir, 'ws'),
    cellDir = join(dir, 'cell');
  const root = join(ws, 'unregistered');
  await evidenceTree(root);
  await put(join(ws, 'orphan.forge-metrics.jsonl'), 'all\nmetrics\n');
  const ordered = await archiveThenRemove({
    root,
    cellDir,
    reason: 'task-error',
    remove: async () => {
      // The source still exists at this boundary. The archive promise has fully settled.
      await access(root + '.forge-client/agent/original.json');
      const [entry] = await readdir(join(cellDir, 'evidence'));
      const manifest = JSON.parse(await readFile(join(cellDir, 'evidence', entry, 'capture.json')));
      assert.equal(manifest.complete, true);
      assert.equal(manifest.files.length, 8);
    },
  });
  assert.equal(ordered.complete, true);
  const captures = await removeWorkspace({
    ws,
    cellDir,
    reason: 'abnormal-exit',
    remove: async () => {
      await access(root);
      const entries = await readdir(join(cellDir, 'evidence'));
      assert.equal(entries.length, 3, 'both abnormal captures complete before workspace removal');
      for (const entry of entries)
        assert.equal(
          JSON.parse(await readFile(join(cellDir, 'evidence', entry, 'capture.json'))).complete,
          true,
        );
    },
  });
  assert.equal(captures.length, 2);
  assert.ok(captures.every(c => c.complete && c.reason === 'abnormal-exit'));
  assert.ok(captures.some(c => c.files.some(f => f.path === 'orphan.forge-metrics.jsonl')));
});

test('archive failure records incomplete capture and does not remove evidence', async t => {
  const dir = await local(t),
    root = join(dir, 'task');
  await mkdir(root + '.forge-client', { recursive: true });
  await put(root + '.forge-client/sync-handoff.json', 'handoff');
  const { symlink } = await import('node:fs/promises');
  await symlink('/missing-evidence', root + '.forge-client/agent');
  let removed = false;
  await assert.rejects(
    archiveThenRemove({
      root,
      cellDir: join(dir, 'cell'),
      reason: 'abnormal-exit',
      remove: async () => {
        removed = true;
      },
    }),
    /BENCH_EVIDENCE_INCOMPLETE/,
  );
  assert.equal(removed, false);
});

test('sparse capture compares materialized scope, retains true deletions and added paths', async t => {
  const dir = await local(t),
    meta = join(dir, 'meta'),
    root = join(dir, 'task');
  await mkdir(meta);
  const git = args => execFileSync('git', ['-C', meta, ...args], { encoding: 'utf8' }).trim();
  git(['init', '-q']);
  git(['config', 'user.name', 'fixture']);
  git(['config', 'user.email', 'fixture@example.invalid']);
  for (const name of ['changed.txt', 'deleted.txt', 'outside.txt']) await put(join(meta, name), 'base\n');
  git(['add', '.']);
  git(['commit', '-qm', 'base']);
  const baseCommit = git(['rev-parse', 'HEAD']);
  await put(
    join(root, '.forge', 'hosted-lane.json'),
    JSON.stringify({ scope: ['changed.txt', 'deleted.txt', 'new.txt', 'missing-in-both.txt'] }),
  );
  await put(join(root, 'changed.txt'), 'edited\n');
  await put(join(root, 'new.txt'), 'new\n');
  const captured = await captureChanges({ arm: 'forge', meta, baseCommit, root, out: join(dir, 'captured') });
  assert.deepEqual(
    captured.files.map(f => [f.path, f.status]),
    [
      ['changed.txt', 'M'],
      ['deleted.txt', 'D'],
      ['new.txt', 'A'],
    ],
  );
  assert.equal(captured.truncated, false);
  assert.equal((await diffFromBase(meta, baseCommit, root)).find(f => f.path === 'outside.txt').status, 'D');
});

test('generated helper parses and conflict edits keep arbitrary file content from both sides', async t => {
  const dir = await local(t);
  scriptedForge(dir);
  execFileSync(process.execPath, ['--check', join(dir, 'scripted-forge.mjs')]);
  await put(join(dir, 'any.file'), 'before\n<<<<<<< left\nleft\n=======\nright\n>>>>>>> right\nafter\n');
  keepBoth({ root: dir, paths: ['any.file'] });
  assert.equal(await readFile(join(dir, 'any.file'), 'utf8'), 'before\nleft\nright\nafter\n');
  assert.equal(typeof callForge, 'function');
});

test('pending save/compose returned by land uses the same landing budget', async () => {
  const finish = response({ phase: 'save', next: next('finish', 'original', { laneId: 'lane' }) });
  const f = await fixture([finish, finish, landed], { maxLandAttempts: 1 });
  assert.equal(f.result.landAttempts, 1);
  assert.deepEqual(
    f.calls.map(c => c.action),
    ['land', 'finish', 'finish'],
  );
});

test('dogfood-size local journal archive is complete, including orphaned nested siblings', async t => {
  const dir = await local(t),
    root = join(dir, 'task'),
    cellDir = join(dir, 'cell');
  // 560 local operation journals, no backend or per-record RPC. A long metrics journal
  // must survive byte-for-byte; this is not a tail/sample capture.
  for (let i = 0; i < 560; i++)
    await put(root + '.forge-client/agent/' + i + '.json', JSON.stringify({ operationId: i }));
  const orphan = root + '.forge-client/lanes/missing-root';
  await put(orphan + '.forge-client/agent/pending.json', '{"pending":true}');
  const metrics =
    Array.from({ length: 2800 }, (_, i) => JSON.stringify({ i, phase: 'checkout' })).join('\n') + '\n';
  await put(orphan + '.forge-metrics.jsonl', metrics);
  const captured = await archiveThenRemove({ root, cellDir, reason: 'scale', remove: async () => {} });
  assert.equal(captured.complete, true);
  assert.equal(captured.files.length, 562);
  const file = captured.files.find(f => f.path.endsWith('missing-root.forge-metrics.jsonl'));
  assert.equal(await readFile(join(captured.dir, 'files', file.path), 'utf8'), metrics);
});

test('abbreviated conflict paths inspect the materialized root without marker-name assumptions', async t => {
  const dir = await local(t);
  await put(join(dir, 'listed'), '<<<<<<< left\na\n=======\nb\n>>>>>>> right\n');
  await put(join(dir, 'unlisted', 'other'), '<<<<<<< left\nc\n=======\nd\n>>>>>>> right\n');
  await put(join(dir, 'unchanged'), 'keep all bytes\n');
  keepBoth({ root: dir, paths: ['listed'], more: 1 });
  assert.equal(await readFile(join(dir, 'unlisted', 'other'), 'utf8'), 'c\nd\n');
  assert.equal(await readFile(join(dir, 'unchanged'), 'utf8'), 'keep all bytes\n');
});

test('child failure preserves both streams and chooses the structured error over progress', async t => {
  const dir = await local(t);
  const { chmod } = await import('node:fs/promises');
  await put(
    join(dir, 'nforge'),
    `#!/bin/sh
printf '%s\\n' '{"event":"progress"}'
printf '%s\\n' '{"error":{"code":"INTERRUPTED","message":"retry exact operation"}}' >&2
exit 1
`,
  );
  await chmod(join(dir, 'nforge'), 0o755);
  const script = `import { callForge } from ${JSON.stringify(new URL('./forge-protocol.mjs', import.meta.url).href)};
const reply = await callForge({ root: process.cwd(), action: 'resolve', body: { operationId: 'original' } });
console.log('RETAINED:' + JSON.stringify(reply));`;
  const { spawnSync } = await import('node:child_process');
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: dir,
    env: { ...process.env, PATH: dir + ':' + process.env.PATH },
    encoding: 'utf8',
  });
  assert.equal(child.status, 0, child.stderr);
  assert.match(child.stdout, /"event":"progress"/);
  assert.match(child.stderr, /"code":"INTERRUPTED"/);
  assert.match(child.stdout, /RETAINED:\{"error":\{"code":"INTERRUPTED"/);
});

test('nonzero pending-source exit follows its structured continuation, never means recovery failed', async t => {
  const dir = await local(t);
  const { chmod } = await import('node:fs/promises');
  await put(
    join(dir, 'nforge'),
    `#!/bin/sh
printf '%s\\n' '{"result":{"phase":"save","next":{"action":"finish","operationId":"retained"}}}'
exit 2
`,
  );
  await chmod(join(dir, 'nforge'), 0o755);
  const script = `import { callForge } from ${JSON.stringify(new URL('./forge-protocol.mjs', import.meta.url).href)};
const reply = await callForge({ root: process.cwd(), action: 'land', body: {} });
console.log('RETAINED:' + reply.result.next.operationId);`;
  const { spawnSync } = await import('node:child_process');
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: dir,
    env: { ...process.env, PATH: dir + ':' + process.env.PATH },
    encoding: 'utf8',
  });
  assert.equal(child.status, 0, child.stderr);
  assert.match(child.stdout, /RETAINED:retained/);
});

test('collector ignores suggested ack IDs and all unexecuted continuations', () => {
  const suggested = '11111111-1111-4111-8111-111111111111';
  const command = `nforge agent . ack '${JSON.stringify({ operationId: suggested })}'`;
  const reply = {
    schema: 1,
    action: 'status',
    operationId: null,
    result: {
      next: { action: 'ack', operationId: suggested },
      command,
    },
    overlapNotice: { command, items: [{ ack: { operationId: suggested } }] },
  };
  assert.deepEqual(operationsOf(command + '\n' + JSON.stringify(reply)), []);
  assert.deepEqual(
    operationsOf(JSON.stringify({ error: { code: 'OVERLAP_UNANSWERED', message: command } })),
    [],
  );
});

test('collector retains only the executed sync/resolve/save/ack identity and landing receipt', () => {
  for (const action of ['sync', 'resolve', 'save', 'ack']) {
    const reply = {
      schema: 1,
      action,
      operationId: 'executed',
      result: {
        next: { action: 'finish', operationId: 'suggested' },
        recovery: { operationId: 'child-sync' },
      },
    };
    assert.deepEqual(operationsOf(JSON.stringify(reply)), [
      { action, operationId: 'executed', receiptId: null },
    ]);
  }
  const landed = {
    action: 'finish',
    operationId: 'landed',
    result: {
      submission: { acceptance: { receiptId: 'accepted' } },
    },
  };
  assert.deepEqual(operationsOf(JSON.stringify(landed) + '\n' + JSON.stringify(landed)), [
    { action: 'finish', operationId: 'landed', receiptId: 'accepted' },
  ]);
  assert.deepEqual(
    operationsOf(JSON.stringify({ action: 'land', result: {}, resolved: { operationId: 'resolved' } })),
    [{ action: 'land', operationId: 'resolved', receiptId: null }],
  );
});

test('collector retains stderr error code and message after stdout progress', () => {
  assert.deepEqual(
    cliError({
      stdout: '{"event":"progress"}\n',
      stderr: JSON.stringify({
        error: { code: 'NOT_FOUND', message: 'No retained landing operation' },
      }),
      message: 'Command failed',
      code: 1,
    }),
    {
      code: 'NOT_FOUND',
      message: 'No retained landing operation',
    },
  );
  assert.deepEqual(
    cliError({
      stdout: '{"error":{"code":"OLD","message":"stdout"}}',
      stderr: '{"error":{"code":"CURRENT","message":"stderr"}}',
    }),
    { code: 'CURRENT', message: 'stderr' },
  );
  assert.deepEqual(
    cliError({ stdout: '', stderr: 'plain failure', message: 'child exited', code: 'ENOENT' }),
    { code: 'ENOENT', message: 'child exited' },
  );
});

test('collector keeps distinct receipt-only identities without inventing landing operation IDs', () => {
  const replies = ['a', 'b'].map(receiptId => ({ action: 'land', receiptId, result: {} }));
  assert.deepEqual(operationsOf(replies.map(JSON.stringify).join('\n')), [
    { action: 'land', operationId: null, receiptId: 'a' },
    { action: 'land', operationId: null, receiptId: 'b' },
  ]);
});

test('collector matches the executed action, including public aliases, rather than JSON source text', () => {
  const reply = JSON.stringify({ action: 'finish', operationId: 'real', result: {} });
  assert.deepEqual(operationsOf(reply, '', 'show'), []);
  assert.deepEqual(operationsOf(reply, '', 'land'), [
    { action: 'finish', operationId: 'real', receiptId: null },
  ]);
  assert.deepEqual(
    operationsOf(JSON.stringify({ action: 'save', operationId: 'saved', result: {} }), '', 'checkpoint'),
    [{ action: 'save', operationId: 'saved', receiptId: null }],
  );
});

for (const legacy of [true, false])
  test(`generic terminal retry envelope (${legacy ? 'legacy' : 'structured'}) retains selection and starts one new attempt`, async () => {
    const retry = {
      inputs: [{ laneId: 'arbitrary', expected: { head: 'pinned' } }],
      dependencies: [{ candidateId: 'dependency' }],
      message: 'original',
      retry: true,
      reason: 'other',
    };
    const command = `nforge agent '${root}' finish '${JSON.stringify(retry)}'`;
    const reply = response({
      submission: { phase: 'terminal-failed', error: { code: 'ARBITRARY_FAILURE' } },
      ...(legacy
        ? { next: 'retry', retry, retryCommand: command }
        : { next: { action: 'finish', ...retry }, command, retry, retryCommand: command }),
    });
    const f = await fixture([reply, landed]);
    assert.equal(f.result.landAttempts, 2);
    assert.deepEqual(f.calls[1], { root, action: 'finish', flags: [], body: retry });
    assert.equal(f.calls[1].body.operationId, undefined);
  });

test('terminal submission without retry is recorded as the actual failure, not a missing-continuation defect', async () => {
  await assert.rejects(
    fixture([
      response({
        submission: { phase: 'terminal-failed', error: { code: 'ANY_CODE', message: 'retained failure' } },
      }),
    ]),
    error => {
      assert.match(error.message, /BENCH_PRODUCT_FAILURE:/);
      assert.match(error.message, /ANY_CODE/);
      assert.doesNotMatch(error.message, /no terminal result or continuation|BENCH_PRODUCT_FRICTION/);
      return true;
    },
  );
});

test('terminal retries count against the existing landing attempt budget', async () => {
  const reply = response({
    submission: { phase: 'terminal-failed' },
    next: { action: 'finish', retry: true, reason: 'other' },
  });
  await assert.rejects(fixture([reply, reply], { maxLandAttempts: 2 }), /BENCH_LAND_ATTEMPTS_EXHAUSTED/);
});

test('an incomplete legacy retry marker never invents missing parameters', async () => {
  await assert.rejects(
    fixture([response({ submission: { phase: 'terminal-failed' }, next: 'retry' })]),
    /BENCH_PRODUCT_FAILURE:/,
  );
});
