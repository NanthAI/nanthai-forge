// SPDX-License-Identifier: Apache-2.0
import { mock } from 'node:test';
import { cpuMilliseconds, retainedBytes } from './resource-budget.mjs';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { AgentWorkflow } from './agent-advisory-fixture.mjs';
import { initNative } from '../dist/native-work.js';
import { readEditPeers } from '../dist/agent-edit-peers.js';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { preEdit } from '../dist/agent-pre-edit.js';
import { indexPeerRecords } from '../dist/agent-peers-index.js';
import { WorkStore } from '../dist/work-store.js';
import { PeersCache } from '../dist/agent-peers-cache.js';

export default async function firstWriteBudget() {
  const cleanup = [];
  try {
    const root = mkdtempSync(join(tmpdir(), 'forge-first-write-budget-'));
    cleanup.push(() => rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
    writeFileSync(join(root, 'file.txt'), 'Synthetic\n');
    initNative(root);
    const agent = new AgentWorkflow(root),
      store = agent.work.store;
    const mine = (await agent.dispatch({ action: 'start', outcome: 'Budget fixture' })).result;
    const data = store.load(),
      template = data.lanes.find(lane => lane.id === mine.laneId);
    for (let i = 1; i < 560; i++) {
      const { agentStart, startReceipt, ...fields } = template;
      void agentStart;
      void startReceipt;
      data.lanes.push({
        ...fields,
        id: randomUUID(),
        name: `Synthetic Lane ${i}`,
        scope: { paths: [i <= 3 ? 'docs' : `unrelated-${i}.txt`] },
      });
    }
    for (let i = 0; i < 2200; i++)
      data.views.push({
        id: randomUUID(),
        intentId: template.intentId,
        base: template.base,
        head: template.head,
        inputs: [],
        status: 'clean',
        details: 'Synthetic unused View',
        at: new Date().toISOString(),
      });
    store.save(data);
    indexPeerRecords(store.root, store.readRecords());
    const fetch = mock.method(globalThis, 'fetch', () => {
      throw new Error('No network allowed');
    });
    const load = mock.method(WorkStore.prototype, 'load', () => {
      throw new Error('No full Work');
    });
    const lookupPages = mock.method(PeersCache.prototype, 'read');
    const checkRead = (path, repeats = 1) => {
      const before = lookupPages.mock.callCount();
      let result;
      for (let i = 0; i < repeats; i++) result = readEditPeers(root, mine.laneId, path);
      const pages = lookupPages.mock.calls
        .slice(before)
        .filter(call => call.arguments[0].startsWith('lane-fields-v1:'));
      assert.equal(pages.length, 5, 'actual header page reads');
      return result;
    };
    const times = [],
      heap = retainedBytes();
    let reads;
    for (let i = 0; i < 25; i++) {
      const at = process.cpuUsage();
      reads = checkRead(`fresh-${i}.txt`);
      times.push(cpuMilliseconds(at));
      assert.equal(reads.overlaps.length, 0);
      assert.equal(reads.budget.convexCalls, 0);
      assert.equal(reads.budget.documentsRead, 0);
      assert.equal(reads.budget.documentsWritten, 0);
      assert.equal(reads.budget.pagesRead, 5);
      assert.equal(reads.budget.headersRead, 0, 'writer primes immutable header pages');
    }
    assert.throws(() => checkRead('planted-double.txt', 2), /actual header page reads/);
    lookupPages.mock.restore();
    const memoryModule = join(root, 'measure-hook.mjs');
    const memoryPath = join(root, 'hook-memory.json');
    writeFileSync(
      memoryModule,
      "import { writeFileSync } from 'node:fs'; process.on('exit', () => writeFileSync(process.env.FORGE_HOOK_MEMORY_FILE, JSON.stringify({ cpuMs: (process.cpuUsage().user + process.cpuUsage().system) / 1000, peakRssBytes: process.resourceUsage().maxRSS * 1024 })));\n",
    );
    const hookTimes = [];
    let hookPeakRssBytes = 0;
    // Exercise the supervisor and its real worker protocol at scale. Measure the
    // worker entry separately: process CPU for the supervisor also includes V8
    // background threads and worker startup running in parallel.
    for (let i = -1; i < 20; i++) {
      const input = {
        session_id: 'budget-session',
        turn_id: 'one',
        cwd: mine.path,
        tool_name: 'Write',
        tool_input: { file_path: `docs/hook-${i}.txt` },
      };
      const child = spawnSync(
        process.execPath,
        [
          '--expose-gc',
          '--import',
          memoryModule,
          fileURLToPath(new URL('../dist/agent-edit-hook.js', import.meta.url)),
          root,
          mine.laneId,
        ],
        {
          input: JSON.stringify(input),
          encoding: 'utf8',
          env: { ...process.env, FORGE_HOOK_MEMORY_FILE: memoryPath },
        },
      );
      assert.equal(child.status, 0, child.stderr);
      const result = JSON.parse(child.stdout);
      hookPeakRssBytes = Math.max(
        hookPeakRssBytes,
        JSON.parse(readFileSync(memoryPath, 'utf8')).peakRssBytes,
      );
      const worker = spawnSync(
        process.execPath,
        [
          '--import',
          memoryModule,
          fileURLToPath(new URL('../dist/agent-edit-hook.js', import.meta.url)),
          '--worker',
          root,
          mine.laneId,
        ],
        {
          input: JSON.stringify(input),
          encoding: 'utf8',
          env: { ...process.env, FORGE_HOOK_MEMORY_FILE: memoryPath },
        },
      );
      assert.equal(worker.status, 0, worker.stderr);
      const direct = JSON.parse(worker.stdout);
      assert.equal(direct.kind, 'forge-edit-hook-result');
      assert.deepEqual(direct.output, result);
      if (i >= 0) hookTimes.push(JSON.parse(readFileSync(memoryPath, 'utf8')).cpuMs);
      assert.equal(result.hookSpecificOutput.permissionDecision, 'deny');
      assert.match(result.hookSpecificOutput.permissionDecisionReason, /3 unacknowledged/);
    }
    const conversation = { agent: 'codex', sessionId: 'cache-budget', turnId: 'one' };
    preEdit(root, mine.laneId, ['cached.txt'], conversation);
    const lookup = mock.method(PeersCache.prototype, 'read');
    assert.equal(preEdit(root, mine.laneId, ['cached.txt'], conversation).checked, 0);
    assert.equal(lookup.mock.callCount(), 1);
    const p95 = list => [...list].sort((a, b) => a - b)[Math.ceil(list.length * 0.95) - 1];
    const delta = retainedBytes() - heap;
    const measured = {
      lanes: 560,
      views: 2200,
      readCpuP95Ms: p95(times),
      hookCpuP95Ms: p95(hookTimes),
      hookPeakRssBytes,
      heapDeltaBytes: delta,
      peakRssBytes: process.resourceUsage().maxRSS * 1024,
      budget: reads.budget,
      networkCalls: fetch.mock.callCount(),
      plantedDoubleReadRejected: true,
    };
    assert.ok(p95(times) < 200);
    assert.ok(p95(hookTimes) < 200, `hook CPU p95=${p95(hookTimes)} ms`);
    assert.ok(delta < 64 * 1024 * 1024);
    assert.ok(hookPeakRssBytes < 128 * 1024 * 1024, `hook peak RSS=${hookPeakRssBytes}`);
    assert.equal(fetch.mock.callCount(), 0);
    load.mock.restore();
    return measured;
  } finally {
    mock.restoreAll();
    for (const fn of cleanup) fn();
  }
}
