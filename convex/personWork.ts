// SPDX-License-Identifier: Apache-2.0
// A person's planning work and newest actions (Item 6a251b23; docs/people.md), read from records that already exist:
// every planning command (put-planning-item, comment-planning-item) writes one Work `change` row in
// projectCoordinationEvents (actor, time, action), and its command is kept in projectWorkEvents or its retained body.
// Nothing here writes on the save, comment or landing path.
// - The project's day close counts Items closed and comments per person (and per agent run) from the change rows
//   (kind 'change': the Work commands and holder handoffs) since the previous closed day, the same window as its Lanes
//   (convex/statsLanes.ts): at most PERSON_WORK_CHANGES change rows and PERSON_WORK_COMMANDS command reads per close.
//   Work past a cap, or already archived, is never dropped silently: the days it falls on are marked partial.
// - A profile view reads the newest few actions from at most PERSON_LATEST_PROJECTS projects the viewer may open.
import type { Id } from './_generated/dataModel';
import type { QueryCtx } from './_generated/server';
import type { Contribution, LatestAction } from '../src/person-days';
import { PERSON_LATEST } from '../src/person-days';
import { isAgentSlug } from '../src/agent-slug';
import { DAY_MS, isAccount } from './statsLanes';

export { isAccount };

/** Change rows one project-day close reads (each about 0.3 KB). */
export const PERSON_WORK_CHANGES = 1_000;
/** Planning commands one close opens (each about the size of the Item edit or comment). */
export const PERSON_WORK_COMMANDS = 400;
/** Projects a profile's Latest reads from, newest activity first. */
export const PERSON_LATEST_PROJECTS = 2;
/** Writers a partial close marks (beyond them, a person's unread planning work goes unmarked; docs/people.md). */
export const PERSON_PARTIAL_MEMBERS = 100;
/** Rows each Latest source reads per project before keeping the person's own. */
export const PERSON_LATEST_READ = 15;

/** Change rows stay in Convex this long, then the journal archives them (convex/coordinationWrite.ts emitChange). */
export const PLANNING_HOT_MS = 14 * DAY_MS;
const PLANNING = new Set(['put-planning-item', 'comment-planning-item']);

type Change = { operationId: string; actor: string; at: number; action: string };
type PlanningCommand = {
  action?: string;
  itemId?: string;
  status?: string;
  expectedVersion?: number;
  imported?: unknown;
  text?: string;
  agent?: string;
  agentClient?: string;
};

/** A Work change row of a planning command, or null for anything else in the feed. */
export function planningChange(row: {
  operationId: string;
  actor: string;
  at: number;
  command: unknown;
}): Change | null {
  const command = row.command as { kind?: string; source?: string; action?: string };
  if (command?.kind !== 'change' || command.source !== 'work' || !PLANNING.has(command.action ?? ''))
    return null;
  if (!isAccount(row.actor) || !row.operationId.startsWith('work:')) return null;
  return { operationId: row.operationId.slice(5), actor: row.actor, at: row.at, action: command.action! };
}

/** The command a planning change stored: its Work event, or its retained body while the journal has not taken it. */
export async function planningCommand(
  ctx: QueryCtx,
  projectId: Id<'hostedProjects'>,
  operationId: string,
): Promise<PlanningCommand | null> {
  const event = await ctx.db
    .query('projectWorkEvents')
    .withIndex('by_project_and_operation', q => q.eq('projectId', projectId).eq('operationId', operationId))
    .unique();
  const text =
    event?.command ??
    (
      await ctx.db
        .query('projectHostedRecordBodies')
        .withIndex('by_project_and_operation', q =>
          q.eq('projectId', projectId).eq('operationId', operationId),
        )
        .unique()
    )?.command;
  if (!text) return null;
  try {
    return JSON.parse(text) as PlanningCommand;
  } catch {
    return null;
  }
}

export const runOf = (command: PlanningCommand) => (isAgentSlug(command.agent) ? command.agent : undefined);
const modelOf = (command: PlanningCommand) => command.agentClient?.split(':')[1] ?? null;

/** Items closed and planning comments in [from, to), for the day close. An Item counts as closed by the put that set
 * its status to closed (never one created closed, as an import does). `cut` is the time of the first planning change
 * the close did not count (past a cap), or null when it counted them all; each person it saw but did not count comes
 * back as a `partial` contribution, so their day is marked too. */
export async function planningContributions(
  ctx: QueryCtx,
  projectId: Id<'hostedProjects'>,
  from: number,
  to: number,
): Promise<{ contributions: Contribution[]; cut: number | null }> {
  // Only change rows (no message, handoff or intent rows): change rows carry no recipient. One past the cap, to know
  // whether any were left.
  const rows = await ctx.db
    .query('projectCoordinationEvents')
    .withIndex('by_project_and_kind_and_recipientActor', q =>
      q
        .eq('projectId', projectId)
        .eq('kind', 'change')
        .eq('recipientActor', undefined)
        .gte('_creationTime', from)
        .lt('_creationTime', to),
    )
    .take(PERSON_WORK_CHANGES + 1);
  const out: Contribution[] = [];
  let cut = rows.length > PERSON_WORK_CHANGES ? rows[PERSON_WORK_CHANGES]!._creationTime : null;
  let opened = 0;
  for (const row of rows.slice(0, PERSON_WORK_CHANGES)) {
    const change = planningChange(row);
    if (!change) continue;
    if (opened >= PERSON_WORK_COMMANDS) {
      cut = Math.min(cut ?? Infinity, row._creationTime);
      out.push({ kind: 'partial', person: change.actor, at: change.at });
      continue;
    }
    opened++;
    const command = await planningCommand(ctx, projectId, change.operationId);
    if (!command) continue;
    if (command.action === 'put-planning-item') {
      if (command.status === 'closed' && command.itemId && command.expectedVersion && !command.imported)
        out.push({ kind: 'close', person: change.actor, at: change.at, item: command.itemId });
    } else if (command.action === 'comment-planning-item') {
      const run = runOf(command);
      out.push({ kind: 'comment', person: change.actor, at: change.at, ...(run ? { run } : {}) });
    }
  }
  return { contributions: out, cut };
}

