// SPDX-License-Identifier: Apache-2.0
import { pushAttemptId } from './bound-push-id.js';
import { randomUUID } from 'node:crypto';
import { makeFunctionReference } from 'convex/server';
import { WorkStore } from './work-store.js';
import { ConvexExchange } from './exchange-client.js';
import { readHostState, requireHostedBinding, updateHostState } from './host-binding.js';
import { invariant } from './errors.js';
import { hostedActionError } from './hosted-action-error.js';
import { retryExchange } from './exchange-retry.js';

/** Reserve intent locally before the server CAS. Ordinary push also resumes an
 * interrupted supersession, including a lost server reply. */
export async function supersedeRetainedPush(
  store: WorkStore,
  explicit: boolean,
  report: (message: string) => void,
) {
  const binding = requireHostedBinding(store);
  if (!explicit && !readHostState(store).supersede) return;
  const reserved = updateHostState(store, state => {
    if (state.supersede) return state.supersede;
    const original = [state.push, ...(state.pendingPushes ?? [])].find(
      push => push?.projectId === binding.projectId && push.deployment === binding.deployment,
    );
    // Repeating the flag after a local commit resumes the reserved replacement.
    if (original && state.supersededPushes?.some(item => item.replacementId === original.operationId)) return;
    invariant(
      original?.returnSource,
      'SOURCE_RETURN_UNAVAILABLE',
      'Select a retained push with an original hosted source-return base.',
    );
    return (state.supersede = { original: structuredClone(original), replacementId: randomUUID() });
  });
  if (!reserved) return;
  const { original, replacementId } = reserved,
    pins = original.returnSource!;
  report('superseding uncommitted retained source return');
  const client = new ConvexExchange(
    original.deployment,
    process.env.FORGE_AUTH_TOKEN,
    original.projectId,
    original.operationId,
    original.previous,
  );
  try {
    await retryExchange('supersede retained push', replacementId, () =>
      client.client.mutation(makeFunctionReference<'mutation'>('projectReturnSupersede:supersede'), {
        projectId: original.projectId,
        operationId: pins.operationId,
        pushOperationId: original.operationId,
        expectedBackupId: pins.expectedBackupId,
        revision: pins.revision,
        replacementId,
      }),
    );
  } catch (error) {
    const failure = hostedActionError(error, 'supersede retained push');
    if (['SOURCE_RETURN_COMMITTED', 'WORK_STALE', 'BAD_ARGUMENT'].includes(failure.code))
      updateHostState(store, state => {
        if (state.supersede?.replacementId === replacementId) delete state.supersede;
      });
    throw failure;
  }
  updateHostState(store, state => {
    invariant(
      state.supersede?.replacementId === replacementId,
      'WORK_OPERATION_CHANGED',
      'Resume the original supersede request.',
    );
    (state.supersededPushes ??= []).push(reserved);
    if (state.push?.operationId === original.operationId) delete state.push;
    state.pendingPushes = (state.pendingPushes ?? []).filter(
      push => push.operationId !== original.operationId,
    );
    if (state.push) state.pendingPushes.push(state.push);
    state.push = {
      operationId: replacementId,
      projectId: original.projectId,
      deployment: original.deployment,
      previous: pins.expectedBackupId,
      revision: store.revision(),
      captureId: pushAttemptId(replacementId, 0, 'capture'),
      needsBaseline: true,
    };
    delete state.supersede;
  });
  report(
    `superseded push ${original.operationId}; starting replacement ${replacementId}; uploaded checkpoint retained`,
  );
}
