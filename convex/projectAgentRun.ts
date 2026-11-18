// SPDX-License-Identifier: Apache-2.0
// One agent run's page in a project (Item 6a251b23): its Lanes, which of them landed, its app, device code and the
// model it declared, read from the Lane records that already exist (no table of agents). Members only, like the
// project's sessions. One read per page view, plus one per "look further back":
// - open Lanes: at most AGENT_OPEN_READ rows of the project's open Lanes, filtered to this run;
// - closed Lanes: one page of at most AGENT_CLOSED_READ rows (64 KB), newest activity first, filtered to this run;
// - the newest landing's receipt, once, for the declared model;
// - saves: one range of save records per Lane shown (at most AGENT_SAVE_LANES Lanes, AGENT_SAVES_READ rows each);
// - comments (first page only): the person's day rows over the run's days (at most AGENT_COMMENT_DAYS rows) for the
//   count the day close made, and the person's Work change rows in the run's window (at most AGENT_COMMENT_CHANGES)
//   plus at most AGENT_COMMENT_COMMANDS command reads for the list (convex/personWork.ts).
import { v } from 'convex/values';
import { query, type QueryCtx } from './cliServer';
import type { Id } from './_generated/dataModel';
import { memberProject } from './projectAuthority';
import { report } from './errors';
import { accountFor } from './urlIdentity';
import { invariant } from '../src/errors';
import { canonicalPayload } from '../src/hosted-source-operation';
import { personDaySchema } from '../src/person-days';
import { firstLine, planningChange, planningCommand, runOf } from './personWork';

export const AGENT_OPEN_READ = 200;
export const AGENT_CLOSED_READ = 100;
export const AGENT_SAVE_LANES = 50;
export const AGENT_SAVES_READ = 200;
export const AGENT_COMMENT_DAYS = 31;
export const AGENT_COMMENT_CHANGES = 200;
export const AGENT_COMMENT_COMMANDS = 40;
const DAY_MS = 86_400_000;
const isoDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

export type AgentLane = {
  laneId: string;
  title: string;
  open: boolean;
  /** When the Lane started and its newest activity (ms). */
  first: number;
  last: number;
  landed: { at: string; receiptId: string } | null;
  /** Save records on this Lane (at most AGENT_SAVES_READ); null past AGENT_SAVE_LANES Lanes in one read. */
  saves: number | null;
};
export type AgentComment = { at: number; itemId: string; text: string };
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
  /** First page only: comments counted by the day close (through `commentsThrough`), and the ones still in the
   * hot change feed, newest first. Null on later pages. */
  comments: {
    count: number;
    /** A day in the run's window stopped counting planning work at a cap: `count` is a floor. */
    partial: boolean;
    through: string | null;
    rows: AgentComment[];
    more: boolean;
  } | null;
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
      // The people wrapper hands the handler the account id of a handle it knows (convex/publicPeople.ts
      // subjectArgs), so an account id is tried first; a bare handle only reaches here when no wrapper resolved it.
      const actor = (await accountFor(ctx, person))
        ? person
        : (
            await ctx.db
              .query('accountHandles')
              .withIndex('by_handle', q => q.eq('handle', person.toLowerCase()))
              .unique()
          )?.owner;
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
      const saves: (number | null)[] = [];
      for (const [i, lane] of rows.entries())
        saves.push(
          i >= AGENT_SAVE_LANES
            ? null
            : (
                await ctx.db
                  .query('projectHostedRecords')
                  .withIndex('by_project_and_kind_and_parent', q =>
                    q.eq('projectId', projectId).eq('kind', 'save').eq('parent', lane.laneId),
                  )
                  .take(AGENT_SAVES_READ)
              ).length,
        );
      const comments =
        cursor || !actor || !rows.length ? null : await runComments(ctx, projectId, actor, run, rows);
      const session = rows.find(lane => lane.session)?.session;
      const result: AgentRunRead = {
        schema: 1,
        person,
        run,
        lanes: rows.map((lane, i) => ({
          laneId: lane.laneId,
          title: lane.intent,
          open: lane.open,
          first: lane._creationTime,
          last: lane.lastActivityAt ?? lane._creationTime,
          landed: lane.landed ? { at: lane.landed.at, receiptId: lane.landed.receiptId } : null,
          saves: saves[i] ?? null,
        })),
        comments,
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

/** The run's comments in this project: the count from the person's day rows over the run's days, and the list from
 * the person's Work change rows in the run's window (its first Lane or session start to a day after its last action),
 * keeping comments whose command names this run. */
async function runComments(
  ctx: QueryCtx,
  projectId: Id<'hostedProjects'>,
  actor: string,
  run: string,
  lanes: readonly { _creationTime: number; lastActivityAt?: number; session?: { startedAt: number } }[],
) {
  const start = Math.min(
    ...lanes.map(lane => Math.min(lane._creationTime, lane.session?.startedAt ?? Infinity)),
  );
  const end = Math.max(...lanes.map(lane => lane.lastActivityAt ?? lane._creationTime)) + DAY_MS;
  const days = await ctx.db
    .query('personDays')
    .withIndex('by_person_and_day', q =>
      q.eq('person', actor).gte('day', isoDay(start)).lte('day', isoDay(end)),
    )
    .take(AGENT_COMMENT_DAYS);
  let count = 0,
    partial = false,
    through: string | null = null;
  for (const row of days) {
    const entry = personDaySchema.parse(JSON.parse(row.value)).p[projectId];
    if (!entry) continue;
    count += entry.rc?.[run] ?? 0;
    if (entry.pp) partial = true;
    through = row.day;
  }
  const changes = await ctx.db
    .query('projectCoordinationEvents')
    .withIndex('by_project_and_actor', q =>
      q.eq('projectId', projectId).eq('actor', actor).gte('_creationTime', start).lt('_creationTime', end),
    )
    .order('desc')
    .take(AGENT_COMMENT_CHANGES);
  const rows: AgentComment[] = [];
  let opened = 0,
    more = changes.length === AGENT_COMMENT_CHANGES;
  for (const row of changes) {
    const change = planningChange(row);
    if (change?.action !== 'comment-planning-item') continue;
    if (opened++ >= AGENT_COMMENT_COMMANDS) {
      more = true;
      break;
    }
    const command = await planningCommand(ctx, projectId, change.operationId);
    if (!command?.itemId || runOf(command) !== run) continue;
    rows.push({
      at: change.at,
      itemId: command.itemId,
      text: firstLine(command.text, 'A comment').slice(0, 300),
    });
  }
  return { count: Math.max(count, rows.length), partial, through, rows, more };
}