/** Which days of a close's window it could not fully count: those from the first change it left past a cap, and those
 * older than the change rows Convex still keeps when the project is that old (their rows may be archived). */
export function planningPartialDays(input: {
  window: number;
  cut: number | null;
  projectCreated: number;
  now: number;
}) {
  const hot = input.now - PLANNING_HOT_MS;
  const archived = input.window < hot && input.projectCreated < hot;
  const cutDay = input.cut === null ? null : new Date(input.cut).toISOString().slice(0, 10);
  const hotDay = new Date(hot).toISOString().slice(0, 10);
  return {
    any: cutDay !== null || archived,
    has: (day: string) => (cutDay !== null && day >= cutDay) || (archived && day < hotDay),
  };
}

/** Everyone who can do planning work in the project: its owner and its writers (at most PERSON_PARTIAL_MEMBERS).
 * A partial close marks them all, so a person whose only planning work it left unread still sees "+". */
export async function planningMembers(
  ctx: QueryCtx,
  project: { _id: Id<'hostedProjects'>; owner: string },
): Promise<string[]> {
  const writers = await ctx.db
    .query('projectContributors')
    .withIndex('by_project_and_contributor', q => q.eq('projectId', project._id))
    .take(PERSON_PARTIAL_MEMBERS);
  return [project.owner, ...writers.map(row => row.contributor)].filter(isAccount);
}

export const firstLine = (text: string | undefined, fallback: string) =>
  (text ?? '')
    .split('\n')
    .find(line => line.trim())
    ?.trim()
    .slice(0, 200) || fallback;

/** The person's newest actions in the projects the viewer may open (newest first, given newest activity first):
 * their landings (receipts, which every viewer of the project may read), and for a viewer with a role in the project
 * (the person themself, or a teammate in a private project both are in) also their open Lanes (presence rows) and
 * planning comments (change rows plus at most PERSON_LATEST command reads). A visitor never gets a Lane title or a
 * comment: those follow the project's own public rules (Lane titles opt-in, hidden Items). Per project: at most three
 * bounded reads of PERSON_LATEST_READ rows each. */
export async function latestActions(
  ctx: QueryCtx,
  owner: string,
  projects: readonly { id: Id<'hostedProjects'>; handle: string; slug: string; member: boolean }[],
): Promise<LatestAction[]> {
  const out: LatestAction[] = [];
  for (const project of projects.slice(0, PERSON_LATEST_PROJECTS)) {
    const where = { handle: project.handle, slug: project.slug };
    const receipts = await ctx.db
      .query('projectHostedAcceptances')
      .withIndex('by_project', q => q.eq('projectId', project.id))
      .order('desc')
      .take(PERSON_LATEST_READ);
    for (const row of receipts) {
      const receipt = JSON.parse(row.value) as {
        id: string;
        at: string;
        actor?: { id?: string };
        message?: string;
        agentRun?: string;
        agentClient?: string;
      };
      if (receipt.actor?.id !== owner) continue;
      out.push({
        kind: 'landed',
        at: Date.parse(receipt.at),
        title: firstLine(receipt.message, 'A landing'),
        run: receipt.agentRun ?? null,
        model: receipt.agentRun ? (receipt.agentClient?.split(':')[1] ?? '') : null,
        project: where,
        target: receipt.id,
      });
    }
    if (!project.member) continue;
    const open = await ctx.db
      .query('projectHostedPresence')
      .withIndex('by_project_and_at', q => q.eq('projectId', project.id))
      .order('desc')
      .take(PERSON_LATEST_READ);
    for (const lane of open)
      if (lane.actor === owner)
        out.push({
          kind: 'lane',
          at: lane.at,
          title: firstLine(lane.goal, 'A Lane'),
          run: lane.agent ?? null,
          model: null,
          project: where,
          target: lane.laneId,
        });
    const changes = await ctx.db
      .query('projectCoordinationEvents')
      .withIndex('by_project_and_actor', q => q.eq('projectId', project.id).eq('actor', owner))
      .order('desc')
      .take(PERSON_LATEST_READ);
    let opened = 0;
    for (const row of changes) {
      const change = planningChange(row);
      if (change?.action !== 'comment-planning-item' || opened++ >= PERSON_LATEST) continue;
      const command = await planningCommand(ctx, project.id, change.operationId);
      if (!command?.itemId) continue;
      const run = runOf(command) ?? null;
      out.push({
        kind: 'comment',
        at: change.at,
        title: firstLine(command.text, 'A comment'),
        run,
        model: run ? (modelOf(command) ?? '') : null,
        project: where,
        target: command.itemId,
      });
    }
  }
  return out.sort((a, b) => b.at - a.at).slice(0, PERSON_LATEST);
}
