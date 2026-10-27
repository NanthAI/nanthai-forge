// SPDX-License-Identifier: Apache-2.0
'use node';
import type { ActionCtx } from './_generated/server';
import type { Doc } from './_generated/dataModel';
import { internal } from './_generated/api';
import { scratch, rowsRef, type Selected, type Exchange, type Cursor } from './projectWorkIndexBuildTypes';
import { buildContext, type BuildContext } from './projectWorkIndexBuildContext';
import { projectRecord } from './projectWorkIndexBuildProjection';
import { projectSummaries } from './projectWorkIndexBuildSummaries';
import { exchangeObjectReader } from './projectExchangeReader';
import { indexTransient } from './projectWorkIndexRetry';
import { readRecord, type RecordPin } from '../src/work-exchange-records';
import { partialWork } from '../src/work-exchange-delta';
import { materializeWork, indexedRecord, type IndexEntry } from '../src/work-hosted-index';
import { stateParentEntries } from '../src/source-state-parent-index';
import { treeRef } from './projectWorkIndexBuildStates';
export async function projectStep(
  ctx: ActionCtx,
  selected: Selected,
  e: Exchange,
  backup: Doc<'projectBackups'>,
  c: Cursor,
  context: BuildContext = buildContext(ctx, selected, e),
): Promise<IndexEntry[]> {
  const pinMap = context.pins;
  e = context.exchange;
  const rawFields = e.records.fields.filter((f): f is typeof f & { records: RecordPin[] } => 'records' in f);
  if (c.phase === 'settings') {
    c.phase = 'records';
    const data = partialWork(e.records, []);
    const projection = materializeWork(data, { ...e.manifest, files: [] }, [], 'objects', new Map(), true);
    const entries = projection.entries.filter(row =>
      ['githubSync', 'githubSync:payload', 'githubAutoPush', 'githubAutoPush:payload'].includes(
        row.collection,
      ),
    );
    if (pinMap.has(e.manifest.head))
      entries.push(
        ...indexedRecord('sourcePins', e.manifest.head, '', 0, {
          key: e.manifest.head,
          head: e.manifest.head,
        }),
        ...indexedRecord('_buildSource', e.manifest.head, '', 0, { head: e.manifest.head }),
      );
    return entries;
  }
  if (c.phase === 'records') {
    const field = rawFields[c.field];
    if (!field) {
      c.phase = 'parents';
      return [];
    }
    if (c.record === field.records.length) {
      c.field++;
      c.record = 0;
      return [];
    }
    const pins: RecordPin[] = [];
    let bytes = 0;
    while (c.record < field.records.length && pins.length < 50) {
      const pin = field.records[c.record]!;
      if (pins.length && bytes + pin.size > 256 * 1024) break;
      pins.push(pin);
      bytes += pin.size;
      c.record++;
    }
    const bodies = await exchangeObjectReader(ctx, false, 0).read(selected.projectId, selected.owner, pins);
    if (field.name === 'landingEntries') {
      const values = await Promise.all(
        pins.map((pin, i) => readRecord(pin, async () => bodies[i]!, field.name)),
      );
      await context.prefetch(
        values.flatMap(value => {
          const pin = context.catalogs.get('views')?.get(String(value.viewId));
          return pin ? [pin] : [];
        }),
      );
    }
    const result: IndexEntry[] = [];
    for (const [i, pin] of pins.entries()) {
      const value = await readRecord(pin, async () => bodies[i]!, field.name);
      result.push(...(await projectRecord(e, field.name, value, c.record - pins.length + i, pinMap)));
    }
    return result;
  }
  if (c.phase === 'parents') {
    const rows = await ctx.runQuery(rowsRef, { ...selected, collection: '_buildSource', offset: c.source });
    if (!rows.length) {
      c.phase = 'summaries';
      c.field = 0;
      c.record = 0;
      return [];
    }
    const selectedPins: { key: string; pin: { sha256: string; size: number } }[] = [];
    let bytes = 0;
    for (const row of rows) {
      const pin = pinMap.get(row.key);
      if (pin && selectedPins.length && (selectedPins.length >= 50 || bytes + pin.size > 2 * 1024 * 1024))
        break;
      c.source = row.position + 1;
      if (pin) {
        selectedPins.push({ key: row.key, pin });
        bytes += pin.size;
      }
    }
    const read = (pins: { sha256: string; size: number }[]) =>
      ctx.runAction(internal.projectWorkAncestry.stateBatch, {
        projectId: selected.projectId,
        actor: selected.owner,
        pins,
      });
    let states: { head: string; parents: string[] }[];
    try {
      states = await read(selectedPins.map(p => p.pin));
    } catch (error) {
      if (indexTransient(error)) throw error;
      // A missing optional State must not discard available parents in its page.
      await ctx.runQuery(internal.projectBackups.get, { id: backup._id, owner: selected.owner });
      states = [];
      for (const { pin } of selectedPins) {
        try {
          states.push(...(await read([pin])));
        } catch (error) {
          if (indexTransient(error)) throw error;
        }
      }
    }
    const entries: IndexEntry[] = [];
    for (const state of states)
      entries.push(
        ...stateParentEntries(state.head, state.parents),
        ...state.parents.map(head => ({
          collection: '_buildSource',
          key: head,
          parent: '',
          position: 0,
          value: JSON.stringify({ head }),
        })),
      );
    return entries;
  }
  if (c.phase === 'summaries') return projectSummaries(ctx, selected, e, backup, c, context);
  if (c.phase === 'trees') {
    const [hosted, main] = await context.main();
    const heads = [...new Set([e.manifest.head, ...(main ? [main] : []), ...(hosted ? [hosted] : [])])];
    const head = heads[c.record++];
    if (!head) {
      c.phase = 'blobs';
      c.record = 0;
      return [];
    }
    const pin = pinMap.get(head);
    if (!pin) return [];
    try {
      return await ctx.runAction(treeRef, {
        projectId: selected.projectId,
        actor: selected.owner,
        pin: { sha256: pin.sha256, size: pin.size },
      });
    } catch (error) {
      if (indexTransient(error)) throw error;
      await ctx.runQuery(internal.projectBackups.get, { id: backup._id, owner: selected.owner });
      return [];
    }
  }
  if (c.phase === 'blobs') {
    const result: IndexEntry[] = [];
    for (let i = 0; i < 500 && c.record < e.manifest.files.length; i++) {
      const pin = e.manifest.files[c.record++]!;
      if (pin.path === `objects/${pin.sha256}`)
        result.push(
          ...indexedRecord('sourceBlobs', pin.sha256, '', 0, { sha256: pin.sha256, size: pin.size }),
        );
    }
    if (c.record === e.manifest.files.length) {
      c.phase = 'journal';
      c.journalCursor = null;
      c.replayRevision = e.records.revision;
    }
    return result;
  }
  if (c.phase === 'cleanup') {
    c.cleanup = (c.cleanup ?? 0) + 1;
    if (c.cleanup >= scratch.length) c.phase = 'done';
  }
  return [];
}
