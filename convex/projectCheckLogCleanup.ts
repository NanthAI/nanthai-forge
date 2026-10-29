// SPDX-License-Identifier: Apache-2.0
'use node';
import { isMachineRunner } from '../src/hosted-machine-runner';
import { snapshotReader } from './projectCheckLogCleanupSnapshot';
import { resumePlan, planStep } from './projectCheckLogCleanupPlan';
import { stepRef, lookupRef } from './projectCheckLogCleanupTypes';
import { cleanupStreamStep } from './projectCheckLogCleanupStream';
import { hostedCheckRunSchema, hostedCheckTerminal } from '../src/hosted-check';
import { v, ConvexError } from 'convex/values';
import { action } from './cliServer';
import { internal } from './_generated/api';
import type { ActionCtx } from './_generated/server';
import type { Doc, Id } from './_generated/dataModel';
import { source } from './projectWorkLoad';
import { exchangeObjectReader } from './projectExchangeReader';
import { resolveExchangeWork } from '../src/native-exchange-stream';
import { sourceManifestSchema } from '../src/work-archive-metadata';
import { parseNativeState } from '../src/native-state-format';
import { objectRecipeSchema, objectChunkPageSchema } from '../src/object-chunks';
import { isCheckMaintenancePath } from '../src/check-log-policy';
import { checkLogStoragePlan, type LogStorageSnapshot } from '../src/check-log-storage-plan';
import { digest } from '../src/hash';
import { deleteR2Object } from './r2Operations';
import { r2Config } from './r2';
import { invariant } from '../src/errors';
import { report } from './errors';

/** Explicit finite maintenance, with indexed DB pages and no scheduled continuation.
 * Reads metadata/recipes, never full provider log bytes. */
