// SPDX-License-Identifier: Apache-2.0
import { randomUUID } from 'node:crypto';
import { workSchema } from '../dist/work-types.js';
import { materializeWork } from '../dist/work-hosted-index.js';

export function hostedCockpitFixture() {
  const intentId = randomUUID(),
    laneId = randomUUID(),
    viewId = randomUUID(),
    checkId = randomUUID();
  const base = 'a'.repeat(64),
    head = 'b'.repeat(64);
  const createdAt = '2026-10-14T10:00:00.000Z',
    savedAt = '2026-10-14T10:10:00.000Z';
  const check = {
    id: checkId,
    name: 'verify',
    executable: 'node',
    args: [],
    environmentLabel: '',
    definition: head,
    at: createdAt,
  };
  const data = workSchema.parse({
    schema: 8,
    revision: 1,
    nativeHead: head,
    intents: [
      {
        id: intentId,
        outcome: 'Hosted summaries',
        constraints: '',
        base,
        status: 'active',
        createdAt,
        notes: [],
      },
    ],
    lanes: [
      {
        id: laneId,
        intentId,
        name: 'summary-lane',
        base,
        head,
        state: 'active',
        assignment: 'Engineer',
        target: '',
        checkpoints: [
          { head: base, parent: base, at: createdAt, message: 'First save' },
          { head, parent: base, at: savedAt, message: 'Latest save ' + 'x'.repeat(40000) },
        ],
      },
    ],
    views: [
      {
        id: viewId,
        intentId,
        base,
        head,
        inputs: [{ laneId, head }],
        dependencies: [],
        status: 'clean',
        details: 'x'.repeat(40000),
        at: '2026-10-14T10:11:00.000Z',
      },
    ],
    checks: [check],
    runs: [
      {
        id: randomUUID(),
        viewId,
        head,
        base,
        inputs: [{ laneId, head }],
        dependencies: [],
        check,
        environment: { platform: 'test', arch: 'test', os: 'test', node: '24', env: {}, fingerprint: head },
        runner: { pid: 1, host: 'synthetic' },
        status: 'failed',
        details: '',
        startedAt: '2026-10-14T10:12:00.000Z',
        endedAt: '2026-10-14T10:13:00.000Z',
        exitCode: 1,
        failureSummary: '✖ hosted summary labels (1ms)\nAssertionError: expected save count',
      },
    ],
  });
  const manifest = {
    schema: 1,
    kind: 'forge-native-work-backup',
    id: randomUUID(),
    head,
    revision: 1,
    files: [{ path: `objects/${head}`, sha256: head, size: 1 }],
    unavailable: [],
    coverage: '',
  };
  const projection = materializeWork(data, manifest, [], 'objects');
  const records = Object.fromEntries(
    ['intents', 'lanes', 'views', 'runs', 'channelMoves', 'notes'].map(collection => [
      collection,
      projection.entries.filter(row => row.collection === collection).map(row => JSON.parse(row.value)),
    ]),
  );
  return {
    data,
    manifest,
    projection,
    records,
    intentId,
    laneId,
    viewId,
    savedAt,
    now: Date.parse('2026-10-14T10:20:00.000Z'),
  };
}

/** B2.4b workspace summaries, with no notice-only read or fabricated timestamps. */
export function recoveryNoticesFixture() {
  const f = hostedCockpitFixture();
  const secondId = randomUUID();
  f.records.intents[0].outcome = 'Faster first byte from R2';
  f.records.intents.push({ id: secondId, outcome: 'Rate limit headers', status: 'active' });
  f.records.runs = [];
  f.records.needsFix = [
    {
      intentId: f.intentId,
      state: 'reverted',
      auditRunId: randomUUID(),
      receiptId: randomUUID(),
      head: 'b'.repeat(64),
      summary: `Reverted receipt ${randomUUID()}: tests/r2-range.test.mjs, tests/hosted-source-bytes.test.mjs failed on ${'b'.repeat(64)}`,
      undo: `nforge agent ROOT revert '{"receiptId":"retained-reverse"}'`,
    },
    {
      intentId: secondId,
      state: 'needs-fix',
      auditRunId: randomUUID(),
      head: 'c'.repeat(64),
      summary: `Fix needed for receipt ${randomUUID()}: tests/http-limits.test.mjs failed on ${'c'.repeat(64)}`,
      undo: 'nforge agent ROOT start fix-forward',
    },
  ];
  return f;
}

export { overlapNowFixture } from './now-overlaps-fixture.mjs';
