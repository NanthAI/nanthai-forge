// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { trustAgents } from './autonomy-fixture.mjs';
import { AgentWorkflow } from '../dist/agent-workflow.js';
import { initNative } from '../dist/native-work.js';
import { ForgeError } from '../dist/errors.js';
import {
  DIAGNOSTICS_FILES,
  DIAGNOSTICS_MAX_BYTES,
  describeFailure,
  recordFailure,
  writeDiagnostics,
} from '../dist/system-errors.js';

const cli = new URL('../dist/cli.js', import.meta.url).pathname;
const worker = new URL('../dist/presence-worker.js', import.meta.url).pathname;
const temp = (t, name) => {
  const root = mkdtempSync(join(tmpdir(), `forge-${name}-`));
  t.after(() => {
    try {
      chmodSync(root, 0o700);
    } catch {
      /* Already removed. */
    }
    rmSync(root, { recursive: true, force: true });
  });
  return root;
};
const owner = async (t, name) => {
  const root = temp(t, name);
  writeFileSync(join(root, 'file.txt'), 'one');
  initNative(root);
  trustAgents(root);
  const agent = new AgentWorkflow(root);
  await agent.dispatch({
    action: 'define-check',
    name: 'verify',
    executable: process.execPath,
    args: ['-e', '0'],
  });
  await agent.dispatch({ action: 'start', outcome: 'Observed' });
  return root;
};
const start = (root, env = {}) => {
  const child = spawn(process.execPath, [worker, root], {
    stdio: 'ignore',
    env: { ...process.env, FORGE_PRESENCE_GUARD_MS: '100', ...env },
  });
  const exited = new Promise(resolve => child.once('exit', resolve));
  return { child, exited };
};
// Startup is over when the owner slot and the Lane's slot both hold a ticket marked `holding`: every
// write the worker makes without being asked has landed. Slow sandboxes take over a second to get there.
const ready = async root => {
  const held = name => {
    const dir = join(root, '.forge', 'work', name);
    return (
      existsSync(dir) &&
      readdirSync(dir, { recursive: true }).some(path => {
        if (!String(path).endsWith('ticket.json')) return false;
        try {
          return JSON.parse(readFileSync(join(dir, String(path)), 'utf8')).holding === true;
        } catch {
          return false;
        }
      })
    );
  };
  for (
    const end = Date.now() + 10_000;
    Date.now() < end && !(held('presence-owner') && held('presence-workers'));
  )
    await new Promise(resolve => setTimeout(resolve, 50));
  assert.ok(held('presence-owner') && held('presence-workers'), 'the worker finished starting');
};
const within = (promise, ms) =>
  Promise.race([promise.then(() => true), new Promise(resolve => setTimeout(() => resolve(false), ms))]);

// Node's rmSync on Linux returns early, leaving part of the tree, when the worker renames an entry under it
// before it has seen the owner dying. Tests repeat the rm; what they assert is what happens afterwards.
const removeOwner = root => {
  for (let attempt = 0; attempt < 20 && existsSync(root); attempt += 1)
    rmSync(root, { recursive: true, force: true });
  assert.equal(existsSync(root), false, 'the owner was removed');
};

test('a presence worker exits when its owner directory is deleted', async t => {
  const root = await owner(t, 'worker-deleted');
  const { child, exited } = start(root);
  t.after(() => child.kill());
  await ready(root);
  assert.equal(await within(exited, 700), false, 'a live owner keeps its worker');
  rmSync(root, { recursive: true, force: true });
  assert.equal(await within(exited, 5000), true, 'deleting the owner ends the worker');
});

test('a presence worker exits when its owner is replaced by a new directory', async t => {
  const root = await owner(t, 'worker-replaced');
  const debug = join(temp(t, 'worker-replaced-debug'), 'guard.jsonl');
  const { child, exited } = start(root, { FORGE_PRESENCE_DEBUG_FILE: debug });
  t.after(() => child.kill());
  await ready(root);
  removeOwner(root);
  mkdirSync(root);
  initNative(root);
  await new AgentWorkflow(root).dispatch({ action: 'start', outcome: 'Replacement' });
  const ended = await within(exited, 5000);
  const ticks = existsSync(debug) ? readFileSync(debug, 'utf8').trim().split('\n') : [];
  // A replaced owner directory cannot contain this worker's marker. Some sandboxes (seen in Modal check
  // containers) keep showing the old directory, marker included, after rm -r + mkdir; no check can
  // detect a replacement the filesystem does not show, so the case is untestable there.
  const staleView = !ended && ticks.length > 0 && JSON.parse(ticks.at(-1)).marked === true;
  if (staleView) return t.skip('this sandbox shows the worker a deleted directory');
  assert.equal(
    ended,
    true,
    `a worker never serves a different owner at the same path; exit=${child.exitCode} ticks=${ticks.length} first=${ticks[0]} last=${ticks.at(-1)}`,
  );
});

