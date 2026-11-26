// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { readyJournalRecord, wakeJournal, journalGraceMs } from './projectJournalWake';
import { journalDependency, journalRecord, loadedJournalRows, journalBody } from './projectJournalStore';
import { fingerprintHostedIntent } from './projectWorkStoreFingerprintWrites';
import { trackHostedOverlapLane } from './projectHostedOverlapStore';
import { planLaneItem } from './projectPlanLaneMarks';
import { purgeOwnsIntent } from './projectItemPurgeFence';
import type { OverlapChange } from '../src/hosted-overlap';
import type { MutationCtx, QueryCtx } from './_generated/server';
import type { Doc, Id } from './_generated/dataModel';
import { activeProject, accessibleProject } from './projectAuthority';
import { sourceAuthority } from '../src/hosted-source-authority';
import { hostedRecordValue, hostedRecordIndex, type HostedRecordKind } from '../src/hosted-records';
import { isAgentSlug } from '../src/agent-slug';
import { indexedSaveStatus, resumeSaveHeadBackfill, saveHeadFact } from './projectMetricSaveHeads';
import { invariant } from '../src/errors';
import { commentPurged, planningPurged } from '../src/work-planning-put';
import { verifiedPurgedRecord } from './projectWorkPurgedRows';
import { digest } from '../src/state/hash';
import {
  effectiveLifecycleRecord,
  visibleLifecycleRecord,
  materializeLifecycleLane,
  touchLifecycleIntent,
  lifecycleGuard,
} from './projectHostedLifecycleOverlay';

export async function hostedWriteProject(
  ctx: MutationCtx | QueryCtx,
  projectId: Id<'hostedProjects'>,
  actor: string,
  epoch: number,
) {
  const project = await activeProject(ctx, projectId, actor);
  requireWriteEpoch(project, epoch);
  return project;
}
/** hostedWriteProject's authority check on an already-read project (no read). */
export function requireWriteEpoch(project: Parameters<typeof sourceAuthority>[0], epoch: number) {
  const authority = sourceAuthority(project);
  invariant(
    authority.mode !== 'native-owner' && authority.epoch === epoch,
    'SOURCE_AUTHORITY_CHANGED',
    'Hosted source authority changed.',
  );
}
export async function recordHead(
  ctx: QueryCtx | MutationCtx,
  projectId: Id<'hostedProjects'>,
  kind: HostedRecordKind,
  key: string,
) {
  const row = await ctx.db
    .query('projectHostedRecordHeads')
    .withIndex('by_project_and_kind_and_key', q =>
      q.eq('projectId', projectId).eq('kind', kind).eq('key', key),
    )
    .unique();
  journalDependency(ctx, `head:${kind}:${key}`, row ? [row.recordId, row.version, row.status] : null);
  return row;
}

// An empty string fits the existing optional string field. Missing is legacy: it predates the marker and posts no
// landing note (Item fc1831eb marked every open legacy Intent that has a same-id Issue).
export const independentIntentItem = '';
export async function recordVersion(
  ctx: QueryCtx | MutationCtx,
  projectId: Id<'hostedProjects'>,
  kind: HostedRecordKind,
  key: string,
  version: number,
) {
  const row = await ctx.db
    .query('projectHostedRecords')
    .withIndex('by_project_and_kind_and_key_and_version_and_plan', q =>
      q
        .eq('projectId', projectId)
        .eq('kind', kind)
        .eq('key', key)
        .eq('version', version)
        .eq('lifecyclePlanId', undefined),
    )
    .unique();
  if (row) {
    if (row.journalSegment && row.purged === undefined) {
      const original = loadedJournalRows(ctx, 'projectHostedRecords').find(item => item._id === row._id);
      if (original) return original;
    }
    journalDependency(ctx, `version:${kind}:${key}:${version}`, [row._id, row.digest, row.status]);
    return row;
  }
  const archived = await journalRecord(ctx, projectId, kind, key, version);
  if (archived || kind !== 'lane') return archived;
  const overlay = await visibleLifecycleRecord(ctx, projectId, key);
  return overlay?.row.version === version ? overlay.row : null;
}

