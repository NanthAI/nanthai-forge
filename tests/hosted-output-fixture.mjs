// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { checksFixture } from './hosted-checks-fixture.mjs';
import { moduleUrl } from './convex-module.mjs';
import { outputMessage, signOutput } from '../dist/hosted-check-output.js';
export const store = await import(moduleUrl('../convex/projectHostedOutputStore.ts'));
export const read = await import(moduleUrl('../convex/projectHostedOutputRead.ts'));
export const api = await import(moduleUrl('../convex/projectHostedOutputApi.ts'));
const schema = (await import(moduleUrl('../convex/schema.ts'))).default;
export const key = 'synthetic-output-collector-key';
export async function outputFixture() {
  const s = await checksFixture();
  const run = await s.activate((await s.enqueue(s.selection())).id);
  const stream = { shard: 0, attempt: 0, executionId: 'synthetic-shard-0', stream: 'stdout', name: '' };
  const call = async (name, fn, args, actor = 'owner') => {
    try {
      return await s.call(name, fn, args, actor);
    } finally {
      for (const [table, rows] of Object.entries(s.tables)) {
        if (!table.startsWith('projectHostedOutput')) continue;
        const fields = schema.tables[table].export().documentType.value;
        for (const row of rows.values()) {
          assert(Object.keys(row).every(k => ['_id', '_creationTime'].includes(k) || k in fields));
          for (const [k, f] of Object.entries(fields)) assert(f.optional || k in row);
        }
      }
    }
  };
  const apply = (body, overrides = {}, signature = null) => {
    const message = { ...outputMessage(run, body), ...overrides };
    return call(
      'outputCommit',
      { _handler: (ctx, input) => store.commitHostedOutput(ctx, input, () => key) },
      { projectId: s.projectId, message, signature: signature ?? signOutput(message, key) },
    );
  };
  const identity = { projectId: s.projectId, runId: run.id };
  const manifest = actor => call('outputManifest', read.manifest, identity, actor).then(JSON.parse);
  const chunks = (after = 0, actor = 'owner') =>
    call('outputChunkPage', read.chunks, { ...identity, after }, actor).then(JSON.parse);
  const streams = (cursor = null, actor = 'owner') =>
    call('outputStreamPage', read.streams, { ...identity, cursor }, actor).then(JSON.parse);
  return { ...s, check: run, stream, apply, call, identity, manifest, chunks, streams };
}
