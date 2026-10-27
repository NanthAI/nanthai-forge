// SPDX-License-Identifier: Apache-2.0
'use node';
import { makeFunctionReference } from 'convex/server';
import { v } from 'convex/values';
import { internalAction, type ActionCtx } from './_generated/server';
import { internal } from './_generated/api';
import type { Doc } from './_generated/dataModel';
import type { BuildContext } from './projectWorkIndexBuildContext';
import { exchangeObjectReader } from './projectExchangeReader';
import { indexReadContext, indexTransient } from './projectWorkIndexRetry';
import { indexEntry } from './projectWorkIndexFields';
import { sourceTreeEntries } from '../src/source-tree-index';
import type { IndexEntry } from '../src/work-hosted-index';
import { parseNativeState } from '../src/native-state-format';
import { reviewPaths } from '../src/native-source-review';
import { viewContributors } from '../src/view-read-model';
import type { WorkData } from '../src/work-types';
import type { ChangedStates, Pin } from './projectDiffstatProjection';
import { invariant } from '../src/errors';
const pin = v.object({ sha256: v.string(), size: v.number() });
const file = v.object({
  path: v.string(),
  blob: v.string(),
  mode: v.union(v.literal('file'), v.literal('executable'), v.literal('symlink')),
});
type Request = { before: Pin; after: Pin; pins: Pin[] };
const batchRef = makeFunctionReference<
  'action',
  {
    projectId: Doc<'projectBackups'>['projectId'];
    actor: string;
    requests: Request[];
  },
  ChangedStates[]
>('projectWorkIndexBuildStates:batch');
/** Compare at most ten Views in bounded byte windows in a separate action.
 * The coordinator receives only changed paths, never historical source trees. */
export const batch = internalAction({
  args: {
    projectId: v.id('hostedProjects'),
    actor: v.string(),
    requests: v.array(v.object({ before: pin, after: pin, pins: v.array(pin) })),
  },
  returns: v.array(
    v.object({
      before: v.array(file),
      after: v.array(file),
      paths: v.array(v.string()),
      states: v.array(v.object({ head: v.string(), files: v.array(file) })),
    }),
  ),
  handler: async (ctx, input) => {
    ctx = indexReadContext(ctx);
    invariant(input.requests.length <= 10, 'BAD_ARGUMENT', 'Read one View source window.');
    const pins = [
      ...new Map(
        input.requests.flatMap(r => [r.before, r.after, ...r.pins]).map(p => [p.sha256, p]),
      ).values(),
    ];
    invariant(pins.length <= 100, 'BAD_ARGUMENT', 'Read one View source pin window.');
    const reader = exchangeObjectReader(ctx, false, 0);
    const states = new Map<string, ReturnType<typeof parseNativeState>['files']>();
    const bodies = await reader.read(input.projectId, input.actor, pins);
    const required = new Set(input.requests.flatMap(r => [r.before.sha256, r.after.sha256]));
    for (const [i, pin] of pins.entries())
      if (required.has(pin.sha256)) states.set(pin.sha256, parseNativeState(bodies[i]!).files);
    const results = input.requests.map(request => {
      const before = states.get(request.before.sha256)!,
        after = states.get(request.after.sha256)!;
      const paths = new Set(
        reviewPaths(before, after)
          .filter(f => f.status !== 'unchanged')
          .map(f => f.path),
      );
      return {
        before: before.filter(f => paths.has(f.path)),
        after: after.filter(f => paths.has(f.path)),
        paths: [...paths],
        states: [] as { head: string; files: typeof before }[],
      };
    });
    const paths = new Set(results.flatMap(r => r.paths));
    for (const [head, files] of states)
      states.set(
        head,
        files.filter(f => paths.has(f.path)),
      );
    for (const [i, pin] of pins.entries())
      if (!required.has(pin.sha256))
        states.set(
          pin.sha256,
          parseNativeState(bodies[i]!).files.filter(f => paths.has(f.path)),
        );
    for (const [i, request] of input.requests.entries()) {
      const result = results[i]!,
        selected = new Set(result.paths);
      result.states = request.pins.map(pin => ({
        head: pin.sha256,
        files: states.get(pin.sha256)!.filter(f => selected.has(f.path)),
      }));
    }
    return results;
  },
});
export const treeRef = makeFunctionReference<
  'action',
  {
    projectId: Doc<'projectBackups'>['projectId'];
    actor: string;
    pin: Pin;
  },
  IndexEntry[]
