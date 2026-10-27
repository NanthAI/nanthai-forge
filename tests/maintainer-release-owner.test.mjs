// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  realpathSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { selectReleaseOwner } from '../dist/maintainer-release-owner.js';
import { releaseProcessRow, oldReleaseWorker } from '../dist/release-owner-processes.js';
import { parseOwnerService } from '../dist/release-owner-supervisor.js';
import { releaseSave } from '../dist/maintainer-release-files.js';
import { releaseChild } from '../dist/maintainer-release-child.js';
import { randomUUID } from 'node:crypto';

function fixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'forge-owner-release-')));
  t.after(() => rmSync(root, { force: true, recursive: true }));
  const file = path => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, 'previous entry point');
    return path;
  };
  const owner = join(root, 'owner');
  mkdirSync(owner);
  const runtimeDirectory = join(root, 'runtime with spaces');
  const directory = join(runtimeDirectory, 'releases', 'release');
  const installed = join(directory, 'install-new');
  const cli = file(join(installed, 'node_modules/@nanthai/forge/dist/cli.js'));
  const service = {
    id: 'fake-supervisor',
    cli: file(join(runtimeDirectory, 'installed-owner/node_modules/@nanthai/forge/dist/cli.js')),
  };
  const journal = { owner, directory, request: { runtimeDirectory } };
  let runtime = {
    pid: 101,
    startTime: 'original-start',
    executablePath: service.cli,
    owner,
    port: 1234,
    token: 'synthetic-private-token',
  };
  let pid = 101;
  let restarts = 0;
  const starts = new Map([
    [101, 'original-start'],
    [202, 'replacement-start'],
  ]);
  let now = 0;
  const signals = [];
  let workers = [];
  const deps = {
    supervisor: {
      discover: async () => service,
      pid: async () => pid,
      restart: async () => {
        restarts++;
        pid = 202;
        runtime = { ...runtime, pid, startTime: starts.get(pid), executablePath: cli };
      },
    },
    runtime: () => runtime,
    answers: async () => true,
    startTime: value => starts.get(value),
    processes: () => workers,
    signal: (worker, signal) => {
      signals.push([worker.pid, signal]);
      workers = workers.filter(current => current.pid !== worker.pid);
      return true;
    },
    sleep: async ms => {
      now += ms;
    },
    now: () => now,
    waitMs: 200,
  };
  const run = () => selectReleaseOwner(journal, installed, cli, deps);
  return {
    root,
    file,
    owner,
    directory,
    installed,
    cli,
    service,
    journal,
    deps,
    run,
    signals,
    starts,
    restarts: () => restarts,
    runtime: () => runtime,
    setRuntime: value => {
      runtime = value;
      pid = value.pid;
    },
    setWorkers: value => {
      workers = value;
    },
    workers: () => workers,
    worker: (name, pid = 303) => ({
      pid,
      startTime: `start-${pid}`,
      executablePath: file(
        join(runtimeDirectory, 'releases/older/install-old/node_modules/@nanthai/forge/dist', name),
      ),
    }),
  };
}

test('release selects a new runtime atomically, verifies the supervised responder, retains rollback and repeats without restarting', async t => {
  const f = fixture(t);
  const result = await f.run();
  assert.equal(readlinkSync(f.service.cli), f.cli);
  assert.equal(readFileSync(result.previousOwnerCli, 'utf8'), 'previous entry point');
  assert.equal(f.restarts(), 1);
  assert.equal(JSON.parse(result.process).pid, 202);
  assert.equal(JSON.stringify(result).includes('synthetic-private-token'), false);
  await f.run();
  assert.equal(f.restarts(), 1);
});

test('already selected and answering owner needs no supervisor restart', async t => {
  const f = fixture(t);
  rmSync(f.service.cli);
  symlinkSync(f.cli, f.service.cli);
  f.setRuntime({ ...f.runtime(), executablePath: f.cli });
  assert.match((await f.run()).note, /already runs/);
  assert.equal(f.restarts(), 0);
});

test('no supervised owner skips cleanly without process enumeration, selection or signals', async t => {
  const f = fixture(t);
  f.deps.supervisor.discover = async () => undefined;
  f.deps.processes = () => assert.fail('no process enumeration');
  const result = await f.run();
  assert.equal(result.owner, 'skipped');
  assert.match(result.note, /no supervised owner/);
  assert.equal(readFileSync(f.service.cli, 'utf8'), 'previous entry point');
  assert.equal(f.restarts(), 0);
});