/** Immutable header/body integrity, shared by authoritative reads and rebuilds. */
export async function hostedRecordBody(ctx: QueryCtx | MutationCtx, row: Doc<'projectHostedRecords'>) {
  // A purged version answers purged, never a digest failure; a marker naming no purge of its Item stays a failure.
  if (row.purged !== undefined) {
    const purged = await verifiedPurgedRecord(ctx, { ...row, purged: row.purged });
    invariant(purged, 'SOURCE_UNAVAILABLE', 'Exact canonical record bytes are unavailable.');
    throw purged.commentId
      ? commentPurged(purged.itemId, purged.commentId, row.purged)
      : planningPurged(purged.itemId, row.purged);
  }
  if (row.inline !== undefined) {
    invariant(
      digest(row.inline) === row.digest && new TextEncoder().encode(row.inline).length === row.bytes,
      'SOURCE_UNAVAILABLE',
      'Exact canonical record bytes are unavailable.',
    );
    return row.inline;
  }
  const body =
    (await ctx.db.get(row.bodyId)) ??
    loadedJournalRows(ctx, 'projectHostedRecordBodies').find(body => body._id === row.bodyId);
  const value =
    body?.value !== undefined && digest(body.value) === row.digest ? body.value : await journalBody(ctx, row);
  invariant(
    (!body || body.projectId === row.projectId) &&
      value !== undefined &&
      digest(value) === row.digest &&
      new TextEncoder().encode(value).length === row.bytes,
    'SOURCE_UNAVAILABLE',
    'Exact canonical record bytes are unavailable.',
  );
  return value;
}

/** Internal transaction primitive, not a source-write API. The source operation
 * reducer must call this in the same transaction as its Lane CAS and receipt.
 * No global revision row is read or written, so independent Lanes do not contend. */
