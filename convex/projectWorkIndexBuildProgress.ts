// SPDX-License-Identifier: Apache-2.0
import type { Doc } from './_generated/dataModel';
import type { Exchange, Cursor } from './projectWorkIndexBuildTypes';
import { scratch } from './projectWorkIndexBuildTypes';
import { indexBuildProgressSchema } from '../src/work-index-build-progress';
/** Uses the generation already returned by a step: progress never performs IO. */
export function buildProgress(generation: Doc<'projectWorkGenerations'>, exchange: Exchange) {
  const cursor = JSON.parse(generation.ensureCursor!) as Cursor;
  const counts: Record<string, number> = JSON.parse(generation.metadata).counts;
  const fields = exchange.records.fields.filter(f => 'records' in f);
  let field: string | undefined,
    done = 0,
    total = 0;
  if (cursor.phase === 'records') {
    const selected = fields[cursor.field];
    field = selected?.name;
    done = cursor.record;
    total = selected && 'records' in selected ? selected.records.length : 0;
  } else if (cursor.phase === 'parents') {
    done = cursor.source;
    total = counts._buildSource ?? 0;
  } else if (cursor.phase === 'summaries') {
    field = ['lanes', 'views', 'runs'][cursor.field];
    done = cursor.record;
    total = counts[field ?? ''] ?? 0;
  } else if (cursor.phase === 'blobs') {
    done = cursor.record;
    total = exchange.manifest.files.length;
  } else if (cursor.phase === 'journal') {
    done = (cursor.replayRevision ?? exchange.records.revision) - exchange.records.revision;
    total = generation.revision - exchange.records.revision;
  } else if (cursor.phase === 'cleanup') {
    done = cursor.cleanup ?? 0;
    total = scratch.length;
  }
  const known = indexBuildProgressSchema.shape.field.safeParse(field);
  return JSON.stringify({
    phase: 'index',
    buildPhase: cursor.phase,
    ...(field ? { field: known.success ? known.data : 'other' } : {}),
    done,
    total,
    step: generation.nextBatch,
  });
}
