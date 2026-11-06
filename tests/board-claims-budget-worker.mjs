// SPDX-License-Identifier: Apache-2.0
// Real first-write hook processes with automatic claims on (board Lane 4): the hook still makes one
// query, its CPU p95 stays under 200 ms, and the claim goes up from the detached sender, batched.
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { once } from 'node:events';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hostedMarker, laneB } from './hosted-edit-fixture.mjs';
import { clientCacheRoot } from '../dist/root-paths.js';

/** counts: 0 queries, 1 claim mutations, 2 claimed paths, 3 unexpected requests. */
async function claimServer() {
  const counts = new Int32Array(new SharedArrayBuffer(16));
  const server = new Worker(
    `
    import { parentPort, workerData } from 'node:worker_threads';
    import { createServer } from 'node:http';
    const counts = new Int32Array(workerData.counts);
    const reply = (res, value) => {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ status: 'success', value: JSON.stringify(value), logLines: [] }));
    };
    const server = createServer(async (req, res) => {
      let bytes = ''; for await (const chunk of req) bytes += chunk;
      const body = JSON.parse(bytes), args = Array.isArray(body.args) ? body.args[0] : body.args;
      if (body.path === 'projectHostedOverlaps:read' && args.board?.claim === true) {
        Atomics.add(counts, 0, 1);
        return reply(res, {
          peerEvidence: { count: 0, coverage: 'hosted', scope: 'saved-paths', unsavedEdits: 'unavailable', items: [] },
          board: { messages: [], more: 0, cursor: 0, claim: 'send' },
        });
      }
      if (body.path === 'projectBoardClaims:claim') {
        Atomics.add(counts, 1, 1);
        Atomics.add(counts, 2, args.paths.length);
        return reply(res, { status: 'ok', claimed: args.paths.length });
      }
      Atomics.add(counts, 3, 1);
      res.writeHead(400).end();
    });
    server.listen(0, '127.0.0.1', () => parentPort.postMessage(server.address().port));
  `,
    { eval: true, execArgv: [], workerData: { counts: counts.buffer } },
  );
  const [port] = await once(server, 'message');
  return { url: `http://127.0.0.1:${port}`, counts, close: () => server.terminate() };
}

export default async function claimBudget() {
  const root = mkdtempSync(join(tmpdir(), 'forge-claim-budget-'));
  const state = mkdtempSync(join(tmpdir(), 'forge-claim-state-'));
  const server = await claimServer();
  try {
    hostedMarker(root, server.url, laneB, 2000);
    const marker = join(state, 'forge', 'board', 'server-synthetic-project.json');
    const { mkdirSync } = await import('node:fs');
    mkdirSync(join(state, 'forge', 'board'), { recursive: true });
    writeFileSync(marker, JSON.stringify({ features: ['agent-board', 'board-wait', 'board-claims'] }));
    const memoryModule = join(root, 'measure-hook.mjs'),
      memoryPath = join(root, 'hook-memory.json');
    writeFileSync(
      memoryModule,
      "import { writeFileSync } from 'node:fs'; process.on('exit', () => writeFileSync(process.env.FORGE_HOOK_MEMORY_FILE, JSON.stringify({ cpuMs: (process.cpuUsage().user + process.cpuUsage().system) / 1000 })));\n",
    );
    const env = {
      ...process.env,
      FORGE_AUTH_TOKEN: 'synthetic-only',
      XDG_STATE_HOME: state,
      FORGE_HOOK_MEMORY_FILE: memoryPath,
    };
    const hook = fileURLToPath(new URL('../dist/agent-edit-hook.js', import.meta.url));
    const times = [];
    // 12 samples made the nearest-rank "p95" the maximum, so one descheduled spawn failed the claim. With 20
    // samples p95 is the 19th: the claim stays strict (a second slow spawn fails it) but one outlier cannot.
    const runs = 20;
    for (let i = -1; i < runs; i++) {
      const before = Atomics.load(server.counts, 0);
      const child = spawnSync(process.execPath, ['--import', memoryModule, hook, '--worker', '--auto'], {
        input: JSON.stringify({
          session_id: `claim-${i}`,
          cwd: root,
          tool_name: 'Write',
          tool_input: { file_path: `src/new-${i}.ts` },
        }),
        encoding: 'utf8',
        env,
      });
      assert.equal(child.status, 0, child.stderr);
      assert.equal(Atomics.load(server.counts, 0) - before, 1, 'the hook makes exactly one query');
      if (i >= 0) times.push(JSON.parse(readFileSync(memoryPath, 'utf8')).cpuMs);
    }
    // The detached sender finishes on its own; wait for its lock to go (bounded).
    const lock = join(clientCacheRoot(root), 'board', `${laneB}.claims.lock`);
    for (let waited = 0; existsSync(lock) && waited < 15_000; waited += 100)
      await new Promise(done => setTimeout(done, 100));
    assert.equal(existsSync(lock), false, 'sender exited');
    const p95 = list => [...list].sort((a, b) => a - b)[Math.ceil(list.length * 0.95) - 1];
    const measured = {
      hooks: runs + 1,
      hookCpuP95Ms: p95(times),
      queries: Atomics.load(server.counts, 0),
      claimMutations: Atomics.load(server.counts, 1),
      claimedPaths: Atomics.load(server.counts, 2),
      unexpected: Atomics.load(server.counts, 3),
    };
    assert.ok(measured.hookCpuP95Ms < 200, `hook CPU p95=${measured.hookCpuP95Ms} ms`);
    assert.equal(measured.unexpected, 0);
    assert.equal(measured.claimedPaths, runs + 1, 'every new path claimed once');
    assert.ok(measured.claimMutations < measured.hooks, 'first writes in one window share a mutation');
    return measured;
  } finally {
    await server.close();
    rmSync(root, { recursive: true, force: true });
    rmSync(state, { recursive: true, force: true });
  }
}
