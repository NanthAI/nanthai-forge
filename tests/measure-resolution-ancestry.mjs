// SPDX-License-Identifier: Apache-2.0
// Local real-handler/R2-fake qualification; no network or repository execution.
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { scaleFixture, at } from './convex-source-scale-fixture.mjs';
import { saveBytes } from '../dist/hosted-save.js';
import { digest } from '../dist/hash.js';
import { HOSTED_WORK_INDEX_FORMAT } from '../dist/work-hosted-summary.js';

export async function measureResolutionAncestry(count, shape, width = 2048) {
  assert(count >= 200 && ['deep', 'wide'].includes(shape));
  const root = mkdtempSync(join(tmpdir(), 'forge-resolution-ancestry-')),
    s = await scaleFixture(),
    parents = new Map();
  try {
    const generationId = await s.ctx.db.insert('projectWorkGenerations', {
      projectId: s.projectId,
      backupId: 'synthetic-backup',
      format: HOSTED_WORK_INDEX_FORMAT,
      revision: 0,
      initialRevision: 0,
      status: 'ready',
      nextBatch: 0,
      metadata: '{}',
    });
    await s.ctx.db.patch(s.projectId, {
      work: {
        generationId,
        backupId: 'synthetic-backup',
        operationId: 'seed',
        initialRevision: 0,
        revision: 0,
      },
    });
    const stable = await s.putSpec(Buffer.from('unchanged\n')),
      file = (path, pin) => ({ path, mode: 'file', blob: pin.sha256 }),
      files = Array.from({ length: width }, (_, i) => file(`src/${String(i).padStart(6, '0')}.ts`, stable));
    async function state(edges = [], content = files) {
      const bytes = Buffer.from(
          saveBytes({
            schema: 1,
            kind: 'forge-source-state',
            files: content,
            parents: edges,
            message: `state-${parents.size}`,
            at,
          }),
        ),
        pin = { sha256: digest(bytes), size: bytes.length },
        path = join(root, pin.sha256);
      writeFileSync(path, bytes);
      // Historical bytes stay on disk, exactly as remote R2 would: never retain
      // all manifests in the coordinator or pass them to a worker at once.
      await s.putSpec({ path, size: bytes.length }, pin);
      parents.set(pin.sha256, edges);
      await s.ctx.db.insert('projectWorkRecords', {
        projectId: s.projectId,
        generationId,
        collection: 'sourceStateParents',
        key: pin.sha256,
        parent: '',
        position: parents.size,
        value: JSON.stringify({ parents: edges }),
      });
      return pin;
    }
    const branches = shape === 'wide' ? 128 : 2,
      depth = shape === 'wide' ? 2 : 40,
      recentCount = branches * depth + 3,
      oldCount = count - recentCount;
    let olderA = await state(),
      olderB = await state();
    for (let i = 2; i < oldCount; i++) {
      if (i % 2) olderA = await state([olderA.sha256]);
      else olderB = await state([olderB.sha256]);
    }
    const base = await state([olderA.sha256, olderB.sha256]),
      tips = [];
    for (let i = 0; i < branches; i++) {
      let tip = base;
      for (let j = 0; j < depth; j++) tip = await state([tip.sha256]);
      tips.push(tip.sha256);
    }
    const leftFile = file('conflict', await s.putSpec(Buffer.from('left\n'))),
      rightFile = file('conflict', await s.putSpec(Buffer.from('right\n'))),
      left = await state(tips, [leftFile, ...files]),
      right = await state([base.sha256], [rightFile, ...files]);
    assert.equal(parents.size, count);
    const conflicts = await s.json({
        schema: 1,
        kind: 'forge-hosted-compose-conflicts',
        left: left.sha256,
        right: right.sha256,
        paths: [{ path: 'conflict', base: null, left: leftFile, right: rightFile }],
        next: null,
      }),
      input = await s.json({
        schema: 1,
        kind: 'forge-hosted-sync-input',
        algorithm: 'forge-native-sync-v1',
        work: { mode: 'resolution', candidateId: '00000000-0000-4000-8000-000000000001', conflicts },
        message: 'resolution',
        at,
      }),
      jobId = await s.enqueue(input),
      report = await s.drain(),
      job = await s.job(jobId);
    assert.equal(job.status, 'completed', JSON.stringify(job));
    const output = JSON.parse(await s.bytes(job.output)),
      draft = JSON.parse(await s.bytes(output.result.state));
    assert.equal(output.result.status, 'conflict');
    assert.deepEqual(draft.parents, [left.sha256]);
    assert.equal(draft.files.length, width + 1);
    assert.equal(s.blobs.size, 0, 'all source and progress bytes use R2');
    const tasks = [...s.tables.projectSourceTasks.values()],
      batches = [...s.tables.projectSourceBatches.values()],
      idleCalls = s.calls.length;
    await Promise.resolve();
    assert.equal(s.calls.length, idleCalls);
    assert.equal(s.ready.length, 0);
    return {
      count,
      shape,
      filesPerState: width,
      ...report,
      stateTasks: tasks.filter(task => JSON.parse(task.input).kind === 'states').length,
      stateFanoutBatches: batches.filter(batch => batch.kind === 'states').length,
      jobSeconds: report.actionMs / 1000,
      output: job.output,
      draft: output.result.state,
      idleCalls: 0,
      convexStorageCalls: report.storageCalls,
    };
  } finally {
    s.restore();
    rmSync(root, { recursive: true, force: true });
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  console.log(
    JSON.stringify(
      await measureResolutionAncestry(Number(process.argv[2] ?? 2800), process.argv[3] ?? 'deep'),
    ),
  );
}
