import { previewLanding, previewExclusionMessage } from './integration-preview-landing.js';
// SPDX-License-Identifier: Apache-2.0
import { landingConflictPeers } from './landing-conflict-peers.js';
import { landingOverlap } from './landing-overlap.js';
import { resolveDocsComposition } from './native-docs-resolve.js';
import { orderLandingEntries } from './landing-batch-order.js';
import { join } from 'node:path';
import { digest } from './hash.js';
import { invariant } from './errors.js';
import { retryWorkPhase } from './work-retry.js';
import { finishChild } from './agent-finish-journal.js';
import { checkEnvironment, changedEnvironmentFields } from './check-environment.js';
import { readPolicy, acceptancePaths } from './work-autonomy.js';
import { reviewReason } from './autonomy-policy.js';
import { checkRoute } from './check-backend.js';
import { NativeSource } from './native-source.js';
import type { WorkService } from './work.js';
import type { CheckRun, WorkData, WorkView } from './work-types.js';
import type { FinishAction } from './agent-workflow-schema.js';
import type { LandingBatch, LandingEntry } from './landing-batch-types.js';

export const batchDirectory = (work: WorkService, channel: string) =>
  join(work.store.directory, 'landing-batch-drain', digest(channel));
export function batchEdit<T>(
  work: WorkService,
  id: string,
  edit: (data: WorkData) => T,
  beforePublish?: () => void,
) {
  return retryWorkPhase(id, () =>
    work.store.locked(() => {
      beforePublish?.();
      const data = work.store.load();
      const before = JSON.stringify(data);
      const result = edit(data);
      if (JSON.stringify(data) === before) return result;
      const expanded =
        Number(data.schema) >= 19 || data.landingBatches?.some(batch => batch.entryIds.length > 4);
      data.schema = (
        Number(data.schema) >= 21
          ? data.schema
          : [16, 18, 20].includes(Number(data.schema))
            ? expanded
              ? 20
              : 18
            : expanded
              ? 19
              : 17
      ) as WorkData['schema'];
      data.revision++;
      work.store.save(data);
      return result;
    }),
  );
}
export function batchEligible(work: WorkService, command: FinishAction, view: WorkView) {
  if (!work.store.native || !command.accept || command.accept.invariant || !view.head) return false;
  const policy = readPolicy(work.store),
    paths = acceptancePaths(work.store, view, command.accept.expectedPrevious);
  // Runner policy is the staged rollout boundary; legacy unconfigured local finishes retain their protocol.
  return (
    policy.checks !== undefined &&
    !reviewReason(policy, work.actor, paths) &&
    !paths.every(path => /^(?:docs\/.+|[^/]+)\.md$/.test(path))
  );
}
export async function enqueueLanding(work: WorkService, command: FinishAction, view: WorkView) {
  return batchEdit(work, command.operationId, data => {
    const request = digest(JSON.stringify({ command, viewId: view.id, head: view.head }));
    const original = data.landingEntries?.find(entry => entry.id === command.operationId);
    if (original) {
      invariant(
        original.request === request,
        'WORK_OPERATION_CHANGED',
        'Reconcile the original queued landing pins.',
      );
      return original;
    }
    const environment = checkEnvironment();
    const entry: LandingEntry = {
      id: command.operationId,
      request,
      channel: command.accept!.channel,
      viewId: view.id,
      head: view.head!,
      checkId: command.checkId!,
      definition: command.expectedDefinition!,
      environment: command.expectedEnvironment ?? environment.fingerprint,
      ...(command.expectedEnvironment === undefined || command.expectedEnvironment === environment.fingerprint
        ? { environmentSnapshot: environment }
        : {}),
      ...(command.preview ? { preview: command.preview } : {}),
      arrivedAt: new Date().toISOString(),
      priority: command.priority ?? 'normal',
      submitter: command.actor ?? work.actor.id,
      keepOpen: command.keepOpen ?? false,
      status: 'queued',
    };
    (data.landingEntries ??= []).push(entry);
    return entry;
  });
}
/** Channel head accepted so far, or null before the first acceptance. */
export const acceptedHead = (data: WorkData, channel: string) =>
  [...data.channelMoves].reverse().find(move => move.channel === channel && move.status === 'accepted')
    ?.head ?? null;
const activeBatches = (data: WorkData, channel: string) =>
  (data.landingBatches ?? []).filter(
    batch => batch.channel === channel && ['composing', 'checking'].includes(batch.status),
  );
