// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { availableParallelism, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { acquireHeavySlot, heavyStatus, tryHeavySlot, wakeHeavyWaiters } from '../dist/heavy-slots.js';
import {
  estimateWaitMs,
  joinQueue,
  leaveQueue,
  queuedNames,
  readQueue,
  recordHold,
} from '../dist/heavy-queue.js';

const cli = resolve('dist/cli-entry.js');
const isolated = t => {
  const directory = mkdtempSync(join(tmpdir(), 'forge-heavy-fair-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
};
const until = async (check, ms = 10_000) => {
  for (const start = Date.now(); Date.now() - start < ms; await sleep(20)) if (check()) return;
  assert.fail('condition not reached in time');
};
const slotFiles = directory => readdirSync(directory).filter(name => /^\d+$/.test(name));

test('waiters get slots in arrival order', async t => {
  const directory = isolated(t),
    order = [];
  const held = tryHeavySlot(directory, 2);
  const other = tryHeavySlot(directory, 2);
  assert(held && other);
  const waiters = [];
  for (let id = 0; id < 8; id++) {
    waiters.push(
      acquireHeavySlot(directory, 2).then(async slot => {
        order.push(id);
        await sleep(5);
        rmSync(slot, { recursive: true });
      }),
    );
    await until(() => queuedNames(directory).length === id + 1);
  }
  // Both slots free at once: the two oldest waiters run first, then the rest in order.
  rmSync(held, { recursive: true });
  rmSync(other, { recursive: true });
  await Promise.all(waiters);
  assert.deepEqual(order, [0, 1, 2, 3, 4, 5, 6, 7]);
  assert.deepEqual(readdirSync(directory), []);
});

test('a caller finding anyone queued waits behind them even when a slot is free', async t => {
  const directory = isolated(t);
  // A live waiter at the front that has not retried yet (it would be woken a moment later).
  const front = joinQueue(directory, { command: 'node' });
  let slot;
  const late = acquireHeavySlot(directory, 3).then(value => (slot = value));
  // The caller joined the queue and ran its first attempt synchronously; let watcher callbacks drain once.
  await until(() => queuedNames(directory).length === 2);
  await new Promise(done => setImmediate(done));
  assert.equal(slot, undefined, 'the free slot belongs to the waiter in front');
  assert.equal(queuedNames(directory).length, 2);
  leaveQueue(directory, front);
  assert.equal(await late, join(directory, '1'));
  assert.deepEqual(queuedNames(directory), []);
});

test('twelve callers on three slots never exceed the limit, lose no wake-up and finish in order', async t => {
  const directory = isolated(t),
    started = [];
  let running = 0,
    peak = 0;
  const open = [];
  const gates = Array.from({ length: 12 }, () => new Promise(done => open.push(done)));
  // Calls are made in id order, so arrival order is id order; each holder keeps its slot until its gate opens.
  const callers = Array.from({ length: 12 }, (_, id) =>
    acquireHeavySlot(directory, 3).then(async slot => {
      started.push(id);
      peak = Math.max(peak, ++running);
      await gates[id];
      running--;
      rmSync(slot, { recursive: true });
    }),
  );
  // Three slots fill at once and the other nine wait: the limit is reached, never passed.
  await until(() => running === 3 && queuedNames(directory).length === 9);
  assert.equal(peak, 3);
  for (const done of open) done();
  await Promise.all(callers);
  assert.equal(peak, 3, `peak ${peak}`);
  assert.deepEqual(started, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
  assert.deepEqual(readdirSync(directory), []);
});

test('a crashed holder is reclaimed on the next check, including a reused PID', async t => {
  const directory = isolated(t);
  const first = tryHeavySlot(directory, 2),
    second = tryHeavySlot(directory, 2);
  // Holder died: its pid no longer exists.
  writeFileSync(join(first, 'pid'), '2147483646');
  // Holder's PID now belongs to a different process: same pid, different start time.
  writeFileSync(join(second, 'start'), 'Thu Jan  1 00:00:00 1970');
  assert.equal(tryHeavySlot(directory, 2, process.pid, false), first, 'the cheap check sees only dead pids');
  assert.equal(tryHeavySlot(directory, 2), second, 'the deep check also sees the reused pid');
  const waiting = acquireHeavySlot(directory, 2, undefined, { tickMs: 50 });
  rmSync(second, { recursive: true });
  assert.equal(await waiting, second);
});

test('a dead waiter never blocks those behind it, even when only the timer can notice', async t => {
  const directory = isolated(t);
  const held = tryHeavySlot(directory, 1);
  // A ticket whose process is gone, and one whose pid was reused (start time differs).
  writeFileSync(join(directory, 'q-000000000000001-2147483646-deadbeef'), '{}');
  const reused = joinQueue(directory, { command: 'node' });
  writeFileSync(join(directory, reused.name), JSON.stringify({ startTime: 'Thu Jan  1 00:00:00 1970' }));
  const waiting = acquireHeavySlot(directory, 1, undefined, { tickMs: 50 });
  // Only the timer can notice the dead tickets: wait until it has reaped them, leaving the live waiter alone.
  await until(() => queuedNames(directory).length === 1);
  rmSync(held, { recursive: true });
  assert.equal(await waiting, join(directory, '1'));
  assert.deepEqual(readQueue(directory), []);
  assert.deepEqual(queuedNames(directory), []);
});

test('a waiter reports its position, and an estimate once history exists', async t => {
  const directory = isolated(t),
    reports = [];
  const held = tryHeavySlot(directory, 1);
  for (const ms of [2000, 4000, 6000]) recordHold(directory, ms);
  const first = acquireHeavySlot(directory, 1, wait => reports.push(['first', wait]), { tickMs: 50 });
  await until(() => reports.length === 1);
  const second = acquireHeavySlot(directory, 1, wait => reports.push(['second', wait]), { tickMs: 50 });
  await until(() => reports.length === 2);
  assert.equal(reports[0][1].position, 1);
  assert.equal(reports[1][1].position, 2);
  assert.equal(reports[1][1].waiting, 2);
  assert.equal(reports[1][1].medianMs, 4000);
  // One running holder (just started) and one waiter ahead: about its remaining time plus one run.
  assert(reports[1][1].estimateMs > 4000 && reports[1][1].estimateMs <= 8000, `${reports[1][1].estimateMs}`);
  rmSync(held, { recursive: true });
  const slot = await first;
  // The one behind moves to the front and is told so, while the first still holds the slot.
  await until(() => reports.some(([name, wait]) => name === 'second' && wait.position === 1));
  rmSync(slot, { recursive: true });
  rmSync(await second, { recursive: true });
});

test('wait estimates need history and count running holders, waiters ahead and the slot count', () => {
  assert.equal(estimateWaitMs([1000, 2000], [], 3, 0), null, 'too little history');
  const holds = [1000, 3000, 2000, 5000, 4000]; // median 3000
  assert.equal(estimateWaitMs(holds, [], 3, 5)?.estimateMs, 3000, 'idle slots absorb the waiters ahead');
  assert.equal(estimateWaitMs(holds, [0, 0, 0], 3, 0)?.estimateMs, 3000, 'full house: a whole run');
  assert.equal(
    estimateWaitMs(holds, [2500, 1000, 0], 3, 0)?.estimateMs,
    500,
    'earliest holder finishes first',
  );
  assert.equal(estimateWaitMs(holds, [2500, 1000, 0], 3, 3)?.estimateMs, 3500, 'a turn per waiter ahead');
  assert.equal(
    estimateWaitMs(holds, [9000], 1, 0)?.estimateMs,
    1500,
    'overrunning holder: half a median more',
  );
});

test('status names holders and waiters by Lane and command, never by folder or arguments', async t => {
  const directory = isolated(t),
    lane = '8ba4b59b-b949-403f-b509-f539126873c6';
  const folder = `/fixture/checkout.forge-client/lanes/${lane}`;
  const held = tryHeavySlot(directory, 1);
  writeFileSync(
    join(held, 'holder.json'),
    JSON.stringify({ cwd: folder, startedAt: Date.now() - 5000, command: '/secret/bin/node' }),
  );
  joinQueue(directory, { command: '/secret/bin/npm', cwd: `${folder}/src`, pid: process.pid });
  const status = heavyStatus(directory, 1, '/elsewhere');
  assert.equal(status.holders[0].lane, lane);
  assert.equal(status.holders[0].command, 'node');
  assert.equal(status.queue.length, 1);
  assert.deepEqual(
    { position: status.queue[0].position, lane: status.queue[0].lane, command: status.queue[0].command },
    { position: 1, lane, command: 'npm' },
  );
  const text = JSON.stringify(status);
  assert(!text.includes('/fixture/checkout') && !text.includes(directory) && !text.includes('/secret'), text);
  assert.deepEqual(slotFiles(directory), ['1'], 'status is read-only');
});

test('friction 25f56c0a: a raised slot limit is taken by the waiter already queued, at once on a wake', async t => {
  const directory = isolated(t);
  let limit = 1;
  const held = tryHeavySlot(directory, 1);
  let slot;
  // No timer within the test: only the wake can make the waiter look again.
  const waiting = acquireHeavySlot(directory, () => limit, undefined, { tickMs: 600_000 }).then(
    value => (slot = value),
  );
  await until(() => queuedNames(directory).length === 1);
  await new Promise(done => setImmediate(done));
  assert.equal(slot, undefined, 'one slot, held');
  limit = 2;
  wakeHeavyWaiters(directory);
  assert.equal(await waiting, join(directory, '2'));
  assert(existsSync(held), 'the first holder still runs');
  assert.deepEqual(queuedNames(directory), []);
  // Without a wake (a settings file edited by hand), the periodic check reads the limit again.
  const timed = acquireHeavySlot(directory, () => limit, undefined, { tickMs: 50 });
  await until(() => queuedNames(directory).length === 1);
  limit = 3;
  assert.equal(await timed, join(directory, '3'));
});

test('friction 25f56c0a: nforge settings localHeavySlots wakes a queued nforge heavy while the slot holder still runs', async t => {
  const directory = isolated(t),
    settings = join(directory, 'settings.json');
  writeFileSync(settings, JSON.stringify({ localHeavySlots: 1 }));
  const held = tryHeavySlot(directory, 1);
  const waiter = heavyProcess(directory, [process.execPath, '-e', printStart], settings);
  await until(() => waiter.stderr.includes('Queue position 1 of 1'), 30_000);
  const raised = spawn(process.execPath, [cli, 'settings', 'localHeavySlots', '2'], {
    env: { ...process.env, FORGE_HEAVY_DIR: directory, FORGE_CLIENT_SETTINGS: settings },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  assert.equal(await new Promise(done => raised.once('exit', done)), 0);
  await waiter.exited;
  assert.match(waiter.stdout, /S\d+/, waiter.stderr);
  assert(existsSync(held), 'the waiter ran in the new slot, not after a release');
});

function heavyProcess(directory, args, settings, cwd, stdin = 'ignore') {
  const env = { ...process.env, FORGE_HEAVY_DIR: directory, FORGE_CLIENT_SETTINGS: settings };
  delete env.FORGE_HEAVY_TEST_CONCURRENCY;
  delete env.GOMAXPROCS;
  delete env.RAYON_NUM_THREADS;
  const child = spawn(process.execPath, [cli, 'heavy', ...args], {
    cwd,
    env,
    stdio: [stdin, 'pipe', 'pipe'],
  });
  const result = { stdout: '', stderr: '', exited: new Promise(done => child.once('exit', done)), child };
  child.stdout.on('data', data => (result.stdout += data));
  child.stderr.on('data', data => (result.stderr += data));
  return result;
}
const printStart = "process.stdout.write('S'+Date.now()+'\\n');setTimeout(()=>{},250)";

test('nforge heavy runs queued commands first come, first served and tells each its position', async t => {
  const directory = isolated(t),
    settings = join(directory, 'settings.json');
  writeFileSync(settings, JSON.stringify({ localHeavySlots: 1 }));
  for (const ms of [200, 250, 300]) recordHold(directory, ms);
  const held = tryHeavySlot(directory, 1);
  assert(held);
  // The real CLI may otherwise admit a burst slot on an idle machine. These commands
  // each reserve the machine's cores, so the test always exercises one occupied slot.
  const command = [
    '--cores',
    String(availableParallelism()),
    process.execPath,
    '-e',
    "process.stdout.write('started\\n'); process.stdin.resume()",
  ];
  const callers = [];
  try {
    for (let id = 0; id < 4; id++) {
      const caller = heavyProcess(directory, command, settings, undefined, 'pipe');
      callers.push(caller);
      await until(() => queuedNames(directory).length === id + 1, 30_000);
      await until(() => caller.stderr.includes(`Queue position ${id + 1} of ${id + 1}`), 30_000);
    }
    rmSync(held, { recursive: true });
    for (const [id, caller] of callers.entries()) {
      await until(() => caller.stdout.includes('started'), 30_000);
      assert(
        callers.slice(id + 1).every(later => !later.stdout.includes('started')),
        'start order is arrival order',
      );
      // Keep the penultimate command in its slot until the last waiter sees its new position.
      if (id === callers.length - 2)
        await until(() => callers.at(-1).stderr.includes('Queue position 1 of 1'), 30_000);
      caller.child.stdin.end();
      assert.equal(await caller.exited, 0, caller.stderr);
    }
  } finally {
    for (const caller of callers)
      if (caller.child.exitCode === null && caller.child.signalCode === null) caller.child.kill();
    await Promise.all(callers.map(caller => caller.exited));
  }
  assert.match(callers[3].stderr, /Queue position 4 of 4; estimated wait about \d+ s \(median heavy command/);
  assert.match(callers[3].stderr, /Queue position 1 of 1/);
  assert.deepEqual(slotFiles(directory), []);
  assert.deepEqual(queuedNames(directory), []);
});

test('nforge heavy: a killed waiter leaves the queue and a killed holder frees its slot', async t => {
  const directory = isolated(t),
    settings = join(directory, 'settings.json');
  writeFileSync(settings, JSON.stringify({ localHeavySlots: 1 }));
  const held = tryHeavySlot(directory, 1);
  const doomed = heavyProcess(directory, [process.execPath, '-e', printStart], settings);
  await until(() => queuedNames(directory).length === 1, 30_000);
  const survivor = heavyProcess(directory, [process.execPath, '-e', printStart], settings);
  await until(() => queuedNames(directory).length === 2, 30_000);
  doomed.child.kill('SIGKILL');
  await doomed.exited;
  rmSync(held, { recursive: true });
  await survivor.exited;
  assert.match(survivor.stdout, /S\d+/, survivor.stderr);
  // A holder killed mid-run: its slot is reclaimed by the next caller without waiting for a timer.
  const stuck = heavyProcess(directory, [process.execPath, '-e', 'setTimeout(()=>{},8000)'], settings);
  await until(() => slotFiles(directory).length === 1, 30_000);
  stuck.child.kill('SIGKILL');
  await stuck.exited;
  const next = heavyProcess(directory, [process.execPath, '-e', printStart], settings);
  await next.exited;
  assert.match(next.stdout, /S\d+/, next.stderr);
});

test('nested heavy reuses the parent slot and preserves whether the parent queued', async t => {
  const directory = isolated(t),
    settings = join(directory, 'settings.json');
  writeFileSync(settings, JSON.stringify({ localHeavySlots: 1 }));
  const held = tryHeavySlot(directory, 1);
  assert(held);
  const showQueued =
    "if (JSON.parse(process.env.FORGE_HEAVY_PARENT).waited !== true) throw Error('lost outer queue wait'); process.stdout.write('nested')";
  const nested = `const {spawnSync}=require('node:child_process'); const fs=require('node:fs');
    const r=spawnSync(process.execPath,[${JSON.stringify(cli)},'heavy',process.execPath,'-e',${JSON.stringify(showQueued)}],{encoding:'utf8',timeout:10000});
    if(r.status!==0)throw Error(r.stderr||r.error?.code); process.stdout.write(r.stdout);
    if(!fs.existsSync(${JSON.stringify(join(directory, '1'))}))throw Error('parent lease removed');`;
  const run = heavyProcess(
    directory,
    ['--cores', String(availableParallelism()), process.execPath, '-e', nested],
    settings,
  );
  t.after(() => run.child.kill());
  await until(() => queuedNames(directory).length === 1, 30_000);
  rmSync(held, { recursive: true });
  assert.equal(await run.exited, 0, run.stderr);
  assert.equal(run.stdout, 'nested');
  assert.deepEqual(slotFiles(directory), [], 'parent releases its lease');
});

test('incident 7008ff18: a project-declared static command waits for a slot and gets its cap', async t => {
  const directory = isolated(t),
    settings = join(directory, 'settings.json');
  writeFileSync(settings, JSON.stringify({ localHeavySlots: 1 }));
  const held = tryHeavySlot(directory, 1);
  assert.ok(held);
  const command = [
    process.execPath,
    '-e',
    `process.stdout.write(JSON.stringify({parent: JSON.parse(process.env.FORGE_HEAVY_PARENT || "null"),
      capped: Number(process.env.GOMAXPROCS) === ${availableParallelism()}}))`,
  ];
  writeFileSync(join(directory, 'forge.json'), JSON.stringify({ preflight: { static: [{ command }] } }));
  const run = heavyProcess(directory, command, settings, directory);
  t.after(() => run.child.kill());
  await until(() => queuedNames(directory).length > 0 || run.stdout.length > 0);
  assert.equal(run.stdout, '', 'the command could not start while the slot was occupied');
  assert.equal(queuedNames(directory).length, 1);
  rmSync(held, { recursive: true });
  assert.equal(await run.exited, 0, run.stderr);
  const seen = JSON.parse(run.stdout);
  assert.equal(seen.parent?.pid, run.child.pid);
  assert.equal(seen.capped, true);
  assert.deepEqual(slotFiles(directory), []);
});
