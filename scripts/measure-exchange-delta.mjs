// SPDX-License-Identifier: Apache-2.0
// Synthetic local HTTP/CLI measurement only: never contacts a hosted project.
// --runtime DIST_DIRECTORY selects a before-build; --full-validation disables
// prior-closure receipts to measure the previous complete-binding validation path.
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { convexToJson, jsonToConvex } from 'convex/values';
import { fixture, modules } from '../tests/project-exchange-fixture.mjs';
import { initNative } from '../dist/native-work.js';
import { NativeSource } from '../dist/native-source.js';
import { WorkStore } from '../dist/work-store.js';
const s = fixture();
let calls = {},
  posts = 0;
const server = createServer(async (req, res) => {
  try {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const bytes = Buffer.concat(chunks);
    if (req.url === '/upload') {
      posts += bytes.length;
      const storageId = await s.ctx.storage.store(new Blob([bytes], { type: req.headers['content-type'] }));
      res.end(JSON.stringify({ storageId }));
      return;
    }
    const input = JSON.parse(bytes),
      [name, method] = input.path.split(':');
    calls[input.path] = (calls[input.path] ?? 0) + 1;
    const args = jsonToConvex(input.args[0]);
    const value = await modules[name][method]._handler(s.ctx, args);
    res.end(JSON.stringify({ status: 'success', value: convexToJson(value) }));
  } catch (error) {
    res.statusCode = 500;
    res.end(
      JSON.stringify({
        status: 'error',
        errorMessage: String(error),
        errorData: convexToJson(error.data ?? null),
      }),
    );
  }
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${server.address().port}`;
s.ctx.storage.generateUploadUrl = async () => `${url}/upload`;
const root = mkdtempSync(resolve('node_modules/b2-synthetic-'));
initNative(root);
const store = new WorkStore(root),
  source = new NativeSource(root);
let files = [];
for (let i = 0; i < 1500; i++)
  files.push({
    path: `file-${i}.txt`,
    mode: 'file',
    blob: source.put(Buffer.from(`${i}\n` + 'x'.repeat(65536))),
  });
let head = store.load().nativeHead;
for (let i = 0; i < 30; i++) {
  files[0] = { ...files[0], blob: source.put(Buffer.from(`revision ${i}\n`)) };
  head = source.writeState(files, [head], `history ${i}`, 'synthetic');
}
let data = store.load();
data.nativeHead = head;
data.revision++;
store.save(data);
const baseline = process.argv.includes('--full-validation');
const option = process.argv.indexOf('--runtime');
const runtime = resolve(option < 0 ? 'dist/cli.js' : join(process.argv[option + 1], 'cli.js'));
async function push(previous) {
  if (baseline && previous) delete s.tables.projectBackups.get(previous).validatedClosure;
  const op = randomUUID(),
    request = { url, projectId: 'project', operationId: op, previous, revision: store.revision() };
  const path = join(root, `.forge/b2-request-${op}.json`);
  writeFileSync(path, JSON.stringify(request));
  const started = performance.now();
  calls = {};
  posts = 0;
  const child = spawn(process.execPath, [runtime, 'exchange', root, 'push', '--command-file', path], {
    env: { ...process.env, FORGE_AUTH_TOKEN: 'synthetic-only' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '',
    err = '';
  child.stdout.on('data', b => (output += b));
  child.stderr.on('data', b => (err += b));
  const code = await new Promise(r => child.on('exit', r));
  if (code) throw Error(err + output);
  const result = JSON.parse(output);
  console.log(JSON.stringify({ baseline, elapsedMs: performance.now() - started, calls, posts, result }));
  return result.backupId;
}
try {
  let previous = await push(null);
  for (let i = 0; i < 3; i++) {
    files[0] = { ...files[0], blob: source.put(Buffer.from(`one-file edit ${i}\n`)) };
    head = source.writeState(files, [head], `delta ${i}`, 'synthetic');
    data = store.load();
    data.nativeHead = head;
    data.revision++;
    store.save(data);
    previous = await push(previous);
  }
} finally {
  server.close();
  rmSync(root, { recursive: true, force: true });
}