export async function planProjectCheckLogs(
  ctx: ActionCtx,
  projectId: Id<'hostedProjects'>,
  actor: string,
  ignoreArchives = false,
) {
  let guard = '';
  async function pages<T>(
    kind: 'backups' | 'objects' | 'states' | 'proposals' | 'output-streams' | 'check-runs',
  ) {
    const rows: T[] = [];
    let cursor: string | null = null;
    do {
      const page = JSON.parse(
        await ctx.runQuery(internal.projectCheckLogCleanupStore.inventory, {
          projectId,
          actor,
          kind,
          cursor,
        }),
      );
      invariant(
        !guard || guard === page.guard,
        'WORK_STALE',
        'Project changed during log cleanup inventory.',
      );
      guard = page.guard;
      rows.push(...page.page);
      cursor = page.isDone ? null : page.continueCursor;
    } while (cursor);
    return rows;
  }
  const outputStreams = await pages<Doc<'projectHostedOutputStreams'>>('output-streams');
  const checkRuns = await pages<Doc<'projectHostedCheckRuns'>>('check-runs');
  const hosted = new Map(
    checkRuns.map(row => {
      const run = hostedCheckRunSchema.parse(JSON.parse(row.value));
      return [run.id, run];
    }),
  );
  const hostedOutputs = outputStreams.flatMap(stream => {
    const run = hosted.get(stream.runId),
      descriptor = JSON.parse(stream.descriptor);
    if (
      !run ||
      !hostedCheckTerminal(run) ||
      stream.retired ||
      descriptor.stream === 'artifact' ||
      descriptor.kind === 'summary'
    )
      return [];
    const rawLocal = isMachineRunner(run.configuration);
    const expiresAt =
      descriptor.expiresAt ??
      Date.parse(run.endedAt ?? run.at) + (run.checkLogs?.retentionDays ?? 90) * 86400000;
    if (rawLocal && run.checkLogs?.uploadLocal && Date.now() < expiresAt) return [];
    return [{ runId: stream.runId, streamId: stream.streamId, bytes: stream.bytes }];
  });
  const backups = await pages<Doc<'projectBackups'>>('backups');
  const objects = await pages<Doc<'projectObjects'>>('objects');
  const states = await pages<Doc<'projectHostedStates'>>('states');
  const proposals = await pages<Doc<'projectProposals'>>('proposals');
  const reader = exchangeObjectReader(ctx, true);
  const read = async (pin: { sha256: string; size: number }) =>
    (await reader.read(projectId, actor, [pin]))[0]!;
  const snapshots: LogStorageSnapshot[] = [];
  const protectedPins = new Set<string>();
  for (const row of objects) if (row.sourceReferenced) protectedPins.add(row.digest);
  const archives: { backupId: string; digest: string; size: number }[] = [];
  for (const backup of backups.filter(
    row => row.status === 'stored' && (!ignoreArchives || row.transport === 'objects'),
  )) {
    const snapshot = await source(ctx, backup._id, actor, reader, false, false);
    for (const file of snapshot.manifest.files)
      if (!isCheckMaintenancePath(file.path)) protectedPins.add(file.sha256);
    snapshots.push({
      id: backup._id,
      files: snapshot.manifest.files.filter(file => isCheckMaintenancePath(file.path)),
      data: {
        ...(snapshot.data.autonomyPolicy ? { autonomyPolicy: snapshot.data.autonomyPolicy } : {}),
        runs: snapshot.data.runs.map(run => ({
          id: run.id,
          startedAt: run.startedAt,
          endedAt: run.endedAt,
          artifacts: run.artifacts,
          ...(run.backend
            ? { backend: { actual: run.backend.actual, requested: run.backend.requested } }
            : {}),
        })),
      },
    });
    protectedPins.add(backup.objectManifest?.digest ?? backup.digest);
    if (backup.ownerDerived) protectedPins.add(backup.ownerDerived.sha256);
    if (backup.transport !== 'objects' && checkLogStoragePlan([snapshots.at(-1)!]).logs.length)
      archives.push({ backupId: backup._id, digest: backup.digest, size: backup.size });
  }
  // Contributor source is kept even when it has not reached main or a backup yet.
  for (const proposal of proposals.filter(row => row.status === 'stored' && row.transport === 'objects')) {
    const resolved = await resolveExchangeWork(
      await read({ sha256: proposal.digest, size: proposal.size }),
      pins => reader.read(projectId, actor, pins),
    );
    protectedPins.add(proposal.digest);
    const manifest = sourceManifestSchema.parse(JSON.parse(resolved.manifest.toString('utf8')));
    for (const file of manifest.files) protectedPins.add(file.sha256);
  }
  const rows = new Map(objects.map(row => [row.digest, row]));
  const stateHeads = new Set(states.map(state => state.head));
  const visitedStates = new Set<string>();
  for (const head of stateHeads) {
    if (visitedStates.has(head)) continue;
    visitedStates.add(head);
    const row = rows.get(head);
    invariant(row, 'SOURCE_UNAVAILABLE', 'A registered source State is unavailable; no cleanup was applied.');
    const state = parseNativeState(await read({ sha256: head, size: row.size }));
    protectedPins.add(head);
    for (const file of state.files) protectedPins.add(file.blob);
    for (const parent of state.parents) stateHeads.add(parent);
    if (state.git) protectedPins.add(state.git.bundle);
  }
  const edges = new Map<string, string[]>();
  const initial = checkLogStoragePlan(snapshots, edges, protectedPins);
  const candidates = new Set(initial.digests);
  // A recipe used by another logical source/artifact also protects shared chunks.
  for (const row of objects.filter(row => row.recipe && !row.removed)) {
    const recipePin = { sha256: row.recipe!.digest, size: row.recipe!.size };
    const recipe = objectRecipeSchema.parse(JSON.parse((await read(recipePin)).toString('utf8')));
    invariant(
      recipe.object.sha256 === row.digest && recipe.object.size === row.size,
      'INVALID_WORK_BACKUP',
      'Object recipe differs from its binding.',
    );
    edges.set(row.digest, [recipePin.sha256]);
    edges.set(recipePin.sha256, [recipe.tree.sha256]);
    if (!candidates.has(row.digest)) protectedPins.add(row.digest);
    const trees = new Map([[recipe.tree.sha256, recipe.tree]]);
    for (const tree of trees.values()) {
      if (!tree.height || edges.has(tree.sha256)) continue;
      const page = objectChunkPageSchema.parse(JSON.parse((await read(tree)).toString('utf8')));
      edges.set(
        tree.sha256,
        page.children.map(child => child.sha256),
      );
      for (const child of page.children) trees.set(child.sha256, child);
    }
  }
  const planned = checkLogStoragePlan(snapshots, edges, protectedPins);
  const selected = planned.digests.flatMap(pin => {
    const row = rows.get(pin);
    return row && !row.removed && (row.storageId || row.recipe || row.r2Committed) ? [row] : [];
  });
  const scope = { guard, logs: planned.logs, digests: planned.digests, archives, hostedOutputs };
  return {
    ...scope,
    planDigest: digest(JSON.stringify(scope)),
    shared: planned.shared,
    objects: selected,
    bytes:
      selected.filter(row => !row.recipe).reduce((sum, row) => sum + row.size, 0) +
      hostedOutputs.reduce((sum, stream) => sum + stream.bytes, 0),
    offset: 0,
  };
}
export async function applyPlanStep(
  ctx: ActionCtx,
  identity: import('./projectCheckLogCleanupTypes').Identity,
  state: import('./projectCheckLogCleanupTypes').PlanState,
) {
  if (state.outputOffset < state.counts.hostedOutputs) {
    const body = await ctx.runQuery(lookupRef, {
      ...identity,
      part: 'hostedOutputs',
      position: state.outputOffset,
    });
    invariant(body, 'NOT_FOUND', 'Original cleanup stream page is unavailable.');
    const streams = JSON.parse(body);
    const expected = JSON.stringify(state);
    const writes = await cleanupStreamStep(ctx, identity, state, streams[0]);
    state.step++;
    state = JSON.parse(
      await ctx.runMutation(stepRef, {
        ...identity,
        expected,
        value: JSON.stringify(state),
        nodes: '[]',
        writes: JSON.stringify(writes),
      }),
    );
  } else if (state.offset < state.counts.objects) {
    const pending = JSON.parse(
      await ctx.runMutation(internal.projectCheckLogCleanupStore.claim, {
        ...identity,
        offset: state.offset,
      }),
    );
    if (pending.jobs.length) {
      const config = r2Config();
      for (const job of pending.jobs) await deleteR2Object(config, job.key);
    }
    state = JSON.parse(await ctx.runMutation(internal.projectCheckLogCleanupStore.complete, identity));
  }
  return state;
}
/** Each invocation advances at most twenty metadata steps or one deletion page.
 * The caller continues immediately only while this requested operation is pending. */
