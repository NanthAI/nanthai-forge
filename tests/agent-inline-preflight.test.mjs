// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { assertCommandWeight } from '../scripts/agent-weight.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { getFunctionName } from 'convex/server';
import { queueProofPaths, REGISTRY } from '../scripts/core-queue-paths.mjs';
import { REFRESH_QUEUE_PROOF, verifyQueueProof } from '../scripts/test-queue-proof.mjs';
import { slimReceipt } from '../dist/receipt-slim.js';
import { agentFixture } from './hosted-agent-fixture.mjs';
import { submitHostedLand } from '../dist/hosted-land-cli.js';
import { effectiveAgentDefaults } from '../dist/agent-parallel-defaults.js';
import { finishGates } from '../dist/agent-default-gates.js';
import { tryHeavySlot } from '../dist/heavy-slots.js';
import { clientCacheRoot } from '../dist/root-paths.js';
import { digest } from '../dist/hash.js';
import { rememberConflictPaths } from '../dist/hosted-conflict-precheck.js';
import { scanSecretPaths, SECRET_SCAN_ALLOW_FILE } from '../dist/secret-scan.js';
import {
  preflightRuntime,
  readPreflightReceipt,
  PREFLIGHT_LOCAL_BUDGET_SECONDS,
} from '../dist/agent-preflight.js';

const common = {
  'package.json': '{"type":"module"}',
  'scripts/forge-check.mjs': '',
  'tests/docs.test.mjs':
    "import test from 'node:test'; import fs from 'node:fs'; test('document remains readable', () => fs.readFileSync(new URL('../README.md', import.meta.url)));\n",
};
async function fixture(t, policy = 'require', reader = common['tests/docs.test.mjs'], extra = {}) {
  const files = { ...common, 'tests/docs.test.mjs': reader, ...extra };
  const s = agentFixture(t, {
    base: { ...files, 'README.md': 'Before\n' },
    lane: { ...files, 'README.md': extra['README.md'] ?? 'After\n' },
  });
  s.caps.agentDefaults = effectiveAgentDefaults({ preflight: policy });
  s.caps.features = ['land-gates'];
  await s.transport().dispatch('open', { laneId: s.lane.laneId });
  // The synthetic server accepts the checked Candidate; real preflight and finish run unchanged.
  const mutate = s.exchange.client.mutation;
  s.exchange.client.mutation = async (ref, args) => {
    const text = await mutate(ref, args);
    if (getFunctionName(ref) !== 'projectHostedLanding:enqueue') return text;
    const state = JSON.parse(text);
    state.phase = 'landed';
    state.observation = { state: 'landed', pendingReason: null, cause: null };
    state.acceptance = { receiptId: randomUUID(), head: s.lane.head };
    return JSON.stringify(state);
  };
  return s;
}

test('7008ff18: preflight refuses an edit made while it queued before any typecheck runs', async t => {
  const s = await fixture(t, 'require', undefined, {
    'forge.json': JSON.stringify({
      preflight: { static: [{ name: 'typecheck', command: ['node', 'check-type.mjs'] }] },
    }),
    'check-type.mjs':
      "import { writeFileSync } from 'node:fs'; writeFileSync('../typecheck-started', 'ran');",
  });
  const slots = `${s.root}-slots`;
  const settings = `${s.root}-settings.json`;
  writeFileSync(settings, JSON.stringify({ localHeavySlots: 1 }));
  for (const [key, value] of [
    ['FORGE_HEAVY_DIR', slots],
    ['FORGE_CLIENT_SETTINGS', settings],
  ]) {
    const prior = process.env[key];
    process.env[key] = value;
    t.after(() => (prior === undefined ? delete process.env[key] : (process.env[key] = prior)));
  }
  const held = tryHeavySlot(slots, 1);
  assert.ok(held);
  const editor = spawn(
    process.execPath,
    [
      '-e',
      `const { readdirSync, rmSync, watch, writeFileSync } = require('node:fs');
      const [slots, held, file] = process.argv.slice(1);
      const watcher = watch(slots, () => {
        if (!readdirSync(slots).some(name => name.startsWith('q-'))) return;
        watcher.close();
        writeFileSync(file, 'edited while queued\\n');
        rmSync(held, { recursive: true });
      });
      process.stdout.write('ready');`,
      slots,
      held,
      join(s.root, 'README.md'),
    ],
    { stdio: ['ignore', 'pipe', 'inherit'] },
  );
  t.after(() => editor.kill());
  const exited = once(editor, 'exit');
  await once(editor.stdout, 'data');
  await assert.rejects(s.transport().dispatch('preflight', { laneId: s.lane.laneId, run: true }), error => {
    assert.equal(error.code, 'LANE_DIRTY');
    assert.match(error.message, /changed while preflight waited for a heavy slot/);
    return true;
  });
  assert.deepEqual(await exited, [0, null]);
  assert.equal(existsSync(join(s.root, '..', 'typecheck-started')), false);
  assert.equal(readPreflightReceipt(s.root, s.lane.laneId), null);
  assert.deepEqual(
    readdirSync(slots).filter(name => /^\d+$/.test(name)),
    [],
  );
});

