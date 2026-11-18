// SPDX-License-Identifier: Apache-2.0
// Pure and import-free apart from zod: Convex (V8) and tests load it; the CLI never does.
//
// A person's contributions (Item 6a251b23; docs/people.md): one summary row per person per active UTC day, holding
// that day's counts per project. The project's day close (convex/projectStats.ts closeDay) writes its own entry into
// each active person's row, so a landing writes nothing extra and an idle project writes nothing. The profile reads
// at most PERSON_DAYS_READ visible days (scanning at most PERSON_DAYS_PAGES pages of rows) and keeps only the
// projects the viewer may open.
import { z } from 'zod';

/** At most a year of active days the viewer may see per read (53 weeks of the day grid); also one page of rows. */
export const PERSON_DAYS_READ = 366;
/** Pages of PERSON_DAYS_READ rows one read scans looking for them, when private-only days are skipped. */
export const PERSON_DAYS_PAGES = 3;
/** Agent runs per page on the profile. */
export const PERSON_AGENTS_PAGE = 25;
/** Projects the viewer may see that one profile read resolves; more are left out and said so (to the person only). */
export const PERSON_PROJECTS_READ = 50;
/** Projects one profile read looks up in all, seen or not, so private ones never make the read unbounded. */
export const PERSON_PROJECTS_PROBE = 200;
/** Runs one project entry keeps per day; a busier day keeps the most active and counts the rest. */
export const PERSON_DAY_RUNS = 40;

const count = z.number().int().nonnegative();
/** One run's day in one project: [Lanes started, landings, declared model or '' when it declared none]. */
const runDay = z.tuple([count, count, z.string().max(64)]);
const projectDay = z
  .object({
    /** Landings the person submitted (by hand or by one of their agent runs) and of those, by agent runs. */
    l: count,
    la: count,
    /** Lanes started, and of those, by agent runs. */
    n: count,
    na: count,
    /** Landings the person accepted after a check, that another submitter (or their own agent) made. */
    v: count,
    /** First and last action that day in this project (ms). */
    t: z.tuple([z.number(), z.number()]),
    /** Agent runs by run name (the slug after `handle/`). */
    r: z.record(z.string().max(64), runDay),
    /** Runs left out of `r` on a very busy day. */
    rm: count.optional(),
    /** Items the person closed that day, each Item once (absent on rows closed before it was counted). */
    c: count.optional(),
    /** Planning comments the person wrote that day, and of those, per agent run (same cap as `r`). */
    m: count.optional(),
    rc: z.record(z.string().max(64), count).optional(),
    /** The close stopped reading this day's planning work at a cap (convex/personWork.ts): c, m and rc are at least
     * these. */
    pp: z.literal(1).optional(),
  })
  .strict();
export type ProjectDay = z.infer<typeof projectDay>;
export const personDaySchema = z.object({ p: z.record(z.string(), projectDay) }).strict();
export type PersonDay = z.infer<typeof personDaySchema>;

/** One contribution the day close found: a landing, a Lane start, a review, an Item closed or a planning comment. */
export type Contribution =
  | { kind: 'landing'; person: string; at: number; run?: string; model?: string }
  | { kind: 'lane'; person: string; at: number; run?: string }
  | { kind: 'review'; person: string; at: number }
  | { kind: 'close'; person: string; at: number; item: string }
  | { kind: 'comment'; person: string; at: number; run?: string }
  /** Planning work the close saw but did not count (past a cap): marks the person's day partial. */
  | { kind: 'partial'; person: string; at: number };

/** Every person's entry for one project-day, from that day's contributions. `partial`: the close stopped counting this
 * day's planning work at a cap, so every entry is marked. */
