// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { moduleSource } from './convex-module.mjs';
import { workSchema } from '../dist/work-types.js';
import { buildWorkRecords } from '../dist/work-exchange-records.js';
import { buildWorkDelta, WORK_DELTA_BYTES } from '../dist/work-exchange-delta.js';
const source = moduleSource('../convex/projectWorkRecordExchange.ts').replace(
  /export async function recordExchange[\s\S]+?(?=export async function verifyRecordSeed)/,
  'async function recordExchange(backup) { return globalThis.__publicationLogFixture[backup.digest]; }\n',
);
const { recordPublication } = await import(
  `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`
);
const reasons = [
  'previous-missing',
  'history-deferred',
  'previous-project-differs',
  'previous-records-unvalidated',
  'previous-closure-unvalidated',
  'previous-history-backfilling',
  'candidate-catalog-unavailable',
  'previous-catalog-unavailable',
  'delta-missing',
  'delta-over-budget',
  'delta-base-root-differs',
  'delta-layout-unsupported',
  'context-over-budget',
  'channel-history-replaced',
];
for (const reason of reasons)
  test(`publication logs ${reason}`, async t => {
    const before = workSchema.parse({
      schema: 15,
      revision: 0,
      nativeHead: 'a'.repeat(64),
      intents: [],
      lanes: [],
      views: [],
    });
    before.intents.push({
      id: randomUUID(),
      base: before.nativeHead,
      outcome: 'Synthetic',
      constraints: '',
      createdAt: 'now',
      status: 'active',
      notes: [],
    });
    if (reason === 'context-over-budget')
      before.intents[0].notes = Array.from({ length: 600 }, () => ({
        text: 'x'.repeat(4000),
        kind: 'comment',
        at: 'now',
      }));
    if (reason === 'channel-history-replaced')
      before.channelMoves.push({
        id: randomUUID(),
        channel: 'main',
        viewId: randomUUID(),
        head: before.nativeHead,
        previous: null,
        at: 'now',
        status: 'pending',
        provenance: 'user-declared-local',
      });
    if (reason === 'channel-history-replaced')
      before.views.push({
        id: before.channelMoves[0].viewId,
        intentId: before.intents[0].id,
        base: before.nativeHead,
        head: before.nativeHead,
        inputs: [],
        status: 'clean',
        details: '',
        at: 'now',
      });
    const after = structuredClone(before);
    after.revision++;
    after.intents[0].notes.push({ text: 'Changed', kind: 'comment', at: 'later' });
    if (reason === 'channel-history-replaced') after.channelMoves[0].at = 'later';
    if (reason === 'delta-layout-unsupported') after.extension = 'new scalar';
    const a = buildWorkRecords(before),
      b = buildWorkRecords(after),
      delta = buildWorkDelta(a.root, b.root, a.pin.sha256);
    if (reason === 'delta-base-root-differs') delta.base.root = 'f'.repeat(64);
    const values = new Map([...a.objects, ...b.objects]);
    const read = async pin => values.get(pin.sha256);
    const candidate = {
      records: b.root,
      root: { records: b.pin, delta: { sha256: 'd'.repeat(64), size: 100 } },
      manifest: { files: [{ path: `objects/${before.nativeHead}`, sha256: before.nativeHead, size: 0 }] },
      read: async pin => (pin.sha256 === 'd'.repeat(64) ? Buffer.from(JSON.stringify(delta)) : read(pin)),
    };
    globalThis.__publicationLogFixture = {
      prior: { records: a.root, root: { records: a.pin }, manifest: { files: [] } },
      candidate,
    };
    t.after(() => delete globalThis.__publicationLogFixture);
    if (reason === 'candidate-catalog-unavailable') delete globalThis.__publicationLogFixture.candidate;
    if (reason === 'previous-catalog-unavailable') delete globalThis.__publicationLogFixture.prior;
    if (reason === 'delta-missing') delete candidate.root.delta;
    if (reason === 'delta-over-budget') candidate.root.delta.size = WORK_DELTA_BYTES + 1;
    const prior = {
      digest: 'prior',
      projectId: reason === 'previous-project-differs' ? 'other' : 'project',
      validatedWorkRecords: reason === 'previous-records-unvalidated' ? undefined : 1,
      validatedClosure: reason === 'previous-closure-unvalidated' ? undefined : 1,
      historyBackfilling: reason === 'previous-history-backfilling',
    };
    const logs = [];
    t.mock.method(console, 'log', (...args) => logs.push(args));
    const result = await recordPublication(
      { runQuery: async () => ({ backup: prior }) },
      {
        projectId: 'project',
        previous: reason === 'previous-missing' ? null : 'prior',
        deferHistory: reason === 'history-deferred',
        digest: 'candidate',
        size: 1,
      },
      'owner',
      {},
    );
    assert.deepEqual(result, { unavailable: reason });
    assert.deepEqual(logs, [['work-record publication skip', { reason, projectId: 'project' }]]);
  });