test('incident e0cedfb5: one land --save lands a one-file docs change after inline preflight, preserving operationId and call budget', async t => {
  const calls = [];
  for (const policy of ['require', 'off']) {
    const s = await fixture(t, policy),
      operationId = randomUUID();
    const before = s.calls.length;
    const result = await submitHostedLand(
      s.root,
      { operationId, message: 'Update document' },
      s.address,
      s.transport(),
    );
    assert.equal(result.operationId, operationId);
    assert.equal(result.result.submission.phase, 'landed');
    assert.equal(result.result.submission.operationId, operationId);
    const gate = JSON.parse(s.calls.find(c => c.name === 'projectHostedLanding:enqueue').args.gates).lanes[0];
    assert.equal(gate.preflight, policy === 'require' ? 'passed' : 'none');
    if (policy === 'require') {
      const receipt = readPreflightReceipt(s.root, s.lane.laneId);
      assert.equal(receipt.passed, true);
      assert.equal(receipt.tests, 1);
      assert.equal(receipt.budgetSeconds, PREFLIGHT_LOCAL_BUDGET_SECONDS);
    }
    calls.push(s.calls.slice(before).map(c => c.name));
    if (policy === 'require') {
      assertCommandWeight('landSave', { calls: calls.at(-1).length });
      t.diagnostic(JSON.stringify({ landSaveCalls: calls.at(-1).length }));
    }
  }
  // off omits path discovery by existing policy; compare require's inline run against a pre-satisfied run below.
  const s = await fixture(t),
    transport = s.transport();
  const advice = { changedPaths: { paths: ['README.md'], complete: true } };
  finishGates(s.root, s.caps.agentDefaults, { laneId: s.lane.laneId, head: s.lane.head }, advice, true);
  const before = s.calls.length;
  await submitHostedLand(
    s.root,
    { operationId: randomUUID(), message: 'Update document' },
    s.address,
    transport,
  );
  assert.deepEqual(
    s.calls.slice(before).map(c => c.name),
    calls[0],
    'inline preflight adds zero Convex calls',
  );
});

test('inline preflight failure stops before compose and names the exact next command', async t => {
  const s = await fixture(t);
  writeFileSync(
    join(s.root, 'tests/docs.test.mjs'),
    "import test from 'node:test'; test('red', () => { throw Error('synthetic regression'); });\n",
  );
  t.mock.method(preflightRuntime, 'filesystemEventHealth', () => ({ ok: true }));
  assert.throws(
    () =>
      finishGates(
        s.root,
        s.caps.agentDefaults,
        { laneId: s.lane.laneId, head: s.lane.head },
        { changedPaths: { paths: ['tests/docs.test.mjs'], complete: true } },
        true,
      ),
    error => {
      assert.equal(error.code, 'PREFLIGHT_REQUIRED');
      assert.match(error.message, /Inline preflight failed/);
      assert(error.message.includes(`nforge agent '${s.root}' preflight '{"laneId":"${s.lane.laneId}"}'`));
      assert.match(error.message, /same land operation/);
      return true;
    },
  );
  assert(!s.calls.some(c => /Compose|Landing/.test(c.name)));
});

test('inline preflight exhaustion keeps the existing budget and returns the exact stopped-files continuation', async t => {
  const s = await fixture(t);
  // Four direct readers exercise stopped-file recovery. Advance the fake clock without sleeping.
  for (let i = 0; i < 4; i++)
    writeFileSync(join(s.root, `tests/reader-${i}.test.mjs`), common['tests/docs.test.mjs']);
  const actual = Date.now();
  // Each parent clock read advances beyond the existing budget; the first group still runs.
  let reads = 0;
  t.mock.method(Date, 'now', () => actual + 181000 * reads++);
  let failure;
  try {
    finishGates(
      s.root,
      s.caps.agentDefaults,
      { laneId: s.lane.laneId, head: s.lane.head },
      { changedPaths: { paths: ['README.md'], complete: true } },
      true,
    );
  } catch (error) {
    failure = error;
  }
  assert.equal(failure?.code, 'PREFLIGHT_BUDGET_EXCEEDED');
  assert.match(failure.message, /exceeded its budget/);
  const receipt = readPreflightReceipt(s.root, s.lane.laneId);
  assert.equal(receipt.budgetSeconds, PREFLIGHT_LOCAL_BUDGET_SECONDS);
  assert(receipt.stoppedForTime > 0);
  assert(failure.message.includes(receipt.incomplete?.finish ?? receipt.stoppedRerun));
});

test('a failed inline land keeps its original operation and complete replay, with a structured exact preflight next command', async t => {
  const reader =
    "import test from 'node:test'; import fs from 'node:fs'; test('red document reader', () => { fs.readFileSync(new URL('../README.md', import.meta.url)); throw Error('synthetic failure'); });\n";
  const s = await fixture(t, 'require', reader),
    operationId = randomUUID();
  t.mock.method(preflightRuntime, 'filesystemEventHealth', () => ({ ok: true }));
  await assert.rejects(
    submitHostedLand(s.root, { operationId, message: 'Retain original message' }, s.address, s.transport()),
    error => {
      assert.equal(error.code, 'PREFLIGHT_REQUIRED');
      assert.match(error.message, /If source is unchanged, replay/);
      assert.match(error.message, /fresh operationId.*original source pins/);
      assert.equal(error.recovery.operationId, operationId);
      assert.equal(error.recovery.replay.parameters.operationId, operationId);
      assert.equal(error.recovery.replay.parameters.message, 'Retain original message');
      assert.match(error.recovery.command, /preflight/);
      assert(error.message.includes(error.recovery.command));
      assert(error.recovery.replayCommand.includes(operationId));
      return true;
    },
  );
  assert(!s.calls.some(c => /Compose|Landing/.test(c.name)), 'a failed local run starts no remote check');
});

test('protected-path approval is printed before required inline preflight spends a check', async t => {
  const s = await fixture(t);
  const { policyPreset } = await import('../dist/autonomy-policy.js');
  s.caps.protectedPathPolicy = {
    acceptance: {
      ...policyPreset('trusted').acceptance,
      ownerApprovalPaths: [],
      protectedPaths: ['README.md'],
    },
    checkEntries: [],
  };
  s.caps.features.push('protected-path-notice');
  const output = [];
  const write = process.stderr.write.bind(process.stderr);
  t.mock.method(process.stderr, 'write', (chunk, ...args) => {
    output.push(String(chunk));
    return write(chunk, ...args);
  });
  const result = await submitHostedLand(
    s.root,
    { operationId: randomUUID(), message: 'Protected document' },
    s.address,
    s.transport(),
  );
  assert.equal(result.result.submission.phase, 'landed');
  assert.match(result.result.protectedPathNotice.message, /a person allowed to accept/);
  const notice = output.findIndex(line => line.includes('Landing will need approval'));
  const check = output.findIndex(line => line.includes('preflight plan:'));
  assert(notice >= 0 && check > notice, 'approval is explained before the preflight run starts');
});

