import { markAgentSyncPrepared, startAgentSyncWorker } from './agent-sync-worker.js';
import { withBoundPushProgress } from './bound-push-progress.js';
import { currentExchangeProgress } from './exchange-progress-hooks.js';
import { acknowledgePendingExchange } from './pending-exchange.js';
import { currentExchangeObservation, withExchangeObservation } from './exchange-observation.js';
import { supersedeRetainedPush } from './bound-exchange-supersede.js';
import { checkoutHostedMain } from './hosted-main-checkout.js';
// SPDX-License-Identifier: Apache-2.0
import { withQueueSlot } from './landing-queue.js';
import { withWorkLockOptions } from './work-lock.js';
import { withWorkProgress, workProgress } from './work-progress.js';
import { retryExchange } from './exchange-retry.js';
import { formatSourceReturnProgress } from './source-return-progress.js';
import { hostedActionError } from './hosted-action-error.js';
import { randomUUID } from 'node:crypto';
import { basename, dirname, join, resolve } from 'node:path';
import { readFileSync, existsSync } from 'node:fs';
import { ConvexError } from 'convex/values';
import { makeFunctionReference } from 'convex/server';
import { WorkStore } from './work-store.js';
import { requireHostedBinding, updateHostState, type HostState } from './host-binding.js';
import { digest } from './hash.js';
import { ConvexExchange } from './exchange-client.js';
import { prepareNativeExchange, pushNativeExchange } from './native-exchange.js';
import { parseWorkBytes } from './work-metadata.js';
import { reconcileExchange } from './exchange-reconcile.js';
import { ForgeError, invariant } from './errors.js';
type PendingPush = NonNullable<HostState['push']>;
const REBASE_ATTEMPTS = 3;
export type BoundExchangeOptions = {
  beforePush?: () => Promise<void>;
  expectedBinding?: { projectId: string; deployment: string };
  exchange?: (
    deployment: string,
    projectId: string,
    operationId: string,
    previous: string | null,
  ) => ConvexExchange;
};
const exchangeClient = (
  options: BoundExchangeOptions,
  deployment: string,
  projectId: string,
  operationId: string,
  previous: string | null,
) =>
  options.exchange?.(deployment, projectId, operationId, previous) ??
  new ConvexExchange(deployment, process.env.FORGE_AUTH_TOKEN, projectId, operationId, previous);
import { pushAttemptId } from './bound-push-id.js';
export { pushAttemptId } from './bound-push-id.js';
const hostedState = async (client: ConvexExchange, projectId: string) =>
  (await retryExchange('hosted Work state read', randomUUID(), () =>
    client.client.query(makeFunctionReference<'query'>('projectWork:state'), { projectId }),
  )) as { currentBackup: string | null; work?: { backupId: string; revision: number } };
