import { postAcceptMoves } from '../dist/post-accept-coverage.js';
// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import { latestWorkFormat } from '../dist/work-format.js';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, rmSync, existsSync } from 'node:fs';
import { tmpdir, hostname } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { initNative, nativeExecute } from '../dist/native-work.js';
import { NativeSource } from '../dist/native-source.js';
import { WorkStore } from '../dist/work-store.js';
import { WorkService } from '../dist/work.js';
import { policyPreset } from '../dist/autonomy-policy.js';
import { checkEnvironment, runWork, recoverRuns } from '../dist/work-run.js';
import { completeAccepted } from '../dist/agent-lifecycle.js';
import { drainPostAccept, wakePostAccept } from '../dist/post-accept-main.js';
import { prepareNativeComposition } from '../dist/native-composition-candidate.js';
import { retainedAcceptance } from '../dist/work-channel.js';
import { fixMainIntentId, recordFixForward } from '../dist/post-accept-fix-forward.js';
const now = () => new Date().toISOString();
const actor = { kind: 'agent', id: 'synthetic-b8' };
function fixture(t, enabled = true) {
  const root = mkdtempSync(join(tmpdir(), 'forge-disjoint-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const file of ['a.txt', 'b.txt', 'delete.txt', 'mode.sh']) writeFileSync(join(root, file), 'base\n');
  const { head: base } = initNative(root),
    store = new WorkStore(root),
    source = new NativeSource(root);
  let data = store.load();
  data.autonomyPolicy = {
    ...policyPreset('trusted'),
    acceptance: { ...policyPreset('trusted').acceptance, disjointFastPath: enabled },
  };
  data.schema = enabled ? 14 : 13;
  const intent = {
    id: randomUUID(),
    outcome: 'Synthetic work',
    constraints: '',
    base,
    status: 'active',
    createdAt: now(),
    dependencies: [],
    notes: [],
  };
  const view = {
    id: randomUUID(),
    intentId: intent.id,
    base,
    head: base,
    inputs: [],
    dependencies: [],
    status: 'clean',
    details: '',
    at: now(),
  };
  const check = {
    id: randomUUID(),
    name: 'Full synthetic verify',
    executable: process.execPath,
    args: ['-e', "if(process.env.FORGE_CHECK_FULL!=='1')process.exit(71);console.log('full main')"],
    definition: 'a'.repeat(64),
    environmentLabel: '',
    at: now(),
  };
  data.intents.push(intent);
  data.views.push(view);
  data.checks.push(check);
  data.channelMoves.push({
    id: randomUUID(),
    channel: 'main',
    viewId: view.id,
    head: base,
    previous: null,
    status: 'accepted',
    provenance: 'user-declared-local',
    at: now(),
  });
  store.locked(() => store.save(data));
  function candidate(path, content = 'changed\n', extra = {}) {
    const laneId = randomUUID();
    const files = source.state(base).files.map(file => ({ ...file }));
    const edits = Array.isArray(path) ? path : [[path, content, extra]];
    for (const [path, content, extra = {}] of edits) {
      const index = files.findIndex(file => file.path === path);
      if (content === null) files.splice(index, 1);
      else if (index < 0) files.push({ path, blob: source.put(Buffer.from(content)), mode: 'file' });
      else files[index] = { ...files[index], blob: source.put(Buffer.from(content)), ...extra };
    }
    const head = source.writeState(files, [base], 'Synthetic candidate', now());
    const id = randomUUID(),
      intentId = randomUUID();
    const view = {
      id,
      intentId,
      base,
      composedMain: base,
      head,
      inputs: [{ laneId, head }],
      dependencies: [],
      status: 'clean',
      details: '',
      at: now(),
    };
    const run = {
      id: randomUUID(),
      viewId: id,
      head,
      base,
      inputs: view.inputs,
      dependencies: [],
      check,
      environment: checkEnvironment(),
      status: 'passed',
      startedAt: now(),
      endedAt: now(),
      exitCode: 0,
      runner: { pid: process.pid, host: hostname() },
      details: 'Synthetic passing evidence',
    };
    store.locked(() => {
      const d = store.load();
      d.intents.push({ ...intent, id: intentId });
      d.lanes.push({
        id: laneId,
        intentId,
        name: String(path),
        base,
        head,
        state: 'active',
        assignment: '',
        target: '',
        checkpoints: [],
      });
      d.views.push(view);
      d.runs.push(run);
      d.revision++;
      store.save(d);
    });
    return { view, run, laneId, intentId };
  }
  function accept(candidate, previous = base, operationId = randomUUID(), acceptanceActor = actor) {
    const command = {
      action: 'accept-channel',
      operationId,
      channel: 'main',
      viewId: candidate.view.id,
      expectedHead: candidate.view.head,
      expectedPrevious: previous,
    };
    return {
      command,
      move: nativeExecute(store, command, store.revision(), { actor: acceptanceActor }).result,
    };
  }
  return { root, store, source, base, check, candidate, accept };
}

test('disjoint acceptance keeps both heads, records proof, preserves retry identity and exact View', t => {
  const f = fixture(t),
    a = f.candidate('a.txt'),
    b = f.candidate('b.txt');
  const first = f.accept(a).move,
    result = f.accept(b);
  assert.equal(result.move.previous, first.head);
  assert.equal(result.move.fastPath.composedMain, f.base);
  assert.deepEqual(result.move.fastPath.mainPaths, ['a.txt']);
  assert.deepEqual(result.move.fastPath.lanePaths, ['b.txt']);
  assert.equal(result.move.fastPath.runId, b.run.id);
  assert.equal(result.move.postAccept.mode, 'full');
  assert.ok(f.source.contains(result.move.head, first.head));
  assert.ok(f.source.contains(result.move.head, b.view.head));
  assert.ok(retainedAcceptance(f.store, f.store.load(), result.move));
  const before = f.store.snapshotBytes();
  assert.deepEqual(nativeExecute(f.store, result.command, 0, { actor }).result, result.move);
  assert.deepEqual(f.store.snapshotBytes(), before);
  assert.throws(
    () =>
      nativeExecute(f.store, { ...result.command, expectedPrevious: first.head }, f.store.revision(), {
        actor,
      }),
    { code: 'WORK_OPERATION_CHANGED' },
  );
});
for (const [label, path, content, extra] of [
  ['add', 'new.txt', 'new\n', {}],
  ['delete', 'delete.txt', null, {}],
  ['mode', 'mode.sh', 'base\n', { mode: 'executable' }],
])
  test(`exact manifest disjointness includes ${label}`, t => {
    const f = fixture(t),
      a = f.candidate(path, content, extra),
      b = f.candidate('b.txt');
    f.accept(a);
    const { move } = f.accept(b);
    assert.deepEqual(move.fastPath.mainPaths, [path]);
  });
for (const reason of [
  'overlap',
  'disabled',
  'definition',
  'environment',
  'lane-head',
  'ancestry',
  'missing-provenance',
  'conflict',
  'run-inputs',
  'run-head',
  'unterminated',
  'missing-run',
  'failed-run',
  'cancelled-run',
  'run-dependencies',
  'historical-view',
])
  test(`does not reuse evidence: ${reason}`, t => {
    const f = fixture(t, reason !== 'disabled'),
      a = f.candidate('a.txt'),
      b = f.candidate(reason === 'overlap' ? 'a.txt' : 'b.txt', 'other\n');
    f.accept(a);
    f.store.locked(() => {
      const d = f.store.load();
      if (reason === 'missing-run') d.runs = d.runs.filter(r => r.id !== b.run.id);
      if (reason === 'failed-run') d.runs.find(r => r.id === b.run.id).status = 'failed';
      if (reason === 'cancelled-run') d.runs.find(r => r.id === b.run.id).status = 'cancelled';
      if (reason === 'run-dependencies')
        d.runs.find(r => r.id === b.run.id).dependencies = [
          { kind: 'view', viewId: a.view.id, head: a.view.head },
        ];
      if (reason === 'historical-view') d.views.push({ ...b.view, id: randomUUID() });
      if (reason === 'run-inputs') d.runs.find(r => r.id === b.run.id).inputs = [];
      if (reason === 'run-head') d.runs.find(r => r.id === b.run.id).head = a.view.head;
      if (reason === 'unterminated') delete d.runs.find(r => r.id === b.run.id).endedAt;
      if (reason === 'definition') d.checks[0].definition = 'b'.repeat(64);
      if (reason === 'environment')
        d.runs.find(r => r.id === b.run.id).environment.fingerprint = 'b'.repeat(64);
      if (reason === 'lane-head') d.lanes.find(l => l.id === b.laneId).head = a.view.head;
      if (reason === 'ancestry') d.views.find(v => v.id === b.view.id).composedMain = b.view.head;
      if (reason === 'missing-provenance') delete d.views.find(v => v.id === b.view.id).composedMain;
      if (reason === 'conflict') d.views.find(v => v.id === b.view.id).status = 'conflict';
      d.revision++;
      f.store.save(d);
    });
    assert.throws(
      () => f.accept(b),
      e => ['CHANNEL_CHANGED', 'VIEW_STALE'].includes(e.code),
    );
  });

test('composition records current main independently of old Intent base', t => {
  const f = fixture(t),
    a = f.candidate('a.txt'),
    b = f.candidate('b.txt');
  const first = f.accept(a).move;
  const synced = f.source.compose(first.head, b.view.head, 'Synthetic sync', now()).head;
  f.store.locked(() => {
    const data = f.store.load();
    data.lanes.find(lane => lane.id === b.laneId).head = synced;
    data.revision++;
    f.store.save(data);
  });
  const composed = prepareNativeComposition(f.root, f.store.load(), {
    action: 'compose',
    operationId: randomUUID(),
    intentId: b.intentId,
    inputs: [{ laneId: b.laneId, head: synced }],
    dependencies: [],
  });
  assert.equal(composed.view.base, f.base);
  assert.equal(composed.view.composedMain, first.head);
  assert.ok(f.source.contains(composed.view.head, first.head));
});

test('dependency/cohort completion includes exact dependency heads and leaves later heads open', async t => {
  const f = fixture(t),
    a = f.candidate('a.txt'),
    b = f.candidate('b.txt'),
    c = f.candidate('new.txt');
  f.store.locked(() => {
    const d = f.store.load();
    d.views.find(v => v.id === a.view.id).dependencies = [
      { kind: 'view', viewId: b.view.id, head: b.view.head },
      { kind: 'view', viewId: c.view.id, head: c.view.head },
    ];
    d.lanes.find(l => l.id === c.laneId).head = a.view.head;
    d.revision++;
    f.store.save(d);
  });
  const result = await completeAccepted(new WorkService(f.root), a.view.id);
  assert.deepEqual(new Set(result.lanes), new Set([a.laneId, b.laneId]));
  assert.equal(f.store.select('lanes', c.laneId).state, 'active');
  assert.ok(result.skipped.some(s => s.laneId === c.laneId && s.code === 'LANE_STALE'));
  assert.equal(f.store.select('intents', b.intentId).status, 'completed');
});

test('burst post-accept requests coalesce to newest main, force full, and reconcile once', async t => {
  const f = fixture(t),
    a = f.candidate('a.txt'),
    b = f.candidate('b.txt'),
    c = f.candidate('new.txt');
  f.accept(a);
  f.accept(b);
  const last = f.accept(c).move;
  const saved = process.env.FORGE_CHECK_FULL;
  process.env.FORGE_CHECK_FULL = '1';
  try {
    await drainPostAccept(f.store);
    await drainPostAccept(f.store);
  } finally {
    if (saved === undefined) delete process.env.FORGE_CHECK_FULL;
    else process.env.FORGE_CHECK_FULL = saved;
  }
  const d = f.store.load(),
    runs = d.runs.filter(r => r.mainCheck);
  assert.equal(runs.length, 1);
  assert.equal(runs[0].status, 'passed');
  assert.equal(runs[0].head, last.head);
  assert.equal(runs[0].environment.env.FORGE_CHECK_FULL, '1');
  assert.equal(
    new Set(
      postAcceptMoves(d.channelMoves)
        .filter(m => m.postAccept)
        .map(m => m.postAcceptRunId),
    ).size,
    1,
  );
});

test('red post-accept main keeps accepted source and retains failing run', async t => {
  const f = fixture(t),
    a = f.candidate('a.txt'),
    b = f.candidate('b.txt');
  f.accept(a);
  const accepted = f.accept(b).move;
  f.store.locked(() => {
    const d = f.store.load();
    d.checks[0].args = ['-e', "console.error('main failed');process.exit(1)"];
    d.checks[0].definition = 'c'.repeat(64);
    d.revision++;
    f.store.save(d);
  });
  const saved = process.env.FORGE_CHECK_FULL;
  process.env.FORGE_CHECK_FULL = '1';
  try {
    await drainPostAccept(f.store);
  } finally {
    if (saved === undefined) delete process.env.FORGE_CHECK_FULL;
    else process.env.FORGE_CHECK_FULL = saved;
  }
  const d = f.store.load();
  assert.equal(d.channelMoves.at(-1).head, accepted.head);
  const run = d.runs.find(r => r.mainCheck);
  assert.equal(run.status, 'failed');
  assert.match(run.failureSummary, /main failed/);
  const intent = d.intents.find(intent => intent.id === fixMainIntentId(run));
  assert.match(intent.outcome, /^Fix main: Full synthetic verify failed after /);
  assert.ok(intent.outcome.endsWith(accepted.id));
  assert.deepEqual(intent.mainCheckFailure, {
    channel: 'main',
    head: accepted.head,
    landingId: accepted.id,
    runId: run.id,
  });
  for (const pin of [run.id, run.viewId, run.head, accepted.id, intent.id])
    assert.ok(intent.constraints.includes(pin));
  assert.match(intent.constraints, /new Lane on current main/);
  assert.match(intent.constraints, /preserving all later accepted work/);
  assert.match(intent.constraints, /Never rewind or automatically revert main/);
  assert.match(intent.notes[0].text, /Copy prompt for an agent/);
  const revision = d.revision;
  await drainPostAccept(f.store);
  assert.equal(f.store.revision(), revision);
  assert.equal(recordFixForward(d), false);
  // A rerun at the same failing head cannot duplicate or reopen the handoff.
  intent.status = 'abandoned';
  d.runs.push({ ...run, id: randomUUID() });
  assert.equal(recordFixForward(d), false);
  assert.equal(d.intents.filter(i => i.mainCheckFailure).length, 1);
  assert.equal(intent.status, 'abandoned');
});

test('4096-character failure receipt is durable and terminal before cleanup', async t => {
  const f = fixture(t),
    candidate = f.candidate('b.txt');
  f.store.locked(() => {
    const d = f.store.load();
    d.checks[0].args = ['-e', "console.error('Error '+ 'x'.repeat(7000));process.exit(1)"];
    d.revision++;
    f.store.save(d);
  });
  const runId = randomUUID();
  runWork(
    f.store,
    {
      action: 'run-check',
      operationId: runId,
      viewId: candidate.view.id,
      expectedHead: candidate.view.head,
      checkId: f.check.id,
      expectedDefinition: f.check.definition,
      expectedEnvironment: checkEnvironment().fingerprint,
    },
    f.store.revision(),
  );
  const deadline = Date.now() + 20000;
  let run;
  do {
    await new Promise(resolve => setTimeout(resolve, 50));
    f.store.locked(() => {
      const d = f.store.load();
      if (recoverRuns(f.store, d)) {
        d.revision++;
        f.store.save(d);
      }
    });
    run = f.store.select('runs', runId);
  } while (!run.endedAt && Date.now() < deadline);
  assert.equal(run.status, 'failed');
  assert.equal(run.failureSummary.length, 4096);
  assert.equal(run.failureSummary[0], '…');
  const receipt = JSON.parse(readFileSync(join(f.store.directory, `check-${runId}`, 'result.json'), 'utf8'));
  assert.equal(receipt.status, 'failed');
  assert.equal(receipt.failureSummary.length, 4096);
  assert.equal(existsSync(join(f.store.directory, `check-${runId}`, 'workspace')), false);
});

test('future format says upgrade nforge before reading or writing', t => {
  const f = fixture(t, false),
    path = join(f.store.directory, 'work.json');
  const raw = JSON.parse(readFileSync(path, 'utf8'));
  raw.fields.schema = latestWorkFormat + 1;
  writeFileSync(path, JSON.stringify(raw));
  const before = readFileSync(path);
  assert.throws(
    () => f.store.load(),
    e => e.code === 'WORK_UPGRADE_REQUIRED' && e.message.includes('upgrade nforge'),
  );
  assert.throws(() => f.store.records(), /upgrade nforge/);
  assert.deepEqual(readFileSync(path), before);
});

const oldCli = process.env.FORGE_OLD_NFORGE;
test(
  'installed pre-B8 CLI rejects format14 reader and writers without retained writes',
  { skip: !oldCli },
  async t => {
    const f = fixture(t),
      candidate = f.candidate('b.txt');
    const retained = () => {
      const files = [];
      const walk = dir => {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          const path = join(dir, entry.name);
          if (entry.isDirectory()) walk(path);
          else if (!/queue|lock/.test(path)) files.push([path, readFileSync(path).toString('base64')]);
        }
      };
      walk(f.store.directory);
      return files.sort(([a], [b]) => a.localeCompare(b));
    };
    const before = retained();
    const commands = [
      ['agent', f.root, 'status', '{}'],
      ['agent', f.root, 'start', JSON.stringify({ outcome: 'must not write' })],
      [
        'agent',
        f.root,
        'checkpoint',
        JSON.stringify({ laneId: candidate.laneId, message: 'must not write' }),
      ],
      [
        'work',
        f.root,
        JSON.stringify({
          action: 'note',
          intentId: candidate.intentId,
          text: 'must not write',
          kind: 'comment',
        }),
        String(f.store.revision()),
      ],
      ['agent', f.root, 'set-policy', JSON.stringify({ operationId: randomUUID(), preset: 'trusted' })],
    ];
    for (const args of commands) {
      let error;
      try {
        execFileSync(oldCli, args, { encoding: 'utf8', stdio: 'pipe', timeout: 20000 });
      } catch (e) {
        error = e;
      }
      assert.ok(error, `old CLI accepted ${args[2]}`);
      assert.match(`${error.stderr}${error.stdout}`, /invalid|Invalid|schema|format|INTERNAL_ERROR/);
      t.diagnostic(
        `old ${args[0]} ${args[2]}: rejected (${JSON.parse(error.stderr || error.stdout).error.code})`,
      );
      assert.deepEqual(retained(), before, `old writer changed retained files: ${args[2]}`);
    }
  },
);

test('scoped acceptance queues full main while disjoint policy stays off and format13 stays readable', t => {
  const f = fixture(t, false),
    candidate = f.candidate('b.txt');
  f.store.locked(() => {
    const data = f.store.load();
    data.runs.find(run => run.id === candidate.run.id).checkSelection = {
      scope: 'scoped',
      reason: 'synthetic',
      tests: ['tests/synthetic.test.mjs'],
    };
    data.revision++;
    f.store.save(data);
  });
  const { move } = f.accept(candidate);
  assert.deepEqual(move.postAccept, { checkId: f.check.id, mode: 'full', reason: 'scoped-check' });
  assert.equal(move.fastPath, undefined);
  assert.equal(f.store.load().schema, 13);
  assert.equal(f.store.load().autonomyPolicy.acceptance.disjointFastPath, false);
});

const oldStoreModule = process.env.FORGE_OLD_WORK_STORE;
test(
  'legacy low-level bare transaction commit bypass is explicit; normal CLI writers reject',
  { skip: !oldStoreModule },
  async t => {
    const f = fixture(t),
      { WorkStore: OldWorkStore } = await import(oldStoreModule);
    const old = new OldWorkStore(f.root),
      before = readFileSync(join(f.store.directory, 'work.json'));
    assert.throws(() => old.load(), /Work metadata is invalid/);
    old.locked(() => old.commitRecords(old.records()));
    const after = readFileSync(join(f.store.directory, 'work.json'));
    assert.notDeepEqual(after, before);
    assert.equal(f.store.load().schema, 14);
    t.diagnostic(
      'Old bare records().commit() changes the revision without validating format14. Do not use legacy embedding APIs after enabling.',
    );
  },
);

test('disabled policy composition retains stale inputs and records their actual main', t => {
  const f = fixture(t, false),
    a = f.candidate('a.txt'),
    b = f.candidate('b.txt');
  const accepted = f.accept(a).move;
  const result = prepareNativeComposition(f.root, f.store.load(), {
    action: 'compose',
    operationId: randomUUID(),
    intentId: b.intentId,
    inputs: b.view.inputs,
    dependencies: [],
  });
  assert.equal(result.view.composedMain, f.base);
  assert.equal(result.view.head, b.view.head);
  assert.equal(f.source.contains(result.view.head, accepted.head), false);
  const file = f.source.state(result.view.head).files.find(file => file.path === 'a.txt');
  assert.equal(f.source.object(file.blob).toString(), 'base\n');
});

for (const [label, first, second] of [
  ['delete versus edit', ['delete.txt', null], ['delete.txt', 'edit\n']],
  ['mode versus content', ['mode.sh', 'base\n', { mode: 'executable' }], ['mode.sh', 'edit\n']],
  ['add versus add', ['new.txt', 'first\n'], ['new.txt', 'second\n']],
  ['identical add versus add', ['new.txt', 'same\n'], ['new.txt', 'same\n']],
  [
    'rename source',
    [
      [
        ['a.txt', null],
        ['renamed.txt', 'base\n'],
      ],
    ],
    ['a.txt', 'edit\n'],
  ],
  [
    'rename destination',
    [
      [
        ['a.txt', null],
        ['renamed.txt', 'base\n'],
      ],
    ],
    ['renamed.txt', 'added\n'],
  ],
  ['file versus directory', ['directory', 'file\n'], ['directory/child.txt', 'child\n']],
])
  test(`overlap never reuses evidence: ${label}`, t => {
    const f = fixture(t),
      a = f.candidate(...first),
      b = f.candidate(...second);
    const landed = f.accept(a).move;
    const before = f.store.snapshotBytes();
    assert.throws(() => f.accept(b), { code: 'CHANNEL_CHANGED' });
    assert.deepEqual(f.store.snapshotBytes(), before);
    assert.equal(f.store.load().channelMoves.at(-1).head, landed.head);
  });

for (const preset of ['supervised', 'trusted'])
  for (const kind of ['agent', 'person'])
    test(`${preset} disjoint policy retains ${kind} acceptance authority`, t => {
      const f = fixture(t),
        a = f.candidate('a.txt'),
        b = f.candidate('b.txt');
      f.accept(a);
      f.store.locked(() => {
        const d = f.store.load();
        d.autonomyPolicy = policyPreset(preset);
        d.autonomyPolicy.acceptance.disjointFastPath = true;
        d.revision++;
        f.store.save(d);
      });
      const accept = () => f.accept(b, f.base, randomUUID(), { kind, id: 'synthetic-policy' });
      if (preset === 'supervised' && kind === 'agent') {
        const before = f.store.snapshotBytes();
        assert.throws(accept, e => ['CHANNEL_CHANGED', 'REVIEW_REQUIRED'].includes(e.code));
        assert.deepEqual(f.store.snapshotBytes(), before);
      } else {
        const { move } = accept();
        assert.equal(move.fastPath.runId, b.run.id);
        assert.equal(f.store.load().runs.filter(run => !run.mainCheck).length, 2);
      }
    });

for (const reason of ['protected-path', 'other-actor'])
  test(`fast path preserves person review: ${reason}`, t => {
    const f = fixture(t),
      a = f.candidate('a.txt'),
      b = f.candidate('b.txt');
    f.accept(a);
    f.store.locked(() => {
      const d = f.store.load();
      if (reason === 'protected-path') d.autonomyPolicy.acceptance.protectedPaths = ['b.txt'];
      else d.autonomyPolicy.acceptance.autoActors = ['someone-else'];
      d.revision++;
      f.store.save(d);
    });
    assert.throws(() => f.accept(b), { code: 'CHANNEL_CHANGED' });
    assert.ok(f.accept(b, f.base, randomUUID(), { kind: 'person', id: 'reviewer' }).move.fastPath);
  });

test('owner wakeup recovers a missing fix-forward handoff after a terminal main failure', async t => {
  const f = fixture(t),
    a = f.candidate('a.txt'),
    b = f.candidate('b.txt');
  f.accept(a);
  const accepted = f.accept(b).move;
  f.store.locked(() => {
    const data = f.store.load();
    data.checks[0].args = ['-e', "console.error('recover repair handoff');process.exit(1)"];
    data.checks[0].definition = 'd'.repeat(64);
    data.revision++;
    f.store.save(data);
  });
  await drainPostAccept(f.store);
  const failed = f.store.load().runs.find(run => run.mainCheck);
  assert.equal(failed.status, 'failed');
  const id = fixMainIntentId(failed);
  // Simulate a worker exit after terminal run publication, before its handoff.
  f.store.locked(() => {
    const data = f.store.load();
    data.intents = data.intents.filter(intent => intent.id !== id);
    data.revision++;
    f.store.save(data);
  });
  wakePostAccept(f.store);
  const end = Date.now() + 20000;
  while (!f.store.select('intents', id)) {
    assert.ok(Date.now() < end, 'Timed out recovering main repair handoff');
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  await drainPostAccept(f.store);
  const data = f.store.load();
  assert.equal(data.intents.filter(intent => intent.id === id).length, 1);
  assert.equal(data.runs.filter(run => run.mainCheck).length, 1);
  assert.equal(data.channelMoves.at(-1).head, accepted.head);
});

for (const preset of ['supervised', 'trusted'])
  test(`${preset} person acceptance needs no check on current main, but a stale person View cannot fast-path unchecked`, t => {
    const f = fixture(t),
      a = f.candidate('a.txt'),
      b = f.candidate('b.txt');
    f.store.locked(() => {
      const data = f.store.load();
      data.autonomyPolicy = policyPreset(preset);
      data.autonomyPolicy.acceptance.disjointFastPath = true;
      data.runs = [];
      data.revision++;
      f.store.save(data);
    });
    assert.throws(() => f.accept(a), {
      code: preset === 'supervised' ? 'REVIEW_REQUIRED' : 'CHECK_REQUIRED',
    });
    const person = { kind: 'person', id: 'reviewer' };
    const { move } = f.accept(a, f.base, randomUUID(), person);
    assert.equal(move.fastPath, undefined);
    const before = f.store.snapshotBytes();
    assert.throws(() => f.accept(b, f.base, randomUUID(), person), { code: 'CHANNEL_CHANGED' });
    assert.deepEqual(f.store.snapshotBytes(), before);
    assert.equal(f.store.load().runs.length, 0);
  });

test('opt-in owner root refresh uses the final disjoint fast-path composed head', t => {
  const f = fixture(t);
  f.store.locked(() => {
    const data = f.store.load();
    data.autonomyPolicy.ownerRootUpdates = true;
    f.store.save(data);
  });
  const a = f.candidate('a.txt', 'root a\n'),
    b = f.candidate('b.txt', 'root b\n');
  f.accept(a);
  const { move } = f.accept(b);
  assert.ok(move.fastPath);
  assert.equal(readFileSync(join(f.root, 'a.txt'), 'utf8'), 'root a\n');
  assert.equal(readFileSync(join(f.root, 'b.txt'), 'utf8'), 'root b\n');
  assert.equal(JSON.parse(readFileSync(join(f.root, '.forge/work/owner-root.json'), 'utf8')).head, move.head);
});