// A project's own formatter, lint command and test inventory, with no Forge-specific command names.
const staticProject = (bad, readers = 'throw') => ({
  'README.md': bad ? 'After  \n' : 'After\n',
  'forge.json': JSON.stringify({
    preflight: {
      static: [
        {
          name: 'style',
          command: ['node', 'scripts/style.mjs'],
          fix: ['node', 'scripts/style.mjs', '--write'],
        },
        { name: 'lint', command: ['node', 'scripts/lint.mjs'] },
      ],
    },
  }),
  'scripts/style.mjs': `import fs from 'node:fs';
    const text = fs.readFileSync('README.md', 'utf8');
    const formatted = text.trimEnd() + '\\n';
    if (process.argv.includes('--write')) fs.writeFileSync('README.md', formatted);
    else if (text !== formatted) { console.error('README.md: format error'); process.exit(1); }`,
  'scripts/lint.mjs': "import fs from 'node:fs'; fs.readFileSync('README.md');",
  // At 4 s/file, this is over the unchanged 10-minute test gate. Tests throw if started.
  ...Object.fromEntries(
    Array.from({ length: 151 }, (_, i) => [
      `tests/reader-${i}.test.mjs`,
      readers === 'throw'
        ? "import test from 'node:test'; import fs from 'node:fs'; test('document reader must stay advised', () => { fs.readFileSync(new URL('../README.md', import.meta.url)); throw Error('tests should not run'); });\n"
        : "import test from 'node:test'; import fs from 'node:fs'; test('document reader', () => { fs.readFileSync(new URL('../README.md', import.meta.url)); });\n",
    ]),
  ),
});

// A guard group of 15 synthetic readers whose first group blocks until the quick cap kills it. `before`
// runs in that runner first (for example, an edit to a tracked file).
async function quickCapFixture(t, before = '') {
  const files = staticProject(false, 'pass');
  files['forge.json'] = JSON.stringify({
    preflight: {
      tests: { glob: 'tests/*.test.mjs', command: ['node', 'quick-runner.mjs', '{files}'] },
      guards: [
        {
          name: 'Quick readers',
          tests: Object.keys(files)
            .filter(path => path.startsWith('tests/'))
            .slice(0, 15),
        },
      ],
    },
  });
  files['quick-runner.mjs'] = `
    import { appendFileSync, existsSync, renameSync, writeFileSync } from 'node:fs';
    const log = '.forge/quick-starts';
    const first = !existsSync(log);
    const line = JSON.stringify(process.argv.slice(2)) + '\\n';
    // The test's clock jumps when the log appears: it must appear with its line, never empty (the timeout
    // would kill this runner between the file's creation and its first write).
    ${before}
    if (first) { writeFileSync(log + '.tmp', line); renameSync(log + '.tmp', log); }
    else appendFileSync(log, line);
    if (first) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0); // test-signal: allow this synthetic runner blocks until the quick timeout kills it under the injected clock
  `;
  const s = await fixture(t, 'require', undefined, files);
  s.caps.agentDefaults = effectiveAgentDefaults({ preflight: 'require', preflightMaxMinutes: 0 });
  const log = join(s.root, '.forge', 'quick-starts');
  const fixed = Date.parse('2026-01-01T00:00:00.000Z');
  const jump = t.mock.method(Date, 'now', () => fixed + (existsSync(log) ? 101_000 : 0));
  return { s, log, restore: () => jump.mock.restore() };
}

test('incidents a1a8505b and 99b4062c: a timed-out first quick group stops new groups and the same land submits, with no replay', async t => {
  const { s, log, restore } = await quickCapFixture(t);
  const command = { operationId: randomUUID(), message: 'Quick cap lands', priority: 'normal' };
  let result;
  try {
    result = await submitHostedLand(s.root, command, s.address, s.transport());
  } finally {
    restore();
  }
  const groups = readFileSync(log, 'utf8')
    .trim()
    .split('\n')
    .map(line => JSON.parse(line));
  assert.equal(groups.length, 1, 'no test group starts after the first one times out');
  const receipt = readPreflightReceipt(s.root, s.lane.laneId);
  assert.equal(receipt.tests, 0);
  assert(receipt.stoppedForTime > groups[0].length, 'the rest of the queue is recorded as stopped');
  // The capped group is the landing check's, like every file the cap never started: one land submits.
  assert.equal(result.result.submission.operationId, command.operationId);
  assert.equal(result.result.submission.phase, 'landed');
  assert.equal(result.result.defaults.preflight.status, 'advised');
  assert.equal(result.result.defaults.preflight.quick.ran, 0);
  assert.equal(result.result.defaults.preflight.reason, 'inline quick preflight reached its local budget');
  const enqueues = s.calls.filter(c => c.name === 'projectHostedLanding:enqueue');
  assert.equal(enqueues.length, 1);
  // The server is told advised for this head, never passed: it is what the old replay sent.
  const gate = JSON.parse(enqueues[0].args.gates).lanes[0];
  assert.equal(gate.head, s.lane.head);
  assert.equal(gate.preflight, 'advised');
  // An operation an older CLI refused at the cap still replays on its quick receipt, even when
  // today's gate would require the full run: no test starts and the receipt is unchanged.
  const advice = { changedPaths: { paths: ['README.md'], complete: true } };
  const replayed = finishGates(
    s.root,
    effectiveAgentDefaults({ preflight: 'require', preflightMaxMinutes: 10 }),
    { laneId: s.lane.laneId, head: s.lane.head },
    advice,
    true,
    true,
  );
  assert.equal(replayed.preflight.status, 'advised');
  assert.equal(replayed.preflight.reason, 'inline quick preflight reached its local budget');
  assert.equal(readFileSync(log, 'utf8').trim().split('\n').length, 1, 'the replay starts no test');
  assert.deepEqual(readPreflightReceipt(s.root, s.lane.laneId), receipt);
});

