// SPDX-License-Identifier: Apache-2.0
import { defineTable } from 'convex/server';
import { v } from 'convex/values';
export const indexEntry = v.object({
  planning: v.optional(
    v.object({
      text: v.string(),
      itemId: v.optional(v.string()),
      payloadKey: v.optional(v.string()),
      kind: v.string(),
      status: v.string(),
      initiativeId: v.string(),
      open: v.boolean(),
    }),
  ),
  activityAt: v.optional(v.number()),
  actor: v.optional(v.string()),
  status: v.optional(v.string()),
  collection: v.string(),
  key: v.string(),
  parent: v.string(),
  position: v.number(),
  value: v.string(),
});
export const generationFields = {
  recordTables: v.optional(v.union(v.literal('copying'), v.literal('split'))),
  recordTablesProgress: v.optional(v.string()),
  planningSearchVersion: v.optional(v.union(v.literal(1), v.literal(2))),
  /** Source blobs resolve through the project object catalog (no per-blob record). */
  objectCatalog: v.optional(v.literal(true)),
  ensureCursor: v.optional(v.string()),
  ensureRetry: v.optional(v.string()),
  returnRetired: v.optional(v.literal(true)),
  returnCleanupRefs: v.optional(v.string()),
  returnCleanupOffset: v.optional(v.number()),
  returnCommitPlan: v.optional(v.string()),
  returnCommitCursor: v.optional(v.string()),
  returnCommitCopied: v.optional(v.boolean()),
  returnCommitOffset: v.optional(v.number()),
  returnCommitDone: v.optional(v.boolean()),
  workSchema: v.optional(v.number()),
  intentMigrationOperationId: v.optional(v.string()),
  retainedForIntentMigration: v.optional(v.string()),
  returnProgress: v.optional(v.string()),
  returnPrepareCursor: v.optional(v.string()),
  returnMetadataCursor: v.optional(v.string()),
  returnMetadataSnapshot: v.optional(v.string()),
  returnCursor: v.optional(v.id('_storage')),
  returnSnapshot: v.optional(v.id('_storage')),
  returnStep: v.optional(v.number()),
  returnOperationId: v.optional(v.string()),
  returnAt: v.optional(v.string()),
  format: v.optional(
    v.union(
      v.literal(2),
      v.literal(3),
      v.literal(4),
      v.literal(5),
      v.literal(6),
      v.literal(7),
      v.literal(8),
      v.literal(9),
      v.literal(10),
      v.literal(11),
    ),
  ),
  projectId: v.id('hostedProjects'),
  backupId: v.id('projectBackups'),
  revision: v.number(),
  initialRevision: v.number(),
  recordsGenerationId: v.optional(v.id('projectWorkGenerations')),
  status: v.union(v.literal('building'), v.literal('ready'), v.literal('failed')),
  nextBatch: v.number(),
  metadata: v.string(),
};
export const generationDocument = v.object({
  _id: v.id('projectWorkGenerations'),
  _creationTime: v.number(),
  ...generationFields,
});
export const indexTables = {
  projectReturnPages: defineTable({
    projectId: v.id('hostedProjects'),
    partitionId: v.id('projectWorkGenerations'),
    key: v.string(),
    position: v.number(),
    body: v.string(),
  })
    .index('by_partition_and_key_and_position', ['partitionId', 'key', 'position'])
    .index('by_project', ['projectId']),
  projectWorkGenerations: defineTable(generationFields)
    .index('by_project_and_intent_migration_and_revision', [
      'projectId',
      'intentMigrationOperationId',
      'revision',
    ])
    .index('by_project_and_returnAt', ['projectId', 'returnAt'])
    .index('by_project_and_return_operation', ['projectId', 'returnOperationId'])
    .index('by_project', ['projectId'])
    .index('by_project_and_backup_and_revision', ['projectId', 'backupId', 'revision'])
    .index('by_project_and_backup_and_revision_and_format', ['projectId', 'backupId', 'revision', 'format'])
    .index('by_project_and_backup_and_revision_and_format_and_work_schema', [
      'projectId',
      'backupId',
      'revision',
      'format',
      'workSchema',
    ]),
  projectPlanningRecords: defineTable({
    projectId: v.id('hostedProjects'),
    generationId: v.id('projectWorkGenerations'),
    ...indexEntry.fields,
  })
    .index('by_generation_and_actor', ['generationId', 'actor'])
    .index('by_generation_and_collection_and_key', ['generationId', 'collection', 'key'])
    .index('by_generation_and_collection_and_position', ['generationId', 'collection', 'position'])
    .index('by_generation_and_collection_and_parent_and_position', [
      'generationId',
      'collection',
      'parent',
      'position',
    ])
    .index('by_project', ['projectId'])
    .index('by_generation', ['generationId'])
    .index('by_planning_initiativeId', ['generationId', 'collection', 'planning.initiativeId', 'position'])
    .index('by_planning_kind', ['generationId', 'collection', 'planning.kind', 'position'])
    .index('by_planning_status', ['generationId', 'collection', 'planning.status', 'position'])
    .index('by_planning_initiativeId_and_kind', [
      'generationId',
      'collection',
      'planning.initiativeId',
      'planning.kind',
      'position',
    ])
    .index('by_planning_initiativeId_and_status', [
      'generationId',
      'collection',
      'planning.initiativeId',
      'planning.status',
      'position',
    ])
    .index('by_planning_kind_and_status', [
      'generationId',
      'collection',
      'planning.kind',
      'planning.status',
      'position',
    ])
    .index('by_planning_initiativeId_and_kind_and_status', [
      'generationId',
      'collection',
      'planning.initiativeId',
      'planning.kind',
      'planning.status',
      'position',
    ])
    .searchIndex('search_planning', {
      searchField: 'planning.text',
      filterFields: [
        'generationId',
        'planning.kind',
        'planning.status',
        'planning.initiativeId',
        'planning.open',
        'planning.itemId',
        'planning.payloadKey',
      ],
    }),
  projectWorkDataRecords: defineTable({
    projectId: v.id('hostedProjects'),
    generationId: v.id('projectWorkGenerations'),
    ...indexEntry.fields,
  })
    .index('by_generation_and_actor', ['generationId', 'actor'])
    .index('by_generation_and_collection_and_key', ['generationId', 'collection', 'key'])
    .index('by_generation_and_collection_and_position', ['generationId', 'collection', 'position'])
    .index('by_generation_and_collection_and_parent_and_position', [
      'generationId',
      'collection',
      'parent',
      'position',
    ])
    .index('by_project', ['projectId'])
    .index('by_generation', ['generationId']),
  projectWorkRecords: defineTable({
    projectId: v.id('hostedProjects'),
    generationId: v.id('projectWorkGenerations'),
    ...indexEntry.fields,
  })
    .index('by_generation_and_collection_and_activityAt', ['generationId', 'collection', 'activityAt'])
    .index('by_generation_and_actor', ['generationId', 'actor'])
    .index('by_generation_and_collection_and_key', ['generationId', 'collection', 'key'])
    .index('by_generation_and_collection_and_position', ['generationId', 'collection', 'position'])
    .index('by_generation_and_collection_and_parent_and_position', [
      'generationId',
      'collection',
      'parent',
      'position',
    ])
    .index('by_generation_and_collection_and_status_and_position', [
      'generationId',
      'collection',
      'status',
      'position',
    ])
    .index('by_planning_initiativeId', ['generationId', 'collection', 'planning.initiativeId', 'position'])
    .index('by_planning_kind', ['generationId', 'collection', 'planning.kind', 'position'])
    .index('by_planning_status', ['generationId', 'collection', 'planning.status', 'position'])
    .index('by_planning_initiativeId_and_kind', [
      'generationId',
      'collection',
      'planning.initiativeId',
      'planning.kind',
      'position',
    ])
    .index('by_planning_initiativeId_and_status', [
      'generationId',
      'collection',
      'planning.initiativeId',
      'planning.status',
      'position',
    ])
    .index('by_planning_kind_and_status', [
      'generationId',
      'collection',
      'planning.kind',
      'planning.status',
      'position',
    ])
    .index('by_planning_initiativeId_and_kind_and_status', [
      'generationId',
      'collection',
      'planning.initiativeId',
      'planning.kind',
      'planning.status',
      'position',
    ])
    .index('by_project', ['projectId'])
    .index('by_generation', ['generationId'])
    .searchIndex('search_planning', {
      searchField: 'planning.text',
      filterFields: [
        'generationId',
        'planning.kind',
        'planning.status',
        'planning.initiativeId',
        'planning.open',
        'planning.itemId',
        'planning.payloadKey',
      ],
    }),
};
