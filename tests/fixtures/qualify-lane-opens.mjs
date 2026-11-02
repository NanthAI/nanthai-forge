// SPDX-License-Identifier: Apache-2.0
// Finite local-only full-open qualification. No hosted service or benchmark project.
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, copyFileSync, rmSync, createReadStream, statSync, openSync, fsyncSync, closeSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import childProcess, { fork } from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { pathToFileURL } from 'node:url';
import { Readable } from 'node:stream';

const [mode, root, argument, output, variant] = process.argv.slice(2);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
if (mode === 'prepare') {
  mkdirSync(join(root, 'source'), { recursive: true });
  const files = [];
  for (let i = 0; i < Number(argument); i++) {
    const bytes = Buffer.alloc(i % 100 === 0 ? 65536 : i % 20 === 0 ? 16384 : 1024);
    const seed = createHash('sha256').update(`ordinary-source-${i}`).digest();
    for (let at = 0; at < bytes.length; at += seed.length) seed.copy(bytes, at);
    const blob = hash(bytes);
    writeFileSync(join(root, 'source', blob), bytes, { mode: 0o600 });
    files.push({ path: `packages/p${Math.floor(i / 100)}/src/f${i}.dat`, blob, mode: i % 97 ? 'file' : 'executable' });
  }
  files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  const bytes = Buffer.from(JSON.stringify({ schema: 1, kind: 'forge-source-state', parents: [], files, message: 'ordinary synthetic tree', at: '2026-01-01T00:00:00Z' }));
  const head = hash(bytes);
  writeFileSync(join(root, 'source', head), bytes, { mode: 0o600 });
  writeFileSync(join(root, 'fixture.json'), JSON.stringify({ head, files: files.length, ids: [head, ...files.map(f => f.blob)] }));
  console.log(JSON.stringify({ prepared: files.length }));
} else if (mode === 'pack') {
  const { createSourcePack } = await import('../../dist/source-pack-archive.js');
  const fixture = JSON.parse(readFileSync(join(root, 'fixture.json')));
  const state = JSON.parse(readFileSync(join(root, 'source', fixture.head)));
  fixture.pack = await createSourcePack(fixture.head, state, join(root, 'source'), join(root, 'pack.gz'));
  if (!fixture.pack) throw Error('synthetic pack unavailable');
  writeFileSync(join(root, 'fixture.json'), JSON.stringify(fixture));
  console.log(JSON.stringify({ pack: fixture.pack }));
} else if (mode === 'child') {
  const processReads = { calls: 0, totalMs: 0, maxMs: 0, failures: 0, timeouts: 0 }, inspect = childProcess.execFileSync;
  childProcess.execFileSync = (file, ...args) => {
    if (file !== '/bin/ps') return inspect(file, ...args);
    const start = performance.now(); processReads.calls++;
    try { return inspect(file, ...args); }
    catch (error) { processReads.failures++; if (error.code === 'ETIMEDOUT') processReads.timeouts++; throw error; }
    finally { const ms = performance.now() - start; processReads.totalMs += ms; processReads.maxMs = Math.max(processReads.maxMs, ms); }
  };
  syncBuiltinESMExports();
  const { checkoutHostedLane } = await import(pathToFileURL(resolve(output)));
  const fixture = JSON.parse(readFileSync(join(root, 'fixture.json')));
  const laneId = randomUUID(), calls = { select: 0, objects: 0, downloads: 0, packs: 0 };
  // A streamed local stand-in for one R2 pack GET, with production checksum and
  // extraction code. Cold means an empty object store, not a purged OS page cache.
  globalThis.fetch = async url => {
    if (url !== 'https://synthetic.invalid/source-pack') throw Error('network forbidden');
    return new Response(Readable.toWeb(createReadStream(join(root, 'pack.gz'))));
  };
  const selection = { schema: 2, projectId: 'synthetic', laneId, intentId: randomUUID(), head: fixture.head, version: 0, sourceVersion: 0, lifecycleVersion: 0, state: 'active', base: { head: fixture.head, receiptId: 'base' }, authority: { mode: 'server', epoch: 1 } };
  const sample = setInterval(() => process.send?.({ rss: process.memoryUsage().rss }), 100);
  try {
    const start = performance.now();
    const result = await checkoutHostedLane(argument, { url: 'https://synthetic.invalid', projectId: 'synthetic', laneId, operationId: randomUUID() }, {
      select: async () => { calls.select++; return selection; },
      objects: async ids => { calls.objects++; return ids.map(sha256 => ({ sha256, size: statSync(join(root, 'source', sha256)).size })); },
      downloadToFile: async (pin, target) => { calls.downloads++; copyFileSync(join(root, 'source', pin.sha256), target); },
      ...(fixture.pack ? { sourcePack: async () => { calls.packs++; return { ...fixture.pack, objectKey: 'synthetic', createdAt: 0, url: 'https://synthetic.invalid/source-pack' }; } } : {}),
    });
    const metric = readFileSync(argument + '.forge-metrics.jsonl', 'utf8').trim().split('\n').map(JSON.parse).find(m => m.kind === 'checkout');
    process.send?.({ rss: process.memoryUsage().rss, result: { wallMs: performance.now() - start, ...metric.checkout, calls, processReads, downloadedObjects: result.downloadedObjects } });
  } finally { clearInterval(sample); process.disconnect?.(); }
} else if (mode === 'run') {
  const fixture = JSON.parse(readFileSync(join(root, 'fixture.json')));
  mkdirSync(output, { recursive: true });
  for (const cache of process.env.FORGE_QUALIFY_CACHE ? [process.env.FORGE_QUALIFY_CACHE] : ['cold', 'warm']) for (const n of (process.env.FORGE_QUALIFY_N ? [Number(process.env.FORGE_QUALIFY_N)] : [1, 3, 10])) {
    const cohort = mkdtempSync(join(root, 'cohort-'));
    const objects = join(cohort, 'objects');
    mkdirSync(objects);
    if (cache === 'warm') {
      for (const id of fixture.ids) copyFileSync(join(root, 'source', id), join(objects, id));
      // Seed outside the timer and finish its writes: a warm measurement must
      // not charge checkout fsync for this fixture's freshly copied cache.
      for (const id of fixture.ids) {
        const fd = openSync(join(objects, id), 'r');
        try { fsyncSync(fd); } finally { closeSync(fd); }
      }
      if (process.platform !== 'win32') {
        const fd = openSync(objects, 'r');
        try { fsyncSync(fd); } finally { closeSync(fd); }
      }
    }
    const children = [], rss = new Map();
    let peakAggregateRssBytes = 0;
    const start = performance.now();
    try {
      const results = await Promise.all(Array.from({ length: n }, (_, i) => new Promise((accept, reject) => {
        const runtime = { ...process.env, FORGE_OBJECT_CACHE: objects };
        delete runtime.UV_THREADPOOL_SIZE;
        const child = fork(import.meta.filename, ['child', root, join(cohort, `lane-${i}`), argument], { env: runtime, execArgv: [], silent: true });
        children.push(child);
        let result, stderr = '';
        child.stderr.on('data', b => stderr += b);
        child.on('message', m => {
          rss.set(child.pid, m.rss);
          peakAggregateRssBytes = Math.max(peakAggregateRssBytes, [...rss.values()].reduce((a, b) => a + b, 0));
          if (m.result) result = m.result;
        });
        child.on('exit', code => { rss.delete(child.pid); code === 0 && result ? accept(result) : reject(Error(stderr || `child exit ${code}`)); });
      })));
      for (const result of results) {
        if (result.files !== fixture.files || result.calls.select !== 2) throw Error('fixture or access-call budget differs');
        if (cache === 'warm' && (result.calls.objects || result.calls.downloads || result.calls.packs || result.downloadedObjects)) throw Error('warm open used transport');
      }
      const data = { variant, files: fixture.files, transport: fixture.pack ? 'local-source-pack' : 'local-object-pages', durableWarmSeed: cache === 'warm', cache, n, wallMs: performance.now() - start, peakAggregateRssBytes, results };
      writeFileSync(join(output, `${variant}-${fixture.files}-${cache}-n${n}.json`), JSON.stringify(data));
      console.log(JSON.stringify({ ...data, results: results.map(r => ({ wallMs: r.wallMs, phasesMs: r.phasesMs, maxRssKiB: r.maxRssKiB, calls: r.calls })) }));
    } finally {
      await Promise.all(children.filter(c => c.exitCode === null && c.signalCode === null).map(c => new Promise(r => { c.once('exit', r); c.kill('SIGTERM'); })));
      rmSync(cohort, { recursive: true, force: true });
    }
  }
} else throw Error('prepare ROOT FILES or run ROOT MODULE OUTPUT VARIANT');
