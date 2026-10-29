// SPDX-License-Identifier: Apache-2.0
import type { MutationCtx, QueryCtx } from './_generated/server';
import type { Doc, Id } from './_generated/dataModel';
import { activeProject, accessibleProject } from './projectAuthority';
import { sourceAuthority } from '../src/hosted-source-authority';
import { hostedRecordValue, hostedRecordIndex, type HostedRecordKind } from '../src/hosted-records';
import { invariant } from '../src/errors';
import { digest } from '../src/portable-hash';
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
  const project = await activeProject(ctx, projectId, actor),
    authority = sourceAuthority(project);
  invariant(
    authority.mode !== 'native-owner' && authority.epoch === epoch,
    'SOURCE_AUTHORITY_CHANGED',
    'Hosted source authority changed.',
  );
  return project;
}
export const recordHead = (
  ctx: QueryCtx | MutationCtx,
  projectId: Id<'hostedProjects'>,
  kind: HostedRecordKind,
  key: string,
) =>
  ctx.db
    .query('projectHostedRecordHeads')
    .withIndex('by_project_and_kind_and_key', q =>
      q.eq('projectId', projectId).eq('kind', kind).eq('key', key),
    )
    .unique();
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
  if (row || kind !== 'lane') return row;
  const overlay = await visibleLifecycleRecord(ctx, projectId, key);
  return overlay?.row.version === version ? overlay.row : null;
}

/** Immutable header/body integrity, shared by authoritative reads and rebuilds. */
export async function hostedRecordBody(ctx: QueryCtx | MutationCtx, row: Doc<'projectHostedRecords'>) {
  const body = await ctx.db.get(row.bodyId);
  invariant(
    body?.projectId === row.projectId &&
      digest(body.value) === row.digest &&
      new TextEncoder().encode(body.value).length === row.bytes,
    'SOURCE_UNAVAILABLE',
    'Exact canonical record bytes are unavailable.',
  );
  return body.value;
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
    /** Trusted compose metadata, outside the client-visible immutable record body. */
    restoreBases?: string;
    /** Trusted source reducers may clear provenance when importing unaccepted peer source. */
    ownerOnly?: boolean;
  },
) {
  const project = await activeProject(ctx, input.projectId, input.actor);
  let { record, ref, value } = hostedRecordValue(input.record);
  if (record.kind === 'intent' && ['completed', 'abandoned'].includes(record.status) && record.needsFix) {
    const { needsFix: handledNotice, ...closed } = record;
    void handledNotice;
    ({ record, ref, value } = hostedRecordValue(closed));
  }
  if (record.kind === 'lane') await materializeLifecycleLane(ctx, input.projectId, record.id);
  const old = await recordVersion(ctx, input.projectId, record.kind, record.id, record.version);
  if (old) {
    invariant(
      old.digest === ref.digest && old.bytes === ref.bytes,
      'WORK_OPERATION_CHANGED',
      'A canonical record version is immutable.',
    );
    return { ...old, value: await hostedRecordBody(ctx, old) };
  }
  await hostedWriteProject(ctx, input.projectId, input.actor, input.authorityEpoch);
  const head = await recordHead(ctx, input.projectId, record.kind, record.id);
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
      : {};
  const indexed = { ...hostedRecordIndex(record), version: record.version, ...ownerOnly },
    identity = { projectId: input.projectId, kind: record.kind, key: record.id };
  const bodyId = await ctx.db.insert('projectHostedRecordBodies', { projectId: input.projectId, value });
  const id = await ctx.db.insert('projectHostedRecords', {
    ...identity,
    ...indexed,
    bodyId,
    ...(record.kind === 'candidate' ? { creatorAccountId: input.actor } : {}),
    ...(record.kind === 'candidate' && input.restoreBases ? { restoreBases: input.restoreBases } : {}),
    digest: ref.digest,
    bytes: ref.bytes,
  });
  const pointer = { ...identity, ...indexed, recordId: id };
  if (head) await ctx.db.replace(head._id, pointer);
  else await ctx.db.insert('projectHostedRecordHeads', pointer);
  if (record.kind === 'lane') await touchLifecycleIntent(ctx, input.projectId, record.intentId);
  return { ...(await ctx.db.get(id))!, value };
}

export async function readHostedRecord(
  ctx: QueryCtx | MutationCtx,
  input: {
    projectId: Id<'hostedProjects'>;
    actor: string;
    kind: HostedRecordKind;
    key: string;
    version?: number;
  },
) {
  await accessibleProject(ctx, input.projectId, input.actor);
  const head =
    input.version === undefined ? await recordHead(ctx, input.projectId, input.kind, input.key) : null;
  let row =
    input.version === undefined
      ? head
        ? await ctx.db.get(head.recordId)
        : null
      : await recordVersion(ctx, input.projectId, input.kind, input.key, input.version);
  if (!row) return null;
  if (input.version === undefined) row = await effectiveLifecycleRecord(ctx, row);
  return { ...row, value: await hostedRecordBody(ctx, row) };
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
    input.status === undefined || input.kind === 'lane'
      ? ctx.db.query('projectHostedRecordHeads').withIndex('by_project_and_kind_and_parent', q => {
          const prefix = q.eq('projectId', input.projectId).eq('kind', input.kind);
          return input.parent === undefined ? prefix : prefix.eq('parent', input.parent);
        })
      : ctx.db
          .query('projectHostedRecordHeads')
          .withIndex('by_project_and_kind_and_status', q =>
            q.eq('projectId', input.projectId).eq('kind', input.kind).eq('status', input.status!),
          );
  const result = await query.paginate({
    cursor: input.cursor,
    numItems: 100,
    maximumRowsRead: 100,
    maximumBytesRead: 128 * 1024,
  });
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
