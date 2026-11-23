// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { v } from 'convex/values';
import { mergedStream, stream } from 'convex-helpers/server/stream';
import { mutation, type QueryCtx, type MutationCtx } from './cliServer';
import type { Doc } from './_generated/dataModel';
import schema from './schema';
import { invariant } from '../src/errors';
import {
  hostedLifecycleResultSchema,
  looseEndIntentCursor,
  looseEndIntentPageSize,
  looseEndIntentBatchSchema,
} from '../src/hosted-lifecycle';
import { hostedIntentSchema } from '../src/hosted-lane';
import { canonicalPayload, hostedPayloadHash } from '../src/hosted-source-operation';
import { sourceAuthority } from '../src/hosted-source-authority';
import { assembleIndexValue, type IndexHeader } from '../src/work-index-value';
import { accessibleProject, activeOwnedProject, readProjectRole } from './projectAuthority';
import { hostedRecordBody, recordHead } from './projectHostedRecords';
import { beginHostedOperation, finishHostedOperation } from './projectHostedOperations';
import { transitionLifecycle } from './projectHostedLifecycle';
import { effectiveLifecycleRecord, lifecycleGuard } from './projectHostedLifecycleOverlay';
import { record, recordPartition, selectedGeneration } from './projectWorkIndexStore';
import { report } from './errors';

type Project = Doc<'hostedProjects'>;
type IntentHead = Doc<'projectHostedRecordHeads'>;
type Ctx = QueryCtx | MutationCtx;
const open = ['active', 'ready', 'proposed'];
const LANE_WINDOW = 25;
const ATTRIBUTE_WINDOW = 4;

type ItemLinks = {
  historyRefs?: unknown[];
  relatedIntentIds?: unknown[];
  memberships?: unknown[];
};
const linked = (value?: ItemLinks | null) =>
  !!(value?.historyRefs?.length || value?.relatedIntentIds?.length || value?.memberships?.length);

/** Current link evidence also covers same-id legacy Items and reciprocal links in the
 * Work index. Only selected attributes are read. An incomplete projection stays unknown. */
async function itemLink(
  ctx: Ctx,
  project: Project,
  head: IntentHead,
  generation: Awaited<ReturnType<typeof selectedGeneration>>,
) {
  if (head.planningItemId || (await recordHead(ctx, project._id, 'issue', head.key))) return 'linked';
  if (!generation) return project.work?.generationId ? 'unknown' : null;
  const partition = recordPartition(generation);
  if (await record(ctx, partition, 'planningSearch', head.key)) return 'linked';
  const row = await record(ctx, partition, 'intents', head.key);
  if (!row) return null;
  const header = JSON.parse(row.value) as ItemLinks & IndexHeader;
  if (!header.payloadKey) return linked(header) ? 'linked' : null;
  if (!header.payloadParts || header.payloadParts > ATTRIBUTE_WINDOW) return 'unknown';
  const parts = await Promise.all(
    Array.from({ length: header.payloadParts }, (_, index) =>
      record(ctx, partition, 'intents:payload', `${header.payloadKey}:${index}`),
    ),
  );
  if (parts.some(part => !part)) return 'unknown';
  const attributes = assembleIndexValue(
    'intents',
    header,
    parts.filter(part => part !== null),
  );
  return linked(attributes) ? 'linked' : null;
}

const childHeads = (ctx: Ctx, projectId: Project['_id'], intentId: string) =>
  ctx.db
    .query('projectHostedRecordHeads')
    .withIndex('by_project_and_kind_and_parent', q =>
      q.eq('projectId', projectId).eq('kind', 'lane').eq('parent', intentId),
    )
    .take(LANE_WINDOW + 1);

/** No-change saves have their own immutable records, even when a Lane version did not move. */
async function childSaves(ctx: Ctx, projectId: Project['_id'], lanes: IntentHead[], since?: number) {
  return Promise.all(
    lanes.map(async lane => {
      const [save] = await ctx.db
        .query('projectHostedRecords')
        .withIndex('by_project_and_kind_and_parent', q => {
          const range = q.eq('projectId', projectId).eq('kind', 'save').eq('parent', lane.key);
          return since === undefined ? range : range.gte('_creationTime', since);
        })
        .order('desc')
        .take(1);
      return save?._creationTime ?? 0;
    }),
  );
}

