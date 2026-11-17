// SPDX-License-Identifier: Apache-2.0
// Pure and import-free apart from zod: Convex (V8) and tests load it; the CLI never does.
//
// A person's contributions (Item 6a251b23; docs/people.md): one summary row per person per active UTC day, holding
// that day's counts per project. The project's day close (convex/projectStats.ts closeDay) writes its own entry into
// each active person's row, so a landing writes nothing extra and an idle project writes nothing. The profile reads
// at most PERSON_DAYS_READ rows and keeps only the projects the viewer may open.
import { z } from 'zod';

/** At most a year of active days per profile read (53 weeks of the day grid). */
export const PERSON_DAYS_READ = 366;
/** Agent runs per page on the profile. */
export const PERSON_AGENTS_PAGE = 25;
/** Distinct projects one profile read resolves; more are left out and said so. */
export const PERSON_PROJECTS_READ = 50;
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
  })
  .strict();
export type ProjectDay = z.infer<typeof projectDay>;
export const personDaySchema = z.object({ p: z.record(z.string(), projectDay) }).strict();
export type PersonDay = z.infer<typeof personDaySchema>;

/** One contribution the day close found: a landing, a Lane start, or a review. */
export type Contribution =
  | { kind: 'landing'; person: string; at: number; run?: string; model?: string }
  | { kind: 'lane'; person: string; at: number; run?: string }
  | { kind: 'review'; person: string; at: number };

/** Every person's entry for one project-day, from that day's contributions. */
export function projectDays(contributions: readonly Contribution[]) {
  const people = new Map<string, ProjectDay>();
  for (const c of contributions) {
    const day = people.get(c.person) ?? { l: 0, la: 0, n: 0, na: 0, v: 0, t: [c.at, c.at], r: {} };
    day.t = [Math.min(day.t[0], c.at), Math.max(day.t[1], c.at)];
    if (c.kind === 'review') day.v++;
    else {
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
    const runs = Object.entries(day.r);
    if (runs.length <= PERSON_DAY_RUNS) continue;
    runs.sort((a, b) => b[1][0] + b[1][1] - (a[1][0] + a[1][1]) || a[0].localeCompare(b[0]));
    day.r = Object.fromEntries(runs.slice(0, PERSON_DAY_RUNS));
    day.rm = runs.length - PERSON_DAY_RUNS;
  }
  return people;
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
  /** Active days in the viewer's scope, oldest first: [day, landings, Lanes, reviews, landings by agents]. */
  days: [string, number, number, number, number][];
  totals: {
    landings: number;
    lanes: number;
    reviews: number;
    landingsByAgents: number;
    lanesByAgents: number;
  };
  projects: (Seen & { landings: number; lanes: number; reviews: number; last: number })[];
  /** Projects the read could not resolve (over PERSON_PROJECTS_READ). */
  projectsLeftOut: number;
  agents: { total: number; from: number; rows: ProfileAgent[] };
};

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
  const totals = { landings: 0, lanes: 0, reviews: 0, landingsByAgents: 0, lanesByAgents: 0 };
  const projects = new Map<string, { landings: number; lanes: number; reviews: number; last: number }>();
  const runs = new Map<string, ProfileAgent & { lastAt: number }>();
  const days: ProfileRead['days'] = [];
  let first: number | null = null,
    last: number | null = null;
  for (const row of [...input.rows].sort((a, b) => a.day.localeCompare(b.day))) {
    const day: ProfileRead['days'][number] = [row.day, 0, 0, 0, 0];
    for (const [projectId, entry] of Object.entries(row.value.p)) {
      const project = input.seen.get(projectId);
      if (!project) continue;
      day[1] += entry.l;
      day[2] += entry.n;
      day[3] += entry.v;
      day[4] += entry.la;
      totals.lanesByAgents += entry.na;
      first = first === null ? entry.t[0] : Math.min(first, entry.t[0]);
      last = last === null ? entry.t[1] : Math.max(last, entry.t[1]);
      const sum = projects.get(projectId) ?? { landings: 0, lanes: 0, reviews: 0, last: 0 };
      sum.landings += entry.l;
      sum.lanes += entry.n;
      sum.reviews += entry.v;
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
    if (day[1] || day[2] || day[3]) days.push(day);
    totals.landings += day[1];
    totals.lanes += day[2];
    totals.reviews += day[3];
    totals.landingsByAgents += day[4];
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
    agents: {
      total: agents.length,
      from,
      rows: agents.slice(from, from + PERSON_AGENTS_PAGE).map(({ lastAt, ...agent }) => (void lastAt, agent)),
    },
  };
}
