// SPDX-License-Identifier: Apache-2.0
import { ConvexClient } from 'convex/browser';
import { makeFunctionReference, type FunctionReference } from 'convex/server';
import { coordinationCredentials } from './coordination-client.js';
import { readHostState, updateHostState } from './host-binding.js';
import { consumeOwnerRequests } from './owner-acceptance-consumer.js';
import { markAgentSyncPrepared, startAgentSyncWorker } from './agent-sync-worker.js';
import { rememberSourceAuthorityError } from './source-authority-client.js';
import type { WorkStore } from './work-store.js';

type Wake = { operationId: string | null; indexReady: boolean };
export interface OwnerAcceptanceSubscription {
  onUpdate(
    reference: FunctionReference<'query'>,
    args: Record<string, unknown>,
    update: (value: Wake) => void,
    error: (error: Error) => void,
  ): () => void;
  close(): Promise<void>;
}
function subscription(deployment: string): OwnerAcceptanceSubscription {
  const credentials = coordinationCredentials(deployment, process.env.FORGE_AUTH_TOKEN);
  const client = new ConvexClient(credentials.url, { logger: false, unsavedChangesWarning: false });
  client.setAuth(async () => credentials.token);
  // Convex's WebSocket reconnects with backoff and restores the query, never a mutation poll.
  return client;
}
/** A live query wakes only known pending work. Timers retry failures, never idle observations. */
export function startOwnerAcceptanceListener(
  store: WorkStore,
  onError: (error: unknown) => void = () => {},
  consume = () => consumeOwnerRequests(store),
  connect: () => OwnerAcceptanceSubscription = () => subscription(readHostState(store).binding!.deployment),
  sync = () => startAgentSyncWorker(store),
) {
  const binding = readHostState(store).binding;
  if (!store.native || !binding?.acceptanceOwner) return async () => {};
  const scope = {
    projectId: binding.projectId,
    ownerId: binding.operationId,
  };
  const resumeSync = () => {
    const state = readHostState(store);
    if (!state.agentSync?.pending.length || state.binding?.autoSync === false) return;
    try {
      updateHostState(store, current => markAgentSyncPrepared(current, binding));
      sync();
    } catch (error) {
      onError(error);
    }
  };
  resumeSync(); // A new owner start releases even a legacy missing-index gate.
  let stopped = false;
  let client: OwnerAcceptanceSubscription | undefined;
  let unsubscribe: (() => void) | undefined;
  let pending: Promise<unknown> | undefined;
  let closing: Promise<void> = Promise.resolve();
  let reconnect: ReturnType<typeof setTimeout> | undefined;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let latest: string | null = null;
  let completed: string | undefined;
  let ready = false;
  let connectionFailures = 0;
  let consumeFailures = 0;
  const delay = (attempt: number) => Math.min(300_000, 1000 * 2 ** Math.min(attempt, 9));
  const tick = () => {
    if (stopped || pending || retry || !latest || latest === completed) return;
    const selected = latest;
    pending = consume()
      .then(result => {
        if ('consumed' in result && result.consumed) {
          completed = result.operationId ?? selected;
          consumeFailures = 0;
        } else if (!stopped) retry = setTimeout(wake, delay(consumeFailures++));
      })
      .catch(error => {
        onError(error);
        if (!stopped) retry = setTimeout(wake, delay(consumeFailures++));
      })
      .finally(() => {
        pending = undefined;
        tick();
      });
  };
  const wake = () => {
    retry = undefined;
    tick();
  };
  const open = () => {
    reconnect = undefined;
    if (stopped) return;
    try {
      const selected = readHostState(store).binding;
      const authority =
        selected?.projectId === binding.projectId ? selected.sourceAuthority : binding.sourceAuthority;
      const current = connect();
      client = current;
      unsubscribe = current.onUpdate(
        makeFunctionReference<'query'>('ownerAcceptance:pending'),
        { ...scope, ...(authority ? { authorityEpoch: authority.epoch } : {}) },
        value => {
          if (stopped || current !== client) return;
          connectionFailures = 0;
          if (value.operationId !== latest) {
            if (retry) clearTimeout(retry);
            retry = undefined;
            consumeFailures = 0;
          }
          latest = value.operationId;
          if (value.indexReady && !ready) resumeSync();
          ready = value.indexReady;
          tick();
        },
        error => failed(error, current),
      );
    } catch (error) {
      failed(error, client);
    }
  };
  const failed = (error: unknown, current: OwnerAcceptanceSubscription | undefined) => {
    if (stopped || current !== client || reconnect) return;
    try {
      rememberSourceAuthorityError(store, error, binding.projectId);
    } catch (rememberError) {
      onError(rememberError);
    }
    onError(error);
    unsubscribe?.();
    unsubscribe = undefined;
    client = undefined;
    latest = null;
    closing = current?.close().catch(onError) ?? Promise.resolve();
    reconnect = setTimeout(() => void closing.then(open), delay(connectionFailures++));
  };
  open();
  return async () => {
    stopped = true;
    if (reconnect) clearTimeout(reconnect);
    if (retry) clearTimeout(retry);
    unsubscribe?.();
    await Promise.all([client?.close(), closing, pending]);
  };
}