export async function writeHostedRecord(
  ctx: MutationCtx,
  input: {
    projectId: Id<'hostedProjects'>;
    actor: string;
    authorityEpoch: number;
    record: unknown;
    expectedVersion: number | null;
    /** The Item selected by a planned start, or null for a new independent Intent. */
    planningItemId?: string | null | undefined;
    reopened?: true;
    /** Historical repair must carry the proved time, not the time the repair was written. */
    intentCompletedAt?: string;
    /** Trusted compose metadata, outside the client-visible immutable record body. */
    restoreBases?: string;
    candidateFiles?: { sha256: string; size: number };
    candidateFilesDirect?: true;
    /** Trusted input aggregate; false clears Lane provenance, true seeds a new resolution/Candidate. */
    ownerOnly?: boolean;
    saveHooks?: import('../src/hosted-lane').AgentHooks;
    overlap?: {
      changes?: OverlapChange[];
      savedBy?: string;
      complete?: boolean;
      baseSequence?: number;
      intent?: string;
      agent?: string | null;
      hooks?: import('../src/hosted-lane').AgentHooks;
      holderChanged?: true;
      session?: import('zod').infer<typeof import('../src/hosted-lane').sessionMetadataSchema>;
      /** A sync moved the Lane's base to a newer main: keep its saved-path evidence (4f167dfd). */
      rebased?: boolean;
    };
  },
) {
  const project = await activeProject(ctx, input.projectId, input.actor);
  let { record, ref, value } = hostedRecordValue(input.record);
  invariant(record.kind !== 'issue', 'BAD_ARGUMENT', 'Publish Item versions through the Work store writer.');
  if (record.kind === 'intent' && ['completed', 'abandoned'].includes(record.status) && record.needsFix) {
    const { needsFix: handledNotice, ...closed } = record;
    void handledNotice;
    ({ record, ref, value } = hostedRecordValue(closed));
  }
  if (record.kind === 'lane') await materializeLifecycleLane(ctx, input.projectId, record.id);
  const head = await recordHead(ctx, input.projectId, record.kind, record.id);
  if (record.kind === 'intent' && (input.intentCompletedAt || record.completionEvidenceAt)) {
    const intent = { ...record };
    if (input.intentCompletedAt && intent.status === 'completed')
      intent.completionEvidenceAt = input.intentCompletedAt;
    else if (intent.status !== 'completed') delete intent.completionEvidenceAt;
    ({ record, ref, value } = hostedRecordValue(intent));
  }
  const old =
    head && record.version <= head.version
      ? await recordVersion(ctx, input.projectId, record.kind, record.id, record.version)
      : null;
  if (old) {
    invariant(
      old.digest === ref.digest && old.bytes === ref.bytes,
      'WORK_OPERATION_CHANGED',
      'A canonical record version is immutable.',
    );
    return { ...old, value };
  }
  await hostedWriteProject(ctx, input.projectId, input.actor, input.authorityEpoch);
  invariant(
    (head?.version ?? null) === input.expectedVersion &&
      record.version === (input.expectedVersion === null ? 0 : input.expectedVersion + 1),
    'WORK_STALE',
    'The hosted record changed from its expected version.',
  );
  // Saves and Candidates are immutable identities; job and Lane versions retain history.
  invariant(
    !head || record.kind === 'lane' || record.kind === 'job' || record.kind === 'intent',
    'WORK_OPERATION_CHANGED',
    'Saves and Candidates retain their original identity.',
  );
  if (
    record.kind === 'intent' &&
    ['completed', 'abandoned'].includes(record.status) &&
    project.needsFix?.[record.id]
  ) {
    const remaining = { ...project.needsFix };
    delete remaining[record.id];
    await ctx.db.patch(input.projectId, { needsFix: Object.keys(remaining).length ? remaining : undefined });
  }
  // Provenance is server metadata, independent of immutable source/record bytes.
  const ownerOnly =
    record.kind === 'lane'
      ? {
          ownerOnly:
            input.actor === project.owner &&
            record.actor === project.owner &&
            input.ownerOnly !== false &&
            (head ? head.ownerOnly === true : input.ownerOnly === true || record.head === record.base.head),
        }
      : record.kind === 'candidate' && input.ownerOnly !== undefined
        ? { ownerOnly: input.actor === project.owner && input.ownerOnly === true }
        : {};
  const reopened =
    input.reopened === true ||
    Boolean(record.kind === 'lane' && head && head.status !== 'active' && record.state === 'active');
  const opening = record.kind === 'lane' && record.state === 'active' && (!head || reopened);
  let itemId =
    input.planningItemId === null ? independentIntentItem : (input.planningItemId ?? head?.planningItemId);
  let openingItem: Awaited<ReturnType<typeof planLaneItem>> | undefined;
  if (record.kind === 'lane' && opening) {
    // Source-only projects have no Item membership to infer. A retained purge or Work
    // can supply one; an explicit binding already came from the caller's selected Intent.
    if (itemId === undefined && (project.work || project.itemPurges?.length))
      itemId = (await recordHead(ctx, input.projectId, 'intent', record.intentId))?.planningItemId;
    invariant(
      !project.itemPurges?.some(purge => purgeOwnsIntent(purge, record.intentId, itemId)),
      'INTENT_CLOSED',
      'A permanently deleted Item cannot open a Lane.',
    );
    // One lookup, reused by the Lane head and overlap/Plan mark. A new independent start
    // already knows it has no existing Item; an Intent-born Item must check its same-ID root.
    openingItem =
      input.planningItemId !== null && project.work?.generationId
        ? await planLaneItem(ctx, project, itemId || record.intentId, true)
        : null;
    itemId = openingItem?.id ?? itemId;
  }
  const indexed = { ...hostedRecordIndex(record), version: record.version, ...ownerOnly },
    identity = { projectId: input.projectId, kind: record.kind, key: record.id };
  const bodyId = await ctx.db.insert('projectHostedRecordBodies', { projectId: input.projectId, value });
  const id = await ctx.db.insert('projectHostedRecords', {
    ...identity,
    ...indexed,
    bodyId,
    ...(record.kind === 'candidate'
      ? {
          creatorAccountId: input.actor,
          ...(input.ownerOnly !== undefined ? { provenanceEpoch: input.authorityEpoch } : {}),
        }
      : {}),
    ...(record.kind === 'candidate' && input.restoreBases ? { restoreBases: input.restoreBases } : {}),
    ...(record.kind === 'candidate' && input.candidateFiles ? { candidateFiles: input.candidateFiles } : {}),
    ...(record.kind === 'candidate' && input.candidateFilesDirect
      ? { candidateFilesDirect: true as const }
      : {}),
    digest: ref.digest,
    bytes: ref.bytes,
  });
  const pointer = {
    ...identity,
    ...indexed,
    ...(record.kind === 'save' ? { status: indexedSaveStatus } : {}),
    ...(record.kind === 'save' && input.saveHooks && isAgentSlug(record.agentRun)
      ? {
          hooks: {
            actor: input.actor,
            run: record.agentRun,
            state: input.saveHooks,
            at: Date.parse(record.at),
          },
        }
      : {}),
    recordId: id,
    ...(record.kind === 'lane' && head?.saveFailure ? { saveFailure: head.saveFailure } : {}),
    ...(itemId !== undefined && (record.kind === 'intent' || (record.kind === 'lane' && itemId))
      ? { planningItemId: itemId }
      : {}),
  };
  if (head) {
    await readyJournalRecord(ctx, input.projectId, head.recordId, head.kind);
    await ctx.db.replace(head._id, pointer);
  } else await ctx.db.insert('projectHostedRecordHeads', pointer);
  if (record.kind === 'intent')
    await fingerprintHostedIntent(ctx, project, ref, head?._creationTime ?? Date.now(), indexed.status);
  if (record.kind === 'lane') {
    if (['completed', 'abandoned'].includes(record.state))
      await wakeJournal(
        ctx,
        { projectId: input.projectId, operationId: id, phase: 2, laneId: record.id },
        Date.now() + journalGraceMs,
      );
    await touchLifecycleIntent(ctx, input.projectId, record.intentId);
    await trackHostedOverlapLane(ctx, input.projectId, record, input.overlap, {
      project,
      itemId: input.planningItemId === null ? null : itemId,
      openingItem,
      newLane: !head,
      reopened,
    });
  }
  const saved = (await ctx.db.get(id))!;
  if (record.kind === 'save') {
    await ctx.db.insert('projectMetricFacts', saveHeadFact(input.projectId, saved._creationTime, record));
    await resumeSaveHeadBackfill(ctx, project);
  }
  return { ...saved, value };
}

