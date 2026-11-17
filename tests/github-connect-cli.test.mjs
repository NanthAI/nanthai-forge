// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import { temporaryDirectory } from '../scripts/test-temp.mjs';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { getFunctionName } from 'convex/server';
import { waitForGithubConnection, githubConnectCli } from '../dist/github-connect-cli.js';
const address = { url: 'https://forge.example', projectId: 'synthetic-project' };
test('GitHub connect waits on one operation subscription, closes when complete, and never polls', async () => {
  const operationId = randomUUID(),
    calls = [];
  let emit;
  const promise = waitForGithubConnection(address, operationId, undefined, () => ({
    onUpdate: (ref, args, update) => {
      calls.push([getFunctionName(ref), args]);
      emit = update;
      return () => calls.push('unsubscribe');
    },
    close: async () => {
      calls.push('close');
    },
  }));
  emit(JSON.stringify({ operationId, status: 'waiting', code: null, repoId: null }));
  emit(JSON.stringify({ operationId, status: 'completed', code: null, repoId: 42 }));
  assert.equal((await promise).repoId, 42);
  assert.deepEqual(calls, [
    ['githubBindingStore:status', { projectId: address.projectId, operationId }],
    'unsubscribe',
    'close',
  ]);
});
test('GitHub connect cancellation and subscription errors close all observation resources', async () => {
  for (const failure of [false, true]) {
    const controller = new AbortController(),
      calls = [];
    let error;
    const promise = waitForGithubConnection(address, randomUUID(), controller.signal, () => ({
      onUpdate: (_ref, _args, _update, reject) => {
        error = reject;
        return () => calls.push('unsubscribe');
      },
      close: async () => {
        calls.push('close');
      },
    }));
    if (failure) {
      error(new Error('synthetic-disconnect'));
      await assert.rejects(promise, /synthetic-disconnect/);
    } else {
      controller.abort();
      assert.equal((await promise).status, 'cancelled');
    }
    assert.deepEqual(calls, ['unsubscribe', 'close']);
  }
});
test('GitHub CLI exposes connect/status/disconnect and rejects malformed invocation before network IO', async () => {
  assert.match((await githubConnectCli(['--help'])).usage, /connect\|status\|disconnect/);
  await assert.rejects(githubConnectCli(['connect']), error => error.code === 'BAD_ARGUMENT');
});

