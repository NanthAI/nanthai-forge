// SPDX-License-Identifier: Apache-2.0
// Separate process: fixture construction is excluded from action peak measurements.
import assert from 'node:assert/strict';
import { readFile, writeFile, stat } from 'node:fs/promises';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';
import { getFunctionName } from 'convex/server';
import { moduleUrl } from './convex-module.mjs';
import { buildExchangeRoot, resolveExchangeRoot } from '../dist/native-exchange-tree.js';
import { workSchema } from '../dist/work-types.js';
import { sourceReturnChunks, validateSourceReturnChunk } from '../dist/work-source-return-chunks.js';
import { parseWorkBytes } from '../dist/work-metadata.js';
import { jsonChunks } from '../dist/json-chunks.js';
import { digest } from '../dist/hash.js';
const [mode, directory] = process.argv.slice(2);
if (mode === 'fixture') {
  const data = workSchema.parse({
    schema: 15,
    revision: 16481,
    nativeHead: digest('state-0'),
    intents: [],
    lanes: [],
    views: [],
  });
  for (let i = 0; i < 22845; i++)
    data.intents.push({
      id: randomUUID(),
      base: data.nativeHead,
      outcome: `Retained ${i}`,
      constraints: '',
      status: 'completed',
      createdAt: 'now',
      notes: [{ kind: 'comment', text: `Synthetic ${i} ${'history '.repeat(498)}`, at: 'now' }],
    });
  const work = Buffer.from(JSON.stringify(data, null, 2)),
    manifest = {
      schema: 1,
      kind: 'forge-native-work-backup',
      id: randomUUID(),
      head: data.nativeHead,
      revision: data.revision,
      files: [
        { path: 'work.json', sha256: digest(work), size: work.length },
        ...Array.from({ length: 22845 }, (_, i) => {
          const sha256 = digest(`state-${i}`);
          return { path: `objects/${sha256}`, sha256, size: 0 };
        }),
      ],
      unavailable: [],
      coverage: 'Synthetic',
    };
  const tree = buildExchangeRoot(Buffer.from(JSON.stringify(manifest)), work);
  for (const [hash, bytes] of tree.objects) writeFileSync(join(directory, hash), bytes);
  const pin = { sha256: digest(tree.bytes), size: tree.bytes.length };
  writeFileSync(join(directory, pin.sha256), tree.bytes);
  const backup = {
    _id: 'candidate',
    projectId: 'project',
    digest: pin.sha256,
    size: pin.size,
    status: 'stored',
    transport: 'objects',
    preview: { format: 'native', revision: data.revision, manifestDigest: digest(JSON.stringify(manifest)) },
  };
  const empty = sourceReturnChunks(data).next().value.data,
    chunks = [];
  for (const [i, chunk] of [...sourceReturnChunks(data)].entries()) {
    const id = `history-${i}`;
    writeFileSync(join(directory, id), gzipSync(Buffer.from(JSON.stringify(chunk))));
    chunks.push(id);
  }
  writeFileSync(
    join(directory, 'fixture.json'),
    JSON.stringify({
      backup,
      empty,
      chunks,
      workDigest: digest(work),
      workBytes: work.length,
      objects: 22845,
      records: 22845,
    }),
  );
  console.log(
    JSON.stringify({ workBytes: work.length, objects: 22845, records: 22845, chunks: chunks.length }),
  );
} else {
  const { prepareLargeReturn } = await import(moduleUrl('../convex/projectSourceReturnPrepare.ts'));
  const { exchangeObjectReader } = await import(moduleUrl('../convex/projectExchangeReader.ts'));
  const { forgetReturnCursors } = await import(moduleUrl('../convex/projectSourceReturnCursor.ts'));
  const config = JSON.parse(readFileSync(join(directory, 'fixture.json'))),
    backup = config.backup;
  const project = { _id: 'project', key: randomUUID(), work: { backupId: 'prior', revision: 16481 } };
  const input = {
    projectId: 'project',
    backupId: 'candidate',
    expectedBackupId: 'prior',
    revision: 16481,
    operationId: randomUUID(),
  };
  const prior = { ...backup, _id: 'prior' },
    stage = {
      _id: 'partition',
      returnPrepareCursor: JSON.stringify({ partitionId: 'partition', key: 'position', parts: 1 }),
    };
  const position = {
    input,
    generationId: 'generation',
    phase: 'source',
    current: { project, backup: prior, data: config.empty, manifest: {}, events: [] },
    before: { lanes: [] },
    chunks: config.chunks,
    offset: 0,
  };
  writeFileSync(join(directory, 'page-position-0'), JSON.stringify(position));
  let sampledHeap = 0,
    invocations = 0,
    longestInvocationMs = 0,
    projectionPages = 0;
  const sample = () => {
    sampledHeap = Math.max(sampledHeap, process.memoryUsage().heapUsed);
  };
  const ctx = {
    auth: { getUserIdentity: async () => ({ subject: 'owner' }) },
    runQuery: async (ref, args) => {
      sample();
      switch (getFunctionName(ref)) {
        case 'projectObjects:resolve':
          return Promise.all(
            args.digests.map(async sha256 => ({
              projectId: 'project',
              digest: sha256,
              size: (await stat(join(directory, sha256))).size,
              storageId: sha256,
            })),
          );
        case 'projectWork:get':
          return project;
        case 'projectWork:events':
          return { page: [], isDone: true, continueCursor: '' };
        case 'projectBackups:get':
          return { backup, project };
        case 'projectReturnMetadataStore:readBatch':
          assert(args.count <= 64);
          return Promise.all(
            Array.from({ length: args.count }, (_, index) =>
              readFile(join(directory, `page-${args.key}-${args.position + index}`), 'utf8'),
            ),
          );
        case 'projectReturnMetadataStore:read':
          return readFile(join(directory, `page-${args.key}-${args.position}`), 'utf8');
        default:
          assert.fail(getFunctionName(ref));
      }
    },
    runMutation: async (ref, args) => {
      sample();
      switch (getFunctionName(ref)) {
        case 'projectReturnMetadataStore:putBatch':
          assert(args.bodies.length <= 64);
          assert(args.bodies.reduce((sum, body) => sum + Buffer.byteLength(body), 0) <= 2 * 1024 * 1024);
          for (const [index, body] of args.bodies.entries()) {
            await writeFile(join(directory, `page-${args.key}-${args.position + index}`), body);
          }
          return null;
        case 'projectReturnMetadataStore:put':
          await writeFile(join(directory, `page-${args.key}-${args.position}`), args.body);
          return null;
        case 'projectReturnIndexStage:prepare':
          stage.returnPrepareCursor = args.cursor;
          return true;
        default:
          assert.fail(getFunctionName(ref));
      }
    },
    storage: {
      get: async id => {
        sample();
        return new Blob([await readFile(join(directory, id))]);
      },
      store: async blob => {
        sample();
        const id = randomUUID();
        await writeFile(join(directory, id), Buffer.from(await blob.arrayBuffer()));
        return id;
      },
      getMetadata: async id => {
        // Convex metadata reads return pins, not a second read of source bytes.
        if (/^[0-9a-f]{64}$/.test(id)) return { size: (await stat(join(directory, id))).size, sha256: id };
        const bytes = await readFile(join(directory, id));
        return { size: bytes.length, sha256: digest(bytes) };
      },
    },
  };
  const reader = exchangeObjectReader(ctx, mode === 'before', mode === 'before' ? 8 * 1024 * 1024 : 0);
  const started = performance.now();
  global.gc();
  if (mode === 'journal') {
    const { exportJournal } = await import(moduleUrl('../convex/projectWorkActions.ts'));
    project.name = 'Synthetic';
    project.work = { backupId: backup._id, revision: 16481, initialRevision: 16481 };
    const journal = JSON.parse(await exportJournal._handler(ctx, { projectId: 'project' }));
    assert.equal(journal.revision, 16481);
    assert.equal(journal.workSha256, config.workDigest);
    assert.deepEqual(journal.events, []);
    sample();
  } else if (mode === 'before') {
    // Exact pre-change candidate load/validate and snapshot compression behavior.
    async function candidateLoad() {
      const resolved = await resolveExchangeRoot(
        await readFile(join(directory, backup.digest)),
        pins => reader.read('project', 'owner', pins),
        { batchSize: 100 },
      );
      const data = parseWorkBytes(resolved.work);
      const candidate = {
        project,
        backup,
        data,
        manifest: JSON.parse(resolved.manifest),
        originalWorkDigest: digest(resolved.work),
      };
      sample();
      const body = gzipSync(
        Buffer.concat(Array.from(jsonChunks(candidate), chunk => new TextEncoder().encode(chunk))),
      );
      sample();
      return body;
    }
    const body = await candidateLoad();
    global.gc();
    const candidate = JSON.parse(gunzipSync(body).toString('utf8'));
    assert.equal(candidate.data.intents.length, 22845);
    for (const id of config.chunks) {
      const chunk = JSON.parse(gunzipSync(await readFile(join(directory, id))).toString('utf8'));
      validateSourceReturnChunk(chunk, candidate.data, candidate.manifest);
      sample();
    }
    sample();
  } else {
    const invoke = async () => {
      invocations++;
      const start = performance.now();
      const result = await prepareLargeReturn(ctx, input, 'owner', reader, backup, prior, stage);
      longestInvocationMs = Math.max(longestInvocationMs, performance.now() - start);
      return result;
    };
    assert.deepEqual(await invoke(), {
      pending: true,
    });
    forgetReturnCursors();
    global.gc();
    assert.deepEqual(await invoke(), {
      pending: true,
    });
    const ref = JSON.parse(stage.returnPrepareCursor);
    const saved = JSON.parse(
      (
        await Promise.all(
          Array.from({ length: ref.parts }, (_, i) =>
            readFile(join(directory, `page-${ref.key}-${i}`), 'utf8'),
          ),
        )
      ).join(''),
    );
    assert.equal(saved.phase, 'validate');
    assert.equal(saved.offset, 0, 'record layout commits before validation resumes');
    assert.equal(saved.records.refs.flatMap(ref => ref.ids).length, 22845);
    projectionPages = saved.records.refs.length;
    forgetReturnCursors();
    global.gc();
    assert.deepEqual(await invoke(), { pending: true });
    const nextRef = JSON.parse(stage.returnPrepareCursor);
    const next = JSON.parse(
      (
        await Promise.all(
          Array.from({ length: nextRef.parts }, (_, i) =>
            readFile(join(directory, `page-${nextRef.key}-${i}`), 'utf8'),
          ),
        )
      ).join(''),
    );
    assert.equal(next.offset, 8, 'cold validation advanced exactly one bounded chunk budget');
    forgetReturnCursors();
    global.gc();
    // Complete every remaining chunk with the production invocation budget.
    // Cold workers retain neither a parsed candidate nor its compressed memo.
    let prepared;
    do {
      forgetReturnCursors();
      global.gc();
      prepared = await invoke();
    } while (prepared.pending);
    assert.equal(prepared.records.refs.flatMap(ref => ref.ids).length, 22845);
    assert.equal(prepared.records.projected, projectionPages);
    assert.equal(prepared.candidate.data.intents.length, 1, 'only distinct source bases remain in context');
    assert.equal(prepared.candidate.manifest.files.length, 22846);
    assert.equal(invocations, 2 + Math.ceil(config.chunks.length / 8) + Math.ceil(projectionPages / 32));
    sample();
  }
  global.gc();
  console.log(
    `MEMORY_RESULT ${JSON.stringify({ mode, ...{ workBytes: config.workBytes, objects: config.objects, records: config.records }, sampledHeap, invocations, longestInvocationMs, validationChunks: config.chunks.length, projectionPages, maxRSS: process.resourceUsage().maxRSS * 1024, elapsedMs: performance.now() - started })}`,
  );
}
