// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';
import { invariant } from './errors.js';
import type { HostedAgentSession } from './hosted-agent-transport.js';
const stepSchema = z
  .object({
    completed: z.array(z.uuid()),
    next: z.object({ sequence: z.number(), page: z.number() }).strict(),
    done: z.boolean(),
  })
  .strict();
/** Operator sweep, driven page by page from the CLI: no scheduler, no idle work. Retrying is safe
 * because a Lane that is no longer active, or changed after landing, is never written. */
export async function completeMergedLanes(session: HostedAgentSession, authorityEpoch: number) {
  const completed: string[] = [];
  let next = { sequence: 0, page: 0 },
    calls = 0;
  for (;;) {
    invariant(calls < 1000, 'SOURCE_UNAVAILABLE', 'Sweep did not finish; run complete-merged again.');
    const step = stepSchema.parse(
      await session.mutation('projectHostedLifecycleMerged:completeMerged', { authorityEpoch, ...next }),
    );
    calls++;
    completed.push(...step.completed);
    next = step.next;
    if (step.done) return { completed, calls };
  }
}
