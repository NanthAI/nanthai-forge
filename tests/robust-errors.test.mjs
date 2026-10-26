import { landingWorkerStates } from '../dist/landing-worker-status.js';
import { WorkStore } from '../dist/work-store.js';
// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { spawn, spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
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
const clock = new URL('./robust-errors-clock.mjs', import.meta.url).pathname;
const workers = new WeakMap();
const temp = (t, name) => {
  const root = mkdtempSync(join(tmpdir(), `forge-${name}-`));
  t.after(async () => {
    // after hooks run in registration order: stop/reap children before removing any fixture tree.
    for (const running of workers.get(t) ?? []) {
      if (running.child.exitCode === null && running.child.signalCode === null) running.child.kill();
      assert.equal(await within(running.exited, 5000), true, 'fixture worker was reaped');
    }
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
const start = (t, root, env = {}, controlled = false) => {
  const child = spawn(process.execPath, [...(controlled ? ['--import', clock] : []), worker, root], {
    stdio: controlled ? ['ignore', 'ignore', 'pipe', 'ipc'] : ['ignore', 'ignore', 'pipe'],
    env: { ...process.env, FORGE_PRESENCE_GUARD_MS: '100', ...env },
  });
  const exited = once(child, 'exit');
  const running = { child, exited, watching: false, edits: 0, errors: '' };
  child.stderr.on('data', bytes => {
    running.errors += bytes;
  });
  child.on('message', message => {
    if (message.watching) running.watching = true;
    if (message.edited) running.edits++;
  });
  workers.set(t, [...(workers.get(t) ?? []), running]);
  return running;
};
const waitFor = async (observe, message, ms = 10_000) => {
  const end = performance.now() + ms;
  while (!observe()) {
    assert.ok(performance.now() < end, message);
    await new Promise(resolve => setTimeout(resolve, 25));
  }
};
// Startup is over when this child's owner slot and Lane slot both hold a ticket marked `holding`.
// Its managed landing service must also report idle before deletion can start.
const ready = async (root, child) => {
  const held = name => {
    const dir = join(root, '.forge', 'work', name);
    return (
      existsSync(dir) &&
      readdirSync(dir, { recursive: true }).some(path => {
        if (!String(path).endsWith('ticket.json') || !String(path).includes(`${child.pid}.`)) return false;
        try {
          return JSON.parse(readFileSync(join(dir, String(path)), 'utf8')).holding === true;
        } catch {
          return false;
        }
      })
    );
  };
  const landingReady = () =>
    landingWorkerStates(new WorkStore(root)).some(
      state => state.worker.pid === child.pid && state.status === 'idle',
    );
  await waitFor(() => {
    assert.equal(child.exitCode, null, 'worker did not exit during startup');
    assert.equal(child.signalCode, null, 'worker was not signalled during startup');
    return held('presence-owner') && held('presence-workers') && landingReady();
  }, 'presence and landing worker finished starting');
};
const within = async (promise, ms) => {
  let timer;
  try {
    return await Promise.race([
      promise.then(() => true),
      new Promise(resolve => {
        timer = setTimeout(() => resolve(false), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
};
const ended = async ({ child, exited }, absentRoot) => {
  // This phase owns a fresh deadline, independent of startup and previous observations. ChildProcess
  // exit/signal state (and the saved exit event) also distinguishes a killed child from a normal exit.
  await waitFor(
    () => {
      if (absentRoot) assert.equal(existsSync(absentRoot), false, 'the worker must not recreate the owner');
      return child.exitCode !== null || child.signalCode !== null;
    },
    'the worker exited',
    5000,
  );
  assert.deepEqual(await exited, [0, null], 'worker exited normally');
};
const advance = async (child, ms, now) => {
  const advanced = once(child, 'message');
  child.send({ ms, ...(now === undefined ? {} : { now }) });
  assert.equal(await within(advanced, 5000), true, 'worker completed the requested interval callbacks');
  assert.deepEqual((await advanced)[0], { advanced: ms });
};

// Recursive removal has no atomic ordering relative to another process's writes/renames. Detach the
// live pathname first, then delete its descendants without competing writers. The half-deletion test
// below separately injects the Linux order where descendants disappear while the owner still exists.
const removeOwner = (t, root) => {
  const removed = join(temp(t, 'removed-owner'), 'owner');
  renameSync(root, removed);
  rmSync(removed, { recursive: true, force: true });
  assert.equal(existsSync(root), false, 'the owner was removed');
};

test('a presence worker exits when its owner directory is deleted', async t => {
  const root = await owner(t, 'worker-deleted');
  const running = start(t, root);
  const { child, exited } = running;
  await ready(root, child);
  assert.equal(await within(exited, 700), false, 'a live owner keeps its worker');
  removeOwner(t, root);
  await ended(running, root);
});

test('a presence worker exits when its owner is replaced by a new directory', async t => {
  const root = await owner(t, 'worker-replaced');
  const running = start(t, root, {}, true);
  await ready(root, running.child);
  await waitFor(() => running.watching, 'native watchers finished attaching');
  // Publish an already-initialized replacement. Building Work at the live path
  // races the old worker's final observations and can fail init with WORK_BUSY.
  const replacement = await owner(t, 'worker-replacement');
  removeOwner(t, root);
  renameSync(replacement, root);
  running.child.send({ ms: 100 });
  await ended(running);
});

test('a deleted owner is never recreated by its running worker', async t => {
  const root = await owner(t, 'worker-no-resurrect');
  const running = start(t, root);
  await ready(root, running.child);
  removeOwner(t, root);
  await ended(running, root);
  assert.equal(existsSync(root), false);
});

const tree = root =>
  readdirSync(root, { recursive: true })
    .map(String)
    .sort()
    .map(path => {
      const entry = join(root, path),
        stat = statSync(entry, { bigint: true });
      return [path, stat.mtimeNs, stat.isFile() ? readFileSync(entry) : null];
    });
test('a worker leaves a half-deleted owner untouched (Linux rm -r timing)', async t => {
  // inotify reports each unlink while `rm -r` is still running, so the worker sees deep entries go
  // while the root and .forge/work still exist. Emulate that order deterministically.
  const root = await owner(t, 'worker-half-deleted');
  const running = start(t, root, { FORGE_PRESENCE_TOUCH_MS: '50' }, true);
  const { child } = running;
  await ready(root, child);
  await waitFor(() => running.watching, 'owner, Lane and landing watchers finished attaching');
  const work = join(root, '.forge', 'work');
  for (const name of readdirSync(work))
    if (/^lane-|^hosted-binding\.json$/.test(name))
      rmSync(join(work, name), { recursive: true, force: true });
  const before = tree(root);
  assert.ok(
    before.some(([path]) => path.includes('presence-owner')),
    'the worker holds its owner slot',
  );
  // Keep the marker: removing it here would let the guard exit before observation can run. Force
  // twenty observation ticks and ten guard ticks, then await the child's acknowledgement.
  await advance(child, 1000);
  assert.equal(child.exitCode, null, 'the worker remains alive during partial deletion');
  assert.equal(child.signalCode, null);
  assert.deepEqual(tree(root), before, 'the worker neither writes nor deletes in a dying owner');
  // Next Linux deletion stage: the marker disappears but the owner and queue tickets remain.
  rmSync(join(work, `presence-worker-${child.pid}.marker`));
  const dying = tree(root);
  child.send({ ms: 100 });
  await ended(running);
  assert.deepEqual(tree(root), dying, 'owner-death exit does not clean up inside the dying owner');
  rmSync(root, { recursive: true, force: true });
  assert.equal(existsSync(root), false);
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
  const env = { FORGE_PRESENCE_IDLE_MS: '1500', FORGE_TEST_CONTROL_DATE: '1' };
  const quiet = start(t, idle, env, true);
  const busy = await owner(t, 'worker-busy');
  const active = start(t, busy, env, true);
  await ready(idle, quiet.child);
  await ready(busy, active.child);
  await waitFor(() => quiet.watching && active.watching, 'both workers subscribed to their edit hints');
  // Start at an explicit durable activity boundary after asynchronous startup.
  // Real filesystem mtimes and the workers' clocks now share this baseline.
  const now = Math.ceil(Date.now() / 1000) * 1000;
  for (const root of [idle, busy])
    utimesSync(join(root, '.forge', 'work', 'work.json'), now / 1000, now / 1000);
  await advance(quiet.child, 1499, now);
  assert.equal(quiet.child.exitCode, null, 'idle worker stays before the idle limit');
  // Guard ticks sample the idle clock every 100 ms; their phase starts at
  // process startup, so cross the deadline and the next sample explicitly.
  quiet.child.send({ ms: 100 });
  await ended(quiet);

  await advance(active.child, 0, now);
  const lane = readdirSync(join(busy, '.forge', 'work')).find(name => name.startsWith('lane-'));
  for (let i = 0; i < 3; i++) {
    await advance(active.child, 1000);
    const edits = active.edits;
    const path = join(busy, '.forge', 'work', lane);
    writeFileSync(join(path, 'edit.txt'), `edit ${i}`);
    active.child.send({ editPath: path });
    await waitFor(() => active.edits > edits, 'Lane edit hint delivered to the real idle guard');
    assert.equal(active.child.exitCode, null, 'acknowledged Lane edits keep the worker running');
    assert.equal(active.child.signalCode, null);
  }
  // The active worker also exits once activity actually stops.
  active.child.send({ ms: 1500 });
  await ended(active);
});

test('a second worker for the same owner exits at once', async t => {
  const root = await owner(t, 'worker-single');
  const first = start(t, root);
  // The first worker must hold the slot before the second starts; a fixed wait loses that race on slow runners.
  await ready(root, first.child);
  const second = start(t, root);
  assert.equal(await within(second.exited, 10_000), true);
  assert.deepEqual(await second.exited, [0, null]);
  assert.equal(first.child.exitCode, null);
  assert.equal(first.child.signalCode, null);
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
