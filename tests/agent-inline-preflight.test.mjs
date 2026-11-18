// SPDX-License-Identifier: Apache-2.0
import { assertCommandWeight } from '../scripts/agent-weight.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getFunctionName } from 'convex/server';
import { agentFixture } from './hosted-agent-fixture.mjs';
import { submitHostedLand } from '../dist/hosted-land-cli.js';
import { effectiveAgentDefaults } from '../dist/agent-parallel-defaults.js';
import { finishGates } from '../dist/agent-default-gates.js';
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
  assert.equal(failure?.code, 'PREFLIGHT_REQUIRED');
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
const staticProject = bad => ({
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
      "import test from 'node:test'; import fs from 'node:fs'; test('document reader must stay advised', () => { fs.readFileSync(new URL('../README.md', import.meta.url)); throw Error('tests should not run'); });\n",
    ]),
  ),
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
  for (const withStatic of [false, true]) {
    const files = staticProject(false);
    if (!withStatic) delete files['forge.json'];
    const s = await fixture(t, 'require', undefined, files);
    s.caps.features.push('save-preflight-timing');
    const before = s.calls.length;
    const result = await submitHostedLand(
      s.root,
      { operationId: randomUUID(), message: 'Formatted document' },
      s.address,
      s.transport(),
    );
    assert.equal(result.result.submission.phase, 'landed');
    counts.push(s.calls.slice(before).map(c => c.name));
    const gate = JSON.parse(s.calls.find(c => c.name === 'projectHostedLanding:enqueue').args.gates).lanes[0];
    assert.equal(gate.preflight, 'advised');
    if (withStatic) {
      const receipt = readPreflightReceipt(s.root, s.lane.laneId);
      assert.equal(receipt.staticOnly, true);
      assert.equal(
        gate.preflightMs,
        undefined,
        'static-only duration never enters the test preflight speed metric',
      );
      assert.deepEqual(result.result.defaults.preflight.static, receipt.static);
      assert.equal(result.result.defaults.preflight.status, 'advised');
      assert.equal(receipt.tests, 0);
      assert.equal(receipt.evidence, undefined, 'a static pass creates no test-coverage evidence');
      const replay = finishGates(
        s.root,
        s.caps.agentDefaults,
        { laneId: s.lane.laneId, head: s.lane.head },
        { changedPaths: { paths: ['README.md'], complete: true } },
        true,
      );
      assert.equal(replay.preflight.status, 'advised', 'a cached static pass never satisfies tests');
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
