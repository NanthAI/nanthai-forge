// SPDX-License-Identifier: Apache-2.0
// Item ff33e9a6: heavy admits by measured CPU, load and memory. A long one-core holder no longer
// blocks test runs while load is low; none extra start at the ceiling; the memory freeze guard holds
// every slot, while load alone never holds a base slot (a busy shared CI runner keeps its slots).
// All machine readings are fixtures (fake load, memory, CPU and clocks); nothing reads this Mac's
// heavy settings or slots.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { availableParallelism, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { admitHeavy, cachedSample, heavyAdmission, heavyBurstLimit } from '../dist/heavy-admission.js';
import { acquireHeavySlot, tryHeavyAdmission, tryHeavySlot } from '../dist/heavy-slots.js';
import { holdSummary } from '../dist/heavy-hold.js';

const cli = resolve('dist/cli-entry.js');
const MIN = 60_000;
// Fixture instant; holders are dated from it and the admission is given it as its clock.
const NOW = Date.parse('2026-01-01T12:00:00.000Z');
const isolated = t => {
  const directory = mkdtempSync(join(tmpdir(), 'forge-heavy-admit-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
};
/** A fake machine: `cpu` maps pid to cores now. */
const machine = ({ load = 4.8, freeRatio = 0.6, swapUsedRatio = null, cpu = {} } = {}) => ({
  load,
  freeRatio,
  swapUsedRatio,
  cpu: pid => cpu[pid] ?? null,
});
// The friction: a one-core model check 50 min in, two test runs, on 10 cores with 3 base slots.
const tla = { pid: 101, elapsedMs: 50 * MIN, declared: 1 };
const testA = { pid: 102, elapsedMs: 2 * MIN, declared: null };
const testB = { pid: 103, elapsedMs: 1 * MIN, declared: null };
const measured = { 101: 1, 102: 2.5, 103: 3 };
const decide = (holders, sample, next = 3) =>
  admitHeavy({ base: 3, cores: 10, share: 3, next, holders, sample: () => sample });

test('ff33e9a6: a long one-core holder plus two test runs admits a fourth command while load is low', () => {
  const low = decide([tla, testA, testB], machine({ load: 4.8, cpu: measured }));
  assert.deepEqual(low, { admit: true, burst: true, reason: null });
  // The one just admitted counts its full share until measured: a fifth does not fit.
  const fifth = decide(
    [tla, testA, testB, { pid: 104, elapsedMs: 1000, declared: null }],
    machine({ load: 4.8, cpu: { ...measured, 104: 0.2 } }),
  );
  assert.equal(fifth.admit, false);
  assert.match(fifth.reason, /would need 12\.5 of 10/);
});

test('ff33e9a6: none extra at the load ceiling; the memory freeze guard holds even a free base slot', () => {
  const ceiling = decide([tla, testA, testB], machine({ load: 10, cpu: measured }));
  assert.equal(ceiling.admit, false);
  assert.match(ceiling.reason, /^load 10, holders use 6\.5 cores; 3 more would need 13 of 10$/);
  // Measured CPU, not only load: a busy tree with load still catching up is counted.
  assert.equal(
    decide([tla, testA, testB], machine({ load: 2, cpu: { 101: 1, 102: 2.5, 103: 3.5 } })).admit,
    true,
  );
  assert.equal(
    decide([tla, testA, testB], machine({ load: 2, cpu: { 101: 2, 102: 3, 103: 3.5 } })).admit,
    false,
  );
  // Load alone never holds a base slot (a shared CI runner sits past 2 x cores through a suite).
  assert.equal(decide([testA], machine({ load: 40 })).admit, true, 'base slots as before');
  assert.equal(decide([tla, testA, testB], machine({ load: 40, cpu: measured })).admit, false);
  // Freeze guard: one holder, base slots free, but memory nearly gone.
  const noMemory = decide([testA], machine({ freeRatio: 0.08 }));
  assert.equal(noMemory.admit, false);
  assert.match(noMemory.reason, /free memory 8% is under 10%/);
  assert.equal(decide([testA], machine({ freeRatio: 0.11 })).admit, true);
});

test('ff33e9a6: an extra slot needs a quarter of memory free and swap under half used; the burst limit holds', () => {
  const low = machine({ load: 1, cpu: measured });
  assert.match(
    decide([tla, testA, testB], { ...low, freeRatio: 0.2 }).reason,
    /free memory 20% is under 25% for an extra slot/,
  );
  assert.match(decide([tla, testA, testB], { ...low, swapUsedRatio: 0.6 }).reason, /swap 60% used/);
  assert.equal(heavyBurstLimit(3, 10), 6);
  assert.equal(heavyBurstLimit(3, 4), 4, 'never more holders than cores');
  assert.equal(heavyBurstLimit(1, 1), 1);
  const six = Array.from({ length: 6 }, (_, index) => ({
    pid: 200 + index,
    elapsedMs: 5 * MIN,
    declared: 1,
  }));
  assert.match(decide(six, machine({ load: 0.5 }), 1).reason, /6 commands hold slots \(most at once: 6\)/);
});

test('ff33e9a6: a young or unmeasured holder counts its share; a settled one what it uses, at least a core', () => {
  const young = { pid: 105, elapsedMs: 5000, declared: null };
  const cpu = { ...measured, 105: 0.4 };
  // Young test measured 0.4 counts its share 3: 1 + 2.5 + 3 + 4 = 10.5, so a 4-core newcomer waits.
  assert.equal(decide([tla, testA, young], machine({ load: 1, cpu }), 4).admit, false);
  // The same holder settled counts what it uses, at least 1 core: 1 + 2.5 + 1 + 4 = 8.5.
  assert.equal(
    decide([tla, testA, { ...young, elapsedMs: 5 * MIN }], machine({ load: 1, cpu }), 4).admit,
    true,
  );
  // Unmeasured holders (a failed ps) count their share: 3 + 3 + 3 + 2 = 11.
  const settled = [testA, testB, { pid: 106, elapsedMs: 5 * MIN, declared: null }];
  assert.equal(decide(settled, machine({ load: 1, cpu: {} }), 2).admit, false);
  assert.equal(decide(settled, machine({ load: 1, cpu: { 102: 1, 103: 1, 106: 1 } }), 2).admit, true);
});

test('ff33e9a6: with no holder nothing is read; one sample serves a burst of attempts', () => {
  const never = () => assert.fail('an idle machine reads nothing');
  assert.deepEqual(admitHeavy({ base: 3, cores: 10, share: 3, next: 3, holders: [], sample: never }), {
    admit: true,
    burst: false,
    reason: null,
  });
  let reads = 0,
    clock = 0;
  const sample = cachedSample(
    () => (reads++, machine()),
    2000,
    () => clock,
  );
  const policy = heavyAdmission({ cores: 10, sample });
  for (let attempt = 0; attempt < 5; attempt++) policy.decide(3, [testA]);
  assert.equal(reads, 1, 'five attempts inside 2 s: one read');
  clock = 2000;
  policy.decide(3, [testA]);
  assert.equal(reads, 2);
});

// Live holders for slot fixtures: processes this test starts and stops.
function sleepers(t, count) {
  const live = ['-e', 'setInterval(()=>{},1000)']; // test-signal: allow a live holder process for the fixture slots, not a test wait
  const children = Array.from({ length: count }, () => spawn(process.execPath, live, { stdio: 'ignore' }));
  t.after(() => children.forEach(child => child.kill('SIGKILL')));
  return children.map(child => child.pid);
}
function holdSlots(directory, pids, records) {
  pids.forEach((pid, index) => {
    const slot = tryHeavySlot(directory, pids.length, pid);
    assert.equal(slot, join(directory, String(index + 1)));
    // Unbounded (maxMs 0): the fixture instant is far from the real clock the overdue check reads.
    writeFileSync(join(slot, 'holder.json'), JSON.stringify({ maxMs: 0, ...records[index] }));
  });
}

test('ff33e9a6: slot files: a fourth command takes slot 4 at low load, none at the ceiling', t => {
  const directory = isolated(t);
  const [modelCheck, first, second] = sleepers(t, 3);
  const now = NOW;
  holdSlots(
    directory,
    [modelCheck, first, second],
    [
      { startedAt: now - 50 * MIN, command: 'java', cores: 1 },
      { startedAt: now - 2 * MIN, command: 'node' },
      { startedAt: now - 1 * MIN, command: 'node' },
    ],
  );
  const cpu = { [modelCheck]: 1, [first]: 2.5, [second]: 3 };
  const ceiling = heavyAdmission({ cores: 10, sample: () => machine({ load: 10, cpu }) });
  assert.deepEqual(tryHeavyAdmission(directory, 3, ceiling, process.pid, true, NOW).slot, null);
  assert.match(
    tryHeavyAdmission(directory, 3, ceiling, process.pid, true, NOW).reason,
    /would need 13 of 10/,
  );
  assert(!existsSync(join(directory, '4')));
  const low = heavyAdmission({ cores: 10, sample: () => machine({ load: 4.8, cpu }) });
  assert.deepEqual(tryHeavyAdmission(directory, 3, low, process.pid, true, NOW), {
    slot: join(directory, '4'),
    reason: null,
  });
});

test('ff33e9a6: measured callers decide and claim one at a time: a held admission lock claims nothing', t => {
  const directory = isolated(t);
  const [modelCheck, first, second, other] = sleepers(t, 4);
  holdSlots(
    directory,
    [modelCheck, first, second],
    [{ startedAt: NOW - 50 * MIN, cores: 1 }, { startedAt: NOW - 2 * MIN }, { startedAt: NOW - 1 * MIN }],
  );
  let decisions = 0;
  const real = heavyAdmission({
    cores: 10,
    sample: () => machine({ load: 4.8, cpu: { [modelCheck]: 1, [first]: 2.5, [second]: 3 } }),
  });
  const counted = { limit: real.limit, decide: (base, holders) => (decisions++, real.decide(base, holders)) };
  // Another live caller is between its decision and its claim.
  const lock = join(directory, 'admit.lock');
  mkdirSync(lock);
  writeFileSync(join(lock, 'pid'), String(other));
  assert.deepEqual(tryHeavyAdmission(directory, 3, counted, process.pid, true, NOW), {
    slot: null,
    reason: null,
  });
  assert.equal(decisions, 0, 'no decision while another caller holds the lock');
  rmSync(lock, { recursive: true });
  assert.equal(tryHeavyAdmission(directory, 3, counted, process.pid, true, NOW).slot, join(directory, '4'));
  // The next caller sees the new holder at its full share: 1 + 2.5 + 3 + 3 + 3 > 10.
  assert.match(
    tryHeavyAdmission(directory, 3, counted, process.pid, true, NOW).reason,
    /would need 12\.5 of 10/,
  );
  assert(!existsSync(join(directory, '5')));
  assert(!existsSync(lock), 'the lock is removed after each attempt');
});

test('ff33e9a6: a queued caller held at the ceiling starts once load drops, and says why it waits', async t => {
  const directory = isolated(t);
  const pids = sleepers(t, 3);
  const now = NOW;
  holdSlots(
    directory,
    pids,
    pids.map(() => ({ startedAt: now - 5 * MIN })),
  );
  const state = { load: 10 };
  const cpu = Object.fromEntries(pids.map(pid => [pid, 1]));
  const waits = [];
  let reads = 0,
    thirdRead;
  const held = new Promise(done => (thirdRead = done));
  const admission = heavyAdmission({
    cores: 10,
    sample: () => {
      if (++reads === 3) thirdRead();
      return machine({ load: state.load, cpu });
    },
  });
  const acquired = acquireHeavySlot(directory, 3, wait => waits.push(wait), { admission, tickMs: 20 });
  // Three decisions at the ceiling, each one reading the machine once.
  await held;
  assert.equal(existsSync(join(directory, '4')), false, 'none at the ceiling');
  assert.match(waits[0]?.reason ?? '', /^load 10, holders use 3 cores; 3 more would need 13 of 10$/);
  state.load = 4;
  assert.equal(await acquired, join(directory, '4'));
});

function heavy(t, directory, settings, args, extra = {}) {
  writeFileSync(join(directory, 'settings.json'), JSON.stringify(settings));
  const child = spawn(process.execPath, [cli, 'heavy', ...args], {
    env: {
      ...process.env,
      ...extra,
      FORGE_HEAVY_DIR: directory,
      FORGE_CLIENT_SETTINGS: join(directory, 'settings.json'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(() => child.kill('SIGKILL'));
  const run = { stdout: '', stderr: '' };
  child.stdout.on('data', data => (run.stdout += data));
  child.stderr.on('data', data => (run.stderr += data));
  run.exited = new Promise(done => child.once('exit', done));
  return run;
}

test(
  'ff33e9a6: a declared long one-core command gets its own bound and cap; a long bound without --cores is refused',
  { skip: availableParallelism() < 2 && 'needs a slot share above one core' },
  async t => {
    const directory = isolated(t);
    const refused = heavy(t, directory, { localHeavySlots: 3, localHeavyMaxMinutes: 60 }, [
      '--max-minutes',
      '120',
      '--',
      process.execPath,
      '-e',
      "process.stdout.write('ran')",
    ]);
    assert.notEqual(await refused.exited, 0);
    assert.match(
      refused.stderr,
      /--max-minutes 120 is past localHeavyMaxMinutes \(60\); that needs --cores below the slot share/,
    );
    assert.equal(refused.stdout, '', 'the command never started');
    const show =
      "const fs=require('fs');process.stdout.write(JSON.stringify({holder:JSON.parse(fs.readFileSync(process.env.FORGE_HEAVY_DIR+'/1/holder.json','utf8')),cap:process.env.FORGE_HEAVY_TEST_CONCURRENCY,go:process.env.GOMAXPROCS}))";
    // One base slot: the share is every core (at least 2), so --cores 1 is below it on any machine.
    // An inherited, larger GOMAXPROCS is lowered to the declared cores.
    const run = heavy(
      t,
      directory,
      { localHeavySlots: 1, localHeavyMaxMinutes: 60 },
      ['--cores', '1', '--max-minutes=120', process.execPath, '-e', show],
      { GOMAXPROCS: '8', FORGE_HEAVY_TEST_CONCURRENCY: '' },
    );
    assert.equal(await run.exited, 0, run.stderr);
    const seen = JSON.parse(run.stdout);
    assert.equal(seen.holder.cores, 1);
    assert.equal(seen.holder.maxMs, 120 * MIN);
    assert.equal(seen.cap, '1');
    assert.equal(seen.go, '1');
    const hold = readFileSync(join(directory, 'holds.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map(line => JSON.parse(line))
      .at(-1);
    assert.equal(typeof hold.wait, 'number', 'the hold records its queue wait');
  },
);

test(
  'ff33e9a6: when the command exits, every child it started stops too',
  { skip: process.platform === 'win32' },
  async t => {
    const directory = isolated(t);
    // The command starts a long child in its own group (as npm starts tsc) and exits at once.
    const orphanMaker =
      "const c=require('child_process').spawn('sleep',['60'],{stdio:'ignore'});c.unref();process.stdout.write(String(c.pid))";
    const run = heavy(t, directory, { localHeavySlots: 1 }, [process.execPath, '-e', orphanMaker]);
    assert.equal(await run.exited, 0, run.stderr);
    const orphan = Number(run.stdout);
    assert(orphan > 0);
    t.after(() => {
      try {
        process.kill(orphan, 'SIGKILL');
      } catch {}
    });
    assert.throws(
      () => process.kill(orphan, 0),
      { code: 'ESRCH' },
      'the child the command left running was stopped',
    );
  },
);

test('ff33e9a6: --status reports queue wait p50/p90 from the holds that recorded one', () => {
  const now = NOW;
  const holds = [1000, 2000, 3000, 4000, 60_000].map((wait, index) => ({
    at: now - 1000 * (index + 1),
    ms: 500,
    lane: null,
    kind: 'test',
    cpu: null,
    load: null,
    wait,
  }));
  holds.push({ at: now - 100, ms: 10, lane: null, kind: 'build', cpu: null, load: null });
  assert.deepEqual(holdSummary(holds, now).wait, { holds: 5, p50Seconds: 3, p90Seconds: 60 });
  assert.equal(holdSummary([], now).wait, null);
});
