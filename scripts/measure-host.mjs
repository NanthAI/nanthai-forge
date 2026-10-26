// SPDX-License-Identifier: Apache-2.0
// Offline synthetic qualification. RPC/storage latency is simulated, never a cloud benchmark.
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { getFunctionName } from 'convex/server';
import { moduleUrl } from '../tests/convex-module.mjs';
import { fixture } from '../tests/project-exchange-fixture.mjs';
import { initNative } from '../dist/native-work.js';
import { NativeSource } from '../dist/native-source.js';
import { WorkStore } from '../dist/work-store.js';
import { hostProject } from '../dist/host-cli.js';
import { ConvexExchange } from '../dist/exchange-client.js';
const rtt = Number(process.env.HOST_BENCH_RTT_MS ?? 20);
const delay = () => new Promise(resolve => setTimeout(resolve, rtt));
const directory = mkdtempSync(join(tmpdir(), 'forge-host-bench-'));
const root = join(directory, 'owner');
mkdirSync(root);
const fetchOriginal = globalThis.fetch;
try {
  const cached = process.env.HOST_BENCH_FIXTURE;
  if (cached && existsSync(join(cached, 'owner'))) cpSync(join(cached, 'owner'), root, { recursive: true });
  else {
    initNative(root);
    const source = new NativeSource(root),
      store = new WorkStore(root),
      data = store.load();
    const states = [],
      blobs = [];
    let parent = data.nativeHead;
    for (let i = 0; i < 500; i++) {
      const files = [];
      for (let j = 0; j < 6; j++) {
        const bytes = Buffer.alloc(73333, (i + j) % 251);
        bytes.writeUInt32LE(i * 6 + j);
        const blob = source.put(bytes);
        blobs.push(blob);
        files.push({ path: `file-${j}.bin`, blob, mode: 'file' });
      }
      parent = source.writeState(files, [parent], `Synthetic ${i}`, new Date(0).toISOString());
      states.push(parent);
    }
    for (let i = 0; i < 1600; i++)
      data.intents.push({
        id: randomUUID(),
        outcome: `Synthetic ${i}`,
        constraints: '',
        base: states[i % 500],
        status: 'active',
        notes: [],
        createdAt: new Date(0).toISOString(),
      });
    for (let i = 0; i < 500; i++)
      data.views.push({
        id: randomUUID(),
        intentId: data.intents[i].id,
        base: states[Math.max(0, i - 1)],
        inputs: [],
        head: states[i],
        status: 'clean',
        details: '',
        at: new Date(0).toISOString(),
      });
    data.nativeHead = parent;
    store.locked(() => store.save(data));
    if (cached) {
      mkdirSync(cached, { recursive: true });
      cpSync(root, join(cached, 'owner'), { recursive: true });
    }
  }
  const s = fixture(),
    hosting = await import(moduleUrl('../convex/projectHosting.ts'));
  const run = s.ctx.runQuery,
    rpc = new Map();
  const record = async (name, fn) => {
    const start = performance.now();
    try {
      return await fn();
    } finally {
      const row = rpc.get(name) ?? { calls: 0, ms: 0 };
      row.calls++;
      row.ms += performance.now() - start;
      rpc.set(name, row);
    }
  };
  s.ctx.runAction =
    s.ctx.runMutation =
    s.ctx.runQuery =
      async (ref, args) => {
        const name = getFunctionName(ref);
        return record(`server:${name}`, async () => {
          await delay();
          if (name.startsWith('projectHosting:')) return hosting[name.split(':')[1]]._handler(s.ctx, args);
          return run(ref, args);
        });
      };
  const credentialId = randomUUID();
  s.tables.cliCredentials.set('device', {
    owner: 'owner',
    credentialId,
    scope: 'cli',
    revoked: false,
    expiresAt: Date.now() + 3600000,
  });
  s.ctx.auth.getUserIdentity = async () => ({ subject: 'owner', forgeCredential: credentialId });
  process.env.FORGE_WEB_URL = 'https://synthetic.invalid';
  globalThis.fetch = async (_url, request) =>
    record('storage:POST', async () => {
      await delay();
      const storageId = await s.ctx.storage.store(
        new Blob([request.body], { type: request.headers['Content-Type'] }),
      );
      return Response.json({ storageId });
    });
  const client = {
    mutation: (ref, args) => s.ctx.runMutation(ref, args),
    action: (ref, args) => s.ctx.runAction(ref, args),
  };
  const events = [],
    start = performance.now();
  const result = await hostProject(
    root,
    { deployment: 'https://synthetic.convex.cloud', onProgress: event => events.push(event) },
    {
      client,
      exchange: (projectId, operationId) => {
        const exchange = new ConvexExchange(
          'https://synthetic.convex.cloud',
          'synthetic',
          projectId,
          operationId,
          null,
        );
        for (const method of ['query', 'mutation', 'action'])
          exchange.client[method] = (ref, args) =>
            record(`client:${getFunctionName(ref)}`, () =>
              s.ctx[method === 'query' ? 'runQuery' : method === 'mutation' ? 'runMutation' : 'runAction'](
                ref,
                args,
              ),
            );
        return exchange;
      },
    },
  );
  console.log(
    JSON.stringify(
      {
        synthetic: true,
        simulatedRttMs: rtt,
        states: 500,
        blobs: 3000,
        workRecords: 2100,
        sourceBytes: 3000 * 73333,
        elapsedMs: performance.now() - start,
        uploadedObjects: result.uploadedObjects,
        uploadedBytes: result.uploadedBytes,
        phases: events
          .filter((event, index) => index === 0 || event.phase !== events[index - 1].phase)
          .map((event, index, phases) => ({
            phase: event.phase,
            startMs: event.elapsedMs,
            durationMs: (phases[index + 1]?.elapsedMs ?? performance.now() - start) - event.elapsedMs,
          })),
        rpc: Object.fromEntries(rpc),
      },
      null,
      2,
    ),
  );
} finally {
  globalThis.fetch = fetchOriginal;
  rmSync(directory, { recursive: true, force: true });
}
