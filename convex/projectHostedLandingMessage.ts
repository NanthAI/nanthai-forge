// SPDX-License-Identifier: Apache-2.0
import type { MutationCtx } from './_generated/server';
import type { Id } from './_generated/dataModel';
import type { HostedLandingState } from '../src/hosted-landing';
import { landingMessage } from '../src/landing-message';
import { hostedFinishSchema } from '../src/hosted-finish';
import { finishRow } from './projectHostedFinishWake';

/** Only pre-upgrade pending requests need this indexed read. New requests carry
 * the value (or explicit omission) in their existing landing record. */
export async function acceptedLandingMessage(ctx: MutationCtx, state: HostedLandingState) {
  if (state.request.message !== undefined) return state.request.message ?? undefined;
  if (state.message !== undefined) return state.message ?? undefined;
  if (!state.request.finish || state.request.finish.reviewedSource) return undefined;
  const row = await finishRow(ctx, {
    projectId: state.projectId as Id<'hostedProjects'>,
    submissionId: state.id,
  });
  if (!row) return undefined;
  const message = hostedFinishSchema.parse(JSON.parse(row.value)).source.message;
  return message === 'Agent change' ? undefined : landingMessage(message);
}