test('Item 99b4062c: a quick group that edits a saved file before the cap stops the land as LANE_DIRTY, not submitted', async t => {
  const { s, restore } = await quickCapFixture(
    t,
    "if (first) appendFileSync('README.md', 'edited by a test\\n');",
  );
  try {
    await assert.rejects(
      submitHostedLand(
        s.root,
        { operationId: randomUUID(), message: 'Dirty quick cap' },
        s.address,
        s.transport(),
      ),
      error => error.code === 'LANE_DIRTY',
    );
  } finally {
    restore();
  }
  assert(
    !s.calls.some(c => c.name === 'projectHostedLanding:enqueue'),
    'the edited checkout submits nothing',
  );
});

test('preflight and land scan a saved resolution against the main it merged in and honor only main allowances', async t => {
  const path = 'config.txt';
  const other = 'extra-config.txt';
  const token = ['gh', 'p_', 'FORGEfake0TEST1never2REAL3token4XYZ5ab'].join('');
  const contents = Buffer.from(`Synthetic fixture\n${token}\n`);
  const expected = scanSecretPaths([path, other], () => contents, { baseAllow: undefined });
  assert.equal(expected.findings.length, 2);
  const allow = JSON.stringify({
    allow: [
      { path, fingerprint: expected.findings[0].fingerprint, reason: 'Synthetic token for scanner test' },
    ],
  });
  const prepare = async (baseAllow, proposedAllow) => {
    const s = agentFixture(t, {
      base: { [path]: 'before', ...(baseAllow ? { [SECRET_SCAN_ALLOW_FILE]: baseAllow } : {}) },
      lane: {
        [path]: contents,
        [other]: contents,
        ...(proposedAllow ? { [SECRET_SCAN_ALLOW_FILE]: proposedAllow } : {}),
      },
    });
    s.caps.main = s.main;
    s.caps.agentDefaults = effectiveAgentDefaults({ preflight: 'advise' });
    await s.transport().dispatch('open', { laneId: s.lane.laneId });
    const objects = join(clientCacheRoot(s.root), 'objects');
    mkdirSync(objects, { recursive: true });
    const base = s.main.head;
    const baseState = JSON.parse(s.objects.get(base));
    const moved = Buffer.from('Both branches changed this file');
    const blob = digest(moved);
    const main = Buffer.from(
      JSON.stringify({
        ...baseState,
        files: baseState.files.map(file => (file.path === path ? { ...file, blob } : file)),
      }),
    );
    s.main.head = digest(main);
    s.objects.set(blob, moved);
    s.objects.set(s.main.head, main);
    for (const [id, bytes] of s.objects) writeFileSync(join(objects, id), bytes, { mode: 0o600 });
    rememberConflictPaths(s.root, s.lane.laneId, [], undefined, false, undefined, {
      head: s.main.head,
      base,
    });
    return s;
  };
  const s = await prepare(undefined, allow);
  const output = [];
  let early = false;
  const write = process.stderr.write.bind(process.stderr);
  t.mock.method(process.stderr, 'write', (chunk, ...args) => {
    output.push(String(chunk));
    if (String(chunk).includes('hosted secret scanner'))
      early = !s.calls.some(call => call.name === 'projectHostedCompose:prepare');
    return write(chunk, ...args);
  });
  writeFileSync(join(s.root, path), 'unsaved clean bytes');
  const before = s.calls.length;
  const preflight = await s.transport().dispatch('preflight', { run: false });
  assert.deepEqual(
    preflight.result.secretScan?.findings,
    expected.findings,
    JSON.stringify({
      plan: preflight.result.plan,
      calls: s.calls.slice(before).map(call => call.name),
    }),
  );
  assert.equal(preflight.result.secretScan.selfAllowed, 1);
  const calls = s.calls.slice(before).map(call => call.name);
  writeFileSync(join(s.root, path), contents);
  const finish = await s.transport().dispatch('finish', { message: 'Synthetic scanner parity' });
  assert.deepEqual(finish.result.defaults.secretScan, preflight.result.secretScan);
  assert(output.some(line => line.includes(expected.findings[0].fingerprint)));
  assert(!JSON.stringify({ preflight, finish, output }).includes(token), 'no matched value is serialized');
  assert(early, 'the scan reports before hosted composition');

  const accepted = await prepare(allow, allow);
  // The unchanged allow file is still verifiable in the checkout when its cache blob is gone.
  rmSync(join(clientCacheRoot(accepted.root), 'objects', digest(allow)));
  const start = accepted.calls.length;
  const allowed = await accepted.transport().dispatch('preflight', { run: false });
  assert.deepEqual(
    allowed.result.secretScan?.findings,
    expected.findings.filter(finding => finding.path === other),
  );
  assert.deepEqual(
    accepted.calls.slice(start).map(call => call.name),
    calls,
    'the scan makes no new calls',
  );
});

