import { trustAgents } from './autonomy-fixture.mjs';
// SPDX-License-Identifier: Apache-2.0
import nodeTest from 'node:test';
// A fixture must fail with its test name instead of waiting for the ten-minute file watchdog.
const test = (name, fn) => nodeTest(name, { timeout: 30_000 }, fn);
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentWorkflow } from '../dist/agent-workflow.js';
import { initNative } from '../dist/native-work.js';

async function setup(script = "console.log('ok')") {
  const root = mkdtempSync(join(tmpdir(), 'forge-agent-clean-'));
  writeFileSync(join(root, 'file.txt'), 'original\n');
  writeFileSync(join(root, '.gitignore'), 'node_modules/\n');
  initNative(root);
  trustAgents(root);
  const agent = new AgentWorkflow(root);
  await agent.dispatch({
    action: 'define-check',
    name: 'verify',
    executable: process.execPath,
    args: ['-e', script],
  });
  return { root, agent };
}
const run = (agent, action, body = {}) => agent.dispatch({ action, ...body });
async function finishedLane(agent, file = 'a.txt') {
  const lane = (await run(agent, 'start', { outcome: `Edit ${file}` })).result;
  writeFileSync(join(lane.path, file), 'a\n');
  mkdirSync(join(lane.path, 'node_modules'));
  writeFileSync(join(lane.path, 'node_modules', 'dep.js'), 'x'.repeat(1000));
  const done = (await run(agent, 'finish', { laneId: lane.laneId, message: 'Edit', accept: true })).result;
  assert.equal(done.status, 'accepted');
  return lane;
}
const clean = async (agent, body = {}) => (await run(agent, 'clean', body)).result;
const group = (result, kind, key = 'candidates') =>
  result[key].find(item => item.kind === kind && item.count > 0);

test('dry run lists lane-deps and lanes; apply removes a captured Lane and reopen restores it', async () => {
  const { agent } = await setup();
  const lane = await finishedLane(agent);
  // Edit nothing more: the directory equals the head State apart from ignored node_modules.
  const dry = await clean(agent, { kinds: ['lane-deps', 'lanes'] });
  assert.equal(dry.mode, 'dry-run');
  assert.equal(group(dry, 'lanes').items[0].laneId, lane.laneId);
  assert.equal(group(dry, 'lane-deps'), undefined, 'a removable Lane is listed once, not also as deps');
  assert.ok(existsSync(lane.path), 'dry run deletes nothing');
  const onlyDeps = await clean(agent, { kinds: ['lane-deps'] });
  assert.equal(group(onlyDeps, 'lane-deps').items[0].path, join(lane.path, 'node_modules'));
  const applied = await clean(agent, { apply: true, kinds: ['lane-deps'] });
  assert.equal(group(applied, 'lane-deps', 'removed').count, 1);
  assert.ok(!existsSync(join(lane.path, 'node_modules')));
  assert.ok(existsSync(join(lane.path, 'file.txt')));
  const whole = await clean(agent, { apply: true, kinds: ['lanes'] });
  assert.equal(group(whole, 'lanes', 'removed').count, 1);
  assert.ok(!existsSync(lane.path));
  assert.equal(
    group(await clean(agent, { apply: true }), 'lanes', 'removed'),
    undefined,
    'repeat is a no-op',
  );
  await run(agent, 'reopen', { laneId: lane.laneId });
  assert.equal(readFileSync(join(lane.path, 'a.txt'), 'utf8'), 'a\n');
});

test('a Lane with uncaptured edits is skipped, active Lanes are untouched, exchange staging is reported', async () => {
  const { agent } = await setup();
  const lane = await finishedLane(agent);
  writeFileSync(join(lane.path, 'late.txt'), 'uncheckpointed\n');
  const open = (await run(agent, 'start', { outcome: 'Open' })).result;
  const dry = await clean(agent, { kinds: ['lanes', 'exchange-staging'] });
  assert.equal(group(dry, 'lanes'), undefined);
  assert.match(dry.skipped.find(item => item.laneId === lane.laneId).reason, /uncaptured edits/);
  assert.equal(dry.skippedKinds[0].kind, 'exchange-staging');
  const applied = await clean(agent, { apply: true });
  assert.ok(existsSync(join(lane.path, 'late.txt')));
  assert.ok(existsSync(open.path));
  assert.ok(!existsSync(join(lane.path, 'node_modules')), 'ignored build dirs of a completed Lane still go');
  assert.equal(applied.mode, 'applied');
});

