// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  rmSync,
  statSync,
  symlinkSync,
  readlinkSync,
  unlinkSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { initNative } from '../dist/native-work.js';
import { WorkStore } from '../dist/work-store.js';
import { NativeSource } from '../dist/native-source.js';
import { maintainerRelease, readMaintainerRelease, releaseDirectory } from '../dist/maintainer-release.js';
import { releaseStages } from '../dist/maintainer-release-schema.js';
import { releaseSave, releaseHash } from '../dist/maintainer-release-files.js';
import { releaseChild } from '../dist/maintainer-release-child.js';
import {
  executeReleaseStage,
  releaseCommand,
  ReleaseChildFailure,
} from '../dist/maintainer-release-stages.js';

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'forge-release-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const owner = join(dir, 'owner');
  mkdirSync(owner);
  writeFileSync(join(owner, 'a.ts'), 'export const a = 1;\n');
  const { head } = initNative(owner);
  const store = new WorkStore(owner);
  const accept = head =>
    store.locked(() => {
      const data = store.load();
      data.channelMoves.push({
        id: randomUUID(),
        channel: 'main',
        head,
        previous: data.channelMoves.at(-1)?.head ?? null,
        viewId: randomUUID(),
        status: 'accepted',
        at: new Date().toISOString(),
        provenance: 'user-declared-local',
      });
      data.revision++;
      store.save(data);
    });
  accept(head);
  const cli = join(dir, 'nforge');
  writeFileSync(cli, '#!/bin/sh\nexit 17\n', { mode: 0o751 });
  const request = {
    operationId: randomUUID(),
    runtimeDirectory: join(dir, 'runtime'),
    configurationDirectory: join(dir, 'config'),
    cliPath: cli,
    npmCli: join(dir, 'npm-cli.cjs'),
  };
  return { dir, store, head, cli, request, accept };
}
function receipt(journal, name, status = 'succeeded', result = {}) {
  const attempt = journal.stages.find(stage => stage.name === name).attempts.at(-1);
  return { attemptId: attempt.id, status, exitCode: status === 'succeeded' ? 0 : 23, signal: null, result };
}

for (const failed of releaseStages)
  test(`release stops at failed ${failed}, retains previous CLI, and resumes only remaining stages`, t => {
    const f = fixture(t),
      calls = [];
    const before = readFileSync(f.cli);
    let fail = true;
    const execute = (journal, name) => {
      calls.push({ name, head: journal.head, id: journal.stages.find(stage => stage.name === name).id });
      return receipt(journal, name, fail && name === failed ? 'failed' : 'succeeded');
    };
    const first = maintainerRelease(f.store, f.request, { execute });
    assert.equal(first.complete, false);
    assert.equal(first.stage, failed);
    assert.equal(first.status, 'failed');
    assert.deepEqual(
      calls.map(call => call.name),
      releaseStages.slice(0, releaseStages.indexOf(failed) + 1),
    );
    assert.deepEqual(readFileSync(f.cli), before);
    const journal = readMaintainerRelease(f.store, f.request.operationId);
    assert.deepEqual(
      readFileSync(join(releaseDirectory(f.store, f.request.operationId), 'previous-cli')),
      before,
    );
    assert.equal(journal.previousCli.mode, 0o751);
    const originalIds = journal.stages.map(stage => stage.id);
    const originalAttempt = journal.stages.find(stage => stage.name === failed).attempts[0].id;
    const source = new NativeSource(f.store.root);
    const next = source.writeState(
      source.state(f.head).files,
      [f.head],
      'Next accepted source',
      new Date().toISOString(),
    );
    f.accept(next);
    fail = false;
    calls.length = 0;
    const resumed = maintainerRelease(f.store, f.request.operationId, { execute });
    assert.equal(resumed.complete, true);
    assert.equal(resumed.head, f.head);
    assert.equal(resumed.landing, 'unchanged');
    assert.equal(resumed.hostedRecovery, 'unchanged');
    assert.deepEqual(
      calls.map(call => call.name),
      releaseStages.slice(releaseStages.indexOf(failed)),
    );
    const saved = readMaintainerRelease(f.store, f.request.operationId);
    assert.deepEqual(
      saved.stages.map(stage => stage.id),
      originalIds,
    );
    assert.notEqual(saved.stages.find(stage => stage.name === failed).attempts.at(-1).id, originalAttempt);
    calls.length = 0;
    assert.equal(maintainerRelease(f.store, f.request, { execute }).complete, true);
    assert.equal(calls.length, 0);
  });

