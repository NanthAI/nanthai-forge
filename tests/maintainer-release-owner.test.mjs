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
  lstatSync,
  renameSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { selectReleaseOwner } from '../dist/maintainer-release-owner.js';
import { releaseProcessRow, oldReleaseWorker } from '../dist/release-owner-processes.js';
import { parseOwnerService } from '../dist/release-owner-supervisor.js';
import { releaseSave } from '../dist/maintainer-release-files.js';
import { releaseChild } from '../dist/maintainer-release-child.js';
import { selectOwnerInstall } from '../dist/release-owner-selection.js';
import { pinWorkerInstall } from '../dist/worker-install.js';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
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
  writeFileSync(file(join(dirname(cli), 'local-watcher-worker.js')), 'new worker');
  const service = {
    id: 'fake-supervisor',
    cli: file(join(runtimeDirectory, 'installed-owner/node_modules/@nanthai/forge/dist/cli.js')),
  };
  const selection = join(runtimeDirectory, 'installed-owner');
  const oldWorker = file(join(selection, 'node_modules/@nanthai/forge/dist/local-watcher-worker.js'));
  writeFileSync(oldWorker, 'old worker');
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
    selection,
    oldWorker,
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
  assert.equal(readlinkSync(f.selection), f.installed);
  assert.equal(realpathSync(f.service.cli), f.cli);
  assert.equal(readFileSync(f.oldWorker, 'utf8'), 'new worker');
  assert.equal(readFileSync(result.previousOwnerCli, 'utf8'), 'previous entry point');
  assert.equal(f.restarts(), 1);
  assert.equal(JSON.parse(result.process).pid, 202);
  assert.equal(JSON.stringify(result).includes('synthetic-private-token'), false);
  await f.run();
  assert.equal(f.restarts(), 1);
});

