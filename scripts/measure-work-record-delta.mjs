// SPDX-License-Identifier: Apache-2.0
// Synthetic only: the existing 25 landings x 40 saves fixture, no hosted calls.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getFunctionName } from 'convex/server';
import {
  fixture,
  checkpoint,
  preparedCheckpoint,
  modules,
  upload,
} from '../tests/project-exchange-fixture.mjs';
import { moduleUrl } from '../tests/convex-module.mjs';
import { land } from '../tests/source-landings-fixture.mjs';
import { retainExchangeBaseline } from '../dist/native-exchange-baseline.js';
const index = await import(moduleUrl('../convex/projectWorkIndexActions.ts'));
const cleanups = [],
  t = { after: callback => cleanups.push(callback) };
const log = console.log;
let observed;
console.log = (label, data) => {
  if (label === 'work-record return prepared') observed = data;
};
async function measure(records, landings) {
  const s = fixture(),
    first = await checkpoint(t, s);
  land(first.store, 25, 40);
  const baseline = first.store.load();
  const seed = await preparedCheckpoint(s, first.store, 0, undefined, { records, logicalWork: false });
  const backupId = await modules.projectExchangeActions.publish._handler(s.ctx, seed.input);
  await modules.projectWorkActions.initialize._handler(s.ctx, {
    projectId: 'project',
    backupId,
    operationId: randomUUID(),
  });
  await index.ensure._handler(s.ctx, { projectId: 'project' });
  const key = 'synthetic/work-record-measure';
  retainExchangeBaseline(
    first.store,
    key,
    seed.manifest,
    baseline,
    [],
    JSON.parse(
      readFileSync(join(first.store.directory, `exchange-${seed.input.operationId}`, 'states.json'), 'utf8'),
    ),
  );
  land(first.store, landings);
  let bytesSent = 0;
  const store = s.ctx.storage.store;
  s.ctx.storage.store = async blob => {
    bytesSent += blob.size;
    return store(blob);
  };
  const next = await preparedCheckpoint(s, first.store, 0, key, {
    records,
    baseline,
    journalRevision: baseline.revision,
    logicalWork: false,
  });
  next.input.previous = backupId;
  const ownerDerived = await upload(
    s,
    readFileSync(join(first.store.directory, `exchange-${next.input.operationId}`, 'owner-derived.json')),
  );
  const candidateId = await modules.projectExchangeActions.publish._handler(s.ctx, next.input);
  s.ctx.storage.store = store;
  let prepareSeconds;
  const mutate = s.ctx.runMutation;
  s.ctx.runMutation = (ref, args) => {
    if (getFunctionName(ref) === 'projectReturnIndexStage:begin' && prepareSeconds === undefined)
      prepareSeconds = (performance.now() - started) / 1000;
    return mutate(ref, args);
  };
  observed = undefined;
  const started = performance.now();
  const input = {
    projectId: 'project',
    backupId: candidateId,
    expectedBackupId: backupId,
    revision: baseline.revision,
    operationId: randomUUID(),
    continuation: true,
    ownerDerived,
  };
  let result;
  do result = await modules.projectSourceReturn.returnSource._handler(s.ctx, input);
  while (result.pending);
  const returnSeconds = (performance.now() - started) / 1000;
  assert.equal(result.revision, first.store.revision() + 1);
  assert.equal(!!observed, records, 'Measured the intended delta/full path');
  const count = data =>
    Object.values(data).reduce((sum, value) => sum + (Array.isArray(value) ? value.length : 0), 0);
  return {
    mode: records ? 'records-v2' : 'full-v1',
    landings,
    historicalStates: 1000,
    bytesSent,
    workRecordsValidated: observed?.recordsValidated ?? count(baseline) + count(first.store.load()),
    touchedRecordsRead: observed?.recordsRead ?? null,
    prepareSeconds: +prepareSeconds.toFixed(6),
    returnSeconds: +returnSeconds.toFixed(6),
  };
}
try {
  const measurements = [];
  for (const landings of [1, 20])
    for (const records of [false, true]) measurements.push(await measure(records, landings));
  console.log = log;
  log(
    JSON.stringify(
      {
        runtime: process.version,
        kind: 'synthetic',
        method:
          'Same 25-landings x 40-saves native fixture and in-memory hosted handlers as source-return-incremental; both modes send only missing content and supply the same owner-derived delta. Bytes count newly uploaded raw content, including metadata and sidecar. Prepare is action entry to first stage-begin mutation. Validated counts are distinct record occurrences in current+candidate full snapshots, or changed records in v2, excluding reference-context reads and streamed hashing. Seed/setup, full suite and live network/deployment are excluded.',
        measurements,
      },
      null,
      2,
    ),
  );
} finally {
  console.log = log;
  for (const cleanup of cleanups.reverse()) cleanup();
}