test('unknown provider reply never deploys twice; exact observation resumes original source', t => {
  const f = fixture(t),
    calls = [];
  const execute = (journal, name) => {
    calls.push(name);
    return {
      ...receipt(journal, name, name === 'web' ? 'unknown' : 'succeeded'),
      code: 'RELEASE_OUTCOME_UNKNOWN',
    };
  };
  const first = maintainerRelease(f.store, f.request, { execute });
  const saved = readMaintainerRelease(f.store, f.request.operationId);
  const web = saved.stages.find(stage => stage.name === 'web').attempts.at(-1);
  // A driver retry observes the same attempt's receipt, rather than creating another deploy.
  const observe = journal => ({ ...receipt(journal, 'web', 'unknown'), code: 'RELEASE_OUTCOME_UNKNOWN' });
  assert.equal(maintainerRelease(f.store, f.request.operationId, { execute: observe }).status, 'unknown');
  assert.equal(calls.filter(name => name === 'web').length, 1);
  assert.throws(
    () =>
      maintainerRelease(f.store, f.request.operationId, {
        reconcile: {
          stage: 'web',
          attemptId: randomUUID(),
          outcome: 'succeeded',
          evidence: 'Synthetic provider receipt',
        },
        execute,
      }),
    /selected unknown/,
  );
  const result = maintainerRelease(f.store, f.request.operationId, {
    reconcile: {
      stage: 'web',
      attemptId: web.id,
      outcome: 'succeeded',
      evidence: 'Synthetic provider receipt for original source',
    },
    execute: (journal, name) =>
      name === 'web'
        ? { ...receipt(journal, name, 'unknown'), code: 'RELEASE_OUTCOME_UNKNOWN' }
        : receipt(journal, name),
  });
  assert.equal(result.complete, true);
  assert.equal(result.head, first.head);
});

test('request IDs reject changed paths and preserve existing runtime directories', t => {
  const f = fixture(t);
  maintainerRelease(f.store, f.request, { execute: (journal, name) => receipt(journal, name, 'failed') });
  assert.throws(
    () => maintainerRelease(f.store, { ...f.request, cliPath: join(f.dir, 'other') }),
    /original release request/,
  );
  const operationId = randomUUID(),
    existing = join(f.request.runtimeDirectory, 'releases', operationId);
  mkdirSync(existing, { recursive: true });
  writeFileSync(join(existing, 'keep'), 'preserved');
  assert.throws(
    () => maintainerRelease(f.store, { ...f.request, operationId }),
    /Existing release directories/,
  );
  assert.equal(readFileSync(join(existing, 'keep'), 'utf8'), 'preserved');
});

test('absence of accepted main does not release bootstrap source', t => {
  const f = fixture(t);
  f.store.locked(() => {
    const data = f.store.load();
    data.channelMoves = [];
    f.store.save(data);
  });
  assert.throws(() => maintainerRelease(f.store, f.request), /No accepted main/);
  assert.equal(existsSync(releaseDirectory(f.store, f.request.operationId)), false);
});

function prepareStage(t, selected) {
  const f = fixture(t);
  maintainerRelease(f.store, f.request, {
    execute: (journal, name) =>
      receipt(journal, name, name === selected ? 'failed' : 'succeeded', {
        path: f.dir,
        commit: 'a'.repeat(40),
        cli: join(f.dir, 'cli.js'),
      }),
  });
  return { ...f, journal: readMaintainerRelease(f.store, f.request.operationId) };
}

