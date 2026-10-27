// SPDX-License-Identifier: Apache-2.0
import { defineTable } from 'convex/server';
import { v } from 'convex/values';
import { sourceAuthority } from './projectSourceAuthorityFields';
export const hostedSeedTables = {
  projectHostedSeeds: defineTable({
    projectId: v.id('hostedProjects'),
    owner: v.string(),
    operationId: v.string(),
    request: v.string(),
    authority: sourceAuthority,
    previous: v.union(v.id('projectBackups'), v.null()),
    projectRevision: v.number(),
    journal: v.union(v.string(), v.null()),
    mainSelection: v.union(v.string(), v.null()),
    nextPage: v.number(),
    objects: v.number(),
    chain: v.string(),
    lastDigest: v.union(v.string(), v.null()),
    backupId: v.optional(v.id('projectBackups')),
    mainDigest: v.optional(v.string()),
  }).index('by_project', ['projectId']),
  projectHostedSeedPages: defineTable({
    projectId: v.id('hostedProjects'),
    seedId: v.id('projectHostedSeeds'),
    index: v.number(),
    body: v.string(),
    previous: v.string(),
    chain: v.string(),
  })
    .index('by_seed_and_index', ['seedId', 'index'])
    .index('by_project', ['projectId']),
};
