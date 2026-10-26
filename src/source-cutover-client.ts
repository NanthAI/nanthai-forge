// SPDX-License-Identifier: Apache-2.0
import { makeFunctionReference } from 'convex/server';
import { coordinationClient, type CoordinationTransport } from './coordination-client.js';
import { requireHostedBinding, updateHostState } from './host-binding.js';
import { cutoverRequestSchema } from './source-cutover.js';
import { sourceAuthoritySchema } from './hosted-source-authority.js';
import { canonicalPayload } from './hosted-source-operation.js';
import { requireOwnerDrained } from './hosted-agent-owner-drain.js';
import { hostedActionError } from './hosted-action-error.js';
import { invariant } from './errors.js';
import type { WorkStore } from './work-store.js';
import { nativeChannels } from './native-work.js';

export async function boundCutoverPins(store: WorkStore, supplied?: CoordinationTransport) {
  const binding = requireHostedBinding(store);
  const client = supplied ?? coordinationClient(binding.deployment, process.env.FORGE_AUTH_TOKEN);
  return JSON.parse(
    (await client.query(makeFunctionReference<'query'>('projectSourceCutover:current'), {
      projectId: binding.projectId,
    })) as string,
  );
}

export async function cutoverBoundProject(
  store: WorkStore,
  input: unknown,
  dryRun: boolean,
  supplied?: CoordinationTransport,
) {
  const request = cutoverRequestSchema.parse(input),
    binding = requireHostedBinding(store);
  const client = supplied ?? coordinationClient(binding.deployment, process.env.FORGE_AUTH_TOKEN);
  const args = { projectId: binding.projectId, request: canonicalPayload(request) };
  try {
    const observation = JSON.parse(
      (await client.query(makeFunctionReference<'query'>('projectSourceCutover:dryRun'), args)) as string,
    );
    if (dryRun)
      return {
        ...observation,
        localChanges: [
          'retain handover marker before checking local drain',
          'remember returned authority epoch in this binding; remove handover marker after receipt',
        ],
      };
    const marker = {
      projectId: binding.projectId,
      deployment: binding.deployment,
      operationId: request.operationId,
      expected: request.pins.authority,
      mode: request.mode,
      cutover: request.pins,
    };
    updateHostState(store, state => {
      invariant(
        !state.authorityTransition ||
          canonicalPayload(state.authorityTransition) === canonicalPayload(marker),
        'WORK_OPERATION_CHANGED',
        'Resume the original handover operation.',
      );
      state.authorityTransition = marker;
    });
    // Close admission first. Unknown replies retain the marker and exact request.
    if (!observation.completed)
      store.locked(() => {
        requireOwnerDrained(store);
        const data = store.load(),
          main = nativeChannels(data).find(c => c.name === 'main');
        invariant(
          main?.head === request.pins.main.head && main?.moveId === request.pins.main.receipt.id,
          'CHANNEL_CHANGED',
          'The prepared owner must match hosted main and its exact receipt.',
        );
        if (request.mode === 'server')
          invariant(
            store.revision() === request.pins.ownerRevision,
            'WORK_STALE',
            'Seed the final drained owner revision before applying cutover.',
          );
      });
    const receipt = JSON.parse(
      (await client.mutation(
        makeFunctionReference<'mutation'>('projectSourceCutover:apply'),
        args,
      )) as string,
    );
    const authority = sourceAuthoritySchema.parse(receipt.authority);
    updateHostState(store, state => {
      invariant(
        state.binding?.projectId === binding.projectId && state.binding.deployment === binding.deployment,
        'WORK_OPERATION_CHANGED',
        'The binding changed during cutover.',
      );
      if (!state.binding.sourceAuthority || state.binding.sourceAuthority.epoch <= authority.epoch)
        state.binding.sourceAuthority = authority;
      if (state.authorityTransition?.operationId === request.operationId) delete state.authorityTransition;
    });
    return receipt;
  } catch (error) {
    const failure = hostedActionError(error, 'source cutover');
    // These outcomes definitively did not publish. Allow preparation with fresh
    // pins; an unknown transport reply must keep the original handover instead.
    if (!dryRun && ['WORK_STALE', 'CHANNEL_CHANGED', 'SOURCE_AUTHORITY_STALE'].includes(failure.code))
      updateHostState(store, state => {
        if (state.authorityTransition?.operationId === request.operationId) delete state.authorityTransition;
      });
    throw failure;
  }
}
