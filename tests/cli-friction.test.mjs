// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { heavyStatus, tryHeavySlot } from '../dist/heavy-slots.js';
import { agentCli } from '../dist/agent-cli.js';
import { HostedAgentTransport } from '../dist/hosted-agent-transport.js';
import { getFunctionName } from 'convex/server';
import { randomUUID } from 'node:crypto';
const cli = resolve('dist/cli-entry.js');
function temporary(t) {
  const root = fs.mkdtempSync(join(tmpdir(), 'forge-cli-friction-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
test('only the executable entry prepares hooks; direct CLI callers keep stderr empty', t => {
  const root = temporary(t),
    home = join(root, 'home'),
    config = join(root, 'config');
  fs.mkdirSync(home);
  fs.mkdirSync(config);
  const env = { ...process.env, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: config };
  const args = ['agent', '/unused/help-only', 'status', '--help'];
  // A hook whose target is gone: the executable entry reports it (a dev build never rewrites it).
  const hooks = join(home, '.codex/hooks.json');
  fs.mkdirSync(join(home, '.codex'));
  const stale = JSON.stringify({
    hooks: {
      PreToolUse: [
        {
          hooks: [
            {
              type: 'command',
              command: `'node' '${join(root, 'gone-lane', 'dist', 'agent-edit-hook.js')}' '--auto' '--forge-first-write'`,
            },
          ],
        },
      ],
    },
  });
  fs.writeFileSync(hooks, stale);
  const direct = spawnSync(process.execPath, [resolve('dist/cli.js'), ...args], { encoding: 'utf8', env });
  assert.equal(direct.status, 0, direct.stderr);
  assert.equal(direct.stderr, '');
  assert.equal(fs.readFileSync(hooks, 'utf8'), stale);
  const entry = spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', env });
  assert.equal(entry.status, 0, entry.stderr);
  assert.equal(entry.stdout, direct.stdout);
  assert.match(entry.stderr, /not the installed Forge CLI.*missing-target.*install-hooks/s);
  assert.equal(fs.readFileSync(hooks, 'utf8'), stale, 'a dev build never rewrites hooks');
});
test('heavy help, no command, status and argument errors never acquire a busy slot or call the network', t => {
  const root = temporary(t);
  for (let i = 1; i <= 3; i++) tryHeavySlot(root, 3, process.pid);
  fs.writeFileSync(
    join(root, '1/holder.json'),
    JSON.stringify({ cwd: root, startedAt: Date.now() - 1000, command: 'node' }),
  );
  const settings = join(root, 'settings.json');
  fs.writeFileSync(settings, JSON.stringify({ localHeavySlots: 3 }));
  const before = fs.readdirSync(root);
  for (const args of [[], ['--help'], ['-h'], ['--status'], ['--unknown'], ['--status', 'extra']]) {
    const result = spawnSync(process.execPath, [cli, 'heavy', ...args], {
      cwd: root,
      encoding: 'utf8',
      timeout: 10_000,
      env: { ...process.env, FORGE_HEAVY_DIR: root, FORGE_CLIENT_SETTINGS: settings },
    });
    assert.equal(result.status, args[0] === '--unknown' || args.length === 2 ? 1 : 0, result.stderr);
    assert(!result.stderr.includes('waiting'));
    if (args[0] === '--status' && args.length === 1) {
      const status = JSON.parse(result.stdout);
      assert.equal(status.holders.length, 3);
      assert.equal(status.holders[0].command, 'node');
      assert.equal(status.selfHeld, true);
      assert(status.holders[0].elapsedMs >= 1000);
    }
  }
  assert.deepEqual(fs.readdirSync(root), before);
  assert.equal(heavyStatus(root, 3, '/different-folder').selfHeld, false);
});
test('missing cwd fails before hooks with command-specific cd advice and no stack', t => {
  if (process.platform === 'win32') return;
  const root = temporary(t),
    cwd = join(root, 'removed');
  for (const args of [['status'], ['heavy', process.execPath], ['agent', root]]) {
    fs.mkdirSync(cwd);
    const code = `process.chdir(${JSON.stringify(cwd)});require('node:fs').rmdirSync(${JSON.stringify(cwd)});process.argv=[process.execPath,${JSON.stringify(cli)},...${JSON.stringify(args)}];import(${JSON.stringify(cli)})`;
    const result = spawnSync(process.execPath, ['-e', code], { encoding: 'utf8' });
    assert.equal(result.status, 1);
    const failure = JSON.parse(result.stderr).error;
    assert.equal(failure.code, 'CWD_UNAVAILABLE');
    assert(failure.message.includes(args[0] === 'agent' ? `cd '${root}'` : 'cd /'));
    assert(!failure.message.includes(`cd '${process.execPath}'`));
    assert(!result.stderr.includes('hooks'));
    assert(!result.stderr.includes('ENOENT'));
  }
});
test('a folder without a hosted marker is refused with its absolute path and nforge host, without network or Git', async t => {
  // One client mode (Issue 657d63ee): no native fallback for a Git or plain folder.
  const root = temporary(t);
  fs.mkdirSync(join(root, 'folder'));
  t.mock.method(globalThis, 'fetch', () => assert.fail('No argument-error network calls'));
  for (const [path, action] of [
    [root, 'planning'],
    [join(root, 'folder'), 'status'],
  ])
    await assert.rejects(
      agentCli([path, action, '{}']),
      error =>
        error.code === 'FORGE_ROOT_UNAVAILABLE' &&
        error.message.includes(JSON.stringify(path)) &&
        error.message.includes(`nforge host ${JSON.stringify(path)}`),
    );
  // coordination ROOT / mcp-coordination ROOT resolve the hosted address, never a local Work store.
  const { coordinationTarget } = await import('../dist/coordination-cli.js');
  assert.throws(
    () => coordinationTarget(join(root, 'folder')),
    error => error.code === 'FORGE_ROOT_UNAVAILABLE' && error.message.includes('nforge host'),
  );
  assert.equal(fs.existsSync(join(root, '.git')), false);
  assert.equal(fs.existsSync(join(root, '.forge')), false);
});
test('live Lane client makes exactly one filtered page query, no capabilities or per-Lane calls; errors are local', async t => {
  const root = temporary(t),
    calls = [];
  const transport = new HostedAgentTransport(
    root,
    { url: 'https://fixture.invalid', projectId: 'project' },
    {
      projectId: 'project',
      client: {
        query: async (ref, args) => {
          calls.push({ name: getFunctionName(ref), args });
          return JSON.stringify({ page: [{ laneId: 'fixture' }], isDone: true, continueCursor: null });
        },
      },
    },
  );
  const planningItemId = randomUUID();
  const result = await transport.dispatch('lanes', { limit: 20, planningItemId });
  assert.equal(result.result.page.length, 1);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, 'projectHostedLiveLanes:list');
  assert.equal(calls[0].args.limit, 20);
  assert.equal(calls[0].args.planningItemId, planningItemId);
  for (const input of [{ limit: 0 }, { limit: 101 }, { cursor: 2 }, { extra: true }])
    await assert.rejects(
      transport.dispatch('lanes', input),
      error => error.code === 'BAD_ARGUMENT' && /--help/.test(error.message),
    );
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls.length, 1);
});

test('non-Git Forge clone roots address hosted planning with no local Git dependency', async t => {
  const root = temporary(t),
    clone = join(root, 'clone');
  fs.mkdirSync(join(clone, '.forge'), { recursive: true });
  fs.writeFileSync(
    join(clone, '.forge/hosted-main.json'),
    JSON.stringify({ selection: { projectId: 'project' } }),
  );
  fs.mkdirSync(join(root, 'clone.forge-client/agent'), { recursive: true });
  fs.writeFileSync(
    join(root, 'clone.forge-client/agent/address.json'),
    JSON.stringify({ url: 'https://fixture.invalid', projectId: 'project' }),
  );
  const { hostedAgentAddress } = await import('../dist/hosted-agent-cli.js');
  assert.deepEqual(hostedAgentAddress(clone, {}), { url: 'https://fixture.invalid', projectId: 'project' });
  const { coordinationTarget } = await import('../dist/coordination-cli.js');
  assert.deepEqual(coordinationTarget(clone), {
    deployment: 'https://fixture.invalid',
    projectId: 'project',
  });
  assert.equal(fs.existsSync(join(clone, '.git')), false);
  const { hostedAgentHelp } = await import('../dist/hosted-agent-help.js');
  assert(hostedAgentHelp('planning').includes('reconcile'));
});

test('live Lane transport preserves typed server errors and gives an exact read continuation', async t => {
  const root = temporary(t);
  const { ConvexError } = await import('convex/values');
  let failure = new ConvexError({
      code: 'BAD_ARGUMENT',
      message: 'cursor: expected the returned cursor. Run nforge agent ROOT lanes {}.',
    }),
    calls = 0;
  const transport = new HostedAgentTransport(
    root,
    { url: 'https://fixture.invalid', projectId: 'project' },
    {
      projectId: 'project',
      client: {
        query: async () => {
          calls++;
          throw failure;
        },
      },
    },
  );
  await assert.rejects(
    transport.dispatch('lanes', {}),
    error => error.code === 'BAD_ARGUMENT' && error.message.includes('cursor'),
  );
  failure = new ConvexError({ code: 'PROJECT_UNAVAILABLE', message: 'Unavailable with this account.' });
  await assert.rejects(
    transport.dispatch('lanes', {}),
    error => error.code === 'PROJECT_UNAVAILABLE' && error.message.includes('nforge login'),
  );
  failure = new Error('Could not find public function for projectHostedLiveLanes:list');
  await assert.rejects(
    transport.dispatch('lanes', {}),
    error => error.code === 'HOSTED_ACTION_UNSUPPORTED' && error.message.includes('Deploy'),
  );
  assert.equal(calls, 3);
});
