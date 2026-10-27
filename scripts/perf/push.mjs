// SPDX-License-Identifier: Apache-2.0
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { convexToJson, jsonToConvex } from 'convex/values';

/** Real exchange CLI against an in-memory loopback backend. There is no hosted URL option. */
export async function syntheticPush(samples = 3) {
  const { fixture, modules, preparedCheckpoint, seedRecordCheckpoint } =
    await import('../../tests/project-exchange-fixture.mjs');
  const { initNative } = await import('../../dist/native-work.js');
  const { NativeSource } = await import('../../dist/native-source.js');
  const { WorkStore } = await import('../../dist/work-store.js');
  const s = fixture();
  let calls = 0,
    uploadBytes = 0;
  const server = createServer(async (req, res) => {
    try {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const bytes = Buffer.concat(chunks);
      if (req.url === '/upload') {
        uploadBytes += bytes.length;
        const storageId = await s.ctx.storage.store(new Blob([bytes], { type: req.headers['content-type'] }));
        res.end(JSON.stringify({ storageId }));
      } else {
        const input = JSON.parse(bytes),
          [name, method] = input.path.split(':');
        calls++;
        const value = await modules[name][method]._handler(s.ctx, jsonToConvex(input.args[0]));
        res.end(JSON.stringify({ status: 'success', value: convexToJson(value) }));
      }
    } catch {
      res.statusCode = 500;
      res.end(JSON.stringify({ status: 'error', errorMessage: 'Synthetic exchange failed.' }));
    }
  });
  const root = mkdtempSync(resolve('node_modules/perf-synthetic-'));
  try {
    await new Promise((done, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', done);
    });
    const url = `http://127.0.0.1:${server.address().port}`;
    s.ctx.storage.generateUploadUrl = async () => `${url}/upload`;
    initNative(root);
    const store = new WorkStore(root),
      source = new NativeSource(root);
    const files = Array.from({ length: 100 }, (_, i) => ({
      path: `file-${i}.txt`,
      mode: 'file',
      blob: source.put(Buffer.from(`${i}\n${'x'.repeat(4096)}`)),
    }));
    let head = store.load().nativeHead;
    const save = message => {
      head = source.writeState(files, [head], message, 'synthetic');
      const data = store.load();
      data.nativeHead = head;
      data.revision++;
      store.save(data);
    };
    save('Synthetic seed');
    async function push(previous) {
      const operationId = randomUUID(),
        path = join(root, '.forge/perf-request.json');
      writeFileSync(
        path,
        JSON.stringify({ url, projectId: 'project', operationId, previous, revision: store.revision() }),
        { mode: 0o600 },
      );
      calls = 0;
      uploadBytes = 0;
      const startedAt = new Date().toISOString(),
        start = performance.now();
      const child = spawn(
        process.execPath,
        [resolve('dist/cli.js'), 'exchange', root, 'push', '--command-file', path],
        {
          env: {
            PATH: process.env.PATH,
            HOME: root,
            FORGE_AUTH_TOKEN: 'synthetic-only',
            XDG_CONFIG_HOME: root,
          },
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );
      let stdout = '';
      child.stdout.on('data', b => (stdout += b));
      child.stderr.resume(); // Never print CLI/library errors or payloads.
      const code = await new Promise((done, reject) => {
        child.once('error', reject);
        child.once('close', done);
      });
      if (code) throw new Error('PERF_SYNTHETIC_PUSH');
      return {
        backupId: JSON.parse(stdout).backupId,
        sample: {
          startedAt,
          endedAt: new Date().toISOString(),
          durationMs: performance.now() - start,
          rpcCalls: calls,
          uploadBytes,
        },
      };
    }
    // New records checkpoints start with the paged hosted seed, not push fallback.
    const seeded = await preparedCheckpoint(s, store, 0, undefined, { records: true });
    let previous = await seedRecordCheckpoint(s, seeded);
    const { ConvexExchange } = await import('../../dist/exchange-client.js');
    const { retainExchangeBaseline } = await import('../../dist/native-exchange-baseline.js');
    const transport = new ConvexExchange(url, 'synthetic-only', 'project', randomUUID(), previous);
    retainExchangeBaseline(
      store,
      transport.checkpointKey(),
      seeded.manifest,
      JSON.parse(readFileSync(join(store.directory, `exchange-${seeded.input.operationId}`, 'work.json'))),
      [],
      JSON.parse(readFileSync(join(store.directory, `exchange-${seeded.input.operationId}`, 'states.json'))),
    );
    const result = [];
    for (let i = 0; i < samples; i++) {
      files[0] = { ...files[0], blob: source.put(Buffer.from(`one-file delta ${i}\n`)) };
      save(`Delta ${i}`);
      const pushed = await push(previous);
      previous = pushed.backupId;
      result.push(pushed.sample);
    }
    return {
      samples: result,
      fixture: {
        files: 100,
        initialFileBytes: 4096,
        seedPushExcluded: true,
        transport: 'loopback HTTP; real CLI; in-memory Convex handlers; no WAN or durable provider storage',
      },
    };
  } finally {
    server.closeAllConnections();
    await new Promise(done => server.close(done));
    rmSync(root, { recursive: true, force: true });
  }
}
