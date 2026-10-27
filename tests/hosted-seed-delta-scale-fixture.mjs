// SPDX-License-Identifier: Apache-2.0
import { mkdirSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fork } from 'node:child_process';
import { makeFunctionReference, getFunctionName } from 'convex/server';
import { moduleUrl } from './convex-module.mjs';

// The in-memory provider otherwise scans every object for each indexed lookup.
export function indexObjects(s) {
  const query = s.ctx.db.query,
    insert = s.ctx.db.insert;
  const byDigest = new Map(),
    byNonce = new Map();
  const keep = row => {
    byDigest.set(JSON.stringify([row.projectId, row.digest]), row);
    byNonce.set(row.nonce, row);
  };
  for (const row of s.tables.projectObjects.values()) keep(row);
  s.ctx.db.insert = async (table, row) => {
    const id = await insert(table, row);
    if (table === 'projectObjects') keep(s.tables.projectObjects.get(id));
    return id;
  };
  s.ctx.db.query = table => {
    if (table !== 'projectObjects') return query(table);
    return {
      withIndex(name, filter) {
        const eq = new Map(),
          q = {
            eq(key, value) {
              eq.set(key, value);
              return q;
            },
          };
        filter(q);
        if (name !== 'by_project_and_digest' && name !== 'by_nonce')
          return query(table).withIndex(name, filter);
        return {
          unique: async () =>
            structuredClone(
              name === 'by_nonce'
                ? (byNonce.get(eq.get('nonce')) ?? null)
                : (byDigest.get(JSON.stringify([eq.get('projectId'), eq.get('digest')])) ?? null),
            ),
        };
      },
    };
  };
}

/** Model Convex accurately: query/mutation DB state stays outside action memory. */
export async function measurePublication(s, input, directory) {
  mkdirSync(directory);
  for (const [id, file] of s.files)
    if (!file.unreferenced) writeFileSync(join(directory, id), Buffer.from(await file.blob.arrayBuffer()));
  writeFileSync(join(directory, 'fixture.json'), JSON.stringify(input));
  let reads = 0,
    writes = 0;
  const originals = {
    get: s.ctx.db.get,
    query: s.ctx.db.query,
    insert: s.ctx.db.insert,
    patch: s.ctx.db.patch,
  };
  s.ctx.db.get = async id => {
    const row = await originals.get(id);
    reads += row ? 1 : 0;
    return row;
  };
  const observe = builder =>
    new Proxy(builder, {
      get(target, key) {
        const value = target[key];
        if (typeof value !== 'function') return value;
        return (...args) => {
          const result = value.apply(target, args);
          if (result?.then)
            return result.then(rows => {
              reads += Array.isArray(rows) ? rows.length : rows?.page ? rows.page.length : rows ? 1 : 0;
              return rows;
            });
          return result && typeof result === 'object' ? observe(result) : result;
        };
      },
    });
  s.ctx.db.query = table => observe(originals.query(table));
  for (const method of ['insert', 'patch'])
    s.ctx.db[method] = (...args) => {
      writes++;
      return originals[method](...args);
    };
  // A deployed action executes compiled JS; never count the test TypeScript compiler.
  const moduleDirectory = dirname(fileURLToPath(moduleUrl('../convex/projectExchangeActions.ts')));
  const child = fork(fileURLToPath(import.meta.url), [directory], {
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    env: {
      PATH: process.env.PATH,
      FORGE_TEST_MODULE_DIRECTORY: moduleDirectory,
      FORGE_TEST_PRECOMPILED: '1',
    },
    execArgv: ['--expose-gc', '--max-old-space-size=192', '--import', './tests/check-runtime.mjs'],
    silent: true,
  });
  let output = '',
    metrics;
  for (const stream of [child.stdout, child.stderr])
    stream.on('data', bytes => {
      output += bytes;
    });
  child.on('message', async message => {
    if (message.kind === 'complete') {
      metrics = message.result;
      return;
    }
    try {
      const value =
        message.kind === 'metadata'
          ? await s.ctx.storage.getMetadata(message.id)
          : await s.ctx[message.kind === 'query' ? 'runQuery' : 'runMutation'](
              makeFunctionReference(message.name),
              message.args,
            );
      child.send({ sequence: message.sequence, value });
    } catch (error) {
      child.send({ sequence: message.sequence, error: String(error) });
    }
  });
  try {
    await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', code =>
        code === 0 && metrics
          ? resolve()
          : reject(new Error(`Publication measurement failed (${code}): ${output}`)),
      );
    });
    return { ...metrics, documentsRead: reads, documentsWritten: writes };
  } finally {
    Object.assign(s.ctx.db, originals);
    child.kill();
  }
}

