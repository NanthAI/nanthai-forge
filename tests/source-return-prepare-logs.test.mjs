// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { getFunctionName } from 'convex/server';
import { moduleSource } from './convex-module.mjs';
import { workSchema } from '../dist/work-types.js';
import { buildWorkRecords } from '../dist/work-exchange-records.js';
import { buildWorkDelta, WORK_DELTA_BYTES } from '../dist/work-exchange-delta.js';
const module = moduleSource('../convex/projectWorkRecordReturn.ts').replace(
  /import \{ recordExchange \} from '[^']+';/,
  'const recordExchange = async backup => globalThis.__prepareLogFixture[backup._id];',
);
const { recordReturn } = await import(
  `data:text/javascript;base64,${Buffer.from(module).toString('base64')}`
);
const head = 'a'.repeat(64);
function setup() {
  const before = workSchema.parse({
    schema: 15,
    revision: 0,
    nativeHead: head,
    intents: [],
    lanes: [],
    views: [],
  });
  before.intents.push({
    id: randomUUID(),
    base: head,
    outcome: 'Synthetic',
    constraints: '',
    status: 'active',
    notes: [],
    createdAt: 'now',
  });
  const after = structuredClone(before);
  after.revision++;
  after.intents[0].notes.push({ kind: 'comment', text: 'Next', at: 'later' });
  return { before, after };
}
const reasons = [
  'candidate-records-unvalidated',
  'previous-records-unvalidated',
  'candidate-catalog-unavailable',
  'previous-catalog-unavailable',
  'delta-missing',
  'delta-over-budget',
  'previous-parsed-bytes-differ',
  'candidate-parsed-bytes-differ',
  'delta-base-root-differs',
  'delta-journal-revision-differs',
  'delta-layout-unsupported',
  'planning-journal-events',
  'context-over-budget',
];
for (const reason of reasons)
  test(`prepare logs ${reason}`, async t => {
    const { before, after } = setup();
    if (reason === 'previous-parsed-bytes-differ') {
      delete before.runs;
    }
    if (reason === 'candidate-parsed-bytes-differ') {
      delete after.runs;
    }
    if (reason === 'delta-layout-unsupported') after.extension = 'new metadata';
    if (reason === 'context-over-budget') {
      before.intents[0].notes.push(
        ...Array.from({ length: 4500 }, () => ({ kind: 'comment', text: 'x'.repeat(4000), at: 'now' })),
      );
      after.intents[0].notes.push(...before.intents[0].notes);
    }
    const a = buildWorkRecords(before),
      b = buildWorkRecords(after);
    const delta = buildWorkDelta(a.root, b.root, a.pin.sha256, 0);
    if (reason === 'delta-base-root-differs') delta.base.root = 'f'.repeat(64);
    if (reason === 'delta-journal-revision-differs') delta.base.journalRevision = 1;
    globalThis.__prepareLogFixture = {
      prior: { records: a.root, root: { records: a.pin }, manifest: { files: [] } },
      candidate: {
        records: b.root,
        root: { records: b.pin, delta: { sha256: 'd'.repeat(64), size: 100 } },
        read: async () => Buffer.from(JSON.stringify(delta)),
        manifest: { files: [] },
      },
    };
    t.after(() => {
      delete globalThis.__prepareLogFixture;
    });
    const f = globalThis.__prepareLogFixture;
    if (reason === 'candidate-catalog-unavailable') f.candidate = undefined;
    if (reason === 'previous-catalog-unavailable') f.prior = undefined;
    if (reason === 'delta-missing') delete f.candidate.root.delta;
    if (reason === 'delta-over-budget') f.candidate.root.delta.size = WORK_DELTA_BYTES + 1;
    const logs = [];
    t.mock.method(console, 'log', (...args) => logs.push(args));
    const ctx = {
      runQuery: async ref => {
        const name = getFunctionName(ref);
        if (name === 'projectWork:get')
          return { key: randomUUID(), work: { backupId: 'prior', revision: 0 } };
        if (name === 'projectWork:events')
          return {
            page:
              reason === 'planning-journal-events'
                ? [
                    {
                      operationId: randomUUID(),
                      actor: 'owner',
                      at: 'now',
                      request: head,
                      previousRevision: 0,
                      command: JSON.stringify({
                        action: 'comment-planning-item',
                        operationId: randomUUID(),
                        itemId: randomUUID(),
                        text: 'Synthetic',
                      }),
                    },
                  ]
                : [],
            isDone: true,
            continueCursor: '',
          };
        assert.fail(name);
      },
    };
    const invoke = () =>
      recordReturn(
        ctx,
        { projectId: 'project', expectedBackupId: 'prior', revision: 0 },
        'owner',
        {},
        {
          _id: 'candidate',
          validatedWorkRecords: reason === 'candidate-records-unvalidated' ? undefined : 1,
        },
        {
          _id: 'prior',
          digest: head,
          validatedWorkRecords: reason === 'previous-records-unvalidated' ? undefined : 1,
        },
      );
    if (reason === 'candidate-records-unvalidated' || reason === 'previous-records-unvalidated')
      assert.equal(await invoke(), undefined);
    else
      await assert.rejects(
        invoke(),
        error => error.code === 'WORK_RETURN_DELTA_UNAVAILABLE' && error.message.includes(reason),
      );
    assert.deepEqual(logs, [['source-return record skip', { reason, revision: 0 }]]);
  });
