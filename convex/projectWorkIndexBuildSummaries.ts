// SPDX-License-Identifier: Apache-2.0
'use node';
import type { ActionCtx } from './_generated/server';
import { internal } from './_generated/api';
import type { Doc } from './_generated/dataModel';
import {
  rowsRef,
  rowBatchRef,
  type RowRequest,
  family,
  type Selected,
  type Exchange,
  type Cursor,
} from './projectWorkIndexBuildTypes';
import { buildContext, type BuildContext } from './projectWorkIndexBuildContext';
import { viewContext } from './projectWorkIndexBuildProjection';
import { readRecord, type RecordPin } from '../src/work-exchange-records';
import { partialWork } from '../src/work-exchange-delta';
import { indexedRecord, type IndexEntry } from '../src/work-hosted-index';
import { viewReadModels } from '../src/view-read-model';
import { viewIndexEntries } from '../src/view-hosted-index';
import { viewSummary, laneSummary, runSummary } from '../src/work-hosted-summary';
import { summaryDiffstats } from './projectWorkIndexBuildDiffstats';
import { summaryStates } from './projectWorkIndexBuildStates';
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
  context: BuildContext = buildContext(ctx, selected, exchange),
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
  await context.prefetch(pins);
  const e = context.exchange;
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
  const [hosted, local] = await context.main();
  const mainHead = hosted ?? local ?? null;
  if (field === 'views') {
    // Walk dependency frontiers for the whole window, then hydrate each selected
    // closure from the same bounded immutable byte memo.
    let frontier = pins;
    const seen = new Set<string>();
    const laneIds = new Set<string>(),
      intentIds = new Set<string>();
    while (frontier.length) {
      await context.prefetch(frontier);
      const next: RecordPin[] = [];
      for (const pin of frontier) {
        if (seen.has(pin.key)) continue;
        seen.add(pin.key);
        const view = (await readRecord(pin, e.read, 'views')) as unknown as WorkView;
        intentIds.add(view.intentId);
        for (const input of view.inputs) laneIds.add(input.laneId);
        const [latest] = pins.some(p => p.key === view.id)
          ? await readRows('_buildFamily', family(view), 0, true)
          : [];
        for (const id of [
          latest?.key,
          ...(view.dependencies ?? []).flatMap(d => (d.kind === 'view' ? [d.viewId] : [])),
        ]) {
          const dependency = id && context.catalogs.get('views')?.get(id);
          if (dependency && !seen.has(dependency.key)) next.push(dependency);
        }
      }
      frontier = [...new Map(next.map(p => [p.key, p])).values()];
    }
    const lanes = [...laneIds].flatMap(id => {
      const pin = context.catalogs.get('lanes')?.get(id);
      return pin ? [pin] : [];
    });
    await context.prefetch(lanes);
    for (const pin of lanes) intentIds.add(String((await readRecord(pin, e.read, 'lanes')).intentId));
    await context.prefetch(
      [...intentIds].flatMap(id => {
        const pin = context.catalogs.get('intents')?.get(id);
        return pin ? [pin] : [];
      }),
    );
  }
  const result: IndexEntry[] = [];
  const changedStates = new Map<string, ChangedStates>();
  const contexts = new Map<string, Awaited<ReturnType<typeof viewContext>>>();
  if (field === 'views') {
    for (const pin of pins) {
      const view = (await readRecord(pin, e.read, field)) as unknown as WorkView;
      const [latest] = await readRows('_buildFamily', family(view), 0, true);
      contexts.set(
        view.id,
        await viewContext(ctx, selected, e, view, latest?.key ?? view.id, readRows, context.catalogs),
      );
    }
    await summaryStates(ctx, context, backup, selected.owner, [...contexts.values()], changedStates);
  }
  if (field === 'lanes') {
    const pairs = await Promise.all(
      pins.map(async pin => {
        const value = await readRecord(pin, e.read, field);
        return partialWork(e.records, [
          { collection: 'views', value: { ...value, inputs: [], dependencies: [] } },
        ]);
      }),
    );
    await summaryStates(ctx, context, backup, selected.owner, pairs, changedStates);
  }
  const stats = await summaryDiffstats(ctx, selected, context, changedStates);
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
      data = contexts.get(selectedView.id)!;
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
          context.pins,
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
    stats,
    context.pins,
  );
  return result;
}