>('projectWorkIndexBuildStates:tree');
export const tree = internalAction({
  args: { projectId: v.id('hostedProjects'), actor: v.string(), pin },
  returns: v.array(indexEntry),
  handler: async (ctx, input) => {
    ctx = indexReadContext(ctx);
    const [bytes] = await exchangeObjectReader(ctx, false, 0).read(input.projectId, input.actor, [input.pin]);
    return sourceTreeEntries(input.pin.sha256, parseNativeState(bytes!).files);
  },
});
export async function summaryStates(
  ctx: ActionCtx,
  context: BuildContext,
  backup: Doc<'projectBackups'>,
  owner: string,
  contexts: WorkData[],
  changed: Map<string, ChangedStates>,
) {
  const requests = new Map<string, Request>();
  for (const data of contexts) {
    const view = data.views[0]!;
    if (!view.head || view.status === 'conflict') continue;
    const before = context.pins.get(view.base),
      after = context.pins.get(view.head);
    if (!before || !after) continue;
    const extra: Pin[] = [];
    let size = before.size + after.size;
    for (const head of new Set(
      viewContributors(data, view).flatMap(c => [
        c.head,
        ...c.saves.flatMap(({ save }) => [save.parent, save.head]),
      ]),
    )) {
      if (head === view.base || head === view.head) continue;
      const pin = context.pins.get(head);
      if (!pin || extra.length >= 98 || size + pin.size > 2 * 1024 * 1024) break;
      extra.push(pin);
      size += pin.size;
    }
    requests.set(`${view.base}:${view.head}`, { before, after, pins: extra });
  }
  const pending = [...requests];
  for (let offset = 0; offset < pending.length;) {
    const window: typeof pending = [],
      pins = new Map<string, Pin>();
    while (offset < pending.length && window.length < 10) {
      const entry = pending[offset]!,
        r = entry[1];
      const next = new Map([...pins, ...[r.before, r.after, ...r.pins].map(p => [p.sha256, p] as const)]);
      if (window.length && next.size > 100) break;
      window.push(entry);
      next.forEach((p, k) => pins.set(k, p));
      offset++;
    }
    try {
      const values = await ctx.runAction(batchRef, {
        projectId: backup.projectId,
        actor: owner,
        requests: window.map(([, r]) => r),
      });
      window.forEach(([key], i) => changed.set(key, values[i]!));
    } catch (error) {
      if (indexTransient(error)) throw error;
      // A missing optional save must preserve each View's existing fallback.
      await ctx.runQuery(internal.projectBackups.get, { id: backup._id, owner });
    }
  }
  // Complete optional save provenance for the entire summary window. Source
  // rows are shared by digest, filtered to the page's changed paths, and dropped
  // after their byte window rather than issuing one action per selected View.
  const needed = new Map<string, Set<string>>();
  const unionPaths = new Set<string>();
  for (const data of contexts) {
    const view = data.views[0]!,
      key = `${view.base}:${view.head}`,
      value = changed.get(key);
    if (!value) continue;
    const heads = needed.get(key) ?? new Set<string>();
    needed.set(key, heads);
    for (const contributor of viewContributors(data, view))
      for (const head of [
        contributor.head,
        ...contributor.saves.flatMap(({ save }) => [save.parent, save.head]),
      ])
        if (head !== view.base && head !== view.head && !value.states?.some(s => s.head === head))
          heads.add(head);
    value.paths.forEach(path => unionPaths.add(path));
  }
  const extras = [...new Set([...needed.values()].flatMap(heads => [...heads]))].flatMap(head => {
    const pin = context.pins.get(head);
    return pin ? [pin] : [];
  });
  for (let offset = 0; offset < extras.length;) {
    const pins: Pin[] = [];
    let bytes = 0;
    while (offset < extras.length && pins.length < 100) {
      const pin = extras[offset]!;
      if (pins.length && bytes + pin.size > 2 * 1024 * 1024) break;
      pins.push(pin);
      bytes += pin.size;
      offset++;
    }
    try {
      const states: { head: string; files?: ChangedStates['before'] }[] = await ctx.runAction(
        internal.projectWorkAncestry.stateBatch,
        { projectId: backup.projectId, actor: owner, pins, paths: [...unionPaths] },
      );
      for (const [key, heads] of needed) {
        const value = changed.get(key)!,
          paths = new Set(value.paths);
        for (const state of states)
          if (heads.has(state.head) && state.files) {
            (value.states ??= []).push({
              head: state.head,
              files: state.files.filter(f => paths.has(f.path)),
            });
            heads.delete(state.head);
          }
      }
    } catch (error) {
      if (indexTransient(error)) throw error;
      await ctx.runQuery(internal.projectBackups.get, { id: backup._id, owner });
    }
  }
}