test('pinned export reuses exact native State; builder and providers use the matching materialization', async t => {
  const f = prepareStage(t, 'build'),
    calls = [];
  mkdirSync(f.request.configurationDirectory, { recursive: true });
  mkdirSync(join(f.request.configurationDirectory, '.netlify'));
  writeFileSync(
    join(f.request.configurationDirectory, '.env.local'),
    'VITE_CONVEX_URL=https://synthetic.invalid\n',
  );
  writeFileSync(join(f.request.configurationDirectory, '.netlify', 'state.json'), '{"siteId":"synthetic"}');
  const before = process.env.VITE_CONVEX_URL;
  t.after(() => {
    if (before === undefined) delete process.env.VITE_CONVEX_URL;
    else process.env.VITE_CONVEX_URL = before;
  });
  const dependencies = {
    exportSource: async (...args) => {
      calls.push(['export', ...args]);
      return { path: f.dir, commit: 'b'.repeat(40) };
    },
    run(command, args, cwd) {
      calls.push([command, args, cwd]);
      if (args.includes('clone')) {
        mkdirSync(args.at(-1));
        writeFileSync(join(args.at(-1), 'package.json'), '{"version":"0.3.0"}');
      }
    },
  };
  f.journal.request.reuseExport = join(f.dir, 'previous-export');
  await executeReleaseStage(f.journal, 'export', f.dir, dependencies);
  assert.equal(calls[0][2], f.head);
  assert.equal(calls[0].at(-1), f.journal.request.reuseExport);
  const output = await executeReleaseStage(f.journal, 'build', f.dir, dependencies);
  f.journal.stages.find(stage => stage.name === 'build').attempts.at(-1).receipt = receipt(
    f.journal,
    'build',
    'succeeded',
    output,
  );
  assert.equal(output.head, f.head);
  assert.ok(
    calls.some(
      call => Array.isArray(call[1]) && call[1].includes('--detach') && call[1].includes('a'.repeat(40)),
    ),
  );
  assert.ok(
    calls.some(
      call => Array.isArray(call[1]) && call[1].includes('ci') && call[1].includes('--ignore-scripts'),
    ),
  );
  for (const stage of ['backend', 'web']) await executeReleaseStage(f.journal, stage, f.dir, dependencies);
  const providerCalls = calls.slice(-2);
  assert.deepEqual(providerCalls[0][1], [f.request.npmCli, 'exec', '--', 'convex', 'dev', '--once']);
  assert.deepEqual(providerCalls[1][1], ['scripts/deploy-forge-preview.mjs', '--prod']);
  assert.ok(providerCalls.every(call => call[2] === output.path));
});

test('CLI selection swaps atomically, retains prior bytes and reconciles a lost selection reply', async t => {
  const f = prepareStage(t, 'select');
  const previous = readFileSync(f.cli);
  const installed = join(f.dir, 'cli.js');
  writeFileSync(installed, '');
  const result = await executeReleaseStage(f.journal, 'select', f.dir);
  assert.equal(result.head, f.head);
  assert.match(readFileSync(f.cli, 'utf8'), /FORGE_CHECK_SCOPED=1/);
  assert.equal(statSync(f.cli).mode & 0o777, 0o755);
  assert.deepEqual(await executeReleaseStage(f.journal, 'select', f.dir), result);
  assert.deepEqual(
    readFileSync(join(releaseDirectory(f.store, f.request.operationId), 'previous-cli')),
    previous,
  );
});

test('a concurrent CLI selection is preserved', async t => {
  const f = prepareStage(t, 'select');
  writeFileSync(f.cli, 'another installed CLI');
  await assert.rejects(executeReleaseStage(f.journal, 'select', f.dir), /CLI selection changed/);
  assert.equal(readFileSync(f.cli, 'utf8'), 'another installed CLI');
});

test('child failure and signal preserve actual exit status', t => {
  const f = fixture(t);
  assert.throws(
    () => releaseCommand(process.execPath, ['-e', 'process.exit(29)'], f.dir),
    error => error instanceof ReleaseChildFailure && error.exitCode === 29 && error.signal === null,
  );
  assert.throws(
    () => releaseCommand(process.execPath, ['-e', 'process.kill(process.pid,"SIGTERM")'], f.dir),
    error => error instanceof ReleaseChildFailure && error.exitCode === null && error.signal === 'SIGTERM',
  );
});