async function childActivity(ctx: QueryCtx, projectId: Project['_id'], children: IntentHead[]) {
  if (children.length > LANE_WINDOW) return null;
  const [lanes, saves] = await Promise.all([
    Promise.all(
      children.map(async head => {
        const row = await ctx.db.get(head.recordId);
        return row ? (await effectiveLifecycleRecord(ctx, row))._creationTime : 0;
      }),
    ),
    childSaves(ctx, projectId, children),
  ]);
  return Math.max(0, ...lanes, ...saves);
}

/** One bounded page of open execution heads. Reply rows give review evidence, not an abandonment verdict. */
export async function readLooseEndIntents(
  ctx: QueryCtx,
  projectId: Project['_id'],
  actor: string,
  cursor: string,
  now: number,
) {
  const project = await accessibleProject(ctx, projectId, actor);
  invariant(
    await readProjectRole(ctx, project, actor),
    'PROJECT_UNAVAILABLE',
    'Project membership is required to read loose-end Intents.',
  );
  let position: { projectId?: string; cursor?: string } = {};
  if (cursor !== looseEndIntentCursor) {
    try {
      position = JSON.parse(cursor.slice(looseEndIntentCursor.length));
    } catch {
      // Invalid cursor uses the same structured error as a cursor from another project.
    }
    invariant(
      position?.projectId === projectId && typeof position.cursor === 'string',
      'BAD_ARGUMENT',
      'Use the Intent group’s continueCursor or start a new Loose ends Intent read.',
    );
  }
  const [generation, page] = await Promise.all([
    selectedGeneration(ctx, project),
    mergedStream(
      open.map(status =>
        stream(ctx.db, schema)
          .query('projectHostedRecordHeads')
          .withIndex('by_project_and_kind_and_status', q =>
            q.eq('projectId', projectId).eq('kind', 'intent').eq('status', status),
          ),
      ),
      ['_creationTime'],
    ).paginate({
      cursor: position.cursor ?? null,
      numItems: looseEndIntentPageSize,
      maximumRowsRead: looseEndIntentPageSize,
    }),
  ]);
  const rows = await Promise.all(
    page.page.map(async head => {
      const link = await itemLink(ctx, project, head, generation);
      if (link === 'linked') return null;
      const row = await ctx.db.get(head.recordId);
      if (!row || row.purged) return null;
      const intent = hostedIntentSchema.parse(JSON.parse(await hostedRecordBody(ctx, row)));
      const [guard, children] = await Promise.all([
        lifecycleGuard(ctx, projectId, head.key),
        childHeads(ctx, projectId, head.key),
      ]);
      const activity = await childActivity(ctx, projectId, children);
      return {
        selection: {
          projectId,
          intentId: head.key,
          version: head.version,
          laneRevision: guard?.revision ?? 0,
          observedAt: now,
        },
        status: intent.status,
        title: intent.outcome,
        lastActivityAt:
          activity === null ? null : new Date(Math.max(Date.parse(intent.at), activity)).toISOString(),
        reason: link === 'unknown' ? 'Item link not reported' : 'No linked Item',
      };
    }),
  );
  return {
    at: now,
    setAside: project.owner === actor ? { authorityEpoch: sourceAuthority(project).epoch } : null,
    groups: {
      intents: {
        reported: true,
        rows: rows.filter(row => row !== null),
        continueCursor: page.isDone
          ? null
          : looseEndIntentCursor + canonicalPayload({ projectId, cursor: page.continueCursor }),
      },
    },
  };
}

