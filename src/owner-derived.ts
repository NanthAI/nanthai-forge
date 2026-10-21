// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';
import { COORDINATION_LIMITS } from './coordination-types.js';
import { digest } from './hash.js';
import { reviewPaths } from './native-source-review.js';
import { contextualHunks } from './review-hunks.js';
import { viewIndexEntries } from './view-hosted-index.js';
import { workSourcePins } from './work-archive-metadata.js';
import { laneSummary, viewSummary } from './work-hosted-summary.js';
import { viewReadModels, viewContributors } from './view-read-model.js';
import type { WorkData } from './work-types.js';
import type { NativeSource } from './native-source.js';
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const count = z.number().safe().nonnegative();
const row = z
  .object({
    collection: z.string(),
    key: z.string(),
    parent: z.string(),
    position: count,
    value: z.string(),
    actor: z.string().optional(),
  })
  .strict();
export const ownerDerivedSchema = z
  .object({
    schema: z.union([z.literal(2), z.literal(3)]),
    work: hash,
    complete: z.boolean().default(false),
    parents: z.array(z.tuple([hash, z.array(hash)])),
    ancestry: z.array(z.tuple([hash, z.array(hash)])),
    stats: z.array(
      z.tuple([
        z.string(),
        z.object({ files: count, add: count.optional(), del: count.optional() }).strict(),
      ]),
    ),
    views: z.array(z.tuple([z.string(), z.string(), z.array(row)])),
    changes: z
      .array(
        z
          .object({
            laneId: z.string(),
            from: hash,
            head: hash,
            paths: z.array(z.string()),
            pathCount: count,
          })
          .strict(),
      )
      .default([]),
    trees: z.array(
      z.tuple([
        hash,
        z.array(
          z
            .object({ path: z.string(), blob: hash, mode: z.enum(['file', 'executable', 'symlink']) })
            .strict(),
        ),
      ]),
    ),
  })
  .strict();
export const OWNER_DERIVED_MAX_BYTES = 4 * 1024 * 1024;
export const OWNER_DISPLAY_PROTOCOL = 3 as const;
export type OwnerDerivedBaseline = { states: ReadonlySet<string>; data?: WorkData | undefined };
export type OwnerDerived = z.infer<typeof ownerDerivedSchema>;
export const viewFingerprint = (data: WorkData, index: number) => {
  const view = data.views[index]!;
  return digest(
    JSON.stringify([
      view,
      viewReadModels(data, index)[0],
      viewContributors(data, view).map(c => [
        c,
        data.intents.find(i => i.id === data.lanes.find(l => l.id === c.laneId)?.intentId)?.outcome,
      ]),
      data.intents.find(i => i.id === view.intentId)?.outcome,
    ]),
  );
};
export const selectedTreeHeads = (data: WorkData) => [
  ...new Set([
    data.nativeHead!,
    ...data.channelMoves
      .filter(m => m.channel === 'main')
      .slice(-1)
      .map(m => m.head),
    ...(data.hostedChannelMoves ?? [])
      .filter(m => m.channel === 'main')
      .slice(-1)
      .map(m => m.head),
  ]),
];
/** Select against the pinned hosted baseline before deriving any source facts.
 * Ancestry contains own-parent deltas, never copied historical closures. */