export async function readHostedRecord(
  ctx: QueryCtx | MutationCtx,
  input: {
    projectId: Id<'hostedProjects'>;
    actor: string;
    kind: HostedRecordKind;
    key: string;
    version?: number;
    withSaveFailure?: boolean;
    /** Head selected in this transaction by an alternate exact index. Undefined uses the key index. */
    selectedHead?: Doc<'projectHostedRecordHeads'> | null;
  },
) {
  await accessibleProject(ctx, input.projectId, input.actor);
  const head =
    input.version !== undefined
      ? null
      : input.selectedHead === undefined
        ? await recordHead(ctx, input.projectId, input.kind, input.key)
        : input.selectedHead;
  invariant(
    !head || (head.projectId === input.projectId && head.kind === input.kind && head.key === input.key),
    'WORK_STALE',
    'The selected record head does not match this read.',
  );
  let row =
    input.version === undefined
      ? head
        ? await ctx.db.get(head.recordId)
        : null
      : await recordVersion(ctx, input.projectId, input.kind, input.key, input.version);
  if (!row) return null;
  if (input.version === undefined) row = await effectiveLifecycleRecord(ctx, row);
  journalDependency(ctx, `selected:${input.kind}:${input.key}`, [
    row._id,
    row.version,
    row.digest,
    row.status,
  ]);
  return {
    ...row,
    ...(head?.planningItemId !== undefined ? { planningItemId: head.planningItemId } : {}),
    ...(input.withSaveFailure && head?.saveFailure
      ? { saveFailure: { id: head._id, value: head.saveFailure } }
      : {}),
    value: await hostedRecordBody(ctx, row),
  };
}