async function queueProofFixture(t, { attach, standard = true, preflight = 'advise' } = {}) {
  const source = 'src/hosted-landing.ts';
  const receipt = '.nforge/queue-proofs/landing-notes.json';
  const saved = 'Saved synthetic landing change';
  const testName = 'synthetic incident replay for landing notes';
  const proof = {
    version: 1,
    kind: 'replay',
    changes: { [source]: digest(Buffer.from(saved)) },
    replay: { incident: '2bf85ddf', test: testName, receipt: randomUUID() },
    authorSession: randomUUID(),
    review: { session: randomUUID(), receipt: randomUUID() },
  };
  const base = {
    'scripts/forge-check.mjs': '',
    [source]: 'Before the landing change',
    [REGISTRY]: JSON.stringify({ replays: [{ incident: '2bf85ddf', test: testName, paths: [source] }] }),
  };
  const stale = JSON.stringify({ ...proof, changes: { [source]: digest(Buffer.from('Stale change')) } });
  // A refreshed proof's recorded replay scope (Item ec229a55); its contents are the planner's to test.
  const exercised = { [source]: { executed: [], digest: 'a'.repeat(64), units: [] } };
  const scoped = { ...proof, exercised };
  const proofBytes =
    attach === 'stale'
      ? stale
      : attach === 'valid'
        ? JSON.stringify(proof)
        : attach === 'scoped'
          ? JSON.stringify(scoped)
          : attach === 'scoped-stale'
            ? JSON.stringify({ ...JSON.parse(stale), exercised })
            : undefined;
  const s = agentFixture(t, {
    base,
    lane: { ...base, [source]: saved, ...(proofBytes ? { [receipt]: proofBytes } : {}) },
  });
  s.caps.main = s.main;
  s.caps.agentDefaults = effectiveAgentDefaults({ preflight });
  const query = s.exchange.client.query;
  s.exchange.client.query = async (ref, args) => {
    const text = await query(ref, args);
    if (getFunctionName(ref) !== 'projectHostedCheckDefinitions:current') return text;
    const settings = JSON.parse(text);
    settings.check.executable = 'node';
    settings.check.args = [standard ? 'scripts/forge-check.mjs' : 'scripts/custom-check.mjs'];
    return JSON.stringify(settings);
  };
  await s.transport().dispatch('open', { laneId: s.lane.laneId });
  const plan = join(s.root, '..', 'plan.json');
  writeFileSync(
    plan,
    JSON.stringify({
      standard: true,
      selection: { queueProof: queueProofPaths(proofBytes ? [source, receipt] : [source]) },
    }),
  );
  return {
    s,
    source,
    receipt,
    proof,
    hosted: () => verifyQueueProof({ FORGE_ACTIONS_PLAN: plan }, s.root),
  };
}

test('preflight reports the same stale queue proof as the hosted check on saved inputs', async t => {
  const { s, source, receipt, proof, hosted } = await queueProofFixture(t, { attach: 'stale' });
  let message;
  await assert.rejects(hosted, error => {
    assert.match(error.message, /^QUEUE_PROOF_REQUIRED:.*src\/hosted-landing\.ts/);
    message = error.message;
    return true;
  });
  // A working-copy proof added since the save cannot cover the saved Candidate.
  writeFileSync(join(s.root, receipt), JSON.stringify(proof));
  const from = s.calls.length;
  const preflight = await s.transport().dispatch('preflight', { run: false });
  const detail = {
    stale: [
      {
        path: source,
        proofs: [receipt],
        next: `\`${REFRESH_QUEUE_PROOF} ${receipt}\``,
      },
    ],
  };
  const expected = { main: s.main.head, code: 'QUEUE_PROOF_REQUIRED', message, detail };
  assert.deepEqual(preflight.result.queueProof, expected);
  assert.deepEqual(slimReceipt(preflight).result.queueProof, expected);
  const preflightCalls = s.calls.slice(from).map(call => call.name);

  const good = await queueProofFixture(t, { attach: 'valid' });
  await good.hosted();
  const goodFrom = good.s.calls.length;
  const goodPreflight = await good.s.transport().dispatch('preflight', { run: false });
  assert.equal(goodPreflight.result.queueProof, undefined);
  assert.deepEqual(
    good.s.calls.slice(goodFrom).map(call => call.name),
    preflightCalls,
  );

  const { s: f } = await queueProofFixture(t, { attach: 'stale' });
  // The fallback derives the change set against newer main than the capability read.
  f.caps.main = structuredClone(f.main);
  const before = JSON.parse(f.objects.get(f.main.head));
  const observed = Buffer.from(JSON.stringify({ ...before, message: 'Newly observed main' }));
  f.main.head = digest(observed);
  f.objects.set(f.main.head, observed);
  const observedPreflight = await f.transport().dispatch('preflight', { run: false });
  assert.deepEqual(observedPreflight.result.queueProof, { ...expected, main: f.main.head });

  // Main changed the same core file: composition gives it new bytes no Lane proof can name, so a
  // proof without a recorded replay scope refuses now, with the offline refresh (incident 9cd6c0ec).
  moveMain(f, source);
  const movedPreflight = await f.transport().dispatch('preflight', { run: false });
  assert.equal(movedPreflight.result.queueProof.code, 'QUEUE_PROOF_REQUIRED');
  assert.equal(movedPreflight.result.queueProof.refresh, true);
  assert.ok(movedPreflight.result.queueProof.message.includes(`refresh-queue-proof.mjs ${receipt}`));
});

/** Main lands its own edit to `source` after the Lane's base, or only makes it executable. */
function moveMain(f, source, { modeOnly = false } = {}) {
  const before = JSON.parse(f.objects.get(f.main.head));
  const peerBytes = Buffer.from('Main changed the same core file');
  const peerBlob = digest(peerBytes);
  const edit = modeOnly ? { mode: 'executable' } : { blob: peerBlob };
  const main = Buffer.from(
    JSON.stringify({
      ...before,
      files: before.files.map(file => (file.path === source ? { ...file, ...edit } : file)),
    }),
  );
  f.main.head = digest(main);
  f.objects.set(f.main.head, main);
  f.objects.set(peerBlob, peerBytes);
}

