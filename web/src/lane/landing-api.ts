// SPDX-License-Identifier: Apache-2.0
import { makeFunctionReference } from 'convex/server';
import type { Id } from '../../../convex/_generated/dataModel';
export const landingMain = makeFunctionReference<'query', { projectId: Id<'hostedProjects'> }, string>(
  'projectHostedChannels:current',
);