export const clean = action({
  args: {
    projectId: v.id('hostedProjects'),
    operationId: v.string(),
    apply: v.optional(v.boolean()),
    expectedPlan: v.optional(v.string()),
  },
  returns: v.string(),
  handler: async (ctx, input): Promise<string> => {
    try {
      const user = await ctx.auth.getUserIdentity();
      invariant(user, 'PROJECT_UNAVAILABLE', 'Sign in as this project owner to clean stored logs.');
      invariant(/^[0-9a-f-]{36}$/i.test(input.operationId), 'BAD_ARGUMENT', 'Use an original cleanup UUID.');
      const identity = { projectId: input.projectId, actor: user.subject, operationId: input.operationId };
      let state = await resumePlan(ctx, identity);
      const started = Date.now(),
        snapshot = snapshotReader(ctx, identity);
      if (!input.apply) {
        for (let steps = 0; state.phase !== 'ready' && steps < 20 && Date.now() - started < 5000; steps++)
          state = await planStep(ctx, identity, state, snapshot);
      } else {
        invariant(
          state.phase === 'ready' && input.expectedPlan === state.planDigest,
          'EVIDENCE_CHANGED',
          'Apply the exact reviewed cleanup plan.',
        );
        invariant(
          !state.counts.archives,
          'ARCHIVE_MIGRATION_REQUIRED',
          'The cleanup client must convert the planned native archives before deleting stored log objects.',
        );
        state = await applyPlanStep(ctx, identity, state);
      }
      const pending =
        state.phase !== 'ready' ||
        (!!input.apply &&
          (state.offset < state.counts.objects || state.outputOffset < state.counts.hostedOutputs));
      return JSON.stringify({
        dryRun: !input.apply,
        pending,
        progress: JSON.stringify({
          phase: state.phase,
          step: state.step,
          done: state.offset + state.outputOffset,
        }),
        planDigest: state.planDigest,
        counts: state.counts,
        objects: state.counts.objects,
        bytes: state.bytes,
        deleted: input.apply ? state.offset : 0,
        complete: !!input.apply && !pending,
        actionMs: Date.now() - started,
      });
    } catch (error) {
      if (error instanceof ConvexError) throw error;
      return report(error);
    }
  },
});
