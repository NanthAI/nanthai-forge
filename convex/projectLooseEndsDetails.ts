// SPDX-License-Identifier: Apache-2.0
import { mergedStream, stream, type QueryStream } from 'convex-helpers/server/stream';
import type { GenericDocument } from 'convex/server';
import { z } from 'zod';
import { invariant } from '../src/errors';
import type { Doc } from './_generated/dataModel';
import type { QueryCtx } from './_generated/server';
import { latestLanding } from './projectLatestLanding';
import type { OpenSummary } from './projectLiveLineOpen';
import { lineSummary } from './projectLiveLineStore';
import { readProjectRole } from './projectAuthority';
import { openDeleteRequests } from './projectDeleteRequests';
import { workHead } from './projectWorkHead';
import { recordPartition, selectedGeneration } from './projectWorkIndexStore';
import schema from './schema';

const limit = 25;
/** Open Lanes counted per listed project; more says "25+" rather than a number it did not count. */
const OPEN_LANES_CAP = 25;
/** The first page of leftover projects: each listed project costs its row, its latest landing and its summary, so the
 * details read stays within its page budget (Item b294a5d8); Show 25 more reads the rest, 25 a page. */
const firstProjects = 10;
const inactiveMs = 30 * 24 * 60 * 60_000;
const prefix = 'forge-loose-ends-details-v1:';
const position = z.discriminatedUnion('group', [
  z.object({ group: z.literal('projects'), at: z.number(), after: z.tuple([z.number(), z.string()]) }),
  z.object({
    group: z.literal('dated'),
    generation: z.string(),
    revision: z.number().int().nonnegative(),
    after: z.tuple([z.number(), z.number(), z.string()]),
  }),
]);
type Position = z.infer<typeof position>;
type Project = Doc<'hostedProjects'>;
const unavailable = (why: string) => ({ reported: false, why });

export function looseEndsPosition(cursor: string | undefined, now: number) {
  if (!cursor?.startsWith(prefix)) return null;
  let value: unknown;
  try {
    value = JSON.parse(cursor.slice(prefix.length));
  } catch {
    // Malformed tokens use the same structured refusal as an invalid range.
  }
  const parsed = position.safeParse(value);
  invariant(
    parsed.success && (parsed.data.group !== 'projects' || (parsed.data.at >= 0 && parsed.data.at <= now)),
    'BAD_ARGUMENT',
    'Use a Loose ends group’s continueCursor or start a new read.',
  );
  return parsed.data;
}

async function page<T extends GenericDocument>(
  range: QueryStream<T>,
  after: (string | number)[] | null,
  size = limit,
) {
  const candidates = after
    ? range.narrow({
        lowerBound: after,
        lowerBoundInclusive: false,
        upperBound: [],
        upperBoundInclusive: true,
      })
    : range;
  const rows: T[] = [];
  let bytes = 0;
  // Ordinary search roots can contain up to a document's worth of indexed body text. Allow one
  // large root to advance the cursor, and keep only one lookahead beyond the row or byte budget.
  for await (const [row, , length] of candidates.iterWithKeys(true)) {
    if (!row) continue;
    if (rows.length === size || (rows.length && bytes + length > 512_000))
      return { rows, boundary: rows.at(-1)! };
    rows.push(row);
    bytes += length;
  }
  return { rows, boundary: null };
}

/** Recheck the current role. The account order is only a cursor, and a new project needs a full 30 days too. */
async function inactive(ctx: QueryCtx, project: Project | null, actor: string, cutoff: number) {
  if (!project || project.removal || project._creationTime > cutoff) return null;
  const role = await readProjectRole(ctx, project, actor);
  if (!role) return null;
  const landing = await latestLanding(ctx, project._id);
  const lastLandingAt = landing?._creationTime ?? null;
  if (lastLandingAt !== null && lastLandingAt > cutoff) return null;
  // Size: stored on the project's live-line summary (convex/projectLiveLineOpen.ts), one point read per listed
  // project; absent means not measured yet and the row says so. Open Lanes: the project's presence rows (one slim row
  // per open Lane, none for a closed or superseded one), one bounded range per listed project that is empty for a
  // project nobody uses. A Lane start must not write a shared counter row, so there is none to read.
  const [summary, open] = await Promise.all([
    lineSummary(ctx.db, project._id),
    ctx.db
      .query('projectHostedPresence')
      .withIndex('by_project_and_at', q => q.eq('projectId', project._id))
      .take(OPEN_LANES_CAP + 1),
  ]);
  const stored = (summary ? JSON.parse(summary.value) : {}) as OpenSummary;
  return {
    projectId: project._id,
    name: project.name,
    role,
    lastLandingAt,
    reason: lastLandingAt === null ? 'No landing recorded since creation' : 'No landing in the past 30 days',
    openLanes: Math.min(open.length, OPEN_LANES_CAP),
    ...(open.length > OPEN_LANES_CAP ? { openLanesMore: true as const } : {}),
    ...(stored.size ? { bytes: stored.size.bytes } : {}),
    // Only the owner moves a project to the trash (projectLifecycle:trash), pinned to this revision and to the
    // landing seen here (a landing does not move the revision).
    ...(project.owner === actor
      ? { trash: { expectedRevision: project.revision, expectedLastLanding: landing?._id ?? null } }
      : {}),
  };
}

