// SPDX-License-Identifier: Apache-2.0
import { makeFunctionReference } from 'convex/server';
import { z } from 'zod';
import { coordinationClient, type CoordinationTransport } from './coordination-client.js';
import { requireHostedBinding, updateHostState } from './host-binding.js';
import { hostedActionError } from './hosted-action-error.js';
import {
  sourceAuthority,
  sourceAuthoritySchema,
  SourceAuthorityStaleError,
} from './hosted-source-authority.js';
import { invariant } from './errors.js';
import type { WorkStore } from './work-store.js';

/** Only call with feedback from this binding's authenticated transport. Never rewind a pin. */
export function rememberSourceAuthorityError(store: WorkStore, error: unknown, projectId: string): void {
  const failure = hostedActionError(error, 'source authority');
  if (!(failure instanceof SourceAuthorityStaleError)) return;
  updateHostState(store, state => {
    if (state.binding?.projectId !== projectId) return;
    if (failure.authority.epoch > sourceAuthority(state.binding).epoch)
      state.binding.sourceAuthority = failure.authority;
  });
}

/** Journal before IO; replay the same command after any unknown reply or local interruption. */
export async function transitionBoundSourceAuthority(
  store: WorkStore,
  input: {
    operationId: string;
    expected: z.infer<typeof sourceAuthoritySchema>;
    mode: z.infer<typeof sourceAuthoritySchema>['mode'];
  },
  supplied?: Pick<CoordinationTransport, 'mutation'>,
) {
  const binding = requireHostedBinding(store);
  invariant(z.uuid().safeParse(input.operationId).success, 'BAD_ARGUMENT', 'Retain the transition UUID.');
  const request = {
    projectId: binding.projectId,
    deployment: binding.deployment,
    operationId: input.operationId,
    expected: sourceAuthoritySchema.parse(input.expected),
    mode: sourceAuthoritySchema.shape.mode.parse(input.mode),
  };
  updateHostState(store, state => {
    invariant(
      !state.authorityTransition || JSON.stringify(state.authorityTransition) === JSON.stringify(request),
      'WORK_OPERATION_CHANGED',
      'Resume the original pending source authority transition.',
    );
    state.authorityTransition = request;
  });
  try {
    const client = supplied ?? coordinationClient(binding.deployment, process.env.FORGE_AUTH_TOKEN);
    const { deployment: _deployment, ...args } = request;
    void _deployment;
    const authority = sourceAuthoritySchema.parse(
      await client.mutation(makeFunctionReference<'mutation'>('projectSourceAuthority:transition'), args),
    );
    updateHostState(store, state => {
      invariant(
        state.binding?.projectId === binding.projectId && state.binding.deployment === binding.deployment,
        'WORK_OPERATION_CHANGED',
        'The owner binding changed during the authority transition.',
      );
      if (authority.epoch >= sourceAuthority(state.binding).epoch) state.binding.sourceAuthority = authority;
      if (state.authorityTransition?.operationId === input.operationId) delete state.authorityTransition;
    });
    return authority;
  } catch (error) {
    rememberSourceAuthorityError(store, error, binding.projectId);
    const failure = hostedActionError(error, 'source authority transition');
    if (failure instanceof SourceAuthorityStaleError)
      updateHostState(store, state => {
        if (state.authorityTransition?.operationId === input.operationId) delete state.authorityTransition;
      });
    throw failure;
  }
}
