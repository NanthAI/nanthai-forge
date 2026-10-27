// SPDX-License-Identifier: Apache-2.0
'use node';
import type { ActionCtx } from './_generated/server';
import type { Doc } from './_generated/dataModel';
import { internal } from './_generated/api';
import {
  scratch,
  rowsRef,
  lookupRef,
  type Selected,
  type Exchange,
  type Cursor,
} from './projectWorkIndexBuildTypes';
import { projectRecord } from './projectWorkIndexBuildProjection';
import { projectSummaries } from './projectWorkIndexBuildSummaries';
import { exchangeObjectReader } from './projectExchangeReader';
import { readRecord, type RecordPin } from '../src/work-exchange-records';
import { partialWork } from '../src/work-exchange-delta';
import { materializeWork, indexedRecord, type IndexEntry } from '../src/work-hosted-index';
import { parseNativeState } from '../src/native-state-format';
import { stateParentEntries } from '../src/source-state-parent-index';
import { sourceTreeEntries } from '../src/source-tree-index';
export async function projectStep(
  ctx: ActionCtx,
  selected: Selected,
  e: Exchange,
  backup: Doc<'projectBackups'>,
  c: Cursor,
): Promise<IndexEntry[]> {
  const pinMap = new Map(
    e.manifest.files.filter(p => p.path === `objects/${p.sha256}`).map(p => [p.sha256, p]),
  );
  const rawFields = e.records.fields.filter((f): f is typeof f & { records: RecordPin[] } => 'records' in f);
  const lookup = (collection: string, key: string) =>
    ctx.runQuery(lookupRef, { ...selected, collection, key });
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
      if (pin && selectedPins.length && (selectedPins.length >= 50 || bytes + pin.size > 256 * 1024)) break;
      c.source = row.position + 1;
      if (pin) {
        selectedPins.push({ key: row.key, pin });
        bytes += pin.size;
      }
    }
    const reader = exchangeObjectReader(ctx, false, 0);
    let bodies: (Buffer | undefined)[];
    try {
      bodies = await reader.read(
        selected.projectId,
        selected.owner,
        selectedPins.map(p => p.pin),
      );
    } catch {
      // A missing optional State must not discard available parents in its page.
      await ctx.runQuery(internal.projectBackups.get, { id: backup._id, owner: selected.owner });
      bodies = [];
      for (const { pin } of selectedPins) {
        try {
          bodies.push((await reader.read(selected.projectId, selected.owner, [pin]))[0]);
        } catch {
          bodies.push(undefined);
        }
      }
    }
    const entries: IndexEntry[] = [];
    for (const [i, { key }] of selectedPins.entries()) {
      try {
        if (!bodies[i]) continue;
        const state = parseNativeState(bodies[i]!);
        entries.push(
          ...stateParentEntries(key, state.parents),
          ...state.parents.map(head => ({
            collection: '_buildSource',
            key: head,
            parent: '',
            position: 0,
            value: JSON.stringify({ head }),
          })),
        );
      } catch {
        await ctx.runQuery(internal.projectBackups.get, { id: backup._id, owner: selected.owner });
      }
    }
    return entries;
  }
  if (c.phase === 'summaries') return projectSummaries(ctx, selected, e, backup, c);
  if (c.phase === 'trees') {
    const main = await lookup('channels', 'main');
    const hosted = await lookup('hostedChannels', 'main');
    const heads = [
      ...new Set([
        e.manifest.head,
        ...(main ? [JSON.parse(main.value).head as string] : []),
        ...(hosted ? [JSON.parse(hosted.value).head as string] : []),
      ]),
    ];
    const head = heads[c.record++];
    if (!head) {
      c.phase = 'blobs';
      c.record = 0;
      return [];
    }
    const pin = pinMap.get(head);
    if (!pin) return [];
    try {
      const [bytes] = await exchangeObjectReader(ctx, false, 0).read(selected.projectId, selected.owner, [
        pin,
      ]);
      return sourceTreeEntries(head, parseNativeState(bytes!).files);
    } catch {
      await ctx.runQuery(internal.projectBackups.get, { id: backup._id, owner: selected.owner });
      return [];
    }
  }
  if (c.phase === 'blobs') {
    const result: IndexEntry[] = [];
    for (let i = 0; i < 100 && c.record < e.manifest.files.length; i++) {
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
