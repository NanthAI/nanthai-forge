// SPDX-License-Identifier: Apache-2.0
import type { QueryCtx } from './_generated/server';
import type { Id } from './_generated/dataModel';
import { recordHead, hostedRecordBody } from './projectHostedRecords';
import { hostedRecordSchema } from '../src/hosted-records';
import { findObject } from './projectObjectFind';
import { invariant } from '../src/errors';

/** Canonical Candidates do not belong to a legacy checkpoint generation. Source
 * bodies are granted separately, under current project authority, and stay in R2. */
export async function canonicalView(ctx: QueryCtx, projectId: Id<'hostedProjects'>, viewId: string) {
  // The public caller has already checked current project access for this query.
  const selected = async (kind: 'candidate' | 'intent', key: string) => {
    const head = await recordHead(ctx, projectId, kind, key);
    const row = head ? await ctx.db.get(head.recordId) : null;
    return row ? { ...row, value: await hostedRecordBody(ctx, row) } : null;
  };
  const row = await selected('candidate', viewId);
  if (!row) return null;
  const candidate = hostedRecordSchema.options[3].parse(JSON.parse(row.value));
  const intentRow = await selected('intent', candidate.intentId);
  const intent = intentRow ? hostedRecordSchema.options[0].parse(JSON.parse(intentRow.value)) : null;
  const runs = await ctx.db
    .query('projectHostedCheckRuns')
    .withIndex('by_project_and_candidate', q => q.eq('projectId', projectId).eq('candidateId', viewId))
    .order('desc')
    .take(101);
  const pins = [];
  if (candidate.result.status === 'clean' && !row.candidateFiles) {
    for (const sha256 of new Set([candidate.base.head, candidate.result.head])) {
      const object = await findObject(ctx, projectId, sha256);
      invariant(object && !object.removed, 'SOURCE_UNAVAILABLE', 'Pinned Candidate State is unavailable.');
      pins.push({ sha256, size: object.size });
    }
  }
  return {
    viewId,
    intentId: candidate.intentId,
    at: candidate.at,
    base: candidate.base.head,
    head: candidate.result.status === 'clean' ? candidate.result.head : null,
    inputs: [],
    dependencies: [],
    accepted: [],
    supersededBy: null,
    status: candidate.result.status === 'clean' ? 'ready' : 'conflict',
    sourceStatus: candidate.result.status,
    why: { intentId: candidate.intentId, outcome: intent?.outcome ?? null },
    whyIntentIds: [candidate.intentId],
    contract: null,
    semanticPlan: candidate.semanticPlan ?? null,
    semanticConflicts: [],
    provenanceAvailable: candidate.result.status === 'clean',
    files: { total: 0, items: [], nextCursor: null },
    runs: runs.slice(0, 100).map(row => {
      const run = JSON.parse(row.value);
      return {
        id: run.id,
        status: run.status,
        startedAt: run.startedAt,
        checkName: run.configuration?.definition?.name,
      };
    }),
    runsMore: runs.length > 100,
    canonicalSource: {
      protocol: 1,
      candidate,
      pins,
      ...(row.candidateFiles ? { files: row.candidateFiles } : {}),
    },
  };
}
