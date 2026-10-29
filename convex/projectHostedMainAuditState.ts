// SPDX-License-Identifier: Apache-2.0
import type { Doc, Id } from './_generated/dataModel';
import type { MutationCtx, QueryCtx } from './_generated/server';
import type { HostedAcceptance } from '../src/hosted-acceptance';
import type { HostedCheckRun } from '../src/hosted-check';
import { mainGateSchema, type MainGate } from '../src/bet2-gate';

export async function mainGate(
  ctx: QueryCtx | MutationCtx,
  projectId: Id<'hostedProjects'>,
): Promise<MainGate> {
  const row = await ctx.db
    .query('projectHostedMainAudits')
    .withIndex('by_project', q => q.eq('projectId', projectId))
    .unique();
  return mainGateSchema.parse({
    status: row?.red ? 'red' : row?.lastGreen ? 'green' : 'unknown',
    unaudited: row?.unaudited ?? { count: 0, firstAt: null },
    debt: row?.debt ?? false,
    hold: row?.red ? 'main-red' : null,
  });
}
/** S0 seam: B2.3 supplies audit bookkeeping without another function call. */
export async function noteMainLanding(
  _ctx: MutationCtx,
  _input: {
    project: Doc<'hostedProjects'>;
    receipt: HostedAcceptance;
    run: HostedCheckRun | null;
  },
): Promise<void> {}

/** S0 seam: B2.3 supplies terminal audit/probe handling. */
export async function onGateRunTerminal(_ctx: MutationCtx, _run: HostedCheckRun): Promise<void> {}