test('incident 9cd6c0ec: a proof main changed under refuses land before compose; a recorded scope goes to the planner', async t => {
  const { s, receipt } = await queueProofFixture(t, { attach: 'valid' });
  moveMain(s, 'src/hosted-landing.ts');
  const message = 'Synthetic mirror cadence change';
  const from = s.calls.length;
  t.mock.method(process.stderr, 'write', () => true);
  await assert.rejects(
    submitHostedLand(s.root, { operationId: randomUUID(), message }, s.address, s.transport()),
    error => {
      assert.equal(error.code, 'QUEUE_PROOF_REQUIRED');
      const root = realpathSync(s.root);
      const sync = `nforge agent '${root}' save --sync '${JSON.stringify({ laneId: s.lane.laneId })}'`;
      const command = `nforge agent '${root}' land --save '${JSON.stringify({ after: null, dependencies: [], message })}'`;
      const { queueProof, ...next } = error.recovery;
      assert.deepEqual(next, { sync, command });
      assert.deepEqual(
        queueProof.stale.map(item => item.path),
        ['src/hosted-landing.ts'],
      );
      assert.ok(error.message.includes(`refresh-queue-proof.mjs ${receipt}`), error.message);
      assert.ok(error.message.includes(sync) && error.message.includes(command));
      return true;
    },
  );
  assert(
    !s.calls.slice(from).some(call => /Compose:prepare|Checks:enqueue|Landing.*:enqueue$/.test(call.name)),
  );

  const scoped = await queueProofFixture(t, { attach: 'scoped' });
  moveMain(scoped.s, 'src/hosted-landing.ts');
  const preview = await scoped.s.transport().dispatch('preflight', { run: false });
  assert.equal(preview.result.queueProof, undefined);

  // A recorded scope never covers a Lane edit after its proof: the saved bytes must be the proven ones.
  const edited = await queueProofFixture(t, { attach: 'scoped-stale' });
  moveMain(edited.s, 'src/hosted-landing.ts');
  const editedPreview = await edited.s.transport().dispatch('preflight', { run: false });
  assert.equal(editedPreview.result.queueProof.code, 'QUEUE_PROOF_REQUIRED');
  assert.equal(editedPreview.result.queueProof.refresh, true);

  // Main changing only the mode keeps the Lane's proven bytes: the exact proof holds.
  const mode = await queueProofFixture(t, { attach: 'valid' });
  moveMain(mode.s, 'src/hosted-landing.ts', { modeOnly: true });
  const modePreview = await mode.s.transport().dispatch('preflight', { run: false });
  assert.equal(modePreview.result.queueProof, undefined);
});

test('incident 7e5f0ad3: missing queue proof refuses land before any hosted job, and attached proof proceeds', async t => {
  const { s, proof, receipt } = await queueProofFixture(t);
  const operationId = randomUUID();
  const message = 'Synthetic landing notes change';
  const retry = { after: null, dependencies: [], message };
  const from = s.calls.length;
  t.mock.method(process.stderr, 'write', () => true);
  const transport = s.transport();
  await assert.rejects(submitHostedLand(s.root, { operationId, message }, s.address, transport), error => {
    assert.equal(error.code, 'QUEUE_PROOF_REQUIRED');
    assert.match(
      error.message,
      /registered incident replay with fresh-context review or an on-path bench cell for src\/hosted-landing\.ts/,
    );
    const command = `nforge agent '${realpathSync(s.root)}' land --save '${JSON.stringify(retry)}'`;
    const attach = '.nforge/queue-proofs/<change>.json';
    const { queueProof, ...next } = error.recovery;
    assert.deepEqual(next, { attach, command });
    // Item 168e4ed8: each missing path, the replays that reach it and the refresh command.
    assert.deepEqual(queueProof.missing, [
      {
        path: 'src/hosted-landing.ts',
        replays: [{ incident: '2bf85ddf', test: 'synthetic incident replay for landing notes' }],
        next: `Add src/hosted-landing.ts to "changes" of a replay proof at ${attach} that names one of the replays that reach it (incident 2bf85ddf), then run \`${REFRESH_QUEUE_PROOF} ${attach}\`.`,
      },
    ]);
    assert(error.message.includes(`src/hosted-landing.ts: Add src/hosted-landing.ts`));
    assert(error.message.includes(attach));
    assert(error.message.includes(command));
    return true;
  });
  assert(
    !s.calls
      .slice(from)
      .some(call =>
        /(?:Compose:prepare|Jobs:submit|SourceRun:submit|Landing.*:(?:enqueue|submit)|Checks:enqueue)$/.test(
          call.name,
        ),
      ),
    'no hosted compose or check job starts',
  );
  assert(
    !process.stderr.write.mock.calls.some(call => String(call.arguments[0]).includes('QUEUE_PROOF_REQUIRED')),
    'the structured refusal is the one proof diagnostic',
  );

  // Model a saved attachment on the same Lane. Reopening the new State keeps the original
  // landing journal, so the suggested command must select a fresh operation on that Lane.
  const proofBytes = Buffer.from(JSON.stringify(proof));
  const blob = digest(proofBytes);
  s.objects.set(blob, proofBytes);
  const state = JSON.parse(s.objects.get(s.lane.head));
  state.files.unshift({ path: receipt, blob, mode: 'file' });
  const withProof = Buffer.from(JSON.stringify(state));
  s.lane.head = digest(withProof);
  s.lane.version++;
  s.lane.sourceVersion++;
  s.objects.set(s.lane.head, withProof);
  await s.transport().dispatch('open', { operationId: randomUUID(), laneId: s.lane.laneId });

  const retried = await submitHostedLand(s.root, retry, s.address, s.transport());
  assert.notEqual(retried.operationId, operationId);
  assert.equal(retried.result.phase, 'finish');
  assert.equal(retried.result.defaults?.queueProof, undefined);

  const calls = [];
  for (const options of [{ attach: 'valid' }, { standard: false }]) {
    const { s: next } = await queueProofFixture(t, options);
    const before = next.calls.length;
    const finish = await submitHostedLand(next.root, retry, next.address, next.transport());
    assert.equal(finish.result.phase, 'finish');
    assert(next.calls.slice(before).some(call => call.name === 'projectHostedLanding:enqueue'));
    assert.equal(
      finish.result.defaults?.queueProof?.code,
      options.standard === false ? 'QUEUE_PROOF_REQUIRED' : undefined,
    );
    calls.push(
      next.calls
        .slice(before)
        .map(call => call.name)
        .sort(),
    );
  }
  assert.deepEqual(calls[0], calls[1], 'the standard and custom normal paths use the same Convex calls');
});

