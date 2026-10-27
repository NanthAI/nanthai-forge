import { prepareLandingRecords } from './landing-records-index.js';
import { editWork } from './work-edit.js';
import { recordLandingWaits, landingWait, checkingWait } from './landing-waiting.js';
import { editLandingRecords, type LandingRecordSelection } from './landing-records.js';
import { previewLanding, previewExclusionMessage } from './integration-preview-landing.js';
import { assertLandingWorkerActive } from './landing-worker-context.js';
import { interruptStaleLandingInputs } from './landing-stale.js';
// SPDX-License-Identifier: Apache-2.0
import { landingConflictPeers } from './landing-conflict-peers.js';
import { composeLandingSource } from './landing-compose-source.js';
import { join } from 'node:path';
import { digest } from './hash.js';
import { ForgeError, invariant } from './errors.js';
import { retryWorkPhase } from './work-retry.js';
import { finishChild } from './agent-finish-journal.js';
import { checkEnvironment } from './check-environment.js';
import {
  landingPins,
  changedLandingEnvironment,
  changedLandingRuntime,
  landingPinsChanged,
  type LandingPins,
} from './landing-environment.js';
import { readPolicy, acceptancePaths } from './work-autonomy.js';
import { reviewReason } from './autonomy-policy.js';
import { checkRoute } from './check-backend.js';
import { NativeSource } from './native-source.js';
import type { WorkService } from './work.js';
import type { CheckRun, WorkData, WorkView } from './work-types.js';
import type { FinishAction } from './agent-workflow-schema.js';
import type { LandingBatch, LandingEntry } from './landing-batch-types.js';
import {
  entryPins,
  markAlreadyOnMain,
  settleCompletedLanes,
  settleQueuedNoops,
  sameLandingTree,
} from './landing-noop.js';
import { soloCheckAdmission, soloCheckEnvironment } from './landing-solo-check.js';
const ACTIVE_LANDING = new Set(['queued', 'checking', 'awaiting-review']);

export const batchDirectory = (work: WorkService, channel: string) =>
  join(work.store.directory, 'landing-batch-drain', digest(channel));
