import { hostedText } from './hosted-paths.js';
// SPDX-License-Identifier: Apache-2.0
import { createHash } from 'node:crypto';
import { readHostState, updateHostState } from './host-binding.js';
import type { WorkStore } from './work-store.js';
/** Reconcile original delivery before projecting later local changes under a fresh stable id. */
export async function publishOwnerMetadata(
  store: WorkStore,
  projectId: string,
  operationId: string,
  revision: number,
  metadata: string,
  mutate: (name: string, args: Record<string, unknown>) => Promise<unknown>,
) {
  const retain = (id: string, value: string) => {
    let original = readHostState(store).acceptancePublications?.[id];
    if (!original) {
      original = value;
      updateHostState(store, state => {
        (state.acceptancePublications ??= {})[id] = value;
      });
    }
    return original;
  };
  metadata = hostedText(metadata);
  const original = retain(operationId, metadata);
  await mutate('projectOwnerSync:publish', { projectId, operationId, metadata: original });
  if (original !== metadata) {
    const hex = createHash('sha256').update(`owner-main:${operationId}:${revision}`).digest('hex');
    const refreshId = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
    await mutate('projectOwnerSync:publish', {
      projectId,
      operationId: refreshId,
      metadata: retain(refreshId, metadata),
    });
  }
}