test('Item 168e4ed8: missing queue proof refuses a required-preflight land before its preflight runs', async t => {
  const { s } = await queueProofFixture(t, { preflight: 'require' });
  t.mock.method(process.stderr, 'write', () => true);
  const from = s.calls.length;
  await assert.rejects(
    submitHostedLand(
      s.root,
      { operationId: randomUUID(), message: 'Unproven core change' },
      s.address,
      s.transport(),
    ),
    error => {
      assert.equal(error.code, 'QUEUE_PROOF_REQUIRED');
      assert.deepEqual(
        error.recovery.queueProof.missing.map(item => item.path),
        ['src/hosted-landing.ts'],
      );
      return true;
    },
  );
  assert.equal(readPreflightReceipt(s.root, s.lane.laneId), null, 'no preflight ran');
  assert(!s.calls.slice(from).some(call => /Compose:prepare|Jobs:submit|Landing.*:enqueue$/.test(call.name)));
});

test('a queue proof preview on older main does not refuse a newer compose pin', async t => {
  const { s, source } = await queueProofFixture(t);
  // The projected-path preview can only use main bytes already available locally.
  await s.transport().dispatch('preflight', { run: false });
  s.caps.main = structuredClone(s.main);
  const query = s.exchange.client.query;
  s.exchange.client.query = (ref, args) =>
    getFunctionName(ref) === 'projectHostedOverlaps:read'
      ? JSON.stringify({
          behindMain: { commits: 0, conflictingPaths: [], more: 0, coverage: 'complete' },
          changedPaths: { paths: [source], complete: true },
        })
      : query(ref, args);
  // The check would no longer require proof for these bytes because main has already taken them.
  s.main.head = s.lane.head;
  s.main.receipt.id = randomUUID();
  s.pinMain(true);
  const finish = await submitHostedLand(
    s.root,
    { message: 'Main took the same change' },
    s.address,
    s.transport(),
  );
  assert.equal(finish.result.defaults?.queueProof?.main, s.caps.main.head);
  assert.equal(finish.result.submission.request.expectedMain.head, s.main.head);
});

test('incident 229147a2: over-budget land with a format error refuses locally before any hosted check', async t => {
  const s = await fixture(t, 'require', undefined, staticProject(true));
  await assert.rejects(
    submitHostedLand(
      s.root,
      { operationId: randomUUID(), message: 'Unformatted document' },
      s.address,
      s.transport(),
    ),
    error => {
      assert.equal(error.code, 'PREFLIGHT_REQUIRED');
      assert.match(error.message, /static checks/);
      assert.match(error.message, /README.md: format error/);
      assert.match(error.message, /Fix: 'node' 'scripts\/style.mjs' '--write'/);
      assert.equal(error.recovery.static[0].outcome, 'failed');
      assert.equal(error.recovery.command, "'node' 'scripts/style.mjs' '--write'");
      assert.match(error.message, /save, then run land --save with the same options and a fresh operationId/);
      assert.doesNotMatch(error.message, /Continue with: .*preflight|Then replay the same land operation/);
      return true;
    },
  );
  const receipt = readPreflightReceipt(s.root, s.lane.laneId);
  assert.equal(receipt.staticOnly, true);
  assert.equal(receipt.passed, false);
  assert.equal(receipt.tests, 0);
  assert(receipt.deferredTests > 150);
  assert.deepEqual(
    receipt.static.map(c => [c.name, c.outcome]),
    [
      ['style', 'failed'],
      ['lint', 'passed'],
    ],
  );
  assert.equal(receipt.buildMs, undefined);
  assert(!s.calls.some(c => /Compose|Landing/.test(c.name)), 'no compose or hosted check dispatched');
});

test('an over-budget static pass remains advised on land and replay, adding zero Convex calls', async t => {
  const counts = [];
  for (const [withStatic, policy] of [
    [false, 'require'],
    [true, 'require'],
    [true, 'advise'],
  ]) {
    // Under require the readers pass: an over-budget land runs its top-ranked tests for the quick
    // budget (13ea93bf). Under advise land runs static checks only, and its readers throw if started.
    const files = staticProject(false, policy === 'require' ? 'pass' : 'throw');
    if (!withStatic) delete files['forge.json'];
    const s = await fixture(t, policy, undefined, files);
    s.caps.features.push('save-preflight-timing', 'preflight-guard-set');
    const before = s.calls.length;
    const result = await submitHostedLand(
      s.root,
      { operationId: randomUUID(), message: 'Formatted document' },
      s.address,
      s.transport(),
    );
    assert.equal(result.result.submission.phase, 'landed');
    if (policy === 'require') counts.push(s.calls.slice(before).map(c => c.name));
    const gate = JSON.parse(s.calls.find(c => c.name === 'projectHostedLanding:enqueue').args.gates).lanes[0];
    assert.equal(gate.preflight, 'advised');
    const receipt = readPreflightReceipt(s.root, s.lane.laneId);
    assert.equal(
      gate.preflightMs,
      undefined,
      'neither a static-only pass nor the quick run enters the preflight speed metric',
    );
    if (policy === 'advise') {
      assert.equal(receipt.staticOnly, true);
      assert.equal(receipt.tests, 0);
      assert.equal(receipt.evidence, undefined, 'a static pass creates no test-coverage evidence');
      assert.equal(gate.ran, '', 'a static-only pass ran no test file');
      continue;
    }
    assert.equal(receipt.quick, true, 'the over-budget land ran its quick head run');
    assert.equal(result.result.defaults.preflight.quick.budgetSeconds, 90);
    assert.equal(result.result.defaults.preflight.quick.ran, receipt.tests);
    assert.ok(receipt.tests > 0);
    // What the quick run ran reaches the guard-set learner, 4 characters per file.
    assert.equal(gate.ran.length, 4 * receipt.tests);
    if (withStatic) {
      assert.deepEqual(result.result.defaults.preflight.static, receipt.static);
      assert.equal(result.result.defaults.preflight.status, 'advised');
      const replay = finishGates(
        s.root,
        s.caps.agentDefaults,
        { laneId: s.lane.laneId, head: s.lane.head },
        { changedPaths: { paths: ['README.md'], complete: true } },
        true,
      );
      assert.equal(replay.preflight.status, 'advised', 'a cached quick run never satisfies tests');
      assert.equal(replay.preflight.reason, 'over 10 min');
      assert.deepEqual(
        replay.preflight.static.map(c => c.outcome),
        ['passed', 'passed'],
      );
    }
  }
  assert.deepEqual(counts[1], counts[0], 'static checks add zero Convex calls');
});

