// SPDX-License-Identifier: Apache-2.0
import { randomUUID } from 'node:crypto';
import { moduleUrl } from './convex-module.mjs';
import { composeFixture } from './hosted-compose-fixture.mjs';
import { saveBytes, savePin, buildSavePages } from '../dist/hosted-save.js';
export const api = await import(moduleUrl('../convex/projectHostedSync.ts'));
export const jobApi = await import(moduleUrl('../convex/projectHostedSyncJobs.ts'));
export const records = await import(moduleUrl('../convex/projectHostedRecords.ts'));
const saves = await import(moduleUrl('../convex/projectHostedSaves.ts'));
const saveJobs = await import(moduleUrl('../convex/projectHostedSaveJobs.ts'));
export { code } from './hosted-compose-fixture.mjs';
export async function syncFixture() {
  const s = await composeFixture();
  const request = (kind, extra = {}) => ({
    operationId: randomUUID(),
    authorityEpoch: 1,
    kind,
    message: 'Explicit hosted sync',
    ...extra,
  });
  const pins = lane => ({
    head: lane.head,
    version: lane.version,
    sourceVersion: lane.sourceVersion,
    lifecycleVersion: lane.lifecycleVersion,
  });
  const prepare = r =>
    s
      .call('syncPrepare', api.prepare, { projectId: s.projectId, request: JSON.stringify(r) })
      .then(JSON.parse);
  const progress = r =>
    s
      .call('syncProgress', api.progress, { projectId: s.projectId, operationId: r.operationId })
      .then(JSON.parse);
  const withWorker = async fn => {
    const env = {
        FORGE_SOURCE_PROVIDER: 'convex',
        FORGE_SOURCE_WORKER: 'fixed-worker',
        FORGE_SOURCE_RUNTIME: 'a'.repeat(64),
        FORGE_SOURCE_KEY_ID: 'SYNTHETIC',
      },
      old = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
    Object.assign(process.env, env);
    try {
      return await fn();
    } finally {
      for (const [key, value] of Object.entries(old)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  };
  const submit = async r => {
    const p = await progress(r);
    s.put(saveBytes(p.input));
    return withWorker(() =>
      s
        .call('syncSubmit', jobApi.submit, { projectId: s.projectId, operationId: r.operationId })
        .then(JSON.parse),
    );
  };
  const work = async r => {
    const result = await s.compute((await progress(r)).input);
    const row = [...s.tables.projectHostedSyncs.values()].find(row => row.operationId === r.operationId);
    const job = await s.activate(row.jobId);
    await s.callback(job, { status: 'completed', output: result.output });
    return { ...result, jobId: job.id };
  };
  const publish = output =>
    s
      .call('syncPublish', jobApi.publish, {
        projectId: s.projectId,
        jobId: output.jobId,
        result: output.manifest,
      })
      .then(JSON.parse);
  const execute = async r => {
    await prepare(r);
    await submit(r);
    const output = await work(r);
    return { terminal: await publish(output), output };
  };
  const readLane = async laneId => {
    const row = await s.run('readLane', ctx =>
      records.readHostedRecord(ctx, { ...s.auth, kind: 'lane', key: laneId }),
    );
    const record = JSON.parse(row.value);
    return {
      record,
      entry: {
        laneId,
        ...pins(record),
        state: { object: { sha256: record.head, size: s.objects.get(record.head).length }, recipe: null },
      },
    };
  };
  const save = async (entry, files) => {
    const before = JSON.parse(s.objects.get(entry.head)).files,
      byPath = new Map(before.map(file => [file.path, file])),
      next = new Map(files.map(file => [file.path, file]));
    const changes = [...new Set([...byPath.keys(), ...next.keys()])].sort().flatMap(path => {
      const old = byPath.get(path),
        file = next.get(path);
      if (JSON.stringify(old) === JSON.stringify(file)) return [];
      return [
        {
          path,
          before: old ? { blob: old.blob, mode: old.mode } : null,
          after: file
            ? {
                blob: file.blob,
                mode: file.mode,
                content: {
                  object: { sha256: file.blob, size: s.objects.get(file.blob).length },
                  recipe: null,
                },
              }
            : null,
        },
      ];
    });
    const built = buildSavePages(changes),
      operationId = randomUUID(),
      args = { projectId: s.projectId, operationId };
    const req = {
      operationId,
      laneId: entry.laneId,
      authorityEpoch: 1,
      expected: pins(entry),
      message: 'Save resolution bytes',
      pages: built.root,
      pageCount: built.pages.length,
      changeCount: changes.length,
    };
    await s.call('savePrepare', saves.prepare, { projectId: s.projectId, request: JSON.stringify(req) });
    for (const [index, page] of built.pages.entries()) {
      s.put(saveBytes(page.value));
      await s.call('saveStage', saves.stage, { ...args, index, page: JSON.stringify(page.value) });
    }
    const p = JSON.parse(await s.call('saveProgress', saves.progress, args));
    if (p.input) s.put(saveBytes(p.input));
    await withWorker(() => s.call('saveSubmit', saveJobs.submit, args));
    if (p.input) {
      const output = await s.compute(p.input),
        row = [...s.tables.projectHostedSaves.values()].find(row => row.operationId === operationId),
        job = await s.activate(row.jobId);
      await s.callback(job, { status: 'completed', output: output.output });
      await s.call('savePublish', saveJobs.publish, {
        projectId: s.projectId,
        jobId: row.jobId,
        result: output.manifest,
      });
    }
    return (await readLane(entry.laneId)).entry;
  };
  const conflict = async () => {
    const a = await s.lane(s.state([s.file('a.txt', 'left\n'), s.hidden], [s.baseline.sha256])),
      b = await s.lane(s.state([s.file('a.txt', 'right\n'), s.hidden], [s.baseline.sha256])),
      x = s.selection([a, b]);
    await s.prepare(x);
    await s.stage(x);
    await s.submit(x);
    const output = await s.work(x),
      candidate = (await s.publish(output)).outcome.result;
    return { a, b, x, candidate };
  };
  return {
    ...s,
    request,
    pins,
    prepareSync: prepare,
    progressSync: progress,
    submitSync: submit,
    workSync: work,
    publishSync: publish,
    execute,
    readLane,
    save,
    conflict,
    withWorker,
  };
}
