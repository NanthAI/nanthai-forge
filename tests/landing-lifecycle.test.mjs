// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { gatedFixture, childWorker, until } from './landing-worker-fixture.mjs';
import { finishChild } from '../dist/finish-child.js';
import { processAlive, processGroupAlive } from '../dist/local-process.js';

for (const admission of ['solo', 'combined'])
  for (const signal of ['SIGTERM', 'SIGKILL']) {
    test(`lifecycle drill: owner restart mid-check (${admission}, ${signal}) retains passed work and settles the original entries`, async t => {
      const started = performance.now(),
        f = await gatedFixture(t);
      const check = f.store.load().checks[0];
      await f.agent.dispatch({
        action: 'define-check',
        checkId: check.id,
        name: check.name,
        executable: check.executable,
        args: [
          '-e',
          `if(require('node:fs').existsSync('inflight.txt')${admission === 'combined' ? " && require('node:fs').existsSync('passed.txt')" : ''}){${check.args[1]}}`,
        ],
      });
      const passed = await f.candidate('passed.txt');
      await f.checkCandidates([passed]);
      let retained = f.store.load().runs.filter(run => !run.mainCheck);
      assert.equal(retained.length, 1);
      assert.equal(retained[0].status, 'passed');
      const inflight = await f.candidate('inflight.txt');
      if (admission === 'combined') {
        await f.checkCandidates([inflight]);
        retained = f.store.load().runs.filter(run => !run.mainCheck);
      }
      assert(
        retained.every(run => run.status === 'passed' && run.reuseKey),
        'seed keyed passed evidence',
      );
      let owner, replacement;
      try {
        owner = await childWorker(f);
        await until(f, () => f.started, 'in-flight check started');
        const running = f.store.load().runs.find(run => run.status === 'running');
        assert(running?.childPid, 'kill only the synthetic running command');
        assert.equal(running.runner.pid, owner.child.pid, 'owner hosts this in-process check controller');
        await owner.stop(signal);
        // A hard service/machine loss can also lose the command. Reclaim only our
        // synthetic process group, never an unrelated process on the test machine.
        if (signal === 'SIGKILL' && processGroupAlive(running.childPid, running.childStartTime))
          process.kill(process.platform === 'win32' ? running.childPid : -running.childPid, 'SIGKILL');
        await until(
          f,
          () => !processAlive(running.runner) && !processGroupAlive(running.childPid, running.childStartTime),
          'old synthetic execution ended',
        );
        f.release();
        replacement = await childWorker(f);
        await until(
          f,
          () => f.store.load().landingEntries.every(entry => !['queued', 'checking'].includes(entry.status)),
          'restarted owner settles original entries',
        );
        const data = f.store.load(),
          entries = data.landingEntries.filter(entry =>
            [passed.command.operationId, inflight.command.operationId].includes(entry.id),
          );
        assert.equal(entries.length, 2, 'no manual resubmission');
        assert(
          entries.every(entry => entry.status === 'accepted'),
          JSON.stringify(entries.map(({ status, reason }) => ({ status, reason }))),
        );
        const retry = f.store.select('runs', finishChild(running.id, 'controller-recovery'));
        assert.equal(retry?.status, 'passed', 'one deterministic replacement check');
        assert.equal(retry.viewId, running.viewId);
        assert.equal(retry.head, running.head);
        assert.equal(
          f.store.select('runs', running.id).status,
          signal === 'SIGTERM' ? 'cancelled' : 'interrupted',
        );
        assert(entries.some(entry => entry.infrastructureRetries?.some(retry => retry.runId === running.id)));
        for (const run of retained)
          assert.deepEqual(f.store.select('runs', run.id), run, 'passed evidence remains immutable');
        const reruns = data.runs.filter(
          run =>
            !run.reusedFrom &&
            !retained.some(passed => passed.id === run.id) &&
            retained.some(passed => passed.reuseKey === run.reuseKey),
        ).length;
        assert.equal(reruns, 0, 'no new physical check for the previously passed tree');
        assert.equal(
          data.landingEntries.filter(entry => ['queued', 'checking'].includes(entry.status)).length,
          0,
        );
        t.diagnostic(
          JSON.stringify({
            scenario: 'owner-restart',
            admission,
            signal,
            elapsedMs: Math.round(performance.now() - started),
            passedCheckReruns: reruns,
            strandedEntries: 0,
            operatorMutationsToSettle: 0,
          }),
        );
      } finally {
        f.release();
        await owner?.stop();
        await replacement?.stop();
      }
    });
  }