export function computeOwnerDerived(
  data: WorkData,
  source: NativeSource,
  previous?: OwnerDerived,
  baseline?: OwnerDerivedBaseline,
): OwnerDerived {
  const parents = new Map<string, string[]>(),
    stats = new Map<string, OwnerDerived['stats'][number][1]>();
  const cachedStats = new Map(previous?.stats);
  const cachedTrees = new Map(previous?.trees);
  const states = new Map<string, ReturnType<NativeSource['state']>>();
  const state = (head: string) => {
    let value = states.get(head);
    if (!value) {
      value = source.state(head);
      states.set(head, value);
    }
    return value;
  };
  const files = (head: string) => cachedTrees.get(head) ?? state(head).files;
  const heads = [
    ...new Set([
      ...workSourcePins(data),
      ...data.lanes.flatMap(l => [l.base, l.head]),
      ...data.channelMoves.map(m => m.head),
      ...(data.hostedChannelMoves ?? []).map(m => m.head),
      ...data.views.flatMap(v => [v.base, ...(v.head ? [v.head] : [])]),
      ...data.runs.map(r => r.head),
    ]),
  ];
  const pending = [...heads];
  const cachedParents = new Map(previous?.parents);
  const visited = new Set<string>();
  while (pending.length) {
    const head = pending.pop()!;
    if (visited.has(head) || baseline?.states.has(head)) continue;
    visited.add(head);
    const list = cachedParents.get(head) ?? source.state(head).parents;
    parents.set(head, list);
    pending.push(...list);
  }
  // Compare the same Lane/View summaries as the hosted delta planner, including
  // supersession caused by a different View. Lane and View IDs have separate keys.
  const comparisons = (work: WorkData) => {
    const models = new Map(viewReadModels(work).map(v => [v.viewId, v]));
    return [
      ...work.lanes.map((record, position) => ({
        position,
        key: `lane:${record.id}`,
        record,
        summary: laneSummary(record),
      })),
      ...work.views.map((record, position) => ({
        position,
        key: `view:${record.id}`,
        record,
        summary: {
          ...viewSummary(record),
          viewStatus: models.get(record.id)!.status,
          supersededBy: models.get(record.id)!.supersededBy,
          inputs: models.get(record.id)!.inputs,
        },
      })),
    ];
  };
  const priorRecords = new Map(
    baseline?.data
      ? comparisons(baseline.data).map(r => [r.key, JSON.stringify([r.position, r.summary])])
      : [],
  );
  for (const { key: identity, record, summary, position } of comparisons(data)) {
    if (priorRecords.get(identity) === JSON.stringify([position, summary])) continue;
    if (!record.head || ('status' in record && record.status === 'conflict')) continue;
    const key = `${record.base}:${record.head}`;
    if (stats.has(key)) continue;
    const cached = cachedStats.get(key);
    if (cached) {
      stats.set(key, cached);
      continue;
    }
    const changed = reviewPaths(files(record.base), files(record.head)).filter(f => f.status !== 'unchanged');
    let add = 0,
      del = 0,
      exact = true;
    for (const file of changed) {
      const before = file.before ? source.object(file.before.blob) : Buffer.alloc(0),
        after = file.after ? source.object(file.after.blob) : Buffer.alloc(0);
      if (before.length > 1024 * 1024 || after.length > 1024 * 1024) {
        exact = false;
        continue;
      }
      const compared = contextualHunks(before, after, 0);
      if (compared.truncated) {
        exact = false;
        continue;
      }
      if (!file.before || !file.after) {
        const text = new TextDecoder().decode(file.before ? before : after),
          lines = text ? text.split('\n').length - Number(text.endsWith('\n')) : 0;
        if (file.before) del += lines;
        else add += lines;
      } else
        for (const hunk of compared.hunks)
          for (const line of hunk.lines) {
            if (line.kind === 'added') add++;
            if (line.kind === 'removed') del++;
          }
    }
    const changes = { files: changed.length, ...(exact ? { add, del } : {}) };
    stats.set(key, changes);
    states.clear();
  }
  const cachedViews = new Map(previous?.views.map(([id, fingerprint, rows]) => [id, { fingerprint, rows }]));
  const priorViews = new Map(baseline?.data?.views.map((v, i) => [v.id, viewFingerprint(baseline.data!, i)]));
  const views: OwnerDerived['views'] = [];
  const addView = (value: OwnerDerived['views'][number]) => {
    views.push(value);
  };
  data.views.forEach((view, index) => {
    const fingerprint = viewFingerprint(data, index),
      cached = cachedViews.get(view.id);
    if (priorViews.get(view.id) === fingerprint) return;
    if (cached?.fingerprint === fingerprint) {
      addView([view.id, fingerprint, cached.rows]);
      return;
    }
    const files = new Map<string, ReturnType<NativeSource['state']>['files']>();
    if (view.head && view.status !== 'conflict')
      for (const head of [
        view.base,
        view.head,
        ...viewContributors(data, view).flatMap(c => [
          c.head,
          ...c.saves.flatMap(({ save }) => [save.parent, save.head]),
        ]),
      ])
        files.set(head, cachedTrees.get(head) ?? state(head).files);
    addView([view.id, fingerprint, viewIndexEntries(data, files, { index, positions: new Map() })]);
    states.clear();
  });
  return {
    schema: 3,
    complete: !baseline?.data,
    work: digest(JSON.stringify(data, null, 2)),
    parents: [...parents],
    ancestry: [...parents],
    stats: [...stats],
    views,
    trees: selectedTreeHeads(data)
      .filter(head => !baseline?.data || !selectedTreeHeads(baseline.data).includes(head))
      .map(head => [head, files(head)]),
    changes: data.lanes
      .filter(l => baseline?.data?.lanes.find(old => old.id === l.id)?.head !== l.head)
      .flatMap(lane => {
        const known = baseline?.data?.lanes.find(old => old.id === lane.id)?.head;
        return [...new Set(known ? [known] : [lane.base, ...lane.checkpoints.map(save => save.head)])].map(
          from => {
            const cached = previous?.changes.find(
              row => row.laneId === lane.id && row.from === from && row.head === lane.head,
            );
            if (cached) return cached;
            const paths = reviewPaths(files(from), files(lane.head))
              .filter(f => f.status !== 'unchanged')
              .map(f => f.path);
            return {
              laneId: lane.id,
              from,
              head: lane.head,
              paths: paths.slice(0, COORDINATION_LIMITS.changePaths),
              pathCount: paths.length,
            };
          },
        );
      }),
  };
}
