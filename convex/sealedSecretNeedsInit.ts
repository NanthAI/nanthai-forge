// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// One-off initialiser for the project needs-you counter (Item 41a0df87, slice 4 review finding 3). A set row stored
// before slice 4 has no `needs`, so the project's `secretsNeeds` never counted its pending work. This fills each
// active set row's `needs` from its signed records and sets each project's counter to the sum, so the top bar
// agrees with the Secrets page at rollout. Run it with `apply: false` first: it writes nothing and counts what it
// would change. A run that has nothing to change writes nothing, so replaying it is free. Delete this file once
// every deployment has run it (docs/development.md, "Needs-you counter").
//
// Reads per call: at most `limit` (default 8, at most 16) set rows by index, in project order, so the
// rows of one project are read together, and one project row for each project those rows belong to. A set row is at
// most 512 KiB, so a call reads under 8 MiB. Writes: only a set row whose `needs` differs and a project row whose
// counter differs. Call again with `after` set to the returned `next` until `next` is null. Idle costs nothing: this
// function is never scheduled.
import { v } from 'convex/values';
import { internalMutation } from './server';
import type { Doc } from './_generated/dataModel';
import { invariant } from '../src/errors';
import { storedNeeds } from './sealedSecretGate';

const DEFAULT_LIMIT = 8,
  MAX_LIMIT = 16;

export const initialise = internalMutation({
  args: { after: v.optional(v.id('hostedProjects')), limit: v.optional(v.number()), apply: v.boolean() },
  returns: v.object({
    projects: v.number(),
    sets: v.number(),
    setsChanged: v.number(),
    projectsChanged: v.number(),
    needsTotal: v.number(),
    next: v.union(v.id('hostedProjects'), v.null()),
  }),
  handler: async (ctx, { after, limit = DEFAULT_LIMIT, apply }) => {
    invariant(
      Number.isInteger(limit) && limit >= 1 && limit <= MAX_LIMIT,
      'BAD_ARGUMENT',
      `limit is a whole number from 1 to ${MAX_LIMIT}.`,
    );
    const rows = await ctx.db
      .query('sealedSecretSets')
      .withIndex('by_project_and_kind_and_active', q => (after ? q.gt('projectId', after) : q))
      .take(limit);
    // A full page may end inside a project: leave that project to the next call, unless it is the only one here.
    const lastProject = rows[rows.length - 1]?.projectId;
    const whole =
      rows.length < limit || rows.every(row => row.projectId === lastProject)
        ? rows
        : rows.filter(row => row.projectId !== lastProject);
    const byProject = new Map<string, Doc<'sealedSecretSets'>[]>();
    for (const row of whole) byProject.set(row.projectId, [...(byProject.get(row.projectId) ?? []), row]);
    let sets = 0,
      setsChanged = 0,
      projectsChanged = 0,
      needsTotal = 0;
    for (const group of byProject.values()) {
      let total = 0;
      for (const row of group.filter(r => r.active)) {
        const needs = storedNeeds(row);
        total += needs;
        sets++;
        if ((row.needs ?? 0) !== needs) {
          setsChanged++;
          if (apply) await ctx.db.patch(row._id, { needs });
        }
      }
      needsTotal += total;
      const project = await ctx.db.get(group[0]!.projectId);
      if (!project || (project.secretsNeeds ?? 0) === total) continue;
      projectsChanged++;
      if (apply) await ctx.db.patch(project._id, { secretsNeeds: total || undefined });
    }
    return {
      projects: byProject.size,
      sets,
      setsChanged,
      projectsChanged,
      needsTotal,
      next: rows.length < limit ? null : (whole[whole.length - 1]?.projectId ?? null),
    };
  },
});
