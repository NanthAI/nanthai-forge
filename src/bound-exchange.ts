import { checkoutHostedMain } from './hosted-main-checkout.js';
// SPDX-License-Identifier: Apache-2.0
import { withWorkLockOptions } from './work-lock.js';
import { withWorkProgress } from './work-progress.js';
import { retryExchange } from './exchange-retry.js';
import { formatSourceReturnProgress } from './source-return-progress.js';
import { hostedActionError } from './hosted-action-error.js';
import { randomUUID } from 'node:crypto';
import { basename, dirname, join, resolve } from 'node:path';
import { readFileSync } from 'node:fs';
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
/** Name-based UUID for one rebase attempt: the same parent and attempt always map to the same IDs. */
export function pushAttemptId(
  parent: string,
  attempt: number,
  phase: 'push' | 'reconcile' | 'return' | 'capture',
) {
  const hex = digest(`forge-push-attempt:${parent}:${attempt}:${phase}`),
    variant = (8 | (parseInt(hex[16]!, 16) & 3)).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
const hostedState = async (client: ConvexExchange, projectId: string) =>
  (await retryExchange('hosted Work state read', randomUUID(), () =>
    client.client.query(makeFunctionReference<'query'>('projectWork:state'), { projectId }),
  )) as { currentBackup: string | null; work?: { backupId: string; revision: number } };
export async function boundExchange(root: string, action: 'push' | 'pull', target?: string) {
  return withWorkLockOptions({ operation: `exchange ${action}` }, () =>
    withWorkProgress({ phase: `exchange ${action}` }, async () => {
      try {
        return await boundExchangeAction(root, action, target);
      } catch (error) {
        throw hostedActionError(error, `exchange ${action}`);
      }
    }),
  );
}
async function boundExchangeAction(root: string, action: 'push' | 'pull', target?: string) {
  const store = new WorkStore(root),
    binding = requireHostedBinding(store);
  const client = new ConvexExchange(
    binding.deployment,
    process.env.FORGE_AUTH_TOKEN,
    binding.projectId,
    '',
    null,
  );
  if (action === 'pull') {
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
      result = await pushAttempt(root, store, request);
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
        const fresh = await hostedState(client, binding.projectId),
          parentId = request.parentId ?? request.operationId,
          attempt = (request.attempt ?? 0) + 1;
        const next: PendingPush = {
          operationId: pushAttemptId(parentId, attempt, 'push'),
          parentId,
          attempt,
          projectId: request.projectId,
          deployment: request.deployment,
          previous: fresh.currentBackup,
          revision: request.revision,
          ...(request.captureId
            ? { captureId: request.captureId, captureRevision: request.captureRevision }
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
      // A push started on the previous binding must not rebind the owner if --new
      // completed while its upload was in flight.
      if (state.binding?.projectId === binding.projectId && state.binding.deployment === binding.deployment)
        state.binding = { ...state.binding, backupId: result.backupId };
      if (state.push?.operationId === request.operationId) delete state.push;
      if (state.pendingPushes)
        state.pendingPushes = state.pendingPushes.filter(push => push.operationId !== request.operationId);
    });
    return {
      ...result,
      operationId: request.operationId,
      projectId: binding.projectId,
      ...(request.parentId ? { parentOperationId: request.parentId, rebases: request.attempt } : {}),
    };
  }
}
/** One attempt with immutable pins. Its local snapshot is retained before network access. */
async function pushAttempt(root: string, store: WorkStore, request: PendingPush) {
  const persist = (update: (pending: PendingPush) => void) =>
    updateHostState(store, state => {
      const pending = [state.push, ...(state.pendingPushes ?? [])].find(
        push => push?.operationId === request.operationId,
      );
      invariant(pending, 'WORK_OPERATION_CHANGED', 'Bound push changed.');
      update(pending);
    });
  const transport = new ConvexExchange(
    request.deployment,
    process.env.FORGE_AUTH_TOKEN,
    request.projectId,
    request.operationId,
    request.previous,
  );
  transport.onReturnProgress = event => process.stderr.write(formatSourceReturnProgress(event));
  // Capture all mutable local inputs before the first hosted read. The separate
  // capture ID stays unchanged across rebases; each attempt overlays only hosted
  // metadata onto these original local bytes.
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
    return pushAttempt(root, store, request);
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
    invariant(
      reconciled.result.status === 'reconciled',
      'WORK_CONFLICT',
      'Hosted and local metadata conflict. Reconcile the retained Work before pushing again.',
    );
    request.revision = Math.max(request.revision, reconciled.result.receipt.revision);
    // Retain the derived attempt before recording reconciliation as complete.
    // A crash can repeat the original reconciliation and receive its same receipt.
    if (captured && candidate)
      await prepareNativeExchange(
        store,
        request.revision,
        request.operationId,
        transport.metadataTrees,
        transport.checkpointKey(),
        request.returnSource ? transport.checkpointKey(request.returnSource.expectedBackupId) : undefined,
        {
          pinCurrent: true,
          captured: { directory: captured.directory, data: candidate },
          ...(transport.workRecords ? { recordMetadata: true } : {}),
          ...(request.returnSource ? { journalRevision: request.returnSource.revision } : {}),
        },
      );
    delete request.reconcileId;
    persist(pending => {
      Object.assign(pending, request);
      delete pending.reconcileId;
    });
  }
  const result = await retryExchange(
    'local checkpoint push',
    request.operationId,
    () =>
      pushNativeExchange(store, request.revision, request.operationId, transport, {
        ...(captured && candidate ? { captured: { directory: captured.directory, data: candidate } } : {}),
        ...(request.returnSource
          ? {
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
  const sourceReturn = await transport.returnSource(
    result.backupId,
    request.returnSource.expectedBackupId,
    request.returnSource.revision,
    request.returnSource.operationId,
    result.ownerDerived,
  );
  await retryExchange('hosted index refresh', request.operationId, () =>
    transport.client.action(makeFunctionReference<'action'>('projectWorkIndexActions:ensure'), {
      projectId: request.projectId,
    }),
  );
  return { ...result, sourceReturn };
}