export async function boundExchange(
  root: string,
  action: 'push' | 'pull',
  target?: string,
  supersedeRetained = false,
  options: BoundExchangeOptions = {},
) {
  const { value, observation } = await withExchangeObservation(() =>
    runBoundExchange(root, action, target, supersedeRetained, options),
  );
  return { ...value, observation };
}
async function runBoundExchange(
  root: string,
  action: 'push' | 'pull',
  target: string | undefined,
  supersedeRetained: boolean,
  options: BoundExchangeOptions,
) {
  return withWorkLockOptions({ operation: `exchange ${action}` }, () =>
    withWorkProgress({ phase: `exchange ${action}` }, async () => {
      let phase = `preparing exchange ${action}`,
        detail = 'in progress';
      const report = (next: string, announce = true) => {
        currentExchangeProgress()?.signal?.throwIfAborted();
        if (announce) currentExchangeProgress()?.progress?.(next);
        if (!announce) {
          detail = next;
          return;
        }
        phase = next;
        detail = 'in progress';
        workProgress(phase, detail);
      };
      report(phase);
      const heartbeat = setInterval(() => workProgress(phase, detail), 5000);
      heartbeat.unref();
      try {
        if (action === 'pull') return await boundExchangeAction(root, action, target, report, options);
        const store = new WorkStore(root);
        // Serialize the complete transport operation, not local Work writers. A
        // second process must not rebase/remove the request another is using.
        const queued = await withQueueSlot(
          join(store.directory, 'bound-push-queue'),
          () =>
            withBoundPushProgress(store, async () => {
              await options.beforePush?.();
              await supersedeRetainedPush(store, supersedeRetained, report);
              return boundExchangeAction(root, action, target, report, options);
            }),
          { anchor: store.directory, phase: 'exchange push' },
        );
        invariant('value' in queued, 'WORK_BUSY', 'A bound push is still running. Retry to resume it.');
        return queued.value;
      } catch (error) {
        throw hostedActionError(error, `exchange ${action}`);
      } finally {
        clearInterval(heartbeat);
      }
    }),
  );
}
async function boundExchangeAction(
  root: string,
  action: 'push' | 'pull',
  target: string | undefined,
  report: (phase: string, announce?: boolean) => void,
  options: BoundExchangeOptions,
) {
  const store = new WorkStore(root),
    binding = requireHostedBinding(store);
  invariant(
    !options.expectedBinding ||
      (binding.projectId === options.expectedBinding.projectId &&
        binding.deployment === options.expectedBinding.deployment),
    'AUTO_EXCHANGE_CHANGED',
    'Automatic exchange binding changed.',
  );
  const client = exchangeClient(options, binding.deployment, binding.projectId, '', null);
  if (action === 'pull') {
    report('checking out hosted main');
    const destination = resolve(target ?? join(dirname(store.root), `${basename(store.root)}-hosted-main`));
    const key = JSON.stringify([binding.deployment, binding.projectId, destination]);
    const operationId = updateHostState(store, state => ((state.pulls ??= {})[key] ??= randomUUID()));
    const result = await checkoutHostedMain(
      destination,
      {
        url: binding.deployment,
        projectId: binding.projectId,
        operationId,
      },
      client,
    );
    updateHostState(store, state => {
      if (state.pulls?.[key] === operationId) delete state.pulls[key];
    });
    return result;
  }
  if (!store.native) report('reading hosted Work state');
  const remote = store.native ? undefined : await hostedState(client, binding.projectId);
  let request: PendingPush = updateHostState(store, state => {
    const original = [...(state.push ? [state.push] : []), ...(state.pendingPushes ?? [])].find(
      push => push.projectId === binding.projectId && push.deployment === binding.deployment,
    );
    if (original) return structuredClone(original);
    if (state.push) {
      (state.pendingPushes ??= []).push(state.push);
    }
    const operationId = randomUUID();
    const pending: PendingPush = {
      operationId,
      projectId: binding.projectId,
      deployment: binding.deployment,
      previous: store.native ? binding.backupId : remote!.currentBackup,
      // A floor: native preparation pins the current revision under the short owner lock.
      revision: store.revision(),
      ...(store.native ? { captureId: pushAttemptId(operationId, 0, 'capture'), needsBaseline: true } : {}),
    };
    state.push = pending;
    return pending;
  });
  for (;;) {
    let result;
    try {
      result = await pushAttempt(root, store, request, report, options);
    } catch (error) {
      // Known stale/conflicting phases can use fresh pins next time. A checkpoint
      // may already be published if source return was stale; it remains retained.
      // Unknown network outcomes keep the exact original request for reconciliation.
      const code =
        error instanceof ForgeError
          ? error.code
          : error instanceof ConvexError && error.data && typeof error.data === 'object'
            ? (error.data as { code?: unknown }).code
            : undefined;
      if ((code === 'PROJECT_CHANGED' || code === 'WORK_STALE') && (request.attempt ?? 0) < REBASE_ATTEMPTS) {
        // A known hosted CAS mismatch: nothing of this attempt was selected. Rebase
        // onto fresh hosted pins with a new, deterministic attempt identity.
        report('reading hosted Work state');
        const fresh = await hostedState(client, binding.projectId),
          parentId = request.parentId ?? request.operationId,
          attempt = (request.attempt ?? 0) + 1;
        // The original capture may predate hosted events already merged into
        // this attempt. Its retained candidate is the next common source; using
        // the older capture again would manufacture an original-prefix conflict.
        const prepared =
          request.captureId &&
          existsSync(join(store.directory, `exchange-${request.operationId}`, 'manifest.json'));
        const next: PendingPush = {
          operationId: pushAttemptId(parentId, attempt, 'push'),
          parentId,
          attempt,
          projectId: request.projectId,
          deployment: request.deployment,
          previous: fresh.currentBackup,
          revision: request.revision,
          ...(request.captureId
            ? {
                captureId: prepared ? request.operationId : request.captureId,
                captureRevision: prepared ? request.revision : request.captureRevision,
              }
            : {}),
          ...(store.native && fresh.work
            ? {
                reconcileId: pushAttemptId(parentId, attempt, 'reconcile'),
                returnSource: {
                  expectedBackupId: fresh.work.backupId,
                  revision: fresh.work.revision,
                  operationId: pushAttemptId(parentId, attempt, 'return'),
                },
              }
            : {}),
        };
        updateHostState(store, state => {
          const replaced = request.operationId;
          if (state.push?.operationId === replaced) state.push = next;
          else {
            const index = (state.pendingPushes ?? []).findIndex(push => push.operationId === replaced);
            invariant(index >= 0, 'WORK_OPERATION_CHANGED', 'Bound push changed.');
            state.pendingPushes![index] = next;
          }
        });
        process.stderr.write(
          `Hosted ${code === 'PROJECT_CHANGED' ? 'checkpoint' : 'Work'} moved during push; rebasing (attempt ${attempt} of ${REBASE_ATTEMPTS}, operation ${next.operationId}).\n`,
        );
        request = next;
        continue;
      }
      if (typeof code === 'string' && ['PROJECT_CHANGED', 'WORK_STALE', 'WORK_CONFLICT'].includes(code))
        updateHostState(store, state => {
          if (state.push?.operationId === request.operationId) delete state.push;
          if (state.pendingPushes)
            state.pendingPushes = state.pendingPushes.filter(
              push => push.operationId !== request.operationId,
            );
        });
      if (error instanceof ConvexError && code === 'WORK_STALE')
        throw new ForgeError(
          'WORK_STALE',
          'Hosted Work changed. The uploaded checkpoint is retained; push again to reconcile current metadata.',
        );
      throw hostedActionError(error, 'exchange push');
    }
    updateHostState(store, state => {
      const original = [...(state.push ? [state.push] : []), ...(state.pendingPushes ?? [])].find(
        push => push.operationId === request.operationId,
      );
      invariant(original, 'WORK_OPERATION_CHANGED', 'Bound push changed.');
      // Reuse the existing completion commit; diagnostic observations must not
      // acquire another owner lock after the successful operation is cleared.
      const observation = currentExchangeObservation();
      if (observation) state.exchangeObservation = observation;
      // A push started on the previous binding must not rebind the owner if --new
      // completed while its upload was in flight.
      if (state.binding?.projectId === binding.projectId && state.binding.deployment === binding.deployment)
        state.binding = { ...state.binding, backupId: result.backupId };
      markAgentSyncPrepared(state, binding);
      if (state.push?.operationId === request.operationId) delete state.push;
      if (state.pendingPushes)
        state.pendingPushes = state.pendingPushes.filter(push => push.operationId !== request.operationId);
    });
    startAgentSyncWorker(store);
    if (result.pendingCoverage) acknowledgePendingExchange(store, result.pendingCoverage);
    return {
      ...result,
      operationId: request.operationId,
      projectId: binding.projectId,
      ...(request.parentId ? { parentOperationId: request.parentId, rebases: request.attempt } : {}),
    };
  }
}
/** One attempt with immutable pins. Its local snapshot is retained before network access. */
async function pushAttempt(
  root: string,
  store: WorkStore,
  request: PendingPush,
  report: (phase: string, announce?: boolean) => void,
  options: BoundExchangeOptions,
) {
  const persist = (update: (pending: PendingPush) => void) =>
    updateHostState(store, state => {
      const pending = [state.push, ...(state.pendingPushes ?? [])].find(
        push => push?.operationId === request.operationId,
      );
      invariant(pending, 'WORK_OPERATION_CHANGED', 'Bound push changed.');
      update(pending);
    });
  const transport = exchangeClient(
    options,
    request.deployment,
    request.projectId,
    request.operationId,
    request.previous,
  );
  transport.onReturnProgress = event => process.stderr.write(formatSourceReturnProgress(event));
  // Capture all mutable local inputs before the first hosted read. The separate
  // capture ID stays unchanged across rebases; each attempt overlays only hosted
  // metadata onto these original local bytes.
  report('capturing local source and Work');
  const captured = request.captureId
    ? await prepareNativeExchange(
        store,
        request.captureRevision ?? request.revision,
        request.captureId,
        true,
        transport.checkpointKey(request.previous ?? undefined),
        undefined,
        { pinCurrent: true },
      )
    : undefined;
  if (captured && request.captureRevision === undefined) {
    request.captureRevision = captured.manifest.revision;
    persist(pending => {
      pending.captureRevision = request.captureRevision;
    });
  }
  if (request.needsBaseline) {
    report('reading hosted Work state');
    const remote = await hostedState(transport, request.projectId);
    request.previous = remote.currentBackup;
    if (remote.work) {
      const parent = request.parentId ?? request.operationId;
      request.reconcileId = pushAttemptId(parent, request.attempt ?? 0, 'reconcile');
      request.returnSource = {
        expectedBackupId: remote.work.backupId,
        revision: remote.work.revision,
        operationId: pushAttemptId(parent, request.attempt ?? 0, 'return'),
      };
    }
    delete request.needsBaseline;
    persist(pending => {
      Object.assign(pending, request);
      delete pending.needsBaseline;
    });
    // The transport was constructed before observing the hosted baseline.
    return pushAttempt(root, store, request, report, options);
  }
  const captureBytes = captured ? readFileSync(join(captured.directory, 'work.json')) : undefined;
  if (captured && captureBytes) {
    const pin = captured.manifest.files.find(file => file.path === 'work.json');
    invariant(
      pin?.size === captureBytes.length && pin.sha256 === digest(captureBytes),
      'EXCHANGE_SOURCE_CHANGED',
      'The original captured Work differs from its retained digest.',
    );
  }
  let candidate = captureBytes ? parseWorkBytes(captureBytes) : undefined;
  if (request.reconcileId && request.returnSource) {
    report('receiving and reconciling hosted Work journal');
    const reconcileId = request.reconcileId,
      returnSource = request.returnSource;
    // Hosted WORK_STALE here is a hosted CAS mismatch (rebased by the caller); local
    // Work written meanwhile is merged under the short owner lock, never a failure.
    const reconciled = await retryExchange('local Work reconciliation', request.reconcileId, () =>
      reconcileExchange(
        root,
        {
          url: request.deployment,
          projectId: request.projectId,
          backupId: returnSource.expectedBackupId,
          operationId: reconcileId,
          revision: request.revision,
          preserveLocalSource: true,
        },
        {
          followLocal: true,
          onProgress: detail => report(detail, false),
          ...(candidate
            ? {
                candidate,
                onCandidate: data => {
                  candidate = data;
                },
              }
            : {}),
        },
      ),
    );
    if (reconciled.result.status !== 'reconciled') {
      // Values may contain complete Work collections. Identify a bounded set of
      // items without serializing source, notes, or whole histories into errors.
      const conflicts = reconciled.result.conflicts;
      const items = conflicts
        .slice(0, 20)
        .map(({ collection, id, field }) => JSON.stringify({ collection, ...(id ? { id } : {}), field }));
      throw new ForgeError(
        'WORK_CONFLICT',
        `Hosted and local metadata conflict (${conflicts.length} items). Reconcile the retained Work before pushing again. Conflicts: ${items.join(', ')}${conflicts.length > items.length ? `; ${conflicts.length - items.length} more` : ''}. Reconcile operation: ${reconcileId}.`,
      );
    }
    request.revision = Math.max(request.revision, reconciled.result.receipt.revision);
    // Retain the derived attempt before recording reconciliation as complete.
    // A crash can repeat the original reconciliation and receive its same receipt.
    if (captured && candidate) {
      report('preparing reconciled checkpoint');
      await prepareNativeExchange(
        store,
        request.revision,
        request.operationId,
        transport.metadataTrees,
        transport.checkpointKey(request.returnSource?.expectedBackupId),
        request.returnSource ? transport.checkpointKey(request.returnSource.expectedBackupId) : undefined,
        {
          pinCurrent: true,
          captured: { directory: captured.directory, data: candidate },
          ...(transport.workRecords ? { recordMetadata: true } : {}),
          ...(request.returnSource ? { journalRevision: request.returnSource.revision } : {}),
        },
      );
    }
    delete request.reconcileId;
    persist(pending => {
      Object.assign(pending, request);
      delete pending.reconcileId;
    });
  }
  report('preparing and uploading checkpoint');
  const result = await retryExchange(
    'local checkpoint push',
    request.operationId,
    () =>
      pushNativeExchange(store, request.revision, request.operationId, transport, {
        deferPendingAcknowledgement: true,
        ...(captured && candidate ? { captured: { directory: captured.directory, data: candidate } } : {}),
        ...(request.returnSource
          ? {
              workBaselineKey: transport.checkpointKey(request.returnSource.expectedBackupId)!,
              ownerDerivedBaselineKey: transport.checkpointKey(request.returnSource.expectedBackupId)!,
              journalRevision: request.returnSource.revision,
            }
          : {}),
        ...(store.native
          ? {
              pinCurrent: true,
              // Later local Work writes belong to the next push; retries reuse this snapshot.
              onPrepared: (revision: number) => {
                if (revision === request.revision) return;
                request.revision = revision;
                persist(pending => {
                  pending.revision = revision;
                });
              },
            }
          : {}),
      }),
    { localSnapshot: true },
  );
  if (!request.returnSource) return result;
  report('returning hosted source');
  const sourceReturn = await transport.returnSource(
    result.backupId,
    request.returnSource.expectedBackupId,
    request.returnSource.revision,
    request.returnSource.operationId,
    result.ownerDerived,
  );
  report('refreshing hosted Work index');
  await retryExchange('hosted index refresh', request.operationId, () =>
    transport.client.action(makeFunctionReference<'action'>('projectWorkIndexActions:ensure'), {
      projectId: request.projectId,
    }),
  );
  return { ...result, sourceReturn };
}