export function projectDays(contributions: readonly Contribution[], partial = false) {
  const people = new Map<string, ProjectDay>();
  const closed = new Set<string>();
  for (const c of contributions) {
    const day = people.get(c.person) ?? { l: 0, la: 0, n: 0, na: 0, v: 0, t: [c.at, c.at], r: {} };
    day.t = [Math.min(day.t[0], c.at), Math.max(day.t[1], c.at)];
    if (c.kind === 'review') day.v++;
    else if (c.kind === 'partial') day.pp = 1;
    else if (c.kind === 'close') {
      // An Item closed, reopened and closed again the same day counts once.
      if (!closed.has(`${c.person}\n${c.item}`)) day.c = (day.c ?? 0) + 1;
      closed.add(`${c.person}\n${c.item}`);
    } else if (c.kind === 'comment') {
      day.m = (day.m ?? 0) + 1;
      if (c.run) day.rc = { ...day.rc, [c.run]: (day.rc?.[c.run] ?? 0) + 1 };
    } else {
      const agent = Boolean(c.run);
      if (c.kind === 'landing') {
        day.l++;
        if (agent) day.la++;
      } else {
        day.n++;
        if (agent) day.na++;
      }
      if (c.run) {
        const run = day.r[c.run] ?? [0, 0, ''];
        if (c.kind === 'lane') run[0]++;
        else run[1]++;
        if (c.kind === 'landing' && c.model) run[2] = c.model;
        day.r[c.run] = run;
      }
    }
    people.set(c.person, day);
  }
  for (const day of people.values()) {
    if (partial) day.pp = 1;
    const commenters = Object.entries(day.rc ?? {});
    if (commenters.length > PERSON_DAY_RUNS)
      day.rc = Object.fromEntries(
        commenters.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, PERSON_DAY_RUNS),
      );
    const runs = Object.entries(day.r);
    if (runs.length <= PERSON_DAY_RUNS) continue;
    runs.sort((a, b) => b[1][0] + b[1][1] - (a[1][0] + a[1][1]) || a[0].localeCompare(b[0]));
    day.r = Object.fromEntries(runs.slice(0, PERSON_DAY_RUNS));
    day.rm = runs.length - PERSON_DAY_RUNS;
  }
  return people;
}

/** A Lanes-only recount of a day (the Lane backfill) over the entry the close wrote: the recount's fields, plus the
 * close's planning counts (Items closed, comments, per-run comments, the partial mark) and its first and last action,
 * so a recount run at any time, before or after a close, never erases planning work. */
export function keepPlanning(old: ProjectDay | undefined, fresh: ProjectDay): ProjectDay {
  if (!old) return fresh;
  const next: ProjectDay = { ...fresh, t: [Math.min(old.t[0], fresh.t[0]), Math.max(old.t[1], fresh.t[1])] };
  if (old.c !== undefined) next.c = old.c;
  if (old.m !== undefined) next.m = old.m;
  if (old.rc !== undefined) next.rc = old.rc;
  if (old.pp !== undefined) next.pp = old.pp;
  return next;
}

/** A person's row with this project's entry set (replaced, so a repeated close writes the same row). */
export function withProjectDay(row: PersonDay | null, projectId: string, day: ProjectDay): PersonDay {
  return { p: { ...(row?.p ?? {}), [projectId]: day } };
}

export type ProfileScope = 'public' | 'shared' | 'all';
export type Seen = { visibility: 'public' | 'private'; shared: boolean; handle: string; slug: string };
export type ProfileAgent = {
  run: string;
  model: string | null;
  lanes: number;
  landings: number;
  first: string;
  last: string;
  project: { handle: string; slug: string };
};
export type ProfileRead = {
  schema: 1;
  handle: string;
  self: boolean;
  scope: ProfileScope;
  /** The newest day counted in this scope; a project's day is counted once that day closes. */
  through: string | null;
  first: number | null;
  last: number | null;
  /** Active days in the viewer's scope, oldest first: [day, landings, Lanes, reviews, landings by agents, Items
   * closed]. */
  days: [string, number, number, number, number, number][];
  totals: {
    landings: number;
    lanes: number;
    reviews: number;
    landingsByAgents: number;
    lanesByAgents: number;
    itemsClosed: number;
  };
  projects: (Seen & { landings: number; lanes: number; reviews: number; closed: number; last: number })[];
  /** Projects the read could not resolve (over PERSON_PROJECTS_READ). */
  projectsLeftOut: number;
  /** A day shown stopped counting planning work at a cap: Items closed are at least `totals.itemsClosed`. */
  closedPartial: boolean;
  agents: { total: number; from: number; rows: ProfileAgent[] };
  /** The newest few actions, read live from the projects the viewer may open (convex/personLatest.ts). */
  latest: LatestAction[];
};

