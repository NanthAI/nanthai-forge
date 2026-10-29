// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { AgentWorkflow } from '../dist/agent-workflow.js';
import { initNative } from '../dist/native-work.js';
import { writeCheckScope } from '../dist/work-check-scope.js';
import { checkEnvironment } from '../dist/check-environment.js';
import { pinnedComparison, sourceFiles, standardSelection } from '../scripts/test-impact.mjs';

const git = (root, args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();

async function fixture(t, native = true) {
  const root = mkdtempSync(join(tmpdir(), 'forge-lane-tests-'));
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  const files = {
    'src/leaf.ts': 'export const answer = 1;\n',
    'src/importer.ts': "export { answer } from './leaf.js';\n",
    'tests/leaf.test.mjs': "import '../dist/importer.js';\n",
    'tests/unrelated.test.mjs': "import 'node:assert';\n",
    "tests/quoted ' $name.test.mjs": "import '../dist/leaf.js';\n",
    'tests/files.test.mjs': '',
    'package.json': '{"scripts":{}}',
    'package-lock.json': '{"packages":{}}',
    'README.md': 'Fixture\n',
    'web/placeholder.json': '{}',
    'convex/placeholder.json': '{}',
    'netlify/placeholder.json': '{}',
    'scripts/placeholder.json': '{}',
  };
  for (const directory of ['src', 'web', 'convex', 'netlify', 'tests', 'scripts'])
    mkdirSync(join(root, directory));
  for (const [path, text] of Object.entries(files)) writeFileSync(join(root, path), text);
  let main;
  if (native) main = initNative(root).head;
  else {
    git(root, ['init', '-q']);
    git(root, ['add', '.']);
    git(root, [
      '-c',
      'user.name=Test',
      '-c',
      'user.email=test@example.invalid',
      '-c',
      'core.hooksPath=/dev/null',
      'commit',
      '-qm',
      'Fixture',
    ]);
    main = git(root, ['rev-parse', 'HEAD']);
    git(root, ['update-ref', 'refs/forge/channels/main', main]);
  }
  const agent = new AgentWorkflow(root);
  const lane = (
    await agent.dispatch({ action: 'start', outcome: 'Select tests', channel: native ? undefined : null })
  ).result;
  const savedFull = process.env.FORGE_CHECK_FULL;
  delete process.env.FORGE_CHECK_FULL;
  t.after(() => {
    if (savedFull === undefined) delete process.env.FORGE_CHECK_FULL;
    else process.env.FORGE_CHECK_FULL = savedFull;
  });
  return { root, agent, lane, main };
}

for (const native of [true, false])
  test(`Lane tests match the ${native ? 'native' : 'Git'} landing selector on saved source without locking or mutating Work`, async t => {
    const { root, agent, lane, main } = await fixture(t, native);
    writeFileSync(join(lane.path, 'src/leaf.ts'), 'export const answer = 2;\n');
    if (!native) git(lane.path, ['add', 'src/leaf.ts']);
    const { head } = (
      await agent.dispatch({ action: 'checkpoint', laneId: lane.laneId, message: 'Change leaf' })
    ).result;
    const runPath = join(root, 'comparison');
    mkdirSync(runPath);
    const changes = writeCheckScope(agent.work.store, { base: main, comparisonBase: main, head }, runPath);
    const comparison = pinnedComparison({
      FORGE_CHECK_CHANGES: changes,
      FORGE_CHECK_BASE: main,
      FORGE_CHECK_HEAD: head,
    });
    const expected = standardSelection({
      ...comparison,
      files: sourceFiles(lane.path),
      env: { ...checkEnvironment().env, FORGE_CHECK_SCOPED: '1' },
    });
    assert.equal(expected.scope, 'scoped');
    // Live source is not part of this request, including uncheckpointed tests.
    writeFileSync(join(lane.path, 'src/leaf.ts'), 'unparseable live edits');
    writeFileSync(join(lane.path, 'tests/live.test.mjs'), "import '../dist/leaf.js';");
    const before = agent.work.store.snapshotBytes();
    agent.work.store.locked = () => {
      throw new Error('read must not lock');
    };
    const reply = await agent.dispatch({ action: 'tests', laneId: lane.laneId });
    const {
      scope,
      reason,
      tests,
      command,
      coverage,
      available,
      intentId,
      candidateId,
      contractVersion,
      contract,
      contractProposal,
      ...pins
    } = reply.result;
    assert.equal(intentId, lane.intentId);
    assert.equal(candidateId, null);
    assert.equal(contractVersion, 0);
    assert.equal(contract, null);
    assert.ok(available.includes('tests/leaf.test.mjs'));
    assert.equal(contractProposal.timingBasis, 'historical-estimate');
    assert.deepEqual(
      { scope, reason, tests },
      { scope: expected.scope, reason: expected.reason, tests: expected.tests },
    );
    assert.ok(tests.includes('tests/leaf.test.mjs'));
    assert.ok(!tests.includes('tests/unrelated.test.mjs'));
    assert.equal(coverage.mode, 'shadow');
    assert.equal(coverage.currentCount, tests.length);
    assert.deepEqual(pins, { laneId: lane.laneId, head, main });
    assert.equal(typeof reply.revision, 'number');
    assert.match(command, /^node --import \.\/tests\/check-runtime\.mjs --test /);
    // Parse through the shell without executing any repository/test code.
    const arguments_ = execFileSync('/bin/sh', ['-c', `node() { printf '%s\\n' "$@"; }; ${command}`], {
      encoding: 'utf8',
    });
    assert.deepEqual(arguments_.trimEnd().split('\n'), [
      '--import',
      './tests/check-runtime.mjs',
      '--test',
      ...tests,
    ]);
    assert.deepEqual(agent.work.store.snapshotBytes(), before);
    const cli = JSON.parse(
      execFileSync(
        process.execPath,
        [resolve('dist/cli.js'), 'agent', root, 'tests', JSON.stringify({ laneId: lane.laneId })],
        { encoding: 'utf8' },
      ),
    );
    assert.deepEqual(cli.result, reply.result);
  });

test('Lane tests report unknown Lane as NOT_FOUND', async t => {
  const { agent } = await fixture(t);
  await assert.rejects(agent.dispatch({ action: 'tests', laneId: randomUUID() }), {
    code: 'NOT_FOUND',
    message: 'Lane not found.',
  });
});

test('documentation selection has no command that would accidentally discover all tests', async t => {
  const { agent, lane } = await fixture(t);
  writeFileSync(join(lane.path, 'README.md'), 'Updated fixture\n');
  await agent.dispatch({ action: 'checkpoint', laneId: lane.laneId, message: 'Docs' });
  const { result } = await agent.dispatch({ action: 'tests', laneId: lane.laneId });
  assert.equal(result.scope, 'docs');
  assert.deepEqual(result.tests, []);
  assert.equal(result.command, null);
});

test('Lane tests retain the selector full fallback for unclassified paths', async t => {
  const { agent, lane } = await fixture(t);
  writeFileSync(join(lane.path, 'unknown.config'), 'changed\n');
  await agent.dispatch({ action: 'checkpoint', laneId: lane.laneId, message: 'Unknown path' });
  const { result } = await agent.dispatch({ action: 'tests', laneId: lane.laneId });
  assert.equal(result.scope, 'full');
  assert.match(result.reason, /Unclassified/);
  assert.ok(result.tests.includes('tests/unrelated.test.mjs'));
});