test('already selected and answering owner needs no supervisor restart', async t => {
  const f = fixture(t);
  rmSync(f.selection, { recursive: true });
  symlinkSync(f.installed, f.selection);
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
    assert.equal(readlinkSync(f.selection), f.installed);
    assert.equal(realpathSync(f.service.cli), f.cli);
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
  rmSync(f.selection);
  mkdirSync(f.selection);
  f.file(f.service.cli);
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

test('observer entry points retire; in-flight check controllers and build copies stay untouched', async t => {
  const f = fixture(t);
  const names = [
    'agent-advisory-worker.js',
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
  const check = f.worker('check-controller-worker.js', 600);
  f.setWorkers([...workers, build, check]);
  await f.run();
  assert.deepEqual(f.workers(), [build, check]);
  assert.deepEqual(
    f.signals,
    workers.map(worker => [worker.pid, 'SIGTERM']),
  );
});

test('resuming an older retirement plan preserves its live check controller', async t => {
  const f = fixture(t);
  await f.run();
  const path = join(f.directory, 'owner-selection.json');
  const state = JSON.parse(readFileSync(path, 'utf8'));
  const check = f.worker('check-controller-worker.js', 601);
  state.retired.push({ ...check, signals: [], gone: false });
  releaseSave(path, state);
  const observer = f.worker('presence-worker.js', 602);
  f.setWorkers([check, observer]);
  await f.run();
  assert.deepEqual(f.workers(), [check]);
  assert.deepEqual(f.signals, [[602, 'SIGTERM']]);
  const retained = JSON.parse(readFileSync(path, 'utf8')).retired.find(worker => worker.pid === check.pid);
  assert.equal(retained.gone, false);
  assert.deepEqual(retained.signals, []);
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

test('legacy directory migration keeps the whole previous install and provides executable rollback', async t => {
  const f = fixture(t);
  const result = await f.run();
  assert.ok(lstatSync(result.selectionPath).isSymbolicLink());
  assert.equal(result.installedDirectory, f.installed);
  assert.equal(
    readFileSync(
      join(result.previousInstall, 'node_modules/@nanthai/forge/dist/local-watcher-worker.js'),
      'utf8',
    ),
    'old worker',
  );
  // Execute only the local filesystem part, never launchctl.
  execFileSync('/bin/sh', ['-c', result.rollbackCommand.split(' && launchctl')[0]]);
  assert.equal(realpathSync(f.selection), result.previousInstall);
  assert.equal(readFileSync(f.oldWorker, 'utf8'), 'old worker');
  assert.ok(lstatSync(f.installed).isDirectory());
});

test('existing install symlink swaps as a whole and retains its previous target', async t => {
  const f = fixture(t);
  const previous = join(f.root, 'runtime with spaces', 'installed-owner.previous');
  renameSync(f.selection, previous);
  symlinkSync(previous, f.selection);
  const result = await f.run();
  assert.equal(result.previousInstall, previous);
  assert.equal(realpathSync(f.service.cli), f.cli);
  assert.equal(
    readFileSync(join(previous, 'node_modules/@nanthai/forge/dist/local-watcher-worker.js'), 'utf8'),
    'old worker',
  );
});

test('migration resumes after a crash between retaining the directory and publishing the symlink', t => {
  const f = fixture(t);
  const result = selectOwnerInstall(f.directory, f.service.cli, f.installed);
  rmSync(f.selection);
  assert.equal(
    selectOwnerInstall(f.directory, f.service.cli, f.installed).previousInstall,
    result.previousInstall,
  );
  assert.equal(realpathSync(f.selection), f.installed);
});

test('a responsive owner from the previous install fails verification with an exact rollback command', async t => {
  const f = fixture(t);
  f.deps.supervisor.restart = async () =>
    f.setRuntime({ ...f.runtime(), pid: 202, startTime: 'replacement-start' });
  await assert.rejects(
    f.run(),
    error => error.code === 'RELEASE_OWNER_UNVERIFIED' && /Rollback:.*kickstart/.test(error.message),
  );
  assert.ok(lstatSync(f.selection).isSymbolicLink());
});

test('worker resolver rejects other installs and a legacy parent rebound to a newer install', t => {
  const f = fixture(t);
  const resolveWorker = pinWorkerInstall(pathToFileURL(f.service.cli).href);
  assert.equal(resolveWorker(pathToFileURL(f.oldWorker)), f.oldWorker);
  const newWorker = f.file(join(dirname(f.cli), 'local-watcher-worker.js'));
  assert.throws(() => resolveWorker(pathToFileURL(newWorker)), { code: 'WORKER_INSTALL_MISMATCH' });
  selectOwnerInstall(f.directory, f.service.cli, f.installed);
  assert.throws(() => resolveWorker(pathToFileURL(f.oldWorker)), { code: 'WORKER_INSTALL_MISMATCH' });
  const newResolver = pinWorkerInstall(pathToFileURL(f.cli).href);
  assert.equal(newResolver(pathToFileURL(newWorker)), newWorker);
});

test('a direct service path already inside the selected install is preserved without a self-referential link', t => {
  const f = fixture(t);
  const result = selectOwnerInstall(f.directory, f.cli, f.installed);
  assert.equal(result.previousInstall, f.installed);
  assert.ok(lstatSync(f.installed).isDirectory());
  assert.equal(realpathSync(f.cli), f.cli);
  assert.equal(result.rollbackCommand, ':');
});

test('launchd configured entry point loads both owner and worker modules from the selected package', async t => {
  const f = fixture(t);
  for (const [cli, version] of [
    [f.service.cli, 'old'],
    [f.cli, 'new'],
  ]) {
    writeFileSync(join(dirname(cli), 'package.json'), JSON.stringify({ type: 'module' }));
    writeFileSync(
      join(dirname(cli), 'local-watcher-worker.js'),
      `export const version = '${version}'; export const workerUrl = import.meta.url;`,
    );
    writeFileSync(
      cli,
      `import {version, workerUrl} from './local-watcher-worker.js'; console.log(JSON.stringify({ version, workerUrl, ownerUrl: import.meta.url }));`,
    );
  }
  const before = JSON.parse(execFileSync(process.execPath, [f.service.cli], { encoding: 'utf8' }));
  assert.equal(before.version, 'old');
  await f.run();
  const after = JSON.parse(execFileSync(process.execPath, [f.service.cli], { encoding: 'utf8' }));
  assert.equal(after.version, 'new');
  assert.equal(after.ownerUrl, pathToFileURL(f.cli).href);
  assert.equal(after.workerUrl, pathToFileURL(join(dirname(f.cli), 'local-watcher-worker.js')).href);
});

test('legacy workers whose argv still uses installed-owner retire after that alias switches', async t => {
  const f = fixture(t);
  const worker = { pid: 303, startTime: 'legacy-worker', executablePath: f.oldWorker };
  f.setWorkers([worker]);
  await f.run();
  assert.deepEqual(f.signals, [[303, 'SIGTERM']]);
  assert.equal(f.workers().length, 0);
  assert.equal(readFileSync(f.oldWorker, 'utf8'), 'new worker');
});

test('custom standalone launchd CLI aliases retain their supported atomic selection and rollback', async t => {
  const f = fixture(t);
  const cli = f.file(join(f.root, 'runtime with spaces/custom-owner.js'));
  writeFileSync(cli, "console.log('old custom owner')");
  f.service.cli = cli;
  const result = await f.run();
  assert.equal(result.selectionPath, cli);
  assert.equal(realpathSync(cli), f.cli);
  execFileSync('/bin/sh', ['-c', result.rollbackCommand.split(' && launchctl')[0]]);
  assert.equal(execFileSync(process.execPath, [cli], { encoding: 'utf8' }).trim(), 'old custom owner');
});

test('release restart retains a checking remote landing and its replacement owner lands it', async t => {
  const { fixture: landingFixture } = await import('./landing-batch-fixture.mjs');
  const { batchEdit, selectBatch, composeBatch } = await import('../dist/landing-batch-store.js');
  const { claimLandingDriver } = await import('../dist/landing-driver.js');
  const { advanceLandingBatch } = await import('../dist/landing-batch-step.js');
  const { drainLandingBatches } = await import('../dist/landing-batch.js');
  const { AgentWorkflow } = await import('../dist/agent-workflow.js');
  const { remoteCancellation } = await import('../dist/work-run-cancellation.js');
  const release = fixture(t);
  const f = await landingFixture(t);
  const gate = join(f.store.directory, 'release-provider-ready');
  writeFileSync(
    join(f.store.directory, 'mock-modal.mjs'),
    `#!${process.execPath}
import fs from 'node:fs';
const plan = JSON.parse(fs.readFileSync(process.argv[3], 'utf8'));
console.log(JSON.stringify({kind:'execution', executionId:'synthetic-in-flight', image:'fixture'}));
const waiting = setInterval(() => {
  if (!fs.existsSync(${JSON.stringify(gate)})) return;
  clearInterval(waiting);
  console.log(JSON.stringify({kind:'result', pin:plan.pin, head:plan.head, definition:plan.definition, exitCode:0, estimatedCostUsd:0}));
}, 5);
`,
  );
  const input = await f.candidate('release-in-flight.txt');
  const batch = await batchEdit(f.work, 'release-select', data => selectBatch(f.work, data, 'main'));
  await composeBatch(f.work, batch);
  const driver = await claimLandingDriver(f.work, 'main');
  const checking = advanceLandingBatch(f.work, batch.id, driver);
  // Attach the rejection handler before replacing publication ownership.
  const oldOwner = checking.then(
    () => undefined,
    error => error,
  );
  let run;
  try {
    for (const deadline = performance.now() + 5000; performance.now() < deadline;) {
      run = f.store
        .load()
        .runs.find(
          item => item.status === 'running' && item.backend?.executionIds?.includes('synthetic-in-flight'),
        );
      if (run) break;
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    assert(run, 'synthetic remote provider is in flight before release');
    assert.equal(f.store.select('landingEntries', input.command.operationId).status, 'checking');
    const worker = release.worker('check-controller-worker.js', run.runner.pid);
    release.setWorkers([worker]);
    const signal = release.deps.signal;
    release.deps.signal = (target, value) => {
      remoteCancellation(f.store, run, { reason: 'signal', signal: value });
      return signal(target, value);
    };
    await release.run();
    await claimLandingDriver(new AgentWorkflow(f.root).work, 'main');
    assert.deepEqual(release.signals, []);
    assert.equal(f.store.select('runs', run.id).cancelRequested, undefined);
    assert.equal(f.store.select('landingEntries', input.command.operationId).status, 'checking');
  } finally {
    writeFileSync(gate, 'complete');
  }
  assert.equal((await oldOwner)?.code, 'LANDING_DRIVER_STALE');
  await drainLandingBatches(new AgentWorkflow(f.root).work, 'main');
  assert.equal(f.store.select('landingEntries', input.command.operationId).status, 'accepted');
  assert.equal(f.store.select('runs', run.id).status, 'passed');
  assert.equal(f.content('release-in-flight.txt'), 'release-in-flight.txt\n');
  t.diagnostic(JSON.stringify({ operatorMutationsToSettle: 0, droppedLandings: 0, cancelledChecks: 0 }));
});