test('old-runtime workers retire with TERM, with KILL only for survivors; MCP, current install and outside paths survive', async t => {
  const f = fixture(t);
  const ordinary = f.worker('local-watcher-worker.js', 303),
    stubborn = f.worker('post-accept-main.js', 304);
  const presence = f.worker('presence-worker.js', 305),
    exchange = f.worker('auto-exchange.js', 306);
  const mcp = f.worker('cli.js', 307);
  const current = {
    ...f.worker('presence-worker.js', 308),
    executablePath: f.file(join(f.installed, 'node_modules/@nanthai/forge/dist/presence-worker.js')),
  };
  const outside = {
    ...f.worker('auto-exchange.js', 309),
    executablePath: f.file(join(f.root, 'foreign/dist/auto-exchange.js')),
  };
  f.setWorkers([ordinary, stubborn, presence, exchange, mcp, current, outside]);
  const signal = f.deps.signal;
  f.deps.signal = (worker, value) => {
    if (worker.pid === stubborn.pid && value === 'SIGTERM') {
      f.signals.push([worker.pid, value]);
      return true;
    }
    return signal(worker, value);
  };
  const result = await f.run();
  assert.deepEqual(f.signals, [
    [303, 'SIGTERM'],
    [304, 'SIGTERM'],
    [304, 'SIGKILL'],
    [305, 'SIGTERM'],
    [306, 'SIGTERM'],
  ]);
  assert.deepEqual(f.workers(), [mcp, current, outside]);
  const retired = JSON.parse(result.retiredWorkers);
  assert.equal(retired.length, 4);
  assert.ok(retired.every(item => item.gone));
  assert.deepEqual(retired[1].signals, ['SIGTERM', 'SIGKILL']);
});

test('PID reuse during TERM grace never signals its replacement', async t => {
  const f = fixture(t),
    worker = f.worker('presence-worker.js');
  f.setWorkers([worker]);
  f.deps.signal = (target, signal) => {
    f.signals.push([target.pid, signal]);
    f.setWorkers([
      {
        ...target,
        startTime: 'reused-pid',
        executablePath: f.file(join(f.root, 'unrelated/dist/presence-worker.js')),
      },
    ]);
    return true;
  };
  await f.run();
  assert.deepEqual(f.signals, [[worker.pid, 'SIGTERM']]);
});

for (const crash of ['before-restart', 'after-restart', 'during-retirement'])
  test(`resume after crash ${crash} reconciles the selection without a double restart`, async t => {
    const f = fixture(t),
      restart = f.deps.supervisor.restart,
      signal = f.deps.signal;
    if (crash === 'during-retirement') {
      f.setWorkers([f.worker('presence-worker.js')]);
      f.deps.signal = () => {
        throw new Error('synthetic crash');
      };
    } else
      f.deps.supervisor.restart = async service => {
        if (crash === 'after-restart') await restart(service);
        throw new Error('synthetic crash');
      };
    await assert.rejects(f.run(), /synthetic crash/);
    assert.equal(readlinkSync(f.service.cli), f.cli);
    f.deps.supervisor.restart = restart;
    f.deps.signal = signal;
    await f.run();
    assert.equal(f.restarts(), 1);
    assert.equal(f.workers().length, 0);
  });

test('new owner that does not answer fails verification and is preserved on resume', async t => {
  const f = fixture(t);
  f.deps.answers = async () => false;
  await assert.rejects(f.run(), { code: 'RELEASE_OWNER_UNVERIFIED' });
  await assert.rejects(f.run(), { code: 'RELEASE_OWNER_UNVERIFIED' });
  assert.equal(f.restarts(), 1);
  f.deps.answers = async () => true;
  await f.run();
  assert.equal(f.restarts(), 1);
});

test('crash before selection retains rollback bytes and preserves an intervening selection', async t => {
  const f = fixture(t);
  const original = f.deps.supervisor.restart;
  f.deps.supervisor.restart = async () => {
    throw new Error('synthetic crash');
  };
  await assert.rejects(f.run());
  rmSync(f.service.cli);
  writeFileSync(f.service.cli, 'intervening selection');
  f.deps.supervisor.restart = original;
  await assert.rejects(f.run(), { code: 'OWNER_SELECTION_CHANGED' });
  assert.equal(readFileSync(f.service.cli, 'utf8'), 'intervening selection');
});

test('path aliases cannot retire the current install or escape the runtime directory', t => {
  const f = fixture(t);
  const current = f.file(join(f.installed, 'dist/presence-worker.js'));
  const alias = join(f.journal.request.runtimeDirectory, 'current-alias');
  symlinkSync(f.installed, alias);
  assert.equal(
    oldReleaseWorker(f.journal.request.runtimeDirectory, f.installed, {
      pid: 3,
      startTime: 'now',
      executablePath: join(alias, 'dist/presence-worker.js'),
    }),
    false,
  );
  assert.equal(
    oldReleaseWorker(f.journal.request.runtimeDirectory, f.installed, {
      pid: 3,
      startTime: 'now',
      executablePath: current,
    }),
    false,
  );
});