/** Immutable save rows include no-change saves, which leave the Lane version unchanged. */
async function childChanged(
  ctx: MutationCtx,
  projectId: Project['_id'],
  intentId: string,
  observedAt: number,
  laneRevision: number,
) {
  const lanes = await childHeads(ctx, projectId, intentId);
  if (lanes.length > LANE_WINDOW) return 'child-review-required';
  const saves = await childSaves(ctx, projectId, lanes, observedAt);
  if (saves.some(Boolean)) return 'saved-since-selection';
  const current = await lifecycleGuard(ctx, projectId, intentId);
  if ((current?.revision ?? 0) !== laneRevision) return 'lane-changed';
  return null;
}

export const setAside = mutation({
  args: { projectId: v.id('hostedProjects'), operationId: v.string(), request: v.string() },
  returns: v.string(),
  handler: async (ctx, { projectId, operationId, request }) => {
    try {
      const user = await ctx.auth.getUserIdentity();
      invariant(user, 'PROJECT_UNAVAILABLE', 'Sign in to change hosted work.');
      const actor = user.subject;
      const project = await activeOwnedProject(ctx, projectId, actor);
      const command = looseEndIntentBatchSchema.safeParse(JSON.parse(request));
      invariant(
        command.success,
        'BAD_ARGUMENT',
        'Use original Intent selections and a reason for setting them aside.',
      );
      const { authorityEpoch, reason, intents } = command.data;
      invariant(
        intents.every(selection => selection.projectId === projectId),
        'BAD_ARGUMENT',
        'Use Intent selections from this Forge project.',
      );
      const expected = { authorityEpoch };
      const payload = { action: 'set-aside-loose-end-intents', ...command.data };
      const auth = { projectId, actor, operationId };
      const prepared = await beginHostedOperation(ctx, {
        ...auth,
        payload,
        request: { schema: 1, ...auth, expected, payloadHash: hostedPayloadHash(payload, expected) },
        firstAttempt: {
          projectId,
          operationId,
          id: crypto.randomUUID(),
          at: new Date().toISOString(),
          parentAttemptId: null,
          expected,
          ids: { receipt: crypto.randomUUID() },
        },
      });
      if (prepared.replayed) {
        const outcome = prepared.operation.terminal?.outcome;
        invariant(
          outcome?.status === 'completed',
          'SOURCE_UNAVAILABLE',
          'The original set-aside receipt is unavailable.',
        );
        return canonicalPayload(outcome.result);
      }
      const now = Date.now();
      invariant(
        intents.every(({ observedAt }) => observedAt <= now),
        'BAD_ARGUMENT',
        'Read the Intent selections from Loose ends.',
      );
      const generation = await selectedGeneration(ctx, project);
      const results: Record<string, string | number>[] = [];
      for (const { intentId, version, observedAt, laneRevision } of intents) {
        const head = await recordHead(ctx, projectId, 'intent', intentId);
        const link = head && (await itemLink(ctx, project, head, generation));
        const result = !head
          ? 'not-found'
          : link === 'linked'
            ? 'item-linked'
            : link === 'unknown'
              ? 'item-link-not-reported'
              : !open.includes(head.status)
                ? 'not-open'
                : head.version !== version
                  ? 'intent-changed'
                  : await childChanged(ctx, projectId, intentId, observedAt, laneRevision);
        if (result) {
          results.push({ intentId, result });
          continue;
        }
        const receipt = hostedLifecycleResultSchema.parse(
          JSON.parse(
            await transitionLifecycle(ctx, { projectId }, actor, {
              operationId: crypto.randomUUID(),
              authorityEpoch,
              action: 'abandon',
              reason,
              target: { kind: 'intent', intentId, version, cascade: false },
            }),
          ),
        );
        results.push({ intentId, result: 'set-aside', receiptId: receipt.receiptId, version: version + 1 });
      }
      const first = prepared.operation.firstAttempt;
      const result = { operationId, receiptId: first.ids.receipt!, results };
      await finishHostedOperation(ctx, {
        ...auth,
        receipt: { attemptId: first.id, at: first.at, outcome: { status: 'completed', result } },
      });
      return canonicalPayload(result);
    } catch (error) {
      return report(error);
    }
  },
});
