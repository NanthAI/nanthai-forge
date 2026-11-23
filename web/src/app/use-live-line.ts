// SPDX-License-Identifier: Apache-2.0
import { useState } from 'react';
import { useSafeQuery } from '../safe-query';
import { makeFunctionReference } from 'convex/server';
import type { Infer } from 'convex/values';
import type { liveLineResult } from '../../../convex/projectLiveLine';
import type { Id } from '../../../convex/_generated/dataModel';

const liveLine = makeFunctionReference<
  'query',
  { projectId: Id<'hostedProjects'>; includeChecks?: boolean },
  Infer<typeof liveLineResult>
>('projectLiveLine:read');
/** Uses the app's sleeping client: hidden/dormant tabs unsubscribe and wake once. Null waits for the project id. */
export function useLiveLine(projectId: Id<'hostedProjects'> | null, includeChecks = false) {
  const [legacy, setLegacy] = useState(false);
  const withChecks = includeChecks || legacy;
  const result = useSafeQuery(
    liveLine,
    projectId ? (withChecks ? { projectId } : { projectId, includeChecks: false }) : 'skip',
  );
  // Web and Convex deploy independently. Keep older backends on the existing argument shape.
  if (!withChecks && result.error?.message.includes('Object contains extra field `includeChecks`'))
    setLegacy(true);
  return result;
}
