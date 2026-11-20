// SPDX-License-Identifier: Apache-2.0
// Item 593fc2d7: a heavy slot is freed when its command hangs past the hold bound or ignores the stop
// signal its agent's end sends, and a holder that never stops itself is freed (unsignalled) by the
// next waiter. A live command inside its bound is never touched.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { HEAVY_MAX_MS, HEAVY_OVERDUE_GRACE_MS, heavyStatus, tryHeavySlot } from '../dist/heavy-slots.js';

const cli = resolve('dist/cli-entry.js');
const isolated = t => {
  const directory = mkdtempSync(join(tmpdir(), 'forge-heavy-bound-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
};
const slotFiles = directory => readdirSync(directory).filter(name => /^\d+$/.test(name));
function heavy(t, directory, settings, args) {
  writeFileSync(join(directory, 'settings.json'), JSON.stringify(settings));
  const child = spawn(process.execPath, [cli, 'heavy', ...args], {
    env: {
      ...process.env,
      FORGE_HEAVY_DIR: directory,
      FORGE_CLIENT_SETTINGS: join(directory, 'settings.json'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(() => child.kill('SIGKILL'));
  const run = { stdout: '', stderr: '', child, exited: new Promise(done => child.once('exit', done)) };
  // Resolves once the command has printed R, i.e. it holds the slot and is running.
  run.running = new Promise(done =>
    child.stdout.on('data', data => {
      run.stdout += data;
      if (run.stdout.includes('R')) done();
    }),
  );
  child.stderr.on('data', data => (run.stderr += data));
  return run;
}
// Ignores SIGTERM, as a hung test or a runner stuck in a handler does; prints R once it is running.
const ignoresStop = "process.on('SIGTERM',()=>{});process.stdout.write('R');setInterval(()=>{},1000)"; // test-signal: allow the child's keep-alive, not a test wait

test('593fc2d7: a command still running past localHeavyMaxMinutes is stopped (exit 124) and frees its slot', async t => {
  const directory = isolated(t);
  // 1.8 s bound; the command ignores the stop signal, so only the kill after the grace ends it.
  const run = heavy(t, directory, { localHeavySlots: 1, localHeavyMaxMinutes: 0.03 }, [
    process.execPath,
    '-e',
    ignoresStop,
  ]);
  assert.equal(await run.exited, 124, run.stderr);
  assert.match(
    run.stderr,
    /still running after \d+ s \(localHeavyMaxMinutes\); stopping it to free its slot/,
  );
  assert.deepEqual(slotFiles(directory), [], 'the slot is free');
});

test('593fc2d7: a stop signal to heavy whose command ignores it kills the command after the grace and frees the slot', async t => {
  const directory = isolated(t);
  // Bound 12 s (grace 3 s): the signal path, not the bound, must end it.
  const run = heavy(t, directory, { localHeavySlots: 1, localHeavyMaxMinutes: 0.2 }, [
    process.execPath,
    '-e',
    ignoresStop,
  ]);
  await run.running;
  run.child.kill('SIGTERM');
  assert.equal(await run.exited, 128 + 9, 'the command was killed after the grace');
  assert.doesNotMatch(run.stderr, /still running after/, 'the bound did not fire');
  assert.deepEqual(slotFiles(directory), [], 'the slot is free');
});

test('593fc2d7: a live holder far past its bound is freed by the next waiter, unsignalled; one inside it or unbounded is kept', t => {
  const directory = isolated(t);
  const slot = tryHeavySlot(directory, 1);
  const holder = record => writeFileSync(join(slot, 'holder.json'), JSON.stringify(record));
  const overdue = Date.now() - (HEAVY_MAX_MS + HEAVY_OVERDUE_GRACE_MS + 60_000);
  // This test process is the live holder throughout.
  holder({ startedAt: Date.now() - HEAVY_MAX_MS - 60_000, maxMs: HEAVY_MAX_MS, command: 'node' });
  assert.equal(tryHeavySlot(directory, 1), null, 'past its bound but inside the grace: kept');
  assert.equal(heavyStatus(directory, 1).holders[0]?.overBound, true, 'status marks it over its bound');
  holder({ startedAt: overdue, maxMs: 0, command: 'node' });
  assert.equal(tryHeavySlot(directory, 1), null, 'localHeavyMaxMinutes 0: never overdue');
  holder({ startedAt: overdue, command: 'node' });
  assert.equal(tryHeavySlot(directory, 1), slot, 'a holder declaring no bound gets the default one');
  assert(existsSync(join(slot, 'pid')), 'the waiter now holds the slot');
});

test('593fc2d7: a holder whose slot was freed as overdue and taken by another caller leaves that slot alone', async t => {
  const directory = isolated(t);
  const run = heavy(t, directory, { localHeavySlots: 1 }, [
    process.execPath,
    '-e',
    "process.stdout.write('R');setTimeout(()=>{},1500)", // test-signal: allow the child's run time, not a test wait
  ]);
  await run.running;
  // Another caller took the slot over (as after an overdue reclaim): it now records that caller's pid.
  writeFileSync(join(directory, '1', 'pid'), String(process.pid));
  assert.equal(await run.exited, 0, run.stderr);
  assert(existsSync(join(directory, '1', 'pid')), "the new holder's slot is still there");
});

test('593fc2d7: a bound past what a timer can hold is refused, not fired at once', async t => {
  const directory = isolated(t);
  const run = heavy(t, directory, { localHeavySlots: 1, localHeavyMaxMinutes: 40_000 }, [
    process.execPath,
    '-e',
    "process.stdout.write('ran')",
  ]);
  assert.notEqual(await run.exited, 0);
  assert.match(run.stderr, /CLIENT_SETTINGS_INVALID/);
  assert.equal(run.stdout, '', 'the command never started');
});
