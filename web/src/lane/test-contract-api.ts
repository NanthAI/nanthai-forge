// SPDX-License-Identifier: Apache-2.0
import { makeFunctionReference } from 'convex/server';
import type { Id } from '../../../convex/_generated/dataModel';
export const readTestContract = makeFunctionReference<
  'query',
  { projectId: Id<'hostedProjects'>; intentId: string; candidateId?: string; head?: string },
  string | null
>('projectIntentTestStore:review');