export function batchEdit<T>(
  work: WorkService,
  id: string,
  edit: (data: WorkData) => T,
  beforePublish?: () => void,
  channel?: string,
  selection: LandingRecordSelection = {},
) {
  let stalePreparations = 0;
  return retryWorkPhase(id, async () => {
    const fence = () => {
      assertLandingWorkerActive();
      beforePublish?.();
    };
    assertLandingWorkerActive();
    const tx = work.store.readRecords();
    if (tx) {
      const admitCurrent = () =>
        // FIFO admission eventually owns one current pointer. The fallback
        // prepares only this selected projection, never complete Work.
        work.store.lockedAsync(() => {
          const current = work.store.readRecords();
          invariant(current, 'INVALID_WORK_STORE', 'Landing record lookup became unavailable.');
          try {
            return editLandingRecords(work.store, channel, edit, current, id, fence, selection, true);
          } finally {
            current.dispose();
          }
        });
      try {
        await prepareLandingRecords(work.store, tx);
        if (stalePreparations < 2)
          return await editLandingRecords(work.store, channel, edit, tx, id, fence, selection);
        return await admitCurrent();
      } catch (error) {
        if (error instanceof ForgeError && error.code === 'WORK_STALE') {
          stalePreparations++;
          // A slow second preparation can consume the reconciliation window.
          // Enter the existing FIFO fallback now, before the retry wrapper can
          // end this phase without ever trying its guaranteed-current pointer.
          if (stalePreparations >= 2) return await admitCurrent();
        }
        throw error;
      } finally {
        tx.dispose();
      }
    }
    // Legacy journals retain their existing validation/migration behavior.
    // Omitting channel never selects this path for indexed owners.
    return editWork(
      work.store,
      data => {
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
        return result;
      },
      fence,
    );
  });
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
export async function enqueueLanding(
  work: WorkService,
  command: FinishAction,
  view: WorkView,
  pins?: LandingPins,
) {
  return batchEdit(
    work,
    command.operationId,
    data => {
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
      // Only an in-progress entry owns its Lane/head; a terminal one (failed, interrupted, conflict…) may be resubmitted.
      const duplicate = data.landingEntries?.find(
        entry =>
          ACTIVE_LANDING.has(entry.status) &&
          entry.channel === command.accept!.channel &&
          data.views
            .find(view => view.id === entry.viewId)
            ?.inputs.some(old => view.inputs.some(pin => pin.laneId === old.laneId && pin.head === old.head)),
      );
      invariant(
        !duplicate,
        'LANDING_ALREADY_SUBMITTED',
        `This Lane/head already has landing entry ${duplicate?.id} (${duplicate?.status}). Replay that request or wait for it to finish.`,
      );
      const submitted = pins ?? landingPins();
      const environment = submitted.environment;
      const entry: LandingEntry = {
        id: command.operationId,
        request,
        channel: command.accept!.channel,
        viewId: view.id,
        head: view.head!,
        checkId: command.checkId!,
        definition: command.expectedDefinition!,
        environment: command.expectedEnvironment ?? environment.fingerprint,
        ...(command.expectedEnvironment === undefined ||
        command.expectedEnvironment === environment.fingerprint
          ? { environmentSnapshot: environment, runtimeSnapshot: submitted.runtime }
          : {}),
        ...(command.preview ? { preview: command.preview } : {}),
        arrivedAt: new Date().toISOString(),
        priority: command.priority ?? 'normal',
        submitter: command.actor ?? work.actor.id,
        keepOpen: command.keepOpen ?? false,
        status: 'queued',
      };
      const active = activeBatches(data, entry.channel);
      const check = work.store.select('checks', entry.checkId);
      (data.landingEntries ??= []).push(entry);
      // Publish the initial overlap reason with admission, not a later no-op
      // selection. The new Candidate is not yet in the queue projection.
      const admission = {
        ...data,
        views: data.views.some(item => item.id === view.id) ? data.views : [...data.views, view],
        lanes: [
          ...data.lanes,
          ...view.inputs
            .filter(pin => !data.lanes.some(lane => lane.id === pin.laneId))
            .flatMap(pin => work.store.select('lanes', pin.laneId) ?? []),
        ],
      };
      recordLandingWaits(work.store, admission, entry.channel);
      if (
        check &&
        active.length >= landingShape(work, check).concurrency &&
        entry.waitingFor?.rule !== 'overlap'
      )
        entry.waitingFor = landingWait(
          data,
          'capacity',
          'Waiting for active batches to free check capacity.',
          active.flatMap(batch => data.landingEntries?.find(entry => entry.id === batch.entryIds[0]) ?? []),
        );
      return entry;
    },
    undefined,
    command.accept!.channel,
  );
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
  const source = new NativeSource(work.store.root);
  interruptStaleLandingInputs(data, channel, source);
  settleQueuedNoops(work, data, channel, source);
  settleCompletedLanes(work, data, channel, acceptedHead(data, channel), source);
  const adopt = (batch: LandingBatch) => {
    recordLandingWaits(work.store, data, channel);
    return batch;
  };
  const environment = checkEnvironment();
  // The submitting CLI does not execute the check. The owner uses the pinned
  // definition/environment and runner recipe; its CLI build is not an input.
  for (const active of activeBatches(data, channel)) {
    if (started?.has(active.id)) continue;
    // Older batches did not retain a runtime snapshot. Recover it from actual
    // evidence, or re-admit unchecked entries against this driver's runtime.
    active.environment ??= data.runs.find(run =>
      active.prefixes.some(prefix => prefix.runId === run.id),
    )?.environment;
    // A lost reply may hide an already accepted prefix. Reconcile that canonical
    // receipt even after a controller upgrade; admission never undoes acceptance.
    const accepted = active.prefixes.some(prefix =>
      data.channelMoves.some(
        move => move.id === finishChild(active.id, `accept:${prefix.viewId}`) && move.status === 'accepted',
      ),
    );
    if (active.environment && accepted) return adopt(active);
    // An already reserved execution owns its original runtime. Observe it to
    // completion rather than superseding it into a second physical check.
    if (
      active.environment &&
      active.prefixes.some(prefix =>
        data.runs.some(
          run => run.id === prefix.runId && ['queued', 'preparing', 'running'].includes(run.status),
        ),
      )
    )
      return adopt(active);
    // Recorded environment variables can be replayed; the host/Node runtime
    // cannot. Also catch an in-place Node upgrade at the same executable path.
    const incompatible: string[] = active.environment
      ? (['platform', 'arch', 'os', 'node'] as const).filter(
          name => active.environment![name] !== environment[name],
        )
      : [];
    incompatible.push(
      ...active.entryIds.flatMap(id => {
        const entry = data.landingEntries?.find(entry => entry.id === id);
        return entry?.runtimeSnapshot
          ? changedLandingRuntime(entry.runtimeSnapshot).filter(name => name !== 'cli')
          : [];
      }),
    );
    if (active.environment && !incompatible.length) return adopt(active);
    active.status = 'superseded';
    for (const entry of data.landingEntries ?? [])
      if (entry.batchId === active.id && entry.status === 'checking') entry.status = 'queued';
  }
  for (const entry of data.landingEntries ?? []) {
    if (entry.channel !== channel || entry.status !== 'queued') continue;
    const check = data.checks.find(check => check.id === entry.checkId);
    const definition = check?.definition;
    const fields = entry.environmentSnapshot
      ? changedLandingEnvironment(entry.environmentSnapshot, environment, check)
      : entry.environment === environment.fingerprint
        ? []
        : ['environment fingerprint (legacy entry)'];
    if (entry.runtimeSnapshot)
      fields.push(...changedLandingRuntime(entry.runtimeSnapshot).filter(name => name !== 'cli'));
    if (definition !== entry.definition) fields.unshift('check definition');
    if (data.views.find(view => view.id === entry.viewId)?.head !== entry.head)
      fields.unshift('candidate head');
    // A Node upgrade changes execution pins, never the selected source or check.
    // Re-admit only when all other compatibility checks still pass. Keep arrival
    // and insertion order; fresh batches get fresh run identities and evidence.
    if (
      fields.length &&
      entry.environmentSnapshot &&
      entry.runtimeSnapshot &&
      fields.every(name => ['node', 'nodeExecutable', 'nodeBinary'].includes(name))
    ) {
      const runtime = landingPins().runtime;
      (entry.runtimeRepins ??= []).push({
        at: new Date().toISOString(),
        fields,
        previousEnvironment: entry.environment,
        environment: environment.fingerprint,
        previousRuntime: entry.runtimeSnapshot,
        runtime,
      });
      entry.environment = environment.fingerprint;
      entry.environmentSnapshot = environment;
      entry.runtimeSnapshot = runtime;
      delete entry.reason;
      delete entry.terminalAt;
      continue;
    }
    if (fields.length) {
      entry.status = 'interrupted';
      entry.terminalAt = new Date().toISOString();
      entry.reason = landingPinsChanged(fields);
    }
  }
  const train = recordLandingWaits(work.store, data, channel);
  const pending = train.pending;
  // Original insertion order breaks equal timestamp ties and survives requeue/restart.
  let first = pending[0];
  if (!first) return;
  const actives = activeBatches(data, channel),
    parent = actives.at(-1);
  const main = acceptedHead(data, channel) ?? data.nativeHead!;
  const admitted = soloCheckAdmission(work.store, data, main, soloCheckEnvironment(environment));
  const ready = new Map(pending.map(entry => [entry.id, admitted(entry)]));
  // Prefer unchecked eligible work before consuming the ready wave. Solo checks
  // never use a speculative main: their result must apply to accepted main.
  const unchecked =
    !parent &&
    pending.find(entry => !ready.get(entry.id) && !train.waits.some(wait => wait.entryId === entry.id));
  const admission = !!unchecked;
  if (unchecked) {
    first = unchecked;
  }
  if (parent) {
    const green = pending.find(
      entry => ready.get(entry.id) && !train.waits.some(wait => wait.entryId === entry.id),
    );
    if (!green) return;
    first = green;
  }
  const check = data.checks.find(check => check.id === first.checkId)!;
  const shape = landingShape(work, check);
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
      parent.environment?.fingerprint !== environment.fingerprint ||
      lead.keepOpen !== first.keepOpen
    ) {
      for (const entry of pending)
        if (entry.waitingFor?.rule !== 'overlap')
          entry.waitingFor = {
            ...landingWait(
              data,
              actives.length >= shape.concurrency ? 'capacity' : 'batch-pins',
              'Waiting for active batches to free compatible check capacity.',
              lead ? [lead] : [],
            ),
            batchId: parent.id,
          };
      return;
    }
  }
  const selected: LandingEntry[] = [];
  // One Lane/head lands once: a duplicate waits for the earlier entry, then is already on main.
  const claimed = new Set(
    (data.landingEntries ?? [])
      .filter(entry => entry.channel === channel && ['checking', 'awaiting-review'].includes(entry.status))
      .map(entry => entryPins(data, entry)),
  );
  for (const entry of admission ? [first] : pending) {
    const pins = entryPins(data, entry);
    if (claimed.has(pins)) {
      entry.waitingFor = landingWait(
        data,
        'duplicate',
        'Waiting for the earlier submission of these exact inputs.',
        (data.landingEntries ?? []).filter(
          other =>
            other !== entry &&
            entryPins(data, other) === pins &&
            (selected.includes(other) || ['checking', 'awaiting-review'].includes(other.status)),
        ),
      );
      continue;
    }
    claimed.add(pins);
    if (
      selected.length === shape.maxBatch ||
      entry.checkId !== first.checkId ||
      entry.definition !== first.definition ||
      entry.keepOpen !== first.keepOpen
    )
      break;
    if (train.waits.some(wait => wait.entryId === entry.id)) continue;
    if (!admission && !ready.get(entry.id)) continue;
    selected.push(entry);
  }
  for (const entry of pending)
    if (!selected.includes(entry) && entry.waitingFor?.rule === 'batch-order')
      entry.waitingFor = landingWait(
        data,
        selected.length === shape.maxBatch ? 'batch-size' : 'batch-pins',
        'Waiting for the next compatible batch after the selected entries.',
        selected.length ? selected : [first],
      );
  if (!selected.length) return;
  const projected = parent ? (parent.prefixes.at(-1)?.head ?? parent.base) : undefined;
  const previous = parent
    ? parent.prefixes.length
      ? projected!
      : parent.previous
    : acceptedHead(data, channel);
  const base = projected ?? previous ?? data.nativeHead!;
  const ordinal =
    work.store.readRecords()?.manifest.collections.landingBatches?.count ?? data.landingBatches?.length ?? 0;
  const batch: LandingBatch = {
    id: finishChild(first.id, `batch:${ordinal}`),
    channel,
    environment: admission ? soloCheckEnvironment(environment) : environment,
    base,
    previous,
    arrivedAt: first.arrivedAt,
    entryIds: selected.map(entry => entry.id),
    ...(parent ? { parentId: parent.id } : {}),
    ...(admission ? { admission: true as const } : {}),
    mode: shape.remote ? 'parallel' : 'halving',
    status: 'composing',
    timing: { selectedAt: new Date().toISOString() },
    prefixes: [],
    conflicts: [],
  };
  for (const entry of selected) {
    entry.status = 'checking';
    entry.waitingFor = {
      rule: 'composition',
      reason: 'Waiting for batch composition.',
      entries: [],
      batchId: batch.id,
    };
    entry.firstSelectedAt ??= new Date().toISOString();
    entry.batchId = batch.id;
  }
  (data.landingBatches ??= []).push(batch);
  return batch;
}
/** Prefix Views carry every pinned Lane and dependency, across Intent boundaries. */
export async function composeBatch(work: WorkService, batch: LandingBatch, beforePublish?: () => void) {
  await batchEdit(
    work,
    batch.id,
    data => {
      const current = data.landingBatches!.find(item => item.id === batch.id)!;
      if (current.timing) current.timing.composeStartedAt ??= new Date().toISOString();
    },
    beforePublish,
    batch.channel,
  );
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
  const views: WorkView[] = [],
    contained: string[] = [];
  for (const entryId of batch.entryIds) {
    if (rejected.has(entryId)) continue;
    const entry = work.store.select('landingEntries', entryId)!;
    const candidate = work.store.select('views', entry.viewId)!;
    const previous = views.filter(view => view.status === 'clean').at(-1);
    const inputs = [...(previous?.inputs ?? []), ...candidate.inputs];
    const dependencies = [...(previous?.dependencies ?? []), ...(candidate.dependencies ?? [])];
    const result = composeLandingSource(
      work.store,
      source,
      candidate,
      head,
      'Landing batch prefix',
      batch.arrivedAt,
    );
    const id = finishChild(batch.id, `prefix:${entryId}`);
    // Composing onto accepted main changed nothing: the content is already on main.
    if (
      result.head &&
      sameLandingTree(source, result.head, head) &&
      head === batch.base &&
      batch.previous === batch.base &&
      !batch.parentId
    ) {
      contained.push(entryId);
      continue;
    }
    if (!result.head) {
      const peers = landingConflictPeers(work.store, head, candidate.inputs, result.conflicts);
      views.push({
        ...candidate,
        inputs,
        dependencies,
        id,
        base: batch.base,
        head: undefined,
        status: 'conflict',
        at: batch.arrivedAt,
        details: `Batch composition conflict with accepted peer Lane(s) ${[...new Set(peers)].join(', ') || 'unknown'}; original States retained:\n${result.conflicts.join('\n')}`,
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
      // Revalidate retained input availability after unlocked composition.
      // A newer Lane save alone does not invalidate this pinned Candidate.
      interruptStaleLandingInputs(data, batch.channel, source);
      const saved = data.landingBatches!.find(item => item.id === batch.id)!;
      if (saved.status !== 'composing') return saved;
      for (const view of views) if (!data.views.some(item => item.id === view.id)) data.views.push(view);
      saved.prefixes = prefixes;
      saved.conflicts = conflicts;
      saved.status = 'checking';
      if (saved.timing) saved.timing.composedAt ??= new Date().toISOString();
      for (const [id, diagnostic] of rejected) {
        const entry = data.landingEntries!.find(entry => entry.id === id)!;
        entry.status = 'failed';
        entry.terminalAt = new Date().toISOString();
        entry.reason = previewExclusionMessage;
        entry.previewDiagnostic = { ...diagnostic, main: preview!.main, key: preview!.key };
      }
      // Main may have moved since composition; a moved main re-queues the entry at settlement.
      if (acceptedHead(data, batch.channel) === batch.base)
        for (const entryId of contained) {
          const entry = data.landingEntries!.find(entry => entry.id === entryId)!;
          if (entry.status === 'checking') markAlreadyOnMain(entry, batch.base);
        }
      for (const conflict of conflicts) {
        const entry = data.landingEntries!.find(entry => entry.id === conflict.entryId)!;
        entry.status = 'conflict';
        entry.terminalAt = new Date().toISOString();
        entry.conflictViewId = conflict.viewId;
      }
      for (const entry of data.landingEntries ?? [])
        if (entry.batchId === saved.id) {
          if (entry.status === 'checking') entry.waitingFor = checkingWait(data, entry);
          else delete entry.waitingFor;
        }
      return saved;
    },
    beforePublish,
    batch.channel,
  );
}