export async function inactiveProjects(
  ctx: QueryCtx,
  project: Project,
  actor: string,
  now: number,
  cursor?: Extract<Position, { group: 'projects' }>,
) {
  const device = (ctx as { forgeDevice?: Doc<'cliCredentials'> | null }).forgeDevice;
  const at = cursor?.at ?? now;
  const cutoff = at - inactiveMs;
  if (device?.settings?.projects.kind === 'project') {
    const row = await inactive(ctx, project, actor, cutoff);
    return { reported: true, rows: row ? [row] : [], continueCursor: null };
  }
  const range = stream(ctx.db, schema)
    .query('accountProjectOrder')
    .withIndex('by_person_and_activity', q => q.eq('person', actor));
  const [{ rows, boundary }, waiting] = await Promise.all([
    page(range, cursor ? [actor, ...cursor.after] : null, cursor ? limit : firstProjects),
    // The first page also says which of the account's projects wait for a permanent-delete approval.
    cursor ? null : openDeleteRequests(ctx, actor, now),
  ]);
  const matches = await Promise.all(
    rows.map(async row =>
      inactive(ctx, row.projectId === project._id ? project : await ctx.db.get(row.projectId), actor, cutoff),
    ),
  );
  return {
    reported: true,
    ...(waiting?.length ? { deleteRequests: waiting } : {}),
    rows: matches.filter(row => row !== null),
    continueCursor: boundary
      ? prefix + JSON.stringify({ group: 'projects', at, after: [boundary.activityHour, boundary.projectId] })
      : null,
  };
}

/** Use the existing open-Issue indexes. A large body's fragments are outside these ranges. */
export async function datedChecks(
  ctx: QueryCtx,
  project: Project,
  actor: string,
  now: number,
  cursor?: Extract<Position, { group: 'dated' }>,
) {
  if (!(await readProjectRole(ctx, project, actor)))
    return unavailable('Project membership is needed to read dated checks.');
  const generation = await selectedGeneration(ctx, project);
  const partition = generation ? recordPartition(generation) : null;
  const revision = partition
    ? ((await workHead(ctx, project._id))?.revision ?? project.work?.revision)
    : null;
  invariant(
    !cursor || (generation?._id === cursor.generation && revision === cursor.revision),
    'WORK_STALE',
    'The Plan changed. Start a new Loose ends read.',
  );
  if (!partition) return unavailable('The project has no current Plan index.');
  const range = mergedStream(
    ['proposed', 'open', 'in-progress'].map(status =>
      stream(ctx.db, schema)
        .query('projectPlanningRecords')
        .withIndex('by_planning_kind_and_status', q =>
          q
            .eq('generationId', partition)
            .eq('collection', 'planningSearch')
            .eq('planning.kind', 'issue')
            .eq('planning.status', status),
        ),
    ),
    ['position'],
  );
  const { rows, boundary } = await page(range, cursor?.after ?? null);
  const today = new Date(now).toISOString().slice(0, 10);
  return {
    reported: true,
    ...(generation?.planningSearchVersion === 2
      ? {}
      : { why: 'The Plan search index is still being prepared. Dated checks may be incomplete.' }),
    rows: rows.flatMap(row => {
      const { title, version, dueCheck, status, owner } = JSON.parse(row.value) as {
        title: string;
        version: number;
        status: string;
        owner?: string;
        dueCheck?: { date: string; line: number; text: string };
      };
      if (!dueCheck) return [];
      return [
        {
          selection: { itemId: row.key, expectedVersion: version },
          title,
          ...(owner ? { owner } : {}),
          ...(status === 'proposed' ? { proposed: true } : {}),
          ...dueCheck,
          reason:
            dueCheck.date < today ? 'Date passed' : dueCheck.date === today ? 'Due today' : 'Upcoming date',
        },
      ];
    }),
    continueCursor: boundary
      ? prefix +
        JSON.stringify({
          group: 'dated',
          generation: generation!._id,
          revision,
          after: [boundary.position, boundary._creationTime, boundary._id],
        })
      : null,
  };
}