/** Remote runners do not share the owner's CPU, so batches may be larger and may overlap. */
export function landingShape(work: WorkService, check: CheckRun['check']) {
  const policy = readPolicy(work.store),
    remote = checkRoute(policy.checks?.runner ?? 'local', check, true).actual !== 'local';
  return {
    remote,
    maxBatch: remote ? 8 : 4,
    concurrency: remote ? (policy.checks?.concurrency ?? 4) : 1,
    windowMs: remote ? (policy.acceptance.batchWindowMs ?? 2000) : 0,
  };
}
/** Select immediately; eject incompatible pins before running any checks. With `started`
 * (a driver's in-flight batch ids), adopt unstarted active batches first, then stack a new
 * speculative batch on the newest active one while concurrency allows. */
export function selectBatch(
  work: WorkService,
  data: WorkData,
  channel: string,
  started?: ReadonlySet<string>,
): LandingBatch | undefined {
  for (const active of activeBatches(data, channel)) {
    if (started?.has(active.id)) continue;
    // Older batches did not retain a runtime snapshot. Recover it from actual
    // evidence, or re-admit unchecked entries against this driver's runtime.
    active.environment ??= data.runs.find(run =>
      active.prefixes.some(prefix => prefix.runId === run.id),
    )?.environment;
    if (active.environment) return active;
    active.status = 'superseded';
    for (const entry of data.landingEntries ?? [])
      if (entry.batchId === active.id && entry.status === 'checking') entry.status = 'queued';
  }
  const environment = checkEnvironment();
  for (const entry of data.landingEntries ?? []) {
    if (entry.channel !== channel || entry.status !== 'queued') continue;
    const definition = data.checks.find(check => check.id === entry.checkId)?.definition;
    const fields = entry.environmentSnapshot
      ? changedEnvironmentFields(entry.environmentSnapshot, environment)
      : entry.environment === environment.fingerprint
        ? []
        : ['environment fingerprint (legacy entry)'];
    if (definition !== entry.definition) fields.unshift('check definition');
    if (fields.length) {
      entry.status = 'interrupted';
      entry.reason = `Queued landing pins changed: ${fields.join(', ')}. Submit finish again from the intended runtime.`;
    }
  }
  const queued = orderLandingEntries(
    (data.landingEntries ?? []).filter(entry => entry.channel === channel && entry.status === 'queued'),
  );
  const activeEntries = (data.landingEntries ?? []).filter(
    entry => entry.channel === channel && entry.status === 'checking',
  );
  const overlap = landingOverlap(work.store, data, [...queued, ...activeEntries]);
  const pending = overlap.ordered.filter(entry => queued.includes(entry));
  // Original insertion order breaks equal timestamp ties and survives requeue/restart.
  const first = pending[0];
  if (!first) return;
  const check = data.checks.find(check => check.id === first.checkId)!;
  const shape = landingShape(work, check);
  const actives = activeBatches(data, channel),
    parent = actives.at(-1);
  if (parent) {
    // Only an unstarted-free driver stacks: speculation needs a composed parent of the same pins.
    const lead = data.landingEntries?.find(entry => entry.id === parent.entryIds[0]);
    if (
      !shape.remote ||
      actives.length >= shape.concurrency ||
      parent.status !== 'checking' ||
      parent.mode !== 'parallel' ||
      !lead ||
      lead.checkId !== first.checkId ||
      lead.definition !== first.definition ||
      lead.environment !== first.environment ||
      lead.keepOpen !== first.keepOpen
    )
      return;
  }
  const selected: LandingEntry[] = [];
  for (const [index, entry] of pending.entries()) {
    if (
      selected.length === shape.maxBatch ||
      entry.checkId !== first.checkId ||
      entry.definition !== first.definition ||
      entry.environment !== first.environment ||
      entry.keepOpen !== first.keepOpen
    )
      break;
    if (
      pending.slice(0, index).some(earlier => overlap.overlaps(earlier, entry)) ||
      activeEntries.some(active => overlap.overlaps(active, entry)) ||
      selected.some(other => overlap.overlaps(other, entry))
    )
      continue;
    selected.push(entry);
  }
  if (!selected.length) return;
  const projected = parent ? (parent.prefixes.at(-1)?.head ?? parent.base) : undefined;
  const previous = parent
    ? parent.prefixes.length
      ? projected!
      : parent.previous
    : acceptedHead(data, channel);
  const base = projected ?? previous ?? data.nativeHead!;
  const ordinal = data.landingBatches?.length ?? 0;
  const batch: LandingBatch = {
    id: finishChild(first.id, `batch:${ordinal}`),
    channel,
    environment,
    base,
    previous,
    arrivedAt: first.arrivedAt,
    entryIds: selected.map(entry => entry.id),
    ...(parent ? { parentId: parent.id } : {}),
    mode: shape.remote ? 'parallel' : 'halving',
    status: 'composing',
    prefixes: [],
    conflicts: [],
  };
  for (const entry of selected) {
    entry.status = 'checking';
    entry.batchId = batch.id;
  }
  (data.landingBatches ??= []).push(batch);
  return batch;
}
/** Prefix Views carry every pinned Lane and dependency, across Intent boundaries. */
export async function composeBatch(work: WorkService, batch: LandingBatch, beforePublish?: () => void) {
  const entries = batch.entryIds.map(id => work.store.select('landingEntries', id)!);
  const preview =
    batch.channel === 'main'
      ? previewLanding(
          work.store,
          entries.flatMap(entry => work.store.select('views', entry.viewId)!.inputs),
          {
            base: batch.base,
            skip: entries.every(entry => entry.preview === 'skip'),
            protectedLaneIds: entries
              .filter(entry => entry.preview === 'skip')
              .flatMap(entry => work.store.select('views', entry.viewId)!.inputs.map(pin => pin.laneId)),
          },
        )
      : undefined;
  const rejected = new Map(
    entries.flatMap(entry => {
      const diagnostic = preview?.excluded.find(exclusion =>
        work.store.select('views', entry.viewId)!.inputs.some(pin => pin.laneId === exclusion.laneId),
      );
      return diagnostic ? [[entry.id, diagnostic] as const] : [];
    }),
  );
  const source = new NativeSource(work.store.root);
  let head = batch.base;
  const prefixes: LandingBatch['prefixes'] = [],
    conflicts: LandingBatch['conflicts'] = [];
  const views: WorkView[] = [];
  for (const entryId of batch.entryIds) {
    if (rejected.has(entryId)) continue;
    const entry = work.store.select('landingEntries', entryId)!;
    const candidate = work.store.select('views', entry.viewId)!;
    const previous = views.filter(view => view.status === 'clean').at(-1);
    const inputs = [...(previous?.inputs ?? []), ...candidate.inputs];
    const dependencies = [...(previous?.dependencies ?? []), ...(candidate.dependencies ?? [])];
    const composed = source.compose(head, entry.head, 'Landing batch prefix', batch.arrivedAt);
    const result = composed.head
      ? composed
      : (resolveDocsComposition(source, entry.head, head, 'Landing batch prefix', batch.arrivedAt) ??
        composed);
    const id = finishChild(batch.id, `prefix:${entryId}`);
    if (!result.head) {
      const peers = landingConflictPeers(work.store, head, candidate.inputs);
      views.push({
        ...candidate,
        inputs,
        dependencies,
        id,
        base: batch.base,
        head: undefined,
        status: 'conflict',
        at: batch.arrivedAt,
        details: `Batch composition conflict with accepted peer Lane(s) ${[...new Set(peers)].join(', ') || 'unknown'}; original States retained:\n${composed.conflicts.join('\n')}`,
      });
      conflicts.push({ entryId, viewId: id });
      continue;
    }
    head = result.head;
    views.push({
      id,
      intentId: candidate.intentId,
      base: batch.base,
      composedMain: batch.base,
      head,
      status: 'clean',
      at: batch.arrivedAt,
      inputs,
      dependencies,
      details: 'Cumulative landing prefix; exact-Candidate check required before acceptance.',
    });
    prefixes.push({
      entryIds: [...(prefixes.at(-1)?.entryIds ?? []), entryId],
      viewId: id,
      head,
      runId: finishChild(batch.id, `run:${entryId}`),
    });
  }
  return batchEdit(
    work,
    batch.id,
    data => {
      const saved = data.landingBatches!.find(item => item.id === batch.id)!;
      if (saved.status !== 'composing') return saved;
      for (const view of views) if (!data.views.some(item => item.id === view.id)) data.views.push(view);
      saved.prefixes = prefixes;
      saved.conflicts = conflicts;
      saved.status = 'checking';
      for (const [id, diagnostic] of rejected) {
        const entry = data.landingEntries!.find(entry => entry.id === id)!;
        entry.status = 'failed';
        entry.reason = previewExclusionMessage;
        entry.previewDiagnostic = { ...diagnostic, main: preview!.main, key: preview!.key };
      }
      for (const conflict of conflicts) {
        const entry = data.landingEntries!.find(entry => entry.id === conflict.entryId)!;
        entry.status = 'conflict';
        entry.conflictViewId = conflict.viewId;
      }
      return saved;
    },
    beforePublish,
  );
}
