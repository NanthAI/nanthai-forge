// SPDX-License-Identifier: Apache-2.0
import { defineTable } from 'convex/server';
import { v } from 'convex/values';
export const publicationFields = {
  projectId: v.id('hostedProjects'),
  owner: v.string(),
  operationId: v.string(),
  request: v.string(),
  digest: v.string(),
  size: v.number(),
  metadataDigest: v.string(),
  pages: v.number(),
  cursor: v.number(),
  chain: v.string(),
  validated: v.boolean(),
};
export const publicationDocument = v.object({
  _id: v.id('projectPublications'),
  _creationTime: v.number(),
  ...publicationFields,
});
export const publicationTables = {
  projectPublicationAttempts: defineTable({
    projectId: v.id('hostedProjects'),
    owner: v.string(),
    operationId: v.string(),
    request: v.string(),
    attemptId: v.string(),
    expiresAt: v.number(),
  })
    .index('by_project_and_operation', ['projectId', 'operationId'])
    .index('by_project', ['projectId']),
  projectPublications: defineTable(publicationFields)
    .index('by_project_and_operation', ['projectId', 'operationId'])
    .index('by_project', ['projectId']),
  projectPublicationPages: defineTable({
    projectId: v.id('hostedProjects'),
    publicationId: v.id('projectPublications'),
    position: v.number(),
    body: v.string(),
    previous: v.string(),
    chain: v.string(),
  })
    .index('by_publication_and_position', ['publicationId', 'position'])
    .index('by_project', ['projectId']),
};
