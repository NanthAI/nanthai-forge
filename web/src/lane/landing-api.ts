// SPDX-License-Identifier: Apache-2.0
import { makeFunctionReference } from 'convex/server';
import type { Id } from '../../../convex/_generated/dataModel';
type CandidateArgs = { projectId: Id<'hostedProjects'>; candidateId: string };
export const landingCandidate = makeFunctionReference<'query', CandidateArgs, string | null>(
  'projectHostedLanding:candidate',
);
export const landingMain = makeFunctionReference<'query', { projectId: Id<'hostedProjects'> }, string>(
  'projectHostedChannels:current',
);