// Incident 060fb653 (friction b7f029c5, 39e0a587): a whole-tree static check fails on a file no Lane
// touches, or on Forge's own Lane metadata. Only the change's own failures may refuse a landing.
const wholeTree = {
  // A formatter run over the whole tree, as a repository's fmt:check would: every .md file, dot folders included.
  'scripts/style.mjs': `import fs from 'node:fs'; import path from 'node:path';
    const bad = [];
    const walk = dir => { for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === 'node_modules') continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (p.endsWith('.md')) { const t = fs.readFileSync(p, 'utf8'); if (t !== t.trimEnd() + '\\n') bad.push(p); }
      else if (p.endsWith('.json') && fs.readFileSync(p, 'utf8') !== JSON.stringify(JSON.parse(fs.readFileSync(p, 'utf8')), null, 2) + '\\n') bad.push(p);
    } };
    walk('.');
    for (const p of bad) console.error(p + ': format error');
    process.exit(bad.length ? 1 : 0);`,
};
const pretty = value => `${JSON.stringify(value, null, 2)}\n`;
const treeConfig = pretty({
  preflight: { static: [{ name: 'style', command: ['node', 'scripts/style.mjs'] }] },
});
async function treeFixture(t, base, lane) {
  const files = {
    ...common,
    'package.json': pretty({ type: 'module' }),
    'forge.json': treeConfig,
    ...wholeTree,
  };
  const s = agentFixture(t, { base: { ...files, ...base }, lane: { ...files, ...lane } });
  s.caps.agentDefaults = effectiveAgentDefaults({ preflight: 'advise' });
  s.caps.features = ['land-gates'];
  await s.transport().dispatch('open', { laneId: s.lane.laneId });
  const mutate = s.exchange.client.mutation;
  s.exchange.client.mutation = async (ref, args) => {
    const text = await mutate(ref, args);
    if (getFunctionName(ref) !== 'projectHostedLanding:enqueue') return text;
    const state = JSON.parse(text);
    state.phase = 'landed';
    state.observation = { state: 'landed', pendingReason: null, cause: null };
    state.acceptance = { receiptId: randomUUID(), head: s.lane.head };
    return JSON.stringify(state);
  };
  return s;
}
const land = s =>
  submitHostedLand(s.root, { operationId: randomUUID(), message: 'Change' }, s.address, s.transport());
const refusedFor = files => error => {
  assert.equal(error.code, 'PREFLIGHT_REQUIRED');
  assert.deepEqual(error.recovery.static[0].files, files);
  assert.equal(error.recovery.static[0].outcome, 'failed');
  for (const file of files) assert.match(error.message, new RegExp(file.replace('.', '\\.')));
  return true;
};

test('incident 060fb653: a clean change lands when main already fails the formatter on an untouched file', async t => {
  const s = await treeFixture(
    t,
    { 'README.md': 'Before\n', 'legacy.md': 'Old  \n' },
    { 'README.md': 'After\n', 'legacy.md': 'Old  \n' },
  );
  const result = await land(s);
  assert.equal(result.result.submission.phase, 'landed');
  const [style] = readPreflightReceipt(s.root, s.lane.laneId).static;
  assert.equal(style.outcome, 'pre-existing');
  assert.deepEqual(style.files, ['legacy.md']);
  assert.match(
    result.result.defaults.preflight.staticAdvisory,
    /^style: fails only in files this Lane does not change \(legacy\.md\): pre-existing on main, not blocking/,
  );
});

test('incident 060fb653: the same base still refuses a change whose own file is unformatted, without a base run', async t => {
  const s = await treeFixture(
    t,
    { 'README.md': 'Before\n', 'legacy.md': 'Old  \n' },
    { 'README.md': 'After  \n', 'legacy.md': 'Old  \n' },
  );
  await assert.rejects(land(s), refusedFor(['README.md']));
  assert(!s.calls.some(c => /Compose|Landing/.test(c.name)), 'no compose or hosted check dispatched');
});

test("incident 060fb653: renaming an unformatted file into the Lane is the change's own failure", async t => {
  const s = await treeFixture(
    t,
    { 'README.md': 'Same\n', 'legacy.md': 'Old  \n' },
    { 'README.md': 'Same\n', 'moved.md': 'Old  \n' },
  );
  await assert.rejects(land(s), refusedFor(['moved.md']));
});

test("incident 060fb653: Forge's own Lane metadata failing the formatter never refuses a landing", async t => {
  const s = await treeFixture(t, { 'README.md': 'Before\n' }, { 'README.md': 'After\n' });
  const result = await land(s);
  assert.equal(result.result.submission.phase, 'landed');
  const [style] = readPreflightReceipt(s.root, s.lane.laneId).static;
  assert.equal(style.outcome, 'forge-metadata');
  assert(style.files.includes('.forge/hosted-lane.json'), 'the checkout marker Forge writes is what failed');
  assert(style.files.every(file => file.startsWith('.forge/')));
  assert.match(
    result.result.defaults.preflight.staticAdvisory,
    /files Forge writes into the Lane .*not blocking/,
  );
});

// Review 3869594b: a changed name with a space is found whole, so old debt or Forge metadata beside it
// never turns the change's own failure into an advisory.
test('incident 060fb653: a new bad file with a space in its name refuses beside old debt and Forge metadata', async t => {
  for (const debt of [{ 'legacy.md': 'Old  \n' }, {}]) {
    const s = await treeFixture(
      t,
      { 'README.md': 'Same\n', ...debt },
      { 'README.md': 'Same\n', ...debt, 'docs/bad name.md': 'New  \n' },
    );
    await assert.rejects(land(s), refusedFor(['docs/bad name.md']));
    assert(!s.calls.some(c => /Compose|Landing/.test(c.name)), 'no compose or hosted check dispatched');
  }
});
