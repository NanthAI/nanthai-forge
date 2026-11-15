// SPDX-License-Identifier: Apache-2.0
import type { QueryCtx } from './_generated/server';
import type { Id } from './_generated/dataModel';
import { streamQuery } from 'convex-helpers/server/pagination';
import schema from './schema';
import { journalIndexAt, journalScope } from './projectJournalStore';
import { canonicalPayload } from '../src/hosted-source-operation';
import { invariant } from '../src/errors';

type Reference = { laneId: string; version: number; head: string };
const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length;
/** Input versions have an exact existing index. Saves have only a Lane-parent
 * index: retain that Lane's bounded context scan, never the project's saves. */
export async function metricInputReferences(
  ctx: QueryCtx,
  projectId: Id<'hostedProjects'>,
  stream: 'lanes' | 'saves',
  references: Reference[],
  from: number,
  to: number,
  cursor: string | null,
) {
  invariant(references.length <= 100, 'BAD_ARGUMENT', 'Read metric inputs in batches of 100 references.');
  const binding = canonicalPayload({ stream, references, from, to });
  let position: { binding: string; index: number; key: (string | number | null)[] | null };
  try {
    position = cursor ? JSON.parse(cursor) : { binding, index: 0, key: null };
  } catch {
    invariant(false, 'EVIDENCE_CHANGED', 'Continue the original metric input selection.');
  }
  invariant(
    position &&
      position.binding === binding &&
      Number.isSafeInteger(position.index) &&
      position.index >= 0 &&
      position.index <= references.length &&
      (position.key === null || Array.isArray(position.key)),
    'EVIDENCE_CHANGED',
    'Continue the original metric input selection.',
  );
  let index: number = position.index,
    key: (string | number | null)[] | null = position.key;
  let readBytes = 0,
    readRows = 0;
  const page: unknown[] = [];
  for (; index < references.length && readRows < 100 && readBytes < 512 * 1024;) {
    const reference = references[index]!;
    invariant(
      key === null ||
        (stream === 'saves' &&
          key.length === 5 &&
          key[0] === projectId &&
          key[1] === 'save' &&
          key[2] === reference.laneId &&
          typeof key[3] === 'number' &&
          key[3] >= from &&
          key[3] < to &&
          typeof key[4] === 'string') ||
        (stream === 'lanes' &&
          key.length === 7 &&
          key[0] === projectId &&
          key[1] === 'lane' &&
          key[2] === reference.laneId &&
          key[3] === reference.version &&
          (key[4] === null || typeof key[4] === 'string') &&
          typeof key[5] === 'number' &&
          Number.isFinite(key[5]) &&
          typeof key[6] === 'string'),
      'EVIDENCE_CHANGED',
      'Metric input cursor differs from its selected Lane.',
    );
    if (stream === 'lanes') {
      // Lifecycle-backed versions share the existing exact version prefix.
      // Select an in-horizon fact, including when the canonical row is older
      // than the horizon. Intent and revert are immutable Lane identity facts.
      const prefix = [projectId, 'lane', reference.laneId, reference.version];
      const start = key?.map((value, index) => (index === 4 && value === null ? undefined : value));
      const rows = streamQuery(ctx, {
        table: 'projectHostedRecords',
        index: 'by_project_and_kind_and_key_and_version_and_plan',
        schema,
        startIndexKey: start ?? prefix,
        startInclusive: key === null,
        endIndexKey: prefix,
        endInclusive: true,
        order: 'asc',
      });
      let complete = true,
        found = false;
      readRows++;
      for await (const [row, indexKey] of rows) {
        if (readRows > 100 || readBytes >= 512 * 1024) {
          complete = false;
          break;
        }
        readBytes += bytes(row);
        key = indexKey.map(value => (value === undefined ? null : value)) as (string | number | null)[];
        if (row._creationTime >= from && row._creationTime < to) {
          if (row.journalLane)
            page.push({
              id: row.key,
              version: row.version,
              intentId: row.parent,
              revert: row.journalLane.revert,
            });
          else {
            const body = await ctx.db.get(row.bodyId);
            invariant(body?.projectId === projectId, 'EVIDENCE_CHANGED', 'Metric record body is missing.');
            readBytes += bytes(body);
            const lane = JSON.parse(body.value);
            invariant(lane.kind === 'lane', 'EVIDENCE_CHANGED', 'Metric record kind changed.');
            page.push({ id: lane.id, version: lane.version, intentId: lane.intentId, revert: !!lane.revert });
          }
          found = true;
          break;
        }
        readRows++;
      }
      if (!complete) break;
      if (!found) {
        const archived = await journalIndexAt(
          ctx,
          projectId,
          journalScope('lane', reference.laneId),
          reference.version,
        );
        const pin = archived?.records?.find(pin => pin[0] === reference.version);
        if (archived) readBytes += bytes(archived);
        if (pin && pin[2] >= from && pin[2] < to)
          page.push({ id: reference.laneId, version: pin[0], intentId: pin[4], revert: !!pin[10] });
      }
      index++;
      key = null;
    } else {
      const rows = streamQuery(ctx, {
        table: 'projectHostedRecords',
        index: 'by_project_and_kind_and_parent',
        schema,
        startIndexKey: (key as (string | number)[] | null) ?? [projectId, 'save', reference.laneId, from],
        startInclusive: key === null,
        endIndexKey: [projectId, 'save', reference.laneId, to],
        endInclusive: false,
        order: 'asc',
      });
      let complete = true;
      // Stream the selected Lane's range, keeping at most one document beyond
      // the byte/row threshold. A continuation rereads only that one lookahead,
      // rather than rereading the next save after every individual save.
      for await (const [row, indexKey] of rows) {
        if (readRows >= 100 || readBytes >= 512 * 1024) {
          complete = false;
          break;
        }
        readRows++;
        readBytes += bytes(row);
        const body = await ctx.db.get(row.bodyId);
        invariant(body?.projectId === projectId, 'EVIDENCE_CHANGED', 'Metric record body is missing.');
        readBytes += bytes(body);
        const save = JSON.parse(body.value);
        invariant(save.kind === 'save', 'EVIDENCE_CHANGED', 'Metric record kind changed.');
        page.push({ id: save.id, laneId: save.laneId, head: save.head, at: save.at });
        key = indexKey as (string | number)[];
      }
      if (complete) {
        index++;
        key = null;
      } else break;
    }
  }
  return {
    page,
    isDone: index === references.length,
    continueCursor: index === references.length ? '' : JSON.stringify({ binding, index, key }),
  };
}