test('check workspaces: finished run cleaned, result kept; running run skipped', async () => {
  const { root, agent } = await setup();
  const lane = (await run(agent, 'start', { outcome: 'Edit' })).result;
  writeFileSync(join(lane.path, 'b.txt'), 'b\n');
  const finish = (await run(agent, 'finish', { laneId: lane.laneId, message: 'Edit' })).result;
  assert.equal(finish.run.status, 'passed');
  const directory = join(root, '.forge', 'work', `check-${finish.run.operationId ?? finish.run.runId}`);
  const found = (await run(agent, 'records', { collection: 'runs' })).result.items[0];
  const checkDir = join(root, '.forge', 'work', `check-${found.id}`);
  assert.ok(existsSync(checkDir), directory);
  mkdirSync(join(checkDir, 'workspace', 'node_modules'), { recursive: true });
  writeFileSync(join(checkDir, 'workspace', 'f'), 'z'.repeat(500));
  const dry = await clean(agent, { kinds: ['check-workspaces'] });
  assert.equal(group(dry, 'check-workspaces').items[0].runId, found.id);
  assert.ok(group(dry, 'check-workspaces').bytes >= 500);
  await clean(agent, { apply: true, kinds: ['check-workspaces'] });
  assert.ok(!existsSync(join(checkDir, 'workspace')));
  assert.ok(existsSync(join(checkDir, 'result.json')));
  assert.ok(existsSync(join(checkDir, 'stdout.log')));
});

test('a running check is skipped', async t => {
  const { root, agent } = await setup();
  const slow = (
    await run(agent, 'define-check', {
      name: 'slow',
      executable: process.execPath,
      args: ['-e', 'setInterval(() => {}, 1000)'],
    })
  ).result;
  const lane = (await run(agent, 'start', { outcome: 'Edit' })).result;
  writeFileSync(join(lane.path, 'b.txt'), 'b\n');
  await run(agent, 'finish', { laneId: lane.laneId, message: 'Edit' });
  const started = (
    await run(agent, 'run', { laneId: lane.laneId, checkId: slow.checkId ?? slow.id, wait: false })
  ).result;
  const id = started.operationId ?? started.runId ?? started.id;
  t.after(() => run(agent, 'cancel', { operationId: id }));
  const checkDir = join(root, '.forge', 'work', `check-${id}`);
  assert.ok(existsSync(join(checkDir, 'workspace')));
  const dry = await clean(agent, { kinds: ['check-workspaces'] });
  assert.equal(group(dry, 'check-workspaces'), undefined);
  assert.match(dry.skipped.find(item => item.runId === id).reason, /recorded as|process group/);
  await clean(agent, { apply: true, kinds: ['check-workspaces'] });
  assert.ok(existsSync(join(checkDir, 'workspace')), 'running workspace untouched');
});

test('apply re-validates items from a stale dry run', async () => {
  // Finish before starting any infinite check: a two-core CI runner has only one check slot.
  const { agent } = await setup();
  const done = await finishedLane(agent, 'c.txt');
  const planned = await clean(agent, { kinds: ['lanes'] });
  const item = group(planned, 'lanes').items.find(entry => entry.laneId === done.laneId);
  writeFileSync(join(done.path, 'after-dry-run.txt'), 'new\n');
  const applied = await clean(agent, { apply: true, kinds: ['lanes'], items: [item.id] });
  assert.equal(group(applied, 'lanes', 'removed'), undefined);
  assert.ok(existsSync(join(done.path, 'after-dry-run.txt')));
  assert.match(applied.skipped.find(entry => entry.laneId === done.laneId).reason, /uncaptured edits/);
});

test('objects kind wraps native object inspection and only runs when named', async () => {
  const { agent } = await setup();
  assert.equal(group(await clean(agent), 'objects'), undefined);
  const dry = await clean(agent, { kinds: ['objects'] });
  assert.equal(dry.mode, 'dry-run');
  assert.equal(dry.kinds[0], 'objects');
  assert.equal((await clean(agent, { apply: true, kinds: ['objects'] })).mode, 'applied');
});