async function run(directory) {
  const { publish } = await import(moduleUrl('../convex/projectExchangeActions.ts'));
  const input = JSON.parse(readFileSync(join(directory, 'fixture.json')));
  let sequence = 0,
    calls = 0,
    storageMetadataReads = 0,
    storageReads = 0,
    storageBytes = 0;
  let peakRssBytes = 0;
  const sample = () => {
    peakRssBytes = Math.max(peakRssBytes, process.memoryUsage().rss);
  };
  const pending = new Map();
  process.on('message', message => {
    const callback = pending.get(message.sequence);
    pending.delete(message.sequence);
    if (message.error) callback.reject(new Error(message.error));
    else callback.resolve(message.value);
  });
  const remote = (kind, data) =>
    new Promise((resolve, reject) => {
      const id = sequence++;
      pending.set(id, { resolve, reject });
      process.send({ kind, sequence: id, ...data });
    }).then(value => {
      sample();
      return value;
    });
  const ctx = {
    auth: { getUserIdentity: async () => ({ subject: 'owner' }) },
    runQuery: (ref, args) => {
      calls++;
      return remote('query', { name: getFunctionName(ref), args });
    },
    runMutation: (ref, args) => {
      calls++;
      return remote('mutation', { name: getFunctionName(ref), args });
    },
    storage: {
      getMetadata: id => {
        storageMetadataReads++;
        return remote('metadata', { id });
      },
      get: async id => {
        const path = join(directory, id);
        if (statSync(path).size > 2 * 1024 * 1024)
          throw new Error('Publication read an unbounded logical Work object.');
        const bytes = readFileSync(path);
        storageReads++;
        storageBytes += bytes.length;
        sample();
        return {
          arrayBuffer: async () =>
            bytes.byteOffset === 0 && bytes.length === bytes.buffer.byteLength
              ? bytes.buffer
              : bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length),
        };
      },
    },
  };
  const logs = [];
  console.log = (...args) => logs.push(args);
  global.gc?.();
  const baselineRssBytes = process.memoryUsage().rss;
  peakRssBytes = baselineRssBytes;
  const started = performance.now();
  const backupId = await publish._handler(ctx, input);
  const { backup } = await ctx.runQuery(makeFunctionReference('projectBackups:get'), {
    id: backupId,
    owner: 'owner',
  });
  sample();
  process.send({
    kind: 'complete',
    result: {
      calls,
      storageMetadataReads,
      storageReads,
      storageBytes,
      elapsedMs: performance.now() - started,
      baselineRssBytes,
      peakRssBytes,
      // Linux rusage retains the fork parent's pre-exec high-water mark.
      // VmHWM belongs to this post-exec address space and excludes fixture setup.
      processPeakRssBytes:
        process.platform === 'linux'
          ? Number(/^VmHWM:\s+(\d+)/m.exec(readFileSync('/proc/self/status', 'utf8'))[1]) * 1024
          : process.resourceUsage().maxRSS * 1024,
      validatedWorkRecords: backup.validatedWorkRecords,
      logs,
    },
  });
  process.disconnect();
}
if (process.argv[1] === fileURLToPath(import.meta.url)) await run(process.argv[2]);
