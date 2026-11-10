// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { AgentWorkflow } from '../dist/agent-workflow.js';
import { initNative } from '../dist/native-work.js';

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
    // Forge's own check entry: the project shape that selects Forge's Node layout.
    'scripts/forge-check.mjs': '',
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