/** One row of a person's Latest: a landing, an open Lane, or a planning comment, in a project the viewer may open. */
export type LatestAction = {
  kind: 'landed' | 'lane' | 'comment';
  at: number;
  /** A landing's message, a Lane's goal, or the comment's first line (member-written data). */
  title: string;
  run: string | null;
  model: string | null;
  project: { handle: string; slug: string };
  /** What the row opens: a receipt, a Lane or an Item id in that project. */
  target: string;
};
/** Rows Latest shows. */
export const PERSON_LATEST = 4;

/** Sum the rows the viewer may see. `seen` names each project the viewer may open; others are dropped whole. */
export function profileRead(input: {
  handle: string;
  self: boolean;
  scope: ProfileScope;
  rows: readonly { day: string; value: PersonDay }[];
  seen: ReadonlyMap<string, Seen>;
  projectsLeftOut: number;
  agentsFrom: number;
}): ProfileRead {
  const totals = { landings: 0, lanes: 0, reviews: 0, landingsByAgents: 0, lanesByAgents: 0, itemsClosed: 0 };
  const projects = new Map<
    string,
    { landings: number; lanes: number; reviews: number; closed: number; last: number }
  >();
  const runs = new Map<string, ProfileAgent & { lastAt: number }>();
  const days: ProfileRead['days'] = [];
  let first: number | null = null,
    last: number | null = null,
    closedPartial = false;
  for (const row of [...input.rows].sort((a, b) => a.day.localeCompare(b.day))) {
    const day: ProfileRead['days'][number] = [row.day, 0, 0, 0, 0, 0];
    for (const [projectId, entry] of Object.entries(row.value.p)) {
      const project = input.seen.get(projectId);
      if (!project) continue;
      // A mark alone (a partial close marked everyone who can plan here): the figure is a floor; no activity is shown.
      if (entry.pp) closedPartial = true;
      if (!entry.l && !entry.n && !entry.v && !entry.c && !entry.m) continue;
      day[1] += entry.l;
      day[2] += entry.n;
      day[3] += entry.v;
      day[4] += entry.la;
      day[5] += entry.c ?? 0;
      totals.lanesByAgents += entry.na;
      first = first === null ? entry.t[0] : Math.min(first, entry.t[0]);
      last = last === null ? entry.t[1] : Math.max(last, entry.t[1]);
      const sum = projects.get(projectId) ?? { landings: 0, lanes: 0, reviews: 0, closed: 0, last: 0 };
      sum.landings += entry.l;
      sum.lanes += entry.n;
      sum.reviews += entry.v;
      sum.closed += entry.c ?? 0;
      sum.last = Math.max(sum.last, entry.t[1]);
      projects.set(projectId, sum);
      for (const [run, [lanes, landings, model]] of Object.entries(entry.r)) {
        const key = `${projectId}/${run}`;
        const agent = runs.get(key) ?? {
          run,
          model: null,
          lanes: 0,
          landings: 0,
          first: row.day,
          last: row.day,
          lastAt: 0,
          project: { handle: project.handle, slug: project.slug },
        };
        agent.lanes += lanes;
        agent.landings += landings;
        if (model) agent.model = model;
        agent.last = row.day;
        agent.lastAt = Math.max(agent.lastAt, entry.t[1]);
        runs.set(key, agent);
      }
    }
    if (day[1] || day[2] || day[3] || day[5]) days.push(day);
    totals.landings += day[1];
    totals.lanes += day[2];
    totals.reviews += day[3];
    totals.landingsByAgents += day[4];
    totals.itemsClosed += day[5];
  }
  const agents = [...runs.values()].sort((a, b) => b.lastAt - a.lastAt || a.run.localeCompare(b.run));
  const from = Math.max(0, Math.min(input.agentsFrom, Math.max(0, agents.length - 1)));
  return {
    schema: 1,
    handle: input.handle,
    self: input.self,
    scope: input.scope,
    through: days.at(-1)?.[0] ?? null,
    first,
    last,
    days,
    totals,
    projects: [...projects]
      .map(([id, sum]) => ({ ...input.seen.get(id)!, ...sum }))
      .sort((a, b) => b.landings - a.landings || b.last - a.last),
    projectsLeftOut: input.projectsLeftOut,
    closedPartial,
    agents: {
      total: agents.length,
      from,
      rows: agents.slice(from, from + PERSON_AGENTS_PAGE).map(({ lastAt, ...agent }) => (void lastAt, agent)),
    },
    latest: [],
  };
}