test('supervisor and process parsers expose only pinned service and process identities', t => {
  const f = fixture(t);
  const output = `service = {\n arguments = {\n /usr/local/bin/node\n ${f.service.cli}\n serve\n ${f.owner}\n --port\n 4173\n }\n environment = {\n SECRET = never-return-this\n }\n}`;
  assert.equal(parseOwnerService(output, f.owner, f.journal.request.runtimeDirectory), f.service.cli);
  assert.equal(parseOwnerService(output, f.root, f.journal.request.runtimeDirectory), undefined);
  const row = `303 Mon Oct 26 20:01:02 2026 /usr/local/bin/node ${f.service.cli} mcp ${f.owner} --token never-return-this`;
  assert.deepEqual(releaseProcessRow(row), {
    pid: 303,
    startTime: 'Mon Oct 26 20:01:02 2026',
    executablePath: f.service.cli,
  });
  assert.equal(releaseProcessRow(row.replace('/usr/local/bin/node', '/usr/bin/other')), undefined);
  assert.equal(
    releaseProcessRow(`303 Mon Oct 26 20:01:02 2026 /usr/local/bin/node /foreign/cli.js ${f.service.cli}`),
    undefined,
  );
});

test('owner-stage durable terminal receipt is replayed without running another child', t => {
  // A prewritten terminal receipt remains the authoritative result even for the resumable owner stage.
  const f = fixture(t),
    id = randomUUID(),
    directory = join(f.directory, 'owner-attempt');
  mkdirSync(directory);
  const receipt = {
    attemptId: id,
    status: 'succeeded',
    exitCode: 0,
    signal: null,
    result: { owner: 'selected' },
  };
  const journal = { stages: [{ name: 'owner', attempts: [{ id, directory }] }] };
  releaseSave(join(directory, 'receipt.json'), receipt);
  assert.deepEqual(releaseChild(journal, 'owner', directory), receipt);
});

test('retirement rescans workers spawned by an old process during TERM shutdown', async t => {
  const f = fixture(t),
    first = f.worker('presence-worker.js', 303),
    late = f.worker('auto-exchange.js', 304);
  f.setWorkers([first]);
  const signal = f.deps.signal;
  f.deps.signal = (target, value) => {
    const result = signal(target, value);
    if (target.pid === first.pid) f.setWorkers([late]);
    return result;
  };
  await f.run();
  assert.deepEqual(f.signals, [
    [303, 'SIGTERM'],
    [304, 'SIGTERM'],
  ]);
  assert.equal(f.workers().length, 0);
});

test('dead owner child resumes the retained attempt; another call replays its receipt', async t => {
  const cp = await import('node:child_process');
  const { syncBuiltinESMExports } = await import('node:module');
  const f = fixture(t),
    id = randomUUID(),
    directory = join(f.directory, 'dead-owner-attempt');
  mkdirSync(directory);
  const journal = { node: process.execPath, stages: [{ name: 'owner', attempts: [{ id, directory }] }] };
  releaseSave(join(directory, 'input.json'), {});
  releaseSave(join(directory, 'process.json'), { pid: 900001, startTime: 'dead' });
  t.mock.method(process, 'kill', pid => {
    assert.equal(pid, 900001);
    throw Object.assign(new Error('Synthetic absent process'), { code: 'ESRCH' });
  });
  let launches = 0;
  const receipt = {
    attemptId: id,
    status: 'succeeded',
    exitCode: 0,
    signal: null,
    result: { owner: 'selected' },
  };
  t.mock.method(cp.default, 'spawnSync', () => {
    launches++;
    releaseSave(join(directory, 'receipt.json'), receipt);
    return { status: 0, signal: null };
  });
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
  assert.deepEqual(releaseChild(journal, 'owner', directory), receipt);
  assert.deepEqual(releaseChild(journal, 'owner', directory), receipt);
  assert.equal(launches, 1);
});

test('all other detached Forge script entry points retire; build copies within runtime stay untouched', async t => {
  const f = fixture(t);
  const names = [
    'agent-advisory-worker.js',
    'check-controller-worker.js',
    'github-auto-push.js',
    'integration-preview-worker.js',
    'self-metrics-weekly-worker.js',
  ];
  const workers = names.map((name, offset) => f.worker(name, 400 + offset));
  const build = {
    pid: 500,
    startTime: 'build',
    executablePath: f.file(
      join(f.journal.request.runtimeDirectory, 'releases/build/source/dist/presence-worker.js'),
    ),
  };
  f.setWorkers([...workers, build]);
  await f.run();
  assert.deepEqual(f.workers(), [build]);
  assert.deepEqual(
    f.signals,
    workers.map(worker => [worker.pid, 'SIGTERM']),
  );
});

test('verification deadline includes time spent on a slow probe', async t => {
  const f = fixture(t);
  let now = 0,
    probes = 0;
  f.deps.now = () => now;
  f.deps.sleep = async ms => {
    now += ms;
  };
  f.deps.answers = async () => {
    probes++;
    now += 1000;
    return false;
  };
  await assert.rejects(f.run(), { code: 'RELEASE_OWNER_UNVERIFIED' });
  assert.equal(probes, 1);
  assert.equal(f.restarts(), 1);
});
