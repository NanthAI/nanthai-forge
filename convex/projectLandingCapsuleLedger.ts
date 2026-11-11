// SPDX-License-Identifier: Apache-2.0
import type { QueryCtx, MutationCtx } from './_generated/server';
import type { Doc, Id } from './_generated/dataModel';
import { canonicalPayload } from '../src/hosted-source-operation';
import { validateComposePage, composeLaneSchema, composeDependencySchema } from '../src/hosted-compose';
import { digest } from '../src/state/hash';
import { invariant } from '../src/errors';

type Ctx = QueryCtx | MutationCtx;
export const capsulePageKind = 'projectLandingCapsulePages';
export const capsuleOwnerKind = 'projectLandingCapsuleOwners';
export const capsulePageKey = (projectId: string, receiptId: string, kind: string, index: number) =>
  `${projectId}:${receiptId}:${kind}:${index}`;
export const capsuleControlKey = (projectId: string, scope: string) => `${projectId}:${scope}`;
export const capsuleControlRow = (ctx: Ctx, sourceId: string) =>
  ctx.db
    .query('projectFinishReadRows')
    .withIndex('by_kind_and_source', q => q.eq('kind', capsuleOwnerKind).eq('sourceId', sourceId))
    .unique();
export function compactCapsulePage(row: Doc<'projectHostedAcceptancePages'>) {
  const page = validateComposePage(JSON.parse(row.value));
  return canonicalPayload([
    row._id,
    row._creationTime,
    row.digest,
    row.root,
    page.next,
    page.entries.map(entry =>
      'laneId' in entry
        ? [
            0,
            entry.laneId,
            entry.head,
            entry.version,
            entry.sourceVersion,
            entry.lifecycleVersion,
            entry.state,
          ]
        : [1, entry.candidateId, entry.head, entry.state],
    ),
  ]);
}
export async function capsuleAcceptancePage(
  ctx: Ctx,
  input: {
    projectId: Id<'hostedProjects'>;
    receiptId: string;
    kind: 'inputs' | 'dependencies';
    index: number;
  },
) {
  const row = await ctx.db
    .query('projectFinishReadRows')
    .withIndex('by_kind_and_source', q =>
      q
        .eq('kind', capsulePageKind)
        .eq('sourceId', capsulePageKey(input.projectId, input.receiptId, input.kind, input.index)),
    )
    .unique();
  if (!row) return null;
  const [id, at, digest, root, next, entries] = JSON.parse(row.value);
  return {
    ...input,
    _id: id,
    _creationTime: at,
    digest,
    root,
    value: canonicalPayload({
      schema: 1,
      kind: 'forge-hosted-compose-page',
      next,
      entries: entries.map((entry: unknown[]) =>
        entry[0] === 0
          ? composeLaneSchema.parse({
              laneId: entry[1],
              head: entry[2],
              version: entry[3],
              sourceVersion: entry[4],
              lifecycleVersion: entry[5],
              state: entry[6],
            })
          : composeDependencySchema.parse({ candidateId: entry[1], head: entry[2], state: entry[3] }),
      ),
    }),
  } as Doc<'projectHostedAcceptancePages'>;
}
type Control = { submissionId?: string; expired?: boolean; branch?: true; entries?: Array<[string, string]> };
/** Only terminal replay consults this ledger. Live callback/compose writes add no lookup. */
export async function capsuleReceiptDigest(
  ctx: Ctx,
  projectId: Id<'hostedProjects'>,
  scope: string,
  event: string,
) {
  const root = capsuleControlKey(projectId, scope),
    hash = digest(event);
  let suffix = '';
  for (;;) {
    const row = await capsuleControlRow(ctx, root + suffix);
    if (!row) return null;
    const data = JSON.parse(row.value) as Control;
    if (!data.branch) return data.entries?.find(([key]) => key === event)?.[1] ?? null;
    suffix += ':' + hash[suffix.length / 2]!;
  }
}
/** 64 KiB is a storage page window, not a user limit: a full leaf splits automatically. */
export async function retainCapsuleReceipts(
  ctx: MutationCtx,
  projectId: Id<'hostedProjects'>,
  scope: string,
  values: Array<[string, string]>,
) {
  const root = capsuleControlKey(projectId, scope);
  async function store(suffix: string, values: Array<[string, string]>, depth: number): Promise<void> {
    const sourceId = root + suffix,
      row = await capsuleControlRow(ctx, sourceId);
    const data = row ? (JSON.parse(row.value) as Control) : {};
    const merged = new Map(data.entries ?? []);
    for (const [event, value] of values) {
      const prior = merged.get(event);
      invariant(
        prior === undefined || prior === value,
        'EVIDENCE_CHANGED',
        'Capsule replay receipt changed.',
      );
      merged.set(event, value);
    }
    const entries = [...merged];
    const text = canonicalPayload({ ...data, entries });
    if (!data.branch && new TextEncoder().encode(text).length <= 64 * 1024) {
      if (row) await ctx.db.patch(row._id, { value: text });
      else
        await ctx.db.insert('projectFinishReadRows', {
          kind: capsuleOwnerKind,
          sourceId,
          projectId,
          value: text,
        });
      return;
    }
    invariant(depth < 64, 'EVIDENCE_CHANGED', 'Capsule receipt hashes cannot separate these identities.');
    const groups = new Map<string, Array<[string, string]>>();
    for (const entry of entries) {
      const part = digest(entry[0])[depth]!;
      if (!groups.has(part)) groups.set(part, []);
      groups.get(part)!.push(entry);
    }
    for (const [part, selected] of groups) await store(suffix + ':' + part, selected, depth + 1);
    const { entries: _entries, ...metadata } = data;
    void _entries;
    const value = canonicalPayload({ ...metadata, branch: true });
    if (row) await ctx.db.patch(row._id, { value });
    else await ctx.db.insert('projectFinishReadRows', { kind: capsuleOwnerKind, sourceId, projectId, value });
  }
  await store('', values, 0);
}

export async function capsuleExpiryScope(
  ctx: Ctx,
  input: {
    projectId: Id<'hostedProjects'>;
    runId?: string;
    jobId?: string;
  },
) {
  if (input.runId) return `check:${input.runId}`;
  if (!input.jobId) return null;
  const row = await ctx.db
    .query('projectHostedComposes')
    .withIndex('by_project_and_job', q => q.eq('projectId', input.projectId).eq('jobId', input.jobId!))
    .unique();
  return row ? `compose:${row.actor}:${row.operationId}` : null;
}
export function readCapsuleExpiry(value: string, request: string) {
  const [requestHash, result] = JSON.parse(value) as [string, string];
  invariant(requestHash === digest(request), 'WORK_OPERATION_CHANGED', 'Retry the original expiry page.');
  return JSON.parse(result);
}
