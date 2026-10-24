// SPDX-License-Identifier: Apache-2.0
import type { ConvexReactClient } from 'convex/react';
import type { FunctionArgs } from 'convex/server';
import { api } from '../../convex/_generated/api';
import { browserObjects, sourcePlan } from './browser-source';
import { hostedText } from '../../src/hosted-paths';
import { checkLogPage } from '../../src/check-log-page';
import { invariant } from '../../src/errors';
export async function readBrowserLog(
  client: Pick<ConvexReactClient, 'action' | 'mutation'>,
  input: FunctionArgs<typeof api.projectViewActions.log>,
) {
  const raw = await client.action(api.projectViewActions.log, input),
    plan = JSON.parse(raw);
  if (!plan.direct) return raw;
  const [bytes] = await browserObjects(client, input.projectId).read([plan.direct]);
  const current = await sourcePlan(client, { projectId: input.projectId, backupId: plan.backupId });
  invariant(current.backupId === plan.backupId, 'WORK_STALE', 'Checkpoint changed while reading output.');
  // Recheck the selected generation through the same access-checked log endpoint after the GET.
  const final = JSON.parse(await client.action(api.projectViewActions.log, input));
  invariant(
    final.direct?.sha256 === plan.direct.sha256 && final.generationId === plan.generationId,
    'WORK_STALE',
    'Checkpoint changed while reading output.',
  );
  const portable = new TextEncoder().encode(hostedText(new TextDecoder().decode(bytes)));
  const offset = Math.min(input.offset, portable.length);
  return JSON.stringify(checkLogPage(portable.subarray(offset, offset + 16384), offset, portable.length));
}
