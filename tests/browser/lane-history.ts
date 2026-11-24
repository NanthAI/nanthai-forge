// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { ConvexError } from 'convex/values';
import { undoReceiptSchema } from '../../src/hosted-undo';
import type { Reply } from '../../web/src/app/lane/review-model';

const older = 'c1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d';
const newer = 'd2b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d';
const oldHead = 'd'.repeat(64);

export function laneHistoryFixture(scenario: string) {
  let lane: Reply['lane'];
  let expected: { head: string; version: number; sourceVersion: number; lifecycleVersion: number };
  let laterHead: string;
  let previous: { operationId: string; version: number; head: string } | undefined;
  let tried = false;
  let emptyRead = true;
  const trace = { reads: 0, writes: [] as unknown[] };
  Object.assign(window, { __saveHistory: trace });
  return {
    start(value: Reply['lane']) {
      lane = value;
      laterHead = lane.head;
      expected = { head: lane.head, version: 2, sourceVersion: 2, lifecycleVersion: 0 };
    },
    read(cursor: string | null) {
      trace.reads++;
      if (scenario === 'history-read-refused')
        throw new ConvexError({ code: 'NOT_FOUND', message: 'This Lane is not on this project.' });
      // At first the result is held until the test sees the reserved rows.
      const value = {
        authorityEpoch: 1,
        expected,
        refusal:
          scenario === 'history-reader'
            ? 'not-yours'
            : scenario === 'history-closed'
              ? 'closed'
              : scenario === 'history-native'
                ? 'native'
                : null,
        waiting: scenario === 'history-wait' && trace.reads <= 2,
        nextCursor: scenario === 'history-wait' && !cursor ? 'older-page' : null,
        items: [
          {
            id: newer,
            head: laterHead,
            at: '2026-11-25T09:00:00.000Z',
            summary: 'Add marker',
            fileCount: 1,
            paths: ['src/parser/marker.txt'],
          },
          ...(scenario === 'history-one'
            ? []
            : [
                {
                  id: older,
                  head: oldHead,
                  at: '2026-11-24T09:00:00.000Z',
                  summary: 'Record parser baseline',
                  fileCount: 1,
                  paths: [`src/${'long-path-'.repeat(12)}.ts`],
                },
              ]),
        ],
      };
      if (cursor === 'older-page')
        return {
          ...value,
          items: [
            {
              id: 'e3b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d',
              head: 'e'.repeat(64),
              at: '2026-11-23T09:00:00.000Z',
              summary: 'Draft parser',
              fileCount: 1,
              paths: ['src/parser.ts'],
            },
          ],
        };
      if (scenario === 'history-loading' && emptyRead) {
        emptyRead = false;
        return new Promise(resolve => Object.assign(window, { __showSaveHistory: () => resolve(value) }));
      }
      return value;
    },
    async return(projectId: string, request: string, archived = false) {
      const input = JSON.parse(request);
      trace.writes.push(input);
      if (scenario === 'history-archive' && !archived) throw new ConvexError({ undoHistory: true });
      if (scenario === 'history-refused') {
        await new Promise<void>(resolve => Object.assign(window, { __finishSaveReturn: resolve }));
        throw new ConvexError({
          code: 'PROJECT_UNAVAILABLE',
          message: 'Only this Lane’s holder, its author or the project owner can return it to a save.',
        });
      }
      if (scenario === 'history-press-wait' && !tried) {
        tried = true;
        throw new ConvexError({ code: 'LANE_FINISH_ACTIVE', message: 'A landing is in progress.' });
      }
      if (scenario === 'history-retry' && !tried) {
        tried = true;
        throw new Error('Connection closed');
      }
      if (
        JSON.stringify(input.expected) !== JSON.stringify(expected) ||
        input.laneId !== lane.laneId ||
        input.authorityEpoch !== 1
      )
        throw new ConvexError({ code: 'WORK_STALE', message: 'The Lane changed.' });
      const from = { ...expected, laneId: lane.laneId };
      const undo = input.returnOperationId !== undefined;
      if (
        undo &&
        (!previous || input.returnOperationId !== previous.operationId || input.version !== previous.version)
      )
        throw new ConvexError({
          code: 'BAD_ARGUMENT',
          message: 'Undo needs the completed browser return for this Lane.',
        });
      const head = undo ? previous!.head : input.saveId === older ? oldHead : laterHead;
      expected = {
        ...expected,
        head,
        version: expected.version + 1,
        sourceVersion: expected.sourceVersion + 1,
      };
      previous = { operationId: input.operationId, version: from.version, head: from.head };
      return JSON.stringify(
        undoReceiptSchema.parse({
          operationId: input.operationId,
          at: '2026-11-26T09:00:00.000Z',
          from,
          lane: {
            ...expected,
            schema: 2,
            projectId,
            laneId: lane.laneId,
            intentId: lane.intentId,
            base: { ...lane.base, receiptId: 'R1' },
            authority: { mode: 'server', epoch: 1 },
            state: 'active',
          },
          restored: {
            head,
            version: undo ? input.version : input.saveId === older ? 1 : 2,
            ...(undo ? {} : { saveId: input.saveId }),
          },
        }),
      );
    },
  };
}