/** The Lane list and detail use the same recorded Intent outcome for the title. */
export async function readHostedIntentLabel(
  ctx: QueryCtx,
  { projectId, actor, intentId }: { projectId: Id<'hostedProjects'>; actor: string; intentId: string },
) {
  await accessibleProject(ctx, projectId, actor);
  let itemId: string | null = null;
  try {
    const head = await recordHead(ctx, projectId, 'intent', intentId);
    itemId = head?.planningItemId || null;
    const record = head ? await ctx.db.get(head.recordId) : null;
    const title =
      record?.projectId === projectId && record.kind === 'intent' && record.key === intentId
        ? JSON.parse(await hostedRecordBody(ctx, record))?.outcome
        : null;
    return { itemId, title: typeof title === 'string' && title.trim() ? title : null };
  } catch {
    // The head carries the Item's identity even when its title bytes are unavailable.
    return { itemId, title: null };
  }
}

/** Page sibling Lanes/saves/Candidates or pending jobs by the schema-owned index. */
export async function hostedRecordPage(
  ctx: QueryCtx | MutationCtx,
  input: {
    projectId: Id<'hostedProjects'>;
    actor: string;
    kind: HostedRecordKind;
    parent?: string;
    status?: string;
    cursor: string | null;
  },
) {
  await accessibleProject(ctx, input.projectId, input.actor);
  invariant(
    input.parent === undefined || input.status === undefined,
    'BAD_ARGUMENT',
    'Select a parent or status index.',
  );
  const query =
    input.kind === 'save' && input.status === 'saved'
      ? ctx.db
          .query('projectHostedRecordHeads')
          .withIndex('by_project_and_kind', q => q.eq('projectId', input.projectId).eq('kind', 'save'))
      : input.status === undefined || input.kind === 'lane'
        ? ctx.db.query('projectHostedRecordHeads').withIndex('by_project_and_kind_and_parent', q => {
            const prefix = q.eq('projectId', input.projectId).eq('kind', input.kind);
            return input.parent === undefined ? prefix : prefix.eq('parent', input.parent);
          })
        : ctx.db.query('projectHostedRecordHeads').withIndex('by_project_and_kind_and_status', q =>
            q
              .eq('projectId', input.projectId)
              .eq('kind', input.kind)
              .eq('status', input.kind === 'save' ? '' : input.status!),
          );
  const result = await query.paginate({
    cursor: input.cursor,
    numItems: 100,
    maximumRowsRead: 100,
    maximumBytesRead: 128 * 1024,
  });
  if (input.kind === 'save') {
    // Public save descriptors have always had one status, including while
    // private heads carry their derived coverage mark.
    for (const head of result.page) head.status = 'saved';
  }
  if (input.kind === 'lane') {
    const cascades = new Map<string, boolean>();
    for (const head of result.page) {
      if (!cascades.has(head.parent))
        cascades.set(head.parent, Boolean((await lifecycleGuard(ctx, input.projectId, head.parent))?.planId));
      if (!cascades.get(head.parent)) continue;
      const overlay = await visibleLifecycleRecord(ctx, input.projectId, head.key);
      if (overlay?.pointer.baseRecordId === head.recordId) {
        head.version = overlay.row.version;
        head.status = overlay.row.status;
        head.recordId = overlay.row._id;
      }
    }
    if (input.status !== undefined) result.page = result.page.filter(row => row.status === input.status);
  }
  return result;
}
