// SPDX-License-Identifier: Apache-2.0
import { useSafeQuery } from '../safe-query';
import { makeFunctionReference } from 'convex/server';
import type { Infer } from 'convex/values';
import type { liveLineResult } from '../../../convex/projectLiveLine';
import type { Id } from '../../../convex/_generated/dataModel';

const liveLine = makeFunctionReference<
  'query',
  { projectId: Id<'hostedProjects'> },
  Infer<typeof liveLineResult>
>('projectLiveLine:read');
/** Uses the app's sleeping client: hidden/dormant tabs unsubscribe and wake once. Null waits for the project id. */
export function useLiveLine(projectId: Id<'hostedProjects'> | null) {
  return useSafeQuery(liveLine, projectId ? { projectId } : 'skip');
}