test('worker with fake provider records failure privately and caller can recover its terminal receipt', t => {
  const f = prepareStage(t, 'backend');
  writeFileSync(join(f.dir, '.env.local'), 'SYNTHETIC_RELEASE_VALUE=fixture-only\n');
  writeFileSync(f.request.npmCli, 'process.stderr.write("fixture-only"); process.exit(31);');
  const attempt = f.journal.stages.find(stage => stage.name === 'backend').attempts.at(-1);
  delete attempt.receipt;
  const result = releaseChild(f.journal, 'backend', attempt.directory);
  assert.equal(result.status, 'unknown');
  assert.equal(result.exitCode, 31);
  assert.equal(JSON.stringify(result).includes('fixture-only'), false);
  assert.equal(readFileSync(join(attempt.directory, 'child.log'), 'utf8'), 'fixture-only');
  assert.deepEqual(releaseChild(f.journal, 'backend', attempt.directory), result);
});

test('lost driver attempt cannot start a second child; live process stays running', t => {
  const f = prepareStage(t, 'backend');
  const attempt = f.journal.stages.find(stage => stage.name === 'backend').attempts.at(-1);
  delete attempt.receipt;
  releaseSave(join(attempt.directory, 'input.json'), {});
  releaseSave(join(attempt.directory, 'process.json'), { pid: process.pid });
  const observed = releaseChild(f.journal, 'backend', attempt.directory);
  assert.equal(observed.status, 'unknown');
  assert.equal(observed.code, 'RELEASE_RUNNING');
  assert.equal(existsSync(join(attempt.directory, 'child.log')), false);
});

test('install verifies archive bytes before running a fake npm', async t => {
  const f = prepareStage(t, 'install');
  const archive = join(f.dir, 'package.tgz');
  writeFileSync(archive, 'original-package');
  const pack = f.journal.stages.find(stage => stage.name === 'package').attempts.at(-1);
  pack.receipt = receipt(f.journal, 'package', 'succeeded', {
    path: archive,
    sha256: releaseHash('original-package'),
  });
  let calls = 0;
  const dependencies = {
    exportSource: async () => assert.fail('no export'),
    run(command, args, cwd) {
      calls++;
      if (args.includes('install')) {
        const path = join(cwd, 'node_modules', '@nanthai', 'forge', 'dist');
        mkdirSync(path, { recursive: true });
        writeFileSync(join(path, 'cli.js'), '');
      }
    },
  };
  const output = join(f.dir, 'install-output');
  mkdirSync(output);
  const result = await executeReleaseStage(f.journal, 'install', output, dependencies);
  assert.equal(result.head, f.head);
  assert.equal(calls, 2);
  writeFileSync(archive, 'changed');
  await assert.rejects(executeReleaseStage(f.journal, 'install', output, dependencies), /bytes changed/);
  assert.equal(calls, 2);
});

test('release CLI help documents resumable explicit deployment without executing providers', () => {
  const cli = spawnSync(process.execPath, ['dist/cli.js', 'release', '--help'], { encoding: 'utf8' });
  assert.equal(cli.status, 0);
  assert.match(cli.stdout, /--resume UUID/);
  assert.match(cli.stdout, /dev backend/);
});

test('resume adopts an original child receipt when the driver lost its reply', t => {
  const f = prepareStage(t, 'build');
  const stage = f.journal.stages.find(stage => stage.name === 'build');
  const attempt = stage.attempts.at(-1);
  delete attempt.receipt;
  releaseSave(
    join(attempt.directory, 'receipt.json'),
    receipt(f.journal, 'build', 'succeeded', { path: f.dir }),
  );
  releaseSave(join(releaseDirectory(f.store, f.request.operationId), 'release.json'), f.journal);
  const calls = [];
  const result = maintainerRelease(f.store, f.request.operationId, {
    execute(journal, name, directory) {
      calls.push(name);
      return name === 'build' ? releaseChild(journal, name, directory) : receipt(journal, name);
    },
  });
  assert.equal(result.complete, true);
  assert.equal(result.stages.find(stage => stage.name === 'build').attempts.length, 1);
  assert.deepEqual(calls, ['build', 'backend', 'web', 'package', 'install', 'select']);
});

