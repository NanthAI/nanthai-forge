// SPDX-License-Identifier: Apache-2.0
'use node';
import type { ActionCtx } from './_generated/server';
import type { Doc } from './_generated/dataModel';
import { internal } from './_generated/api';
import {
  scratch,
  rowsRef,
  lookupRef,
  family,
  type Selected,
  type Exchange,
  type Cursor,
} from './projectWorkIndexBuildTypes';
import { projectRecord, viewContext } from './projectWorkIndexBuildProjection';
import { exchangeObjectReader } from './projectExchangeReader';
import { readRecord, type RecordPin } from '../src/work-exchange-records';
import { partialWork } from '../src/work-exchange-delta';
import { materializeWork, indexedRecord, type IndexEntry } from '../src/work-hosted-index';
import { viewReadModels } from '../src/view-read-model';
import { viewIndexEntries } from '../src/view-hosted-index';
import { viewSummary, laneSummary, runSummary } from '../src/work-hosted-summary';
import { viewStates } from './projectSourceProjection';
import { addDiffstats } from './projectDiffstatProjection';
import { parseNativeState } from '../src/native-state-format';
import { stateParentEntries } from '../src/source-state-parent-index';
import { sourceTreeEntries } from '../src/source-tree-index';
import type { WorkView } from '../src/work-types';
export async function projectStep(
  ctx: ActionCtx,
  selected: Selected,
  e: Exchange,
  backup: Doc<'projectBackups'>,
  c: Cursor,
): Promise<IndexEntry[]> {
  const read = (pin: RecordPin, collection: string) => readRecord(pin, e.read, collection);
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
    const [row] = await ctx.runQuery(rowsRef, { ...selected, collection: '_buildSource', offset: c.source });
    if (!row) {
      c.phase = 'summaries';
      c.field = 0;
      c.record = 0;
      return [];
    }
    c.source = row.position + 1;
    const pin = pinMap.get(row.key);
    if (!pin) return [];
    try {
      const [bytes] = await exchangeObjectReader(ctx, false, 0).read(selected.projectId, selected.owner, [
        pin,
      ]);
      const state = parseNativeState(bytes!);
      return [
        ...stateParentEntries(row.key, state.parents),
        ...state.parents.map(head => ({
          collection: '_buildSource',
          key: head,
          parent: '',
          position: 0,
          value: JSON.stringify({ head }),
        })),
      ];
    } catch {
      await ctx.runQuery(internal.projectBackups.get, { id: backup._id, owner: selected.owner });
      return [];
    }
  }
  if (c.phase === 'summaries') {
    const field = ['lanes', 'views', 'runs'][c.field];
    if (!field) {
      c.phase = 'trees';
      c.record = 0;
      return [];
    }
    const pin = rawFields.find(f => f.name === field)?.records[c.record];
    if (!pin) {
      c.field++;
      c.record = 0;
      return [];
    }
    const value = await read(pin, field);
    const main = (await lookup('hostedChannels', 'main')) ?? (await lookup('channels', 'main'));
    const mainHead: string | null = main ? JSON.parse(main.value).head : null;
    const head = typeof value.head === 'string' ? value.head : undefined;
    // The cockpit resolves current membership from the staged parent facts at
    // read time, as it does for native owner-fact projections. Do not traverse
    // the entire source history again for every retained View and run.
    const included = !mainHead ? (field === 'lanes' ? null : true) : head === mainHead ? true : null;
    c.record++;
    const mainSummary = { head: mainHead, included };
    let data = partialWork(e.records, [{ collection: field, value }]);
    let summary: unknown;
    const derived: IndexEntry[] = [];
    if (field === 'lanes') {
      const submitted: string[] = [];
      let offset = 0;
      while (true) {
        const rows = await ctx.runQuery(rowsRef, {
          ...selected,
          collection: '_buildSubmission',
          parent: String(value.id),
          offset,
        });
        for (const row of rows) submitted.push(JSON.parse(row.value).head);
        if (rows.length < 100) break;
        offset = rows.at(-1)!.position + 1;
      }
      summary = laneSummary(data.lanes[0]!, mainSummary, submitted);
    } else if (field === 'runs') summary = runSummary(data.runs[0]!, mainSummary);
    else {
      const selectedView = value as unknown as WorkView;
      const [latest] = await ctx.runQuery(rowsRef, {
        ...selected,
        collection: '_buildFamily',
        parent: family(selectedView),
        last: true,
      });
      data = await viewContext(ctx, selected, e, selectedView, latest?.key ?? selectedView.id);
      const view = data.views[0]!;
      const model = viewReadModels(data, 0)[0]!;
      summary = {
        ...viewSummary(view, mainSummary),
        viewStatus: model.status,
        supersededBy: model.supersededBy,
        inputs: model.inputs,
      };
      let states;
      try {
        states = await viewStates(ctx, { backup, manifest: e.manifest, data }, selected.owner, 0);
      } catch {
        await ctx.runQuery(internal.projectBackups.get, { id: backup._id, owner: selected.owner });
      }
      derived.push(...viewIndexEntries(data, states, { index: 0, positions: new Map() }));
    }
    const entries = indexedRecord(
      field,
      String(value.id),
      field === 'lanes' || field === 'views' ? String(value.intentId) : String(value.viewId),
      0,
      value,
      summary,
    );
    await addDiffstats(ctx, { backup, manifest: e.manifest, data }, selected.owner, entries);
    return [...entries, ...derived];
  }
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
