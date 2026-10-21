// SPDX-License-Identifier: Apache-2.0
// Producer/consumer separation keeps fixture construction outside the action peak.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { readFile, writeFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { getFunctionName } from 'convex/server';
import { ConvexError } from 'convex/values';
import { moduleUrl } from './convex-module.mjs';
import { workSchema } from '../dist/work-types.js';
import { sourceReturnChunks } from '../dist/work-source-return-chunks.js';
import { computeOwnerDerived } from '../dist/owner-derived.js';
import { digest } from '../dist/hash.js';
const [mode, directory] = process.argv.slice(2);
if (mode === 'fixture') {
  const head = digest('synthetic-state'),
    data = workSchema.parse({
      schema: 19,
      revision: 17096,
      nativeHead: head,
      intents: [],
      lanes: [],
      views: [],
    });
  for (let i = 0; i < 22845; i++)
    data.intents.push({
      id: randomUUID(),
      base: head,
      outcome: `Retained ${i}`,
      constraints: '',
      status: 'completed',
      createdAt: 'now',
      notes: [{ kind: 'comment', text: `Synthetic ${i} ${'history '.repeat(498)}`, at: 'now' }],
    });
  for (let i = 0; i < 347; i++)
    data.lanes.push({
      id: randomUUID(),
      intentId: data.intents[i].id,
      base: head,
      head,
      name: `Lane ${i}`,
      assignment: '',
      target: '',
      state: 'active',
      checkpoints: [],
    });
  for (let i = 0; i < 1079; i++)
    data.views.push({
      id: randomUUID(),
      intentId: data.intents[i].id,
      base: head,
      head,
      inputs: [],
      status: 'clean',
      details: '',
      at: 'now',
    });
  const work = Buffer.from(JSON.stringify(data, null, 2)),
    workSha256 = digest(work),
    manifest = {
      schema: 1,
      kind: 'forge-native-work-backup',
      id: randomUUID(),
      head,
      revision: data.revision,
      files: [
        { path: 'work.json', sha256: workSha256, size: work.length },
        ...Array.from({ length: 14704 }, (_, i) => {
          const sha256 = i ? digest(`pin-${i}`) : head;
          return { path: `objects/${sha256}`, sha256, size: 100000 };
        }),
      ],
      unavailable: [],
      coverage: 'Synthetic logical pins; server must use owner display without reading source.',
    };
  manifest.files[1].size += 1461289991 - manifest.files.reduce((n, p) => n + p.size, 0);
  const owner = computeOwnerDerived(data, { state: () => ({ parents: [], files: [] }) }),
    derived = Buffer.from(JSON.stringify(owner)),
    ownerDerived = { sha256: digest(derived), size: derived.length },
    backup = {
      _id: 'candidate',
      projectId: 'project',
      status: 'stored',
      transport: 'objects',
      digest: digest('candidate-root'),
      size: 10,
      displayProtocol: 3,
      ownerDerived,
      preview: { format: 'native', revision: data.revision },
    },
    project = {
      _id: 'project',
      key: randomUUID(),
      work: { backupId: 'prior', revision: 16868, generationId: 'generation' },
    },
    prior = { ...backup, _id: 'prior', digest: digest('prior-root') },
    empty = sourceReturnChunks(data).next().value.data;
  empty.revision = 16868;
  const input = {
      projectId: 'project',
      backupId: 'candidate',
      expectedBackupId: 'prior',
      revision: 16868,
      operationId: randomUUID(),
      continuation: true,
    },
    position = {
      input: { ...input, continuation: undefined },
      generationId: 'generation',
      phase: 'validate',
      current: { project, backup: prior, data: empty, manifest: {}, events: [] },
      before: { lanes: data.lanes.map(({ id, head }) => ({ id, head })) },
      chunks: ['last-chunk'],
      offset: 0,
      candidate: 'candidate-snapshot',
    },
    candidate = { backup, project, manifest, data, originalWorkDigest: workSha256 };
  writeFileSync(join(directory, 'candidate-snapshot'), gzipSync(Buffer.from(JSON.stringify(candidate))));
  writeFileSync(
    join(directory, 'last-chunk'),
    gzipSync(Buffer.from(JSON.stringify({ data: empty, offset: 0, hostedMoves: 0 }))),
  );
  writeFileSync(join(directory, ownerDerived.sha256), derived);
  writeFileSync(join(directory, 'position-0'), JSON.stringify(position));
  writeFileSync(
    join(directory, 'fixture.json'),
    JSON.stringify({
      input,
      backup,
      prior,
      project,
      workSha256,
      workBytes: work.length,
      objects: manifest.files.length,
      logicalBytes: manifest.files.reduce((n, p) => n + p.size, 0),
      views: data.views.length,
      lanes: data.lanes.length,
    }),
  );
} else {
  const { returnSource } = await import(moduleUrl('../convex/projectSourceReturn.ts')),
    { forgetReturnCursors } = await import(moduleUrl('../convex/projectSourceReturnCursor.ts')),
    config = JSON.parse(readFileSync(join(directory, 'fixture.json'))),
    { input, backup, prior, project } = config,
    stage = {
      _id: 'partition',
      backupId: 'candidate',
      revision: 17097,
      returnAt: '2026-10-21T13:41:43.000Z',
      returnOperationId: input.operationId,
      returnPrepareCursor: JSON.stringify({ partitionId: 'partition', key: 'position', parts: 1 }),
      nextBatch: 0,
      returnStep: 0,
    },
    generation = { _id: 'generation', backupId: 'prior', revision: 16868 };
  let sampledHeap = 0,
    maxPageBytes = 0,
    rows = 0,
    invocations = 0,
    fail = mode === 'recover',
    loseBatchReply = true,
    receipt;
  const sample = () => {
    sampledHeap = Math.max(sampledHeap, process.memoryUsage().heapUsed);
  };
  const ctx = {
    auth: { getUserIdentity: async () => ({ subject: 'owner' }) },
    runQuery: async (ref, args) => {
      sample();
      switch (getFunctionName(ref)) {
        case 'projectWork:owner':
          return project;
        case 'projectWork:get':
          return project;
        case 'projectBackups:get':
          return { project, backup: args.id === 'candidate' ? backup : prior };
        case 'projectWork:find':
          return receipt ?? null;
        case 'projectReturnIndexStage:resume':
          return { ...stage };
        case 'projectWorkIndexStore:current':
          return generation;
        case 'projectReturnMetadataStore:read':
          return readFile(join(directory, `${args.key}-${args.position}`), 'utf8');
        case 'projectObjects:resolve':
          return Promise.all(
            args.digests.map(async sha256 => ({
              projectId: 'project',
              digest: sha256,
              size: (await stat(join(directory, sha256))).size,
              storageId: sha256,
            })),
          );
        default:
          assert.fail(getFunctionName(ref));
      }
    },
    runMutation: async (ref, args) => {
      sample();
      switch (getFunctionName(ref)) {
        case 'projectReturnIndexStage:begin':
          if (fail) {
            fail = false;
            throw new ConvexError({
              code: 'HOSTED_ACTION_FAILED',
              message: 'synthetic failure after prepared',
            });
          }
          return 'partition';
        case 'projectReturnMetadataStore:put':
          maxPageBytes = Math.max(maxPageBytes, Buffer.byteLength(args.body));
          await writeFile(join(directory, `${args.key}-${args.position}`), args.body);
          return null;
        case 'projectReturnIndexStage:batch':
          rows += args.entries.length;
          stage.nextBatch++;
          stage.returnStep = args.step + 1;
          stage.returnMetadataCursor = args.metadataCursor;
          stage.returnMetadataSnapshot = args.metadataSnapshot;
          if (args.last) stage.status = 'ready';
          if (loseBatchReply) {
            loseBatchReply = false;
            throw new ConvexError({ code: 'HOSTED_ACTION_FAILED', message: 'lost batch reply' });
          }
          return true;
        case 'projectWork:returnSource':
          assert.equal(JSON.parse(args.command).workSha256, config.workSha256);
          assert.equal(args.operationId, input.operationId);
          assert.equal(args.at, stage.returnAt);
          receipt = {
            operationId: args.operationId,
            command: args.command,
            request: args.request,
            at: args.at,
            revision: 17097,
          };
          return receipt;
        default:
          assert.fail(getFunctionName(ref));
      }
    },
    storage: {
      get: async id => {
        sample();
        return new Blob([await readFile(join(directory, id))]);
      },
      getMetadata: async id => {
        const bytes = await readFile(join(directory, id));
        return { size: bytes.length, sha256: digest(bytes) };
      },
    },
  };
  const start = performance.now();
  if (fail) {
    await assert.rejects(returnSource._handler(ctx, input), /synthetic failure after prepared/);
    invocations++;
    forgetReturnCursors();
    global.gc();
  }
  let result;
  do {
    invocations++;
    try {
      result = await returnSource._handler(ctx, input);
    } catch (error) {
      if (error.data?.code !== 'HOSTED_ACTION_FAILED' || error.data.message !== 'lost batch reply')
        throw error;
      result = { pending: true };
    }
    forgetReturnCursors();
    global.gc();
  } while (result.pending && invocations < 100);
  assert.equal(result.revision, 17097);
  assert.ok(rows > 22845);
  assert.ok(invocations > 2, 'resumed cold output cursors after the original prepared failure');
  assert.ok(maxPageBytes <= 128 * 1024);
  const replay = await returnSource._handler(ctx, input);
  assert.equal(replay.operationId, result.operationId);
  assert.equal(replay.at, result.at);
  sample();
  console.log(
    `MEMORY_RESULT ${JSON.stringify({ ...config, project: undefined, backup: undefined, prior: undefined, input: undefined, sampledHeap, maxRSS: process.resourceUsage().maxRSS * 1024, maxPageBytes, rows, invocations, elapsedMs: performance.now() - start })}`,
  );
}
