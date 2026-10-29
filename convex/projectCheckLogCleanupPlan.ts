// SPDX-License-Identifier: Apache-2.0
'use node';
import { isMachineRunner } from '../src/hosted-machine-runner';
import type { ActionCtx } from './_generated/server';
import type { Doc } from './_generated/dataModel';
import { internal } from './_generated/api';
import {
  beginRef,
  readRef,
  stepRef,
  lookupRef,
  nodesRef,
  queueRef,
  sourcesRef,
  type Identity,
  type PlanState,
  type Node,
  type PlanWrite,
  type Part,
} from './projectCheckLogCleanupTypes';
import { snapshotReader } from './projectCheckLogCleanupSnapshot';
import { exchangeObjectReader } from './projectExchangeReader';
import { parseNativeState } from '../src/native-state-format';
import { objectRecipeSchema, objectChunkPageSchema } from '../src/object-chunks';
import { isCheckMaintenancePath, portableCheckPath } from '../src/check-log-policy';
import { hostedCheckRunSchema, hostedCheckTerminal } from '../src/hosted-check';
import { invariant } from '../src/errors';
import { digest } from '../src/hash';
const phases = [
  'check-runs',
  'output-streams',
  'objects',
  'backups',
  'proposals',
  'states',
  'recipes',
  'trees',
  'closure',
  'source-union',
  'source-closure',
  'select',
  'ready',
];
export async function resumePlan(ctx: ActionCtx, input: Identity, automatic = false): Promise<PlanState> {
  const prior = await ctx.runQuery(readRef, input);
  if (prior) {
    const state = JSON.parse(prior);
    invariant(
      state.version === 2,
      'WORK_OPERATION_CHANGED',
      'Retain the old cleanup receipt and prepare a new plan file.',
    );
    return state;
  }
  return JSON.parse(
    await ctx.runMutation(beginRef, {
      ...input,
      value: JSON.stringify({
        version: 2,
        ...(automatic ? { automatic: true } : {}),
        guard: '',
        now: Date.now(),
        phase: phases[0]!,
        step: 0,
        cursor: null,
        fileOffset: 0,
        counts: { objects: 0, logs: 0, shared: 0, archives: 0, hostedOutputs: 0, digests: 0 },
        bytes: 0,
        planDigest: '',
        recipeCount: 0,
        recipeOffset: 0,
        queueCount: 0,
        queueOffset: 0,
        treeCount: 0,
        treeOffset: 0,
        offset: 0,
        outputOffset: 0,
      } satisfies PlanState),
    }),
  );
}
// Hashes this invocation already merged into the union. States share most files,
// so later States send only new hashes and the transaction reads only their leaves.
const unionSent = new WeakMap<object, Set<string>>();
export async function planStep(
  ctx: ActionCtx,
  input: Identity,
  original: PlanState,
  snapshot = snapshotReader(ctx, input),
): Promise<PlanState> {
  const expected = JSON.stringify(original),
    state = structuredClone(original);
  const nodes: Node[] = [],
    writes: PlanWrite[] = [];
  let sent: Set<string> | undefined,
    fresh: string[] = [];
  const mark = (key: string, flags: Omit<Node, 'key'>) => nodes.push({ key, ...flags });
  const put = (part: string, position: number, value: unknown) =>
    writes.push({ part, position, value: JSON.stringify(value) });
  const append = (part: Part, values: unknown[]) => {
    if (!values.length) return;
    put(part, state.counts[part], values);
    state.counts[part] += values.length;
  };
  async function lookup<T>(part: string, position = 0): Promise<T | null> {
    const value = await ctx.runQuery(lookupRef, { ...input, part, position });
    return value ? JSON.parse(value) : null;
  }
  const node = (key: string) => lookup<Node>(`node:${key}`);
  const advance = () => {
    state.phase = phases[phases.indexOf(state.phase) + 1]!;
    state.cursor = null;
  };
  const reader = exchangeObjectReader(ctx, true);
  const read = async (pin: { sha256: string; size: number }) =>
    (await reader.read(input.projectId, input.actor, [pin]))[0]!;
  if (['backups', 'proposals'].includes(state.phase)) {
    if (!state.selected) {
      const page = JSON.parse(
        await ctx.runQuery(internal.projectCheckLogCleanupStore.inventory, {
          projectId: input.projectId,
          actor: input.actor,
          kind: state.phase as 'backups' | 'proposals',
          cursor: state.cursor,
          one: true,
        }),
      );
      invariant(state.guard === page.guard, 'WORK_STALE', 'Project changed during cleanup inventory.');
      const selected = page.page[0] as Doc<'projectBackups'> | Doc<'projectProposals'> | undefined;
      state.cursor = page.isDone ? null : page.continueCursor;
      if (
        selected?.status === 'stored' &&
        (!state.automatic || state.phase !== 'backups' || selected.transport === 'objects') &&
        (state.phase === 'backups' || selected.transport === 'objects')
      ) {
        state.selected = selected;
        state.fileOffset = 0;
        mark(
          'objectManifest' in selected && selected.objectManifest
            ? selected.objectManifest.digest
            : selected.digest,
          { protected: true },
        );
        if ('ownerDerived' in selected && selected.ownerDerived)
          mark(selected.ownerDerived.sha256, { protected: true });
      } else if (page.isDone) advance();
    } else {
      const selected = state.selected,
        page = await snapshot(selected, state.fileOffset);
      const logs = [];
      for (const file of page.files) {
        const candidate =
          state.phase === 'backups' &&
          isCheckMaintenancePath(file.path) &&
          !portableCheckPath(page.data, file.path, state.now);
        mark(file.sha256, candidate ? { candidate: true } : { protected: true });
        if (candidate) logs.push({ snapshotId: selected._id, ...file });
      }
      append('logs', logs);
      if (logs.length && selected.transport !== 'objects' && !state.fileOffset)
        append('archives', [{ backupId: selected._id, digest: selected.digest, size: selected.size }]);
      // An archive may first contain logs on a later page.
      if (logs.length && selected.transport !== 'objects' && state.fileOffset) {
        if (!(await lookup(`archive:${selected._id}`))) {
          append('archives', [{ backupId: selected._id, digest: selected.digest, size: selected.size }]);
        }
      }
      if (logs.length && selected.transport !== 'objects') put(`archive:${selected._id}`, 0, true);
      state.fileOffset += page.files.length;
      if (state.fileOffset >= page.total) {
        delete state.selected;
        if (!state.cursor) advance();
      }
    }
  } else if (state.phase === 'recipes') {
    if (state.recipeOffset === state.recipeCount) advance();
    else {
      const row = (await lookup<Doc<'projectObjects'>>('recipeQueue', state.recipeOffset++))!;
      const pin = { sha256: row.recipe!.digest, size: row.recipe!.size };
      const recipe = objectRecipeSchema.parse(JSON.parse((await read(pin)).toString('utf8')));
      invariant(
        recipe.object.sha256 === row.digest && recipe.object.size === row.size,
        'INVALID_WORK_BACKUP',
        'Object recipe differs from its binding.',
      );
      mark(row.digest, {
        children: [pin.sha256],
        ...(!(await node(row.digest))?.candidate ? { protected: true } : {}),
      });
      mark(pin.sha256, { children: [recipe.tree.sha256] });
      if (recipe.tree.height) mark(recipe.tree.sha256, { tree: recipe.tree });
    }
  } else if (state.phase === 'trees') {
    if (state.treeOffset === state.treeCount) advance();
    else {
      const entry = await lookup<{ key: string }>('treeQueue', state.treeOffset++),
        current = await node(entry!.key);
      const tree = current!.tree!;
      const page = objectChunkPageSchema.parse(JSON.parse((await read(tree)).toString('utf8')));
      mark(tree.sha256, { children: page.children.map(child => child.sha256) });
      for (const child of page.children) if (child.height) mark(child.sha256, { tree: child });
    }
  } else if (state.phase === 'source-union') {
    const page = JSON.parse(await ctx.runQuery(sourcesRef, { ...input, cursor: state.cursor }));
    for (const key of page.page) mark(key, { protected: true });
    state.cursor = page.isDone ? null : page.continueCursor;
    if (page.isDone) advance();
  } else if (['closure', 'source-closure'].includes(state.phase)) {
    if (state.sourceParts) {
      const position = state.sourceOffset ?? 0;
      const refs = await lookup<Node[]>('sourceRefs', position);
      invariant(refs, 'NOT_FOUND', 'Original State reference page is unavailable.');
      nodes.push(...refs);
      state.sourceOffset = position + 1;
      if (state.sourceOffset === state.sourceParts) {
        delete state.sourceParts;
        delete state.sourceOffset;
      }
    } else if (state.queueOffset === state.queueCount) advance();
    else {
      const batch: { key: string; kind: 'candidate' | 'protected' | 'state'; node: Node }[] = JSON.parse(
        await ctx.runQuery(queueRef, { ...input, offset: state.queueOffset }),
      );
      for (const entry of batch) {
        state.queueOffset++;
        const current = entry.node;
        if (entry!.kind === 'state') {
          const [row] = await ctx.runQuery(internal.projectObjects.resolve, {
            projectId: input.projectId,
            actor: input.actor,
            digests: [entry!.key],
          });
          invariant(
            row,
            'SOURCE_UNAVAILABLE',
            'A registered source State is unavailable; no cleanup was applied.',
          );
          const source = parseNativeState(await read({ sha256: row.digest, size: row.size }));
          const refs = [
            { key: row.digest, protected: true },
            ...source.parents.map(parent => ({ key: parent, state: true })),
            ...(source.git ? [{ key: source.git.bundle, protected: true }] : []),
          ];
          // One verified parse contributes the complete deduplicated reference union.
          // The transaction merges bounded union buckets; propagation visits each hash once.
          sent = unionSent.get(snapshot) ?? new Set<string>();
          unionSent.set(snapshot, sent);
          fresh = [...new Set(source.files.map(file => file.blob))].filter(blob => !sent!.has(blob));
          if (fresh.length) put('sourceProtection', 0, fresh);
          const unique = [...new Map(refs.map(ref => [ref.key, ref])).values()];
          if (unique.length <= 3500) nodes.push(...unique);
          else {
            // Larger trees stage bounded durable pages in this same transaction.
            // Resumed propagation never downloads or parses the State again.
            for (let offset = 0; offset < unique.length; offset += 500)
              put('sourceRefs', offset / 500, unique.slice(offset, offset + 500));
            state.sourceParts = Math.ceil(unique.length / 500);
            state.sourceOffset = 0;
          }
          break; // bound this transaction to one State/tree, not 25 whole trees
        } else for (const child of current?.children ?? []) mark(child, { [entry!.kind]: true });
      }
    }
  } else if (state.phase === 'select') {
    const page = JSON.parse(await ctx.runQuery(nodesRef, { ...input, cursor: state.cursor }));
    const objects = [],
      digests = [],
      shared = [];
    for (const row of page.page) {
      const n: Node = JSON.parse(row.value);
      if (!n.candidate) continue;
      if (n.protected) {
        shared.push(n.key);
        continue;
      }
      digests.push(n.key);
      const object: Doc<'projectObjects'> | null = row.object;
      if (object && !object.removed && (object.storageId || object.recipe || object.r2Committed)) {
        objects.push(object);
        if (!object.recipe) state.bytes += object.size;
      }
    }
    append('objects', objects);
    append('digests', digests);
    append('shared', shared);
    state.cursor = page.isDone ? null : page.continueCursor;
    if (page.isDone) advance();
  } else {
    const kind = state.phase;
    const page = JSON.parse(
      await ctx.runQuery(internal.projectCheckLogCleanupStore.inventory, {
        projectId: input.projectId,
        actor: input.actor,
        kind: kind as 'objects',
        cursor: state.cursor,
      }),
    );
    invariant(state.guard === page.guard, 'WORK_STALE', 'Project changed during cleanup inventory.');
    for (const row of page.page) {
      if (state.phase === 'check-runs') put(`run:${row.runId}`, 0, JSON.parse(row.value));
      else if (state.phase === 'output-streams') {
        const run = await lookup<ReturnType<typeof hostedCheckRunSchema.parse>>(`run:${row.runId}`);
        const descriptor = JSON.parse(row.descriptor);
        if (
          !run ||
          !hostedCheckTerminal(run) ||
          row.retired ||
          descriptor.stream === 'artifact' ||
          descriptor.kind === 'summary'
        )
          continue;
        const expiresAt =
          descriptor.expiresAt ??
          Date.parse(run.endedAt ?? run.at) + (run.checkLogs?.retentionDays ?? 90) * 86400000;
        if (isMachineRunner(run.configuration) && run.checkLogs?.uploadLocal && state.now < expiresAt)
          continue;
        append('hostedOutputs', [
          {
            runId: row.runId,
            streamId: row.streamId,
            bytes: row.bytes,
            chunks: row.chunks,
            maxSequence: row.maxSequence,
            seal: row.seal,
            descriptor: row.descriptor,
          },
        ]);
        state.bytes += row.bytes;
      } else if (state.phase === 'objects') {
        put(`object:${row.digest}`, 0, row);
        if (row.recipe && !row.removed) put('recipeQueue', state.recipeCount++, row);
        if (row.sourceReferenced) mark(row.digest, { protected: true });
      } else if (state.phase === 'states') mark(row.head, { state: true });
    }
    state.cursor = page.isDone ? null : page.continueCursor;
    if (page.isDone) advance();
  }
  state.step++;
  state.planDigest = digest(
    JSON.stringify([
      state.planDigest,
      state.guard,
      writes.filter(w =>
        ['objects', 'logs', 'shared', 'archives', 'hostedOutputs', 'digests'].includes(w.part),
      ),
    ]),
  );
  const next: PlanState = JSON.parse(
    await ctx.runMutation(stepRef, {
      ...input,
      expected,
      value: JSON.stringify(state),
      nodes: JSON.stringify(nodes),
      writes: JSON.stringify(writes),
    }),
  );
  for (const blob of fresh) sent!.add(blob); // only after the union commit
  return next;
}
