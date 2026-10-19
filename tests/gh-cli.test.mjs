// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, existsSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { initNative } from '../dist/native-work.js';
import { AgentWorkflow } from '../dist/agent-workflow.js';
import { WorkStore } from '../dist/work-store.js';
import { checkRow, laneChecks } from '../dist/gh-cli-reads.js';
import { trustAgents } from './autonomy-fixture.mjs';
const cli = new URL('../dist/cli.js', import.meta.url).pathname;
function run(args, cwd, extra = {}) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, ...extra };
    delete env.FORGE_AUTH_TOKEN;
    delete env.FORGE_DEPLOYMENT_URL;
    delete env.FORGE_HTTP_URL;
    if (extra.FORGE_AUTH_TOKEN) env.FORGE_AUTH_TOKEN = extra.FORGE_AUTH_TOKEN;
    const child = spawn(process.execPath, [cli, ...args], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '',
      stderr = '';
    child.stdout.on('data', bytes => (stdout += bytes));
    child.stderr.on('data', bytes => (stderr += bytes));
    child.on('error', reject);
    child.on('close', code =>
      resolve({ code, stdout, stderr, json: stdout.trim() ? JSON.parse(stdout) : null }),
    );
  });
}
async function project(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'forge-gh-cli-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, 'a.txt'), 'original\n');
  initNative(root);
  trustAgents(root);
  const agent = new AgentWorkflow(root);
  await agent.dispatch({
    action: 'define-check',
    name: 'verify',
    executable: process.execPath,
    args: ['-e', '0'],
  });
  return { root, agent, store: new WorkStore(root) };
}
test('PR/repo JSON shapes, projection, current Lane, live diff paging, checkout restoration, retryable create', async t => {
  const p = await project(t),
    operation = randomUUID();
  const args = [
    'pr',
    'create',
    '--repo',
    p.root,
    '--title',
    'Synthetic proposal',
    '--body',
    'Description',
    '--operation-id',
    operation,
    '--json',
    'id,title,body,headRefOid,operationId',
  ];
  const created = await run(args, p.root);
  assert.equal(created.code, 0, created.stderr);
  assert.deepEqual(Object.keys(created.json), ['id', 'title', 'body', 'headRefOid', 'operationId']);
  assert.equal(created.json.operationId, operation);
  assert.equal(created.json.body, 'Description');
  assert.deepEqual((await run(args, p.root)).json, created.json);
  assert.equal(p.store.load().lanes.length, 1);
  const id = created.json.id,
    path = p.store.path(id);
  const listed = await run(['pr', 'list', '--json', 'id,state'], path);
  assert.deepEqual(listed.json, [{ id, state: 'OPEN' }]);
  const view = await run(['pr', 'view', '--json', 'id,title,number,path'], path);
  assert.deepEqual(view.json, { id, title: 'Synthetic proposal', number: id, path });
  const repository = await run(['repo', 'view', p.root, '--json', 'path,engine,defaultBranchRef'], p.root);
  assert.deepEqual(repository.json, {
    path: p.root,
    engine: 'forge-native',
    defaultBranchRef: { name: 'main', target: { oid: null } },
  });
  writeFileSync(join(path, 'a.txt'), 'changed\n');
  writeFileSync(join(path, 'b.txt'), 'new\n');
  const diff = await run(['pr', 'diff', '--limit', '1', '--json', 'changes,more,nextOffset'], path);
  assert.equal(diff.code, 0, diff.stderr);
  assert.equal(diff.json.changes[0].path, 'a.txt');
  assert.ok(
    diff.json.changes[0].hunks.some(h => h.lines.some(l => l.kind === 'added' && l.text === 'changed')),
  );
  assert.equal(diff.json.more, true);
  const page = await run(['pr', 'diff', '--offset', '1', '--limit', '1', '--json', 'changes,more'], path);
  assert.equal(page.json.changes[0].path, 'b.txt');
  assert.equal(page.json.more, false);
  const checks = await run(['pr', 'checks', '--json', 'name,state,bucket'], path);
  assert.equal(checks.code, 8);
  assert.deepEqual(checks.json, []);
  await p.agent.dispatch({ action: 'checkpoint', laneId: id, message: 'Save' });
  rmSync(path, { recursive: true });
  const checkout = await run(['pr', 'checkout', id, '--json', 'laneId,head,path'], p.root);
  assert.equal(checkout.code, 0, checkout.stderr);
  assert.equal(checkout.json.path, path);
  assert.equal(existsSync(join(path, 'b.txt')), true);
  assert.equal(p.store.select('lanes', id).state, 'active');
});
test('unsupported flags and JSON fields fail before mutations with structured errors', async t => {
  const p = await project(t);
  for (const args of [
    ['pr', 'create', '--title', 'Invalid', '--draft'],
    ['pr', 'merge', '--admin'],
    ['pr', 'list', '--jq', '.[].id'],
    ['pr', 'view', '--web'],
    ['repo', 'view', '--branch', 'main'],
    ['auth', 'status', '--show-token'],
  ]) {
    const result = await run(args, p.root);
    assert.equal(result.code, 1);
    const error = JSON.parse(result.stderr).error;
    assert.equal(error.code, 'UNSUPPORTED_FLAG');
    assert.ok(error.message.includes(args.at(-1).startsWith('--') ? args.at(-1) : args.at(-2)));
  }
  const invalid = await run(['pr', 'create', '--title', 'Invalid', '--json', 'invented'], p.root);
  assert.equal(JSON.parse(invalid.stderr).error.code, 'UNKNOWN_JSON_FIELD');
  assert.equal(p.store.load().lanes.length, 0);
});
test('pr merge runs exact checks and uses finish acceptance, including protected-path review', async t => {
  const p = await project(t);
  const lane = (await p.agent.dispatch({ action: 'start', outcome: 'Merge' })).result;
  writeFileSync(join(lane.path, 'a.txt'), 'accepted\n');
  const mergeId = randomUUID();
  const merged = await run(
    [
      'pr',
      'merge',
      lane.laneId,
      '--operation-id',
      mergeId,
      '--json',
      'laneId,complete,status,acceptance,receipt',
    ],
    p.root,
  );
  assert.equal(merged.code, 0, merged.stderr);
  assert.equal(merged.json.complete, true);
  assert.equal(merged.json.status, 'accepted');
  let data = p.store.load();
  assert.equal(data.channelMoves.length, 1);
  assert.equal(data.runs.length, 1);
  assert.equal(data.runs[0].status, 'passed');
  const replay = await run(
    ['pr', 'merge', lane.laneId, '--operation-id', mergeId, '--json', 'complete,status'],
    p.root,
  );
  assert.equal(replay.code, 0, replay.stderr);
  assert.equal(p.store.load().runs.length, 1);
  const changed = await run(
    ['pr', 'merge', lane.laneId, '--operation-id', mergeId, '--subject', 'Different'],
    p.root,
  );
  assert.equal(JSON.parse(changed.stderr).error.code, 'WORK_OPERATION_CHANGED');
  assert.equal(data.runs[0].head, data.channelMoves[0].head);
  const checks = await run(
    ['pr', 'checks', lane.laneId, '--json', 'id,name,state,bucket,viewId,head'],
    p.root,
  );
  assert.equal(checks.code, 0);
  assert.equal(checks.json[0].bucket, 'pass');
  assert.equal(checks.json[0].name, 'verify');
  await p.agent.dispatch({
    action: 'set-policy',
    operationId: randomUUID(),
    preset: 'trusted',
    acceptance: { protectedPaths: ['a.txt'] },
  });
  const guarded = (await p.agent.dispatch({ action: 'start', outcome: 'Protected' })).result;
  writeFileSync(join(guarded.path, 'a.txt'), 'needs review\n');
  const waiting = await run(['pr', 'merge', guarded.laneId, '--json', 'complete,status,receipt'], p.root);
  assert.equal(waiting.code, 1, waiting.stderr);
  assert.equal(waiting.json.status, 'awaiting-review');
  assert.equal(waiting.json.complete, false);
  assert.match(waiting.json.receipt.reason, /protected paths/);
  data = p.store.load();
  assert.equal(data.channelMoves.length, 1);
  assert.equal(data.runs.at(-1).status, 'passed');
  // A failing configured check also leaves the Channel unchanged.
  await p.agent.dispatch({
    action: 'define-check',
    checkId: data.checks[0].id,
    name: 'verify',
    executable: process.execPath,
    args: ['-e', 'process.exit(1)'],
  });
  const failed = (await p.agent.dispatch({ action: 'start', outcome: 'Failed check' })).result;
  writeFileSync(join(failed.path, 'b.txt'), 'failure\n');
  assert.equal((await run(['pr', 'merge', failed.laneId], p.root)).code, 1);
  assert.equal((await run(['pr', 'checks', failed.laneId], p.root)).code, 1);
  assert.equal(p.store.load().channelMoves.length, 1);
});
test('auth status signed out/in, hostname, hosts JSON and environment source never expose tokens', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'forge-gh-auth-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const server = createServer(async (request, response) => {
    for await (const _chunk of request) {
      /* consume synthetic request */
    }
    response.setHeader('Content-Type', 'application/json');
    response.end(
      JSON.stringify({
        status: 'success',
        value: { subject: 'synthetic-owner', credentialId: 'device', token: 'must-never-leave-response' },
      }),
    );
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const deployment = `http://127.0.0.1:${server.address().port}`,
    env = { XDG_CONFIG_HOME: directory };
  const out = await run(['auth', 'status', '--json'], directory, env);
  assert.equal(out.code, 1);
  assert.equal(out.json.authenticated, false);
  mkdirSync(join(directory, 'forge'));
  writeFileSync(
    join(directory, 'forge', 'auth.json'),
    JSON.stringify({
      defaultDeployment: deployment,
      deployments: {
        [deployment]: {
          token: 'synthetic-saved-token',
          credentialId: 'device',
          name: 'Synthetic',
          scope: 'cli',
          expiresAt: Date.now() + 60000,
        },
      },
    }),
    { mode: 0o600 },
  );
  const status = await run(
    [
      'auth',
      'status',
      '--hostname',
      new URL(deployment).host,
      '--json',
      'hosts,account,tokenSource,identity',
    ],
    directory,
    env,
  );
  assert.equal(status.code, 0, status.stderr);
  assert.equal(status.json.account, 'synthetic-owner');
  assert.equal(status.json.hosts[new URL(deployment).host][0].state, 'success');
  assert.equal(status.json.tokenSource, 'saved');
  const override = await run(['auth', 'status', '--json', 'tokenSource,authenticated'], directory, {
    ...env,
    FORGE_AUTH_TOKEN: 'synthetic-env-token',
  });
  assert.equal(override.code, 0);
  assert.equal(override.json.tokenSource, 'FORGE_AUTH_TOKEN');
  for (const output of [status, override])
    assert.doesNotMatch(
      output.stdout + output.stderr,
      /synthetic-saved-token|synthetic-env-token|must-never-leave-response/,
    );
});

