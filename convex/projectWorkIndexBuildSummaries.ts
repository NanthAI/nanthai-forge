// SPDX-License-Identifier: Apache-2.0
'use node';
import type { ActionCtx } from './_generated/server';
import { internal } from './_generated/api';
import type { Doc } from './_generated/dataModel';
import {
  rowsRef,
  rowBatchRef,
  type RowRequest,
  lookupRef,
  family,
  type Selected,
  type Exchange,
  type Cursor,
} from './projectWorkIndexBuildTypes';
import { viewContext } from './projectWorkIndexBuildProjection';
import { exchangeObjectReader } from './projectExchangeReader';
import { readRecord, type RecordPin } from '../src/work-exchange-records';
import { partialWork } from '../src/work-exchange-delta';
import { indexedRecord, type IndexEntry } from '../src/work-hosted-index';
import { viewReadModels } from '../src/view-read-model';
import { viewIndexEntries } from '../src/view-hosted-index';
import { viewSummary, laneSummary, runSummary } from '../src/work-hosted-summary';
import { viewStates } from './projectSourceProjection';
import { addDiffstats, type ChangedStates } from './projectDiffstatProjection';
import type { WorkView } from '../src/work-types';
/** A bounded summary page shares source resolution and diffstat work. */
export async function projectSummaries(
  ctx: ActionCtx,
  selected: Selected,
  exchange: Exchange,
  backup: Doc<'projectBackups'>,
  c: Cursor,
): Promise<IndexEntry[]> {
  const field = ['lanes', 'views', 'runs'][c.field];
  if (!field) {
    c.phase = 'trees';
    c.record = 0;
    return [];
  }
  const raw = exchange.records.fields.find(f => f.name === field);
  const records = raw && 'records' in raw ? raw.records : [];
  if (c.record >= records.length) {
    c.field++;
    c.record = 0;
    return [];
  }
  const pins: RecordPin[] = [];
  let bytes = 0;
  while (c.record < records.length && pins.length < 10) {
    const pin = records[c.record]!;
    if (pins.length && bytes + pin.size > 256 * 1024) break;
    pins.push(pin);
    bytes += pin.size;
    c.record++;
  }
  const bodies = await exchangeObjectReader(ctx, false, 0).read(selected.projectId, selected.owner, pins);
  const batch = new Map(pins.map((p, i) => [p.sha256, bodies[i]!]));
  const e: Exchange = {
    ...exchange,
    read: pin => (batch.has(pin.sha256) ? Promise.resolve(batch.get(pin.sha256)!) : exchange.read(pin)),
  };
  if (field === 'views') {
    // Seed the common context for this page in metadata-sized transport windows.
    // Dependency closure and unusually large records retain the ordinary reader.
    // These are immutable projection inputs; the publication transaction rechecks
    // current authority, just as it does for the page's own record bodies.
    const values = await Promise.all(pins.map(pin => readRecord(pin, e.read, field)));
    const laneIds = new Set(
      values.flatMap(value => (value as unknown as WorkView).inputs.map(i => i.laneId)),
    );
    const intentIds = new Set(values.map(value => String(value.intentId)));
    const lanes = e.records.fields.find(f => f.name === 'lanes');
    const intents = e.records.fields.find(f => f.name === 'intents');
    const pending = [
      ...(lanes && 'records' in lanes ? lanes.records.filter(p => laneIds.has(p.key)) : []),
      ...(intents && 'records' in intents ? intents.records.filter(p => intentIds.has(p.key)) : []),
    ];
    let retained = bytes;
    while (pending.length) {
      const selectedPins: RecordPin[] = [];
      let size = 0;
      while (pending.length && selectedPins.length < 100) {
        const pin = pending.shift()!;
        if (batch.has(pin.sha256) || pin.size > 256 * 1024 || retained + pin.size > 2 * 1024 * 1024) continue;
        if (selectedPins.length && size + pin.size > 256 * 1024) {
          pending.unshift(pin);
          break;
        }
        selectedPins.push(pin);
        size += pin.size;
        retained += pin.size;
      }
      if (!selectedPins.length) continue;
      const values = await exchangeObjectReader(ctx, false, 0).read(
        selected.projectId,
        selected.owner,
        selectedPins,
      );
      for (const [index, pin] of selectedPins.entries()) batch.set(pin.sha256, values[index]!);
    }
  }
  const requests: RowRequest[] = [];
  for (const pin of pins) {
    const value = await readRecord(pin, e.read, field);
    if (field === 'lanes') requests.push({ collection: '_buildSubmission', parent: String(value.id) });
    if (field === 'views')
      requests.push(
        { collection: '_buildFamily', parent: family(value as unknown as WorkView), last: true },
        { collection: '_buildLocalAcceptance', parent: String(value.id) },
        { collection: '_buildHostedAcceptance', parent: String(value.id) },
      );
  }
  const rowPages = requests.length ? await ctx.runQuery(rowBatchRef, { ...selected, requests }) : [];
  const key = (r: RowRequest) => JSON.stringify([r.collection, r.parent, r.last ?? false]);
  const rowCache = new Map(rowPages.map((rows, index) => [key(requests[index]!), rows]));
  const readRows = (collection: string, parent: string, offset = 0, last = false) => {
    const request = { collection, parent, last };
    const cached = offset === 0 ? rowCache.get(key(request)) : undefined;
    return cached ? Promise.resolve(cached) : ctx.runQuery(rowsRef, { ...selected, ...request, offset });
  };
  const lookup = (collection: string, key: string) =>
    ctx.runQuery(lookupRef, { ...selected, collection, key });
  const main = (await lookup('hostedChannels', 'main')) ?? (await lookup('channels', 'main'));
  const mainHead: string | null = main ? JSON.parse(main.value).head : null;
  const result: IndexEntry[] = [];
  const changedStates = new Map<string, ChangedStates>();
  let outputBytes = 0;
  const started = Date.now();
  c.record -= pins.length;
  for (const pin of pins) {
    const value = await readRecord(pin, e.read, field);
    const head = typeof value.head === 'string' ? value.head : undefined;
    // The cockpit resolves current membership from the staged parent facts at
    // read time, as it does for native owner-fact projections. Do not traverse
    // the entire source history again for every retained View and run.
    const included = !mainHead ? (field === 'lanes' ? null : true) : head === mainHead ? true : null;
    const mainSummary = { head: mainHead, included };
    let data = partialWork(e.records, [{ collection: field, value }]);
    let summary: unknown;
    const derived: IndexEntry[] = [];
    if (field === 'lanes') {
      const submitted: string[] = [];
      let offset = 0;
      while (true) {
        const rows = await readRows('_buildSubmission', String(value.id), offset);
        for (const row of rows) submitted.push(JSON.parse(row.value).head);
        if (rows.length < 100) break;
        offset = rows.at(-1)!.position + 1;
      }
      summary = laneSummary(data.lanes[0]!, mainSummary, submitted);
    } else if (field === 'runs') summary = runSummary(data.runs[0]!, mainSummary);
    else {
      const selectedView = value as unknown as WorkView;
      const [latest] = await readRows('_buildFamily', family(selectedView), 0, true);
      data = await viewContext(ctx, selected, e, selectedView, latest?.key ?? selectedView.id, readRows);
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
        states = await viewStates(
          ctx,
          { backup, manifest: e.manifest, data },
          selected.owner,
          0,
          changedStates,
        );
      } catch {
        await ctx.runQuery(internal.projectBackups.get, { id: backup._id, owner: selected.owner });
      }
      derived.push(...viewIndexEntries(data, states, { index: 0, positions: new Map() }));
    }
    const entries = [
      ...indexedRecord(
        field,
        String(value.id),
        field === 'lanes' || field === 'views' ? String(value.intentId) : String(value.viewId),
        0,
        value,
        summary,
      ),
      ...derived,
    ];
    result.push(...entries);
    c.record++;
    outputBytes += entries.reduce((bytes, entry) => bytes + Buffer.byteLength(JSON.stringify(entry)), 0);
    if (result.length >= 500 || outputBytes >= 500000 || Date.now() - started >= 1000) break;
  }
  await addDiffstats(
    ctx,
    { backup, manifest: e.manifest, data: partialWork(e.records, []) },
    selected.owner,
    result,
    changedStates,
  );
  return result;
}