const { githubImportCli, readImportJournal } = await import('../dist/github-import-cli.js');
const { ConvexError } = await import('convex/values');
function importClient({ startError, final = 'ready', updates = ['importing', 'ready'] } = {}) {
  const calls = [];
  let emit;
  const status = phase => ({
    projectId: 'project-1',
    commit: 'a'.repeat(40),
    phase,
    completed: 3,
    total: 3,
    totalKnown: true,
    bytes: 30,
    totalBytes: 30,
    submodules: 0,
    report: '0 submodules kept as pointers',
    error:
      phase === 'error'
        ? { code: 'GITHUB_RATE_LIMIT', message: 'Retry after reset.', retryAt: 1_900_000_000_000 }
        : null,
    githubRequests: { user: 2, app: 5, server: 0, anonymous: 1 },
  });
  const client = {
    async action(name, args) {
      calls.push([name, args]);
      if (name === 'projectGithubImport:start') {
        if (startError) throw startError;
        return 'job-1';
      }
      return status(final);
    },
    watch(id, onUpdate) {
      calls.push(['watch', id]);
      emit = onUpdate;
      queueMicrotask(() => {
        for (const phase of updates)
          emit({ projectId: 'project-1', phase, completed: 3, total: 3, error: status(phase).error });
      });
      return { close: async () => calls.push(['close']) };
    },
  };
  return { client, calls };
}
test('nforge import starts once, waits on one progress subscription (no polling) and reports project and readiness', async t => {
  t.after(() => {
    process.exitCode = undefined;
  });
  const directory = temporaryDirectory(t, 'forge-import-'),
    { client, calls } = importClient();
  const report = await githubImportCli(
    [
      'https://github.com/example/repo',
      '--ref',
      'v1',
      '--name',
      'Repo',
      '--deployment',
      'https://forge.example',
    ],
    { client: () => client, directory },
  );
  assert.equal(report.ready, true);
  assert.equal(report.projectId, 'project-1');
  assert.equal(report.commit, 'a'.repeat(40));
  assert.deepEqual(report.githubRequests, { user: 2, app: 5, server: 0, anonymous: 1 });
  assert.equal(report.next, 'nforge clone project-1 DIR --deployment https://forge.example');
  assert.deepEqual(
    calls.map(([name]) => name),
    ['projectGithubImport:start', 'watch', 'close', 'projectGithubImport:status'],
  );
  assert.deepEqual(calls[0][1], {
    operationId: report.operationId,
    url: 'https://github.com/example/repo',
    ref: 'v1',
    name: 'Repo',
  });
  const journal = readImportJournal(directory, report.operationId);
  assert.equal(journal.jobId, 'job-1');
  assert.equal(process.exitCode, undefined);
  // Resume replays the original operation and request; a changed request is refused before any call.
  const resumed = importClient();
  await githubImportCli(['--resume', report.operationId], { client: () => resumed.client, directory });
  assert.deepEqual(resumed.calls[0][1], calls[0][1]);
  const refused = importClient();
  await assert.rejects(
    githubImportCli(
      ['example/other', '--operation-id', report.operationId, '--deployment', 'https://forge.example'],
      { client: () => refused.client, directory },
    ),
    error => error.code === 'WORK_OPERATION_CHANGED',
  );
  await assert.rejects(githubImportCli(['--resume', randomUUID()], { directory }), {
    code: 'IMPORT_UNKNOWN',
  });
  await assert.rejects(githubImportCli([], { directory }), { code: 'BAD_ARGUMENT' });
  assert.equal(refused.calls.length, 0);
});
test('nforge import keeps the operation for resume and names the reset when GitHub or the worker is rate limited', async t => {
  t.after(() => {
    process.exitCode = undefined;
  });
  const directory = temporaryDirectory(t, 'forge-import-'),
    retryAt = 1_900_000_000_000;
  const limited = importClient({
    startError: new ConvexError({ code: 'GITHUB_RATE_LIMIT', message: 'GitHub limit.', retryAt }),
  });
  const operationId = randomUUID();
  await assert.rejects(
    githubImportCli(
      ['example/repo', '--operation-id', operationId, '--deployment', 'https://forge.example'],
      {
        client: () => limited.client,
        directory,
      },
    ),
    error => {
      assert.equal(error.code, 'GITHUB_RATE_LIMIT');
      assert.equal(error.retryAt, retryAt);
      assert.deepEqual(error.recovery, {
        resume: `nforge import --resume ${operationId}`,
        retryAt: new Date(retryAt).toISOString(),
      });
      return true;
    },
  );
  assert.equal(readImportJournal(directory, operationId).operationId, operationId);
  const failed = importClient({ final: 'error', updates: ['error'] });
  const report = await githubImportCli(['--resume', operationId], { client: () => failed.client, directory });
  assert.equal(report.ready, false);
  assert.equal(report.error.retryAt, retryAt);
  // A recorded reset still ahead: the next step asks Forge to resume then, with nothing left running here.
  assert.equal(
    report.next,
    `nforge import --resume ${operationId} --at-reset (resumes on Forge at ${new Date(retryAt).toISOString()})`,
  );
  assert.equal(process.exitCode, 1);
});
test('nforge import --private sends the choice, keeps it for resume, and a changed choice is another request (a488af2a)', async t => {
  t.after(() => {
    process.exitCode = undefined;
  });
  const directory = temporaryDirectory(t, 'forge-import-'),
    { client, calls } = importClient();
  const report = await githubImportCli(
    ['example/repo', '--private', '--deployment', 'https://forge.example'],
    {
      client: () => client,
      directory,
    },
  );
  assert.equal(calls[0][1].visibility, 'private');
  assert.equal(readImportJournal(directory, report.operationId).visibility, 'private');
  const resumed = importClient();
  await githubImportCli(['--resume', report.operationId], { client: () => resumed.client, directory });
  assert.equal(resumed.calls[0][1].visibility, 'private');
  await assert.rejects(
    githubImportCli(
      ['example/repo', '--operation-id', report.operationId, '--deployment', 'https://forge.example'],
      {
        client: () => importClient().client,
        directory,
      },
    ),
    { code: 'WORK_OPERATION_CHANGED' },
  );
});
test('nforge import --resume --at-reset asks Forge to resume at the reset and keeps waiting while paused (2abda01f)', async t => {
  t.after(() => {
    process.exitCode = undefined;
  });
  const directory = temporaryDirectory(t, 'forge-import-'),
    first = importClient();
  const report = await githubImportCli(['example/repo', '--deployment', 'https://forge.example'], {
    client: () => first.client,
    directory,
  });
  const paused = importClient({ updates: ['paused', 'importing', 'ready'] });
  const resumed = await githubImportCli(['--resume', report.operationId, '--at-reset'], {
    client: () => paused.client,
    directory,
  });
  assert.equal(paused.calls[0][1].atReset, true);
  assert.equal(resumed.ready, true, 'paused is not terminal: the one subscription waits for ready');
  await assert.rejects(githubImportCli(['example/repo', '--at-reset'], { directory }), {
    code: 'BAD_ARGUMENT',
  });
});
test('nforge import --preview makes one read and starts nothing (a488af2a)', async t => {
  const directory = temporaryDirectory(t, 'forge-import-'),
    calls = [];
  const client = {
    async action(name, args) {
      calls.push([name, args]);
      return {
        repository: 'example/repo',
        origin: 'public',
        choices: ['public', 'private'],
        ref: 'main',
        commit: 'a'.repeat(40),
        files: 60000,
        bytes: 10,
        submodules: 0,
        attributes: 0,
        lfs: 'No .gitattributes, so no Git LFS files.',
        warnings: [{ code: 'SOURCE_STATE_TOO_LARGE', message: '60,000 files is above the limit.' }],
        githubRequests: { user: 0, app: 0, server: 0, anonymous: 3 },
      };
    },
    watch() {
      throw Error('a preview never waits');
    },
  };
  const report = await githubImportCli(
    ['example/repo', '--preview', '--deployment', 'https://forge.example'],
    {
      client: () => client,
      directory,
    },
  );
  assert.deepEqual(
    calls.map(([name]) => name),
    ['projectGithubImportPreview:preview'],
  );
  assert.match(report.summary, /60,000 files/);
  assert.equal(report.next, 'nforge import example/repo [--private]');
  assert.deepEqual(readdirSync(directory), [], 'no journal: nothing was started');
});