test('a deleted owner is never recreated by its running worker', async t => {
  const root = await owner(t, 'worker-no-resurrect');
  const { child, exited } = start(root);
  t.after(() => child.kill());
  await ready(root);
  // A live worker may still refresh a ticket before it sees the owner dying; removeOwner repeats the rm.
  removeOwner(root);
  // Several guard ticks (100 ms) plus any watch events the deletion produced.
  for (let tick = 0; tick < 15; tick++) {
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(existsSync(root), false, 'the worker must not recreate the owner root');
  }
  assert.equal(await within(exited, 5000), true);
  assert.equal(existsSync(root), false);
});

const tree = root => (existsSync(root) ? readdirSync(root, { recursive: true }).map(String).sort() : []);
test('a worker leaves a half-deleted owner untouched (Linux rm -r timing)', async t => {
  // inotify reports each unlink while `rm -r` is still running, so the worker sees deep entries go
  // while the root and .forge/work still exist. Emulate that order deterministically.
  const root = await owner(t, 'worker-half-deleted');
  // A 50 ms observation period makes the timers certain to fire inside the observation window.
  const { child, exited } = start(root, { FORGE_PRESENCE_TOUCH_MS: '50' });
  t.after(() => child.kill());
  await ready(root);
  const work = join(root, '.forge', 'work');
  for (const name of readdirSync(work))
    if (/^lane-|^hosted-binding\.json$|^presence-worker-\d+\.marker$/.test(name))
      rmSync(join(work, name), { recursive: true, force: true });
  const before = tree(root);
  assert.ok(
    before.some(path => path.includes('presence-owner')),
    'the worker holds its owner slot',
  );
  // Watch events for the removals plus ten guard ticks and twenty observation ticks, all while the
  // owner directory still exists.
  await new Promise(resolve => setTimeout(resolve, 1000));
  assert.deepEqual(tree(root), before, 'the worker neither writes nor deletes in a dying owner');
  rmSync(root, { recursive: true, force: true });
  assert.equal(existsSync(root), false);
  for (let tick = 0; tick < 15; tick++) {
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(existsSync(root), false, 'the worker must not recreate the owner root');
  }
  assert.equal(await within(exited, 5000), true);
});

test('diagnostics for an owner never create a missing owner directory', t => {
  const base = temp(t, 'diagnostics-parent');
  const missing = join(base, 'owner', '.forge', 'logs');
  assert.equal(writeDiagnostics(missing, 'entry', true), undefined);
  assert.equal(existsSync(join(base, 'owner')), false);
  mkdirSync(join(base, 'owner', '.forge'), { recursive: true });
  assert.equal(writeDiagnostics(missing, 'entry', true), join(missing, 'diagnostics.log'));
  rmSync(join(base, 'owner'), { recursive: true });
  assert.equal(recordFailure(new Error('x'), join(base, 'owner')).diagnostics?.startsWith(base), false);
  assert.equal(existsSync(join(base, 'owner')), false);
});

test('queues and locks under a deleted owner fail instead of recreating it', async t => {
  const base = temp(t, 'queue-parent');
  const { withQueueSlot } = await import('../dist/landing-queue.js');
  const directory = join(base, 'owner', '.forge', 'work');
  await assert.rejects(
    withQueueSlot(join(directory, 'q'), async () => 1, { anchor: directory }),
    {
      code: 'ENOENT',
    },
  );
  assert.equal(existsSync(join(base, 'owner')), false);
});

test('an idle presence worker exits after the idle limit, an active one stays', async t => {
  const idle = await owner(t, 'worker-idle');
  const quiet = start(idle, { FORGE_PRESENCE_IDLE_MS: '1500' });
  const busy = await owner(t, 'worker-busy');
  const active = start(busy, { FORGE_PRESENCE_IDLE_MS: '1500' });
  t.after(() => {
    quiet.child.kill();
    active.child.kill();
  });
  const lane = readdirSync(join(busy, '.forge', 'work')).find(name => name.startsWith('lane-'));
  const ticker = setInterval(
    () => writeFileSync(join(busy, '.forge', 'work', lane, 'edit.txt'), `${Date.now()}`),
    300,
  );
  t.after(() => clearInterval(ticker));
  assert.equal(await within(quiet.exited, 6000), true, 'idle worker exits');
  assert.equal(active.child.exitCode, null, 'a worker with Lane edits keeps running');
});