test('packaging uses the existing tool and requires exactly one archive', async t => {
  const f = prepareStage(t, 'package');
  const before = process.env.npm_execpath;
  t.after(() => {
    if (before === undefined) delete process.env.npm_execpath;
    else process.env.npm_execpath = before;
  });
  const calls = [];
  const dependencies = {
    exportSource: async () => assert.fail('no export'),
    run(command, args, cwd) {
      calls.push([command, args, cwd]);
      assert.equal(process.env.npm_execpath, f.request.npmCli);
      writeFileSync(join(args.at(-1), 'forge.tgz'), 'synthetic-package');
    },
  };
  const output = await executeReleaseStage(f.journal, 'package', f.dir, dependencies);
  assert.equal(output.sha256, releaseHash('synthetic-package'));
  assert.deepEqual(calls[0][1], ['scripts/package-local.mjs', '--out', f.dir]);
  writeFileSync(join(f.dir, 'other.tgz'), 'other-package');
  await assert.rejects(executeReleaseStage(f.journal, 'package', f.dir, dependencies), /exactly one/);
});

test('web deploy tool supports production and preview with entirely fake providers', t => {
  const f = fixture(t),
    bin = join(f.dir, 'bin');
  mkdirSync(bin);
  mkdirSync(join(f.dir, '.netlify'));
  writeFileSync(join(f.dir, '.netlify', 'state.json'), '{"siteId":"synthetic-site"}');
  const inventory = join(f.dir, 'calls.jsonl');
  const fake = `#!${process.execPath}\nconst fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_CALLS, JSON.stringify(args)+'\\n');
if (args.includes('netlify-cli@27.10.2')) console.log(JSON.stringify({deploy_url:'https://synthetic.netlify.app',site_id:'synthetic-site',deploy_id:'synthetic-deploy'}));
else if (args.includes('get')) console.log(args.includes('FORGE_WORKER_KEY') ? 'fixture-key' : 'fixture-token');\n`;
  writeFileSync(join(bin, 'npx'), fake, { mode: 0o755 });
  for (const mode of ['--prod', 'preview']) {
    writeFileSync(inventory, '');
    const output = spawnSync(
      process.execPath,
      [join(process.cwd(), 'scripts/deploy-forge-preview.mjs'), ...(mode === '--prod' ? [mode] : [])],
      {
        cwd: f.dir,
        env: {
          ...process.env,
          PATH: bin,
          FAKE_CALLS: inventory,
          VITE_CONVEX_URL: 'https://synthetic.convex.cloud',
        },
        encoding: 'utf8',
      },
    );
    assert.equal(output.status, 0, output.stderr);
    assert.equal(output.stdout.includes('fixture-key'), false);
    const calls = readFileSync(inventory, 'utf8')
      .trim()
      .split('\n')
      .map(line => JSON.parse(line));
    const deploy = calls.find(args => args.includes('netlify-cli@27.10.2'));
    assert.equal(deploy.includes('--prod'), mode === '--prod');
    assert.equal(deploy.includes('deploy-preview'), mode === 'preview');
    assert.ok(calls.some(args => args[0] === 'convex' && args.includes('NETLIFY_WORKER_URL')));
  }
});

test('an npm-style CLI symlink is retained without modifying its prior target', async t => {
  const f = fixture(t);
  const target = join(f.dir, 'old-cli.js');
  writeFileSync(target, 'previous CLI target');
  rmSync(f.cli);
  symlinkSync(target, f.cli);
  maintainerRelease(f.store, f.request, {
    execute: (journal, name) =>
      receipt(journal, name, name === 'select' ? 'failed' : 'succeeded', {
        path: f.dir,
        cli: join(f.dir, 'new-cli.js'),
      }),
  });
  const journal = readMaintainerRelease(f.store, f.request.operationId);
  assert.equal(journal.previousCli.kind, 'symlink');
  assert.equal(
    readFileSync(join(releaseDirectory(f.store, f.request.operationId), 'previous-cli'), 'utf8'),
    target,
  );
  await executeReleaseStage(journal, 'select', f.dir);
  assert.equal(readFileSync(target, 'utf8'), 'previous CLI target');
  assert.equal(statSync(f.cli).isFile(), true);
  // Restore the saved selection, including its symlink form.
  unlinkSync(f.cli);
  symlinkSync(
    readFileSync(join(releaseDirectory(f.store, f.request.operationId), 'previous-cli'), 'utf8'),
    f.cli,
  );
  assert.equal(readlinkSync(f.cli), target);
});
