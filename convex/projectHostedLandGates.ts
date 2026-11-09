// SPDX-License-Identifier: Apache-2.0
import type { Id } from './_generated/dataModel';
import type { MutationCtx } from './server';
import { readHostedRecord } from './projectHostedRecords';
import { effectivePolicy } from '../src/autonomy-policy';
import { effectiveAgentDefaults } from '../src/agent-parallel-defaults';
import { landGateRefusal, parseLandGates, GATED_LANES } from '../src/hosted-land-gates';
import { hostedLaneSchema } from '../src/hosted-lane';

/** Server `preflight: require` (Issue 029138ef) for a new agent landing at its public entry point:
 * refuse one that lacks the CLI's preflight result for a Lane head it lands. Other policies read
 * nothing. A gated landing reads its compose selection once (indexed: the Lanes and heads it
 * lands). Person landings, replays and server re-landings are never judged here. */
export async function enforceLandGates(
  ctx: MutationCtx,
  input: {
    projectId: Id<'hostedProjects'>;
    project: { autonomyPolicy?: unknown };
    actor: { id: string; kind: 'agent' | 'person' };
    composeOperationId: string | undefined;
    gates: string | undefined;
  },
) {
  if (input.actor.kind !== 'agent') return;
  const { preflight } = effectiveAgentDefaults(
    effectivePolicy(input.project as Parameters<typeof effectivePolicy>[0]).agentDefaults,
  );
  if (preflight !== 'require') return;
  const gates = parseLandGates(input.gates);
  const lanes: { laneId: string; head: string }[] = [];
  if (input.composeOperationId) {
    const selected = await ctx.db
      .query('projectHostedComposeSelections')
      .withIndex('by_project_and_actor_and_operation_and_kind_and_key', q =>
        q
          .eq('projectId', input.projectId)
          .eq('actor', input.actor.id)
          .eq('operationId', input.composeOperationId!)
          .eq('kind', 'inputs'),
      )
      .take(GATED_LANES);
    for (const row of selected) {
      // Rows staged before the head was recorded: the Lane's saved head (one read, transitional).
      let head = row.head;
      if (!head) {
        const record = await readHostedRecord(ctx, {
          projectId: input.projectId,
          actor: input.actor.id,
          kind: 'lane',
          key: row.key,
        });
        head = record ? hostedLaneSchema.parse(JSON.parse(record.value)).head : undefined;
      }
      if (head) lanes.push({ laneId: row.key, head });
    }
  }
  const refusal = landGateRefusal({ preflight, lanes, gates });
  if (refusal) throw refusal;
}