test('version probe is stable, one line, and rejects extra flags', () => {
  const probe = () => spawnSync(process.execPath, [cli, '--version'], { encoding: 'utf8' });
  const first = probe();
  assert.equal(first.status, 0);
  assert.match(first.stdout, /^nforge version \d+\.\d+\.\d+\n$/);
  assert.equal(probe().stdout, first.stdout);
  const invalid = spawnSync(process.execPath, [cli, '--version', '--bogus'], { encoding: 'utf8' });
  assert.equal(invalid.status, 1);
  assert.match(JSON.parse(invalid.stderr).error.message, /--bogus/);
});

test('check projection buckets states and excludes stale View/head evidence', () => {
  const run = {
    id: 'run',
    check: { id: 'check', name: 'verify' },
    viewId: 'view',
    head: 'head',
    startedAt: 'start',
  };
  for (const [state, bucket] of [
    ['queued', 'pending'],
    ['preparing', 'pending'],
    ['running', 'pending'],
    ['passed', 'pass'],
    ['failed', 'fail'],
    ['interrupted', 'fail'],
    ['cancelled', 'cancel'],
  ]) {
    assert.deepEqual(checkRow({ ...run, status: state }), {
      id: 'run',
      name: 'verify',
      state,
      bucket,
      startedAt: 'start',
      completedAt: null,
      link: null,
      viewId: 'view',
      head: 'head',
    });
  }
  const lane = { id: 'lane', head: 'head' },
    view = { id: 'view', head: 'head', inputs: [{ laneId: 'lane', head: 'head' }] };
  assert.deepEqual(
    laneChecks({ views: [view], runs: [{ ...run, status: 'passed', head: 'stale' }] }, lane),
    [],
  );
  assert.equal(
    laneChecks(
      {
        views: [view],
        runs: [
          { ...run, status: 'failed' },
          { ...run, status: 'passed' },
        ],
      },
      lane,
    )[0].bucket,
    'pass',
  );
});
