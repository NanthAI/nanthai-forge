// SPDX-License-Identifier: Apache-2.0
// One agent run's page in a project (Item 6a251b23): its Lanes, which of them landed, its app, device code and the
// model it declared, read from the Lane records that already exist (no table of agents). Members only, like the
// project's sessions. One read per page view, plus one per "look further back":
// - open Lanes: at most AGENT_OPEN_READ rows of the project's open Lanes, filtered to this run;
// - closed Lanes: one page of at most AGENT_CLOSED_READ rows (64 KB), newest activity first, filtered to this run;
// - the newest landing's receipt, once, for the declared model.
import { v } from 'convex/values';
import { query } from './cliServer';
import { memberProject } from './projectAuthority';
import { report } from './errors';
import { invariant } from '../src/errors';
import { canonicalPayload } from '../src/hosted-source-operation';

export const AGENT_OPEN_READ = 200;
export const AGENT_CLOSED_READ = 100;

export type AgentLane = {
  laneId: string;
  title: string;
  open: boolean;
  /** When the Lane started and its newest activity (ms). */
  first: number;
  last: number;
  landed: { at: string; receiptId: string } | null;
};
export type AgentRunRead = {
  schema: 1;
  person: string;
  run: string;
  lanes: AgentLane[];
  /** The model as the run declared it on its newest landing; '' when it declared none; null when nothing landed. */
  model: string | null;
  app: string | null;
  device: string | null;
  identityFrom: string | null;
  continueCursor: string;
  isDone: boolean;
};

export const read = query({
  args: {
    projectId: v.id('hostedProjects'),
    person: v.string(),
    run: v.string(),
    cursor: v.union(v.string(), v.null()),
  },
  returns: v.string(),
  handler: async (ctx, { projectId, person, run, cursor }) => {
    try {
      const user = await ctx.auth.getUserIdentity();
      invariant(user, 'AUTH_REQUIRED', 'Sign in to see this agent run.');
      await memberProject(ctx, projectId, user.subject);
      const alias = await ctx.db
        .query('accountHandles')
        .withIndex('by_handle', q => q.eq('handle', person.toLowerCase()))
        .unique();
      const actor = alias?.owner;
      const mine = (lane: { actor: string; agent?: string }) =>
        !!actor && lane.actor === actor && lane.agent === run;
      const open = cursor
        ? []
        : (
            await ctx.db
              .query('projectHostedOverlapLanes')
              .withIndex('by_project_and_open', q => q.eq('projectId', projectId).eq('open', true))
              .order('desc')
              .take(AGENT_OPEN_READ)
          ).filter(mine);
      const closed = await ctx.db
        .query('projectHostedOverlapLanes')
        .withIndex('by_project_and_open_and_activity', q => q.eq('projectId', projectId).eq('open', false))
        .order('desc')
        .filter(q => q.and(q.eq(q.field('actor'), actor ?? ''), q.eq(q.field('agent'), run)))
        .paginate({ numItems: 25, cursor, maximumRowsRead: AGENT_CLOSED_READ, maximumBytesRead: 64 * 1024 });
      const rows = [...open, ...closed.page];
      const newestLanded = rows
        .filter(lane => lane.landed)
        .sort((a, b) => b.landed!.at.localeCompare(a.landed!.at))[0];
      let model: string | null = null;
      if (newestLanded?.landed) {
        const receipt = await ctx.db
          .query('projectHostedAcceptances')
          .withIndex('by_project_and_receipt', q =>
            q.eq('projectId', projectId).eq('receiptId', newestLanded.landed!.receiptId),
          )
          .unique();
        const client = receipt
          ? (JSON.parse(receipt.value) as { agentClient?: string }).agentClient
          : undefined;
        model = client?.split(':')[1] ?? '';
      }
      const session = rows.find(lane => lane.session)?.session;
      const result: AgentRunRead = {
        schema: 1,
        person,
        run,
        lanes: rows.map(lane => ({
          laneId: lane.laneId,
          title: lane.intent,
          open: lane.open,
          first: lane._creationTime,
          last: lane.lastActivityAt ?? lane._creationTime,
          landed: lane.landed ? { at: lane.landed.at, receiptId: lane.landed.receiptId } : null,
        })),
        model,
        app: session?.app ?? null,
        // A device's code is what everyone sees; its name stays with its person (DESIGN.md rule 32).
        device: session?.device?.code ?? null,
        identityFrom: session?.identityFrom ?? null,
        continueCursor: closed.continueCursor,
        isDone: closed.isDone,
      };
      return canonicalPayload(result);
    } catch (error) {
      return report(error);
    }
  },
});