test('a second worker for the same owner exits at once', async t => {
  const root = await owner(t, 'worker-single');
  const first = start(root);
  t.after(() => first.child.kill());
  // The first worker must hold the slot before the second starts; a fixed wait loses that race on slow runners.
  await ready(root);
  const second = start(root);
  t.after(() => second.child.kill());
  assert.equal(await within(second.exited, 10_000), true);
  assert.equal(first.child.exitCode, null);
});

test('system errors map to a code, syscall, path and hint', () => {
  const error = Object.assign(new Error('EPERM: operation not permitted, mkdir'), {
    code: 'EPERM',
    syscall: 'mkdir',
    path: `${process.env.HOME}/.forge/check-queue/1.x`,
  });
  const failure = describeFailure(error);
  assert.equal(failure.code, 'SYSTEM_EPERM');
  assert.match(failure.message, /^mkdir .*\/\.forge\/check-queue\/1\.x: operation not permitted\./);
  assert.match(failure.message, /No successful result is claimed\./);
  assert.match(failure.hint, /write access to ~\/\.forge.*FORGE_CHECK_QUEUE_DIR/);
  for (const code of ['EACCES', 'ENOSPC', 'EMFILE', 'ENFILE', 'EROFS', 'ENOENT'])
    assert.equal(
      describeFailure(Object.assign(new Error(code), { code, syscall: 'open', path: '/x' })).code,
      `SYSTEM_${code}`,
    );
  assert.deepEqual(describeFailure(new ForgeError('BAD_ARGUMENT', 'Bad.')), {
    code: 'BAD_ARGUMENT',
    message: 'Bad.',
  });
  assert.equal(describeFailure(Object.assign(new Error('x'), { code: 'EOTHER' })).code, 'INTERNAL_ERROR');
});

test('unexpected errors stay INTERNAL_ERROR but name a diagnostics log with the stack', t => {
  const root = temp(t, 'diagnostics');
  mkdirSync(join(root, '.forge'));
  const failure = recordFailure(new Error('boom-secretless'), root);
  assert.equal(failure.code, 'INTERNAL_ERROR');
  assert.equal(failure.message, 'Unexpected failure; no successful result is claimed.');
  assert.equal(failure.diagnostics, join(root, '.forge', 'logs', 'diagnostics.log'));
  assert.match(readFileSync(failure.diagnostics, 'utf8'), /INTERNAL_ERROR[\s\S]*boom-secretless[\s\S]*at /);
});

test('the diagnostics log rotates and stays bounded', t => {
  const directory = join(temp(t, 'rotate'), 'logs');
  const entry = 'x'.repeat(DIAGNOSTICS_MAX_BYTES / 8);
  for (let index = 0; index < 80; index++) writeDiagnostics(directory, entry);
  const files = readdirSync(directory).sort();
  assert.deepEqual(files, ['diagnostics.log', 'diagnostics.log.1', 'diagnostics.log.2']);
  assert.equal(files.length, DIAGNOSTICS_FILES);
});

test('the CLI reports a real permission failure with its path, hint and log', async t => {
  const root = await owner(t, 'cli-eperm');
  const lane = readdirSync(join(root, '.forge', 'work'))
    .find(name => name.startsWith('lane-'))
    .slice(5);
  const queue = temp(t, 'readonly-queue');
  chmodSync(queue, 0o500);
  if (spawnSync('mkdir', [join(queue, 'probe')]).status === 0)
    return t.skip('this account ignores directory permissions');
  const result = spawnSync(
    process.execPath,
    [cli, 'agent', root, 'finish', JSON.stringify({ laneId: lane, message: 'x' })],
    {
      encoding: 'utf8',
      env: { ...process.env, FORGE_CHECK_QUEUE_DIR: join(queue, 'q') },
    },
  );
  assert.equal(result.status, 1);
  const { error } = JSON.parse(result.stderr.trim().split('\n').at(-1));
  assert.equal(error.code, 'SYSTEM_EACCES');
  assert.match(error.message, new RegExp(`mkdir ${queue}`));
  assert.match(error.hint, /FORGE_CHECK_QUEUE_DIR/);
  assert.ok(existsSync(error.diagnostics));
});
