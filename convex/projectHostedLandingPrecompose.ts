// SPDX-License-Identifier: Apache-2.0
import { v } from 'convex/values';
import { makeFunctionReference } from 'convex/server';
import { internalMutation, type MutationCtx } from './server';
import type { Id } from './_generated/dataModel';
import { loadFinish, writeFinish } from './projectHostedFinishStore';
import { reserveFinishRetry } from './projectHostedFinishCompose';
import { composeRow } from './projectHostedComposeStore';
import { acceptancePlan, acceptancePage } from './projectHostedAcceptanceStore';
import { landingQueue } from './projectHostedLandingStore';
import { hostedLandingStateSchema } from '../src/hosted-landing';
import { hostedStartMain } from './projectHostedChannels';
import { readHostedRecord } from './projectHostedRecords';
import { ForgeError } from '../src/errors';
import { hostedRecordSchema } from '../src/hosted-records';
import { canonicalPayload } from '../src/hosted-source-operation';

/** A finite background optimization window, never an admission restriction.
 * One main transition examines at most 50 queued submissions in two paged
 * passes and starts at most 50
 * source jobs through the existing bounded worker. No client reads drive it. */
export const PRECOMPOSE_ENTRIES = 50;
export const PRECOMPOSE_PAGE = 10;
type TriggerCandidate = { id: string; actor: string; digest: string };
export async function scheduleLandingPrecompose(
  ctx: MutationCtx,
  input: {
    projectId: Id<'hostedProjects'>;
    receiptIds: string[];
    paths?: string[];
    candidate?: TriggerCandidate;
  },
) {
  const [waiting] = await ctx.db
    .query('projectHostedLandingRequests')
    .withIndex('by_project_and_channel_and_phase_and_sequence', q =>
      q.eq('projectId', input.projectId).eq('channel', 'main').eq('phase', 'queued'),
    )
    .take(1);
  if (!waiting) return;
  await ctx.scheduler.runAfter(
    0,
    makeFunctionReference<'mutation'>('projectHostedLandingPrecompose:start'),
    input,
  );
}
export const start = internalMutation({
  args: {
    projectId: v.id('hostedProjects'),
    receiptIds: v.array(v.string()),
    after: v.optional(v.number()),
    remaining: v.optional(v.number()),
    paths: v.optional(v.array(v.string())),
    candidate: v.optional(v.object({ id: v.string(), actor: v.string(), digest: v.string() })),
    cleanPass: v.optional(v.boolean()),
    peerLanes: v.optional(v.array(v.string())),
    hasCleanCandidate: v.optional(v.boolean()),
    peerMainReceiptId: v.optional(v.string()),
  },
  returns: v.number(),
  handler: (ctx, input) => precomposeWaiting(ctx, input),
});
export async function precomposeWaiting(
  ctx: MutationCtx,
  input: {
    projectId: Id<'hostedProjects'>;
    receiptIds: string[];
    after?: number;
    remaining?: number;
    paths?: string[];
    candidate?: TriggerCandidate;
    cleanPass?: boolean;
    peerLanes?: string[];
    hasCleanCandidate?: boolean;
    peerMainReceiptId?: string;
  },
) {
  const main = await hostedStartMain(ctx, input.projectId);
  // A delayed event still carries real overlap information. Keep its paths and
  // peers, but pin a new job to actual current main: a newer disjoint landing
  // must not erase the earlier conflict before its event gets CPU time.
  const queue = await landingQueue(ctx, { projectId: input.projectId, channel: 'main' });
  const peerLanes = new Set(input.peerLanes ?? []);
  const receipts = new Set(input.peerLanes ? [] : input.receiptIds);
  if (input.peerMainReceiptId !== main.receipt.id) receipts.add(main.receipt.id);
  for (const receiptId of receipts) {
    const identity = { projectId: input.projectId, receiptId };
    const plan = await acceptancePlan(ctx, identity);
    // The accepted inclusion ledger is immutable. Read its exact input pages,
    // not a first-page sample that could omit the actual peer Lane. Only IDs
    // survive this scoped traversal; later queue windows reuse them.
    for (let index = 0; index < (plan?.inputPages ?? 0); index++) {
      const page = await acceptancePage(ctx, { ...identity, kind: 'inputs', index });
      if (page)
        for (const entry of (JSON.parse(page.value) as { entries: { laneId: string }[] }).entries)
          peerLanes.add(entry.laneId);
    }
  }
  const rows = await ctx.db
    .query('projectHostedLandingRequests')
    .withIndex('by_project_and_channel_and_phase_and_sequence', q =>
      q
        .eq('projectId', input.projectId)
        .eq('channel', 'main')
        .eq('phase', 'queued')
        .gt('sequence', input.after ?? 0),
    )
    .take(PRECOMPOSE_PAGE);
  let paths = input.paths;
  if (!paths && input.candidate) {
    const record = await readHostedRecord(ctx, {
      projectId: input.projectId,
      actor: input.candidate.actor,
      kind: 'candidate',
      key: input.candidate.id,
    }).catch(error => {
      if (
        error instanceof ForgeError &&
        ['PROJECT_UNAVAILABLE', 'SOURCE_UNAVAILABLE', 'NOT_FOUND'].includes(error.code)
      )
        return null;
      throw error;
    });
    // A missing/revoked/changed advisory pin means unknown coverage, never
    // permission to skip a possible conflict. Actual source pins do not change.
    if (record?.digest === input.candidate.digest)
      paths = hostedRecordSchema.options[3].parse(JSON.parse(record.value)).governance?.paths;
  }
  const changed = paths ? new Set(paths) : null;
  const prefixes = new Set<string>();
  for (const path of changed ?? []) {
    for (let end = path.indexOf('/'); end !== -1; end = path.indexOf('/', end + 1))
      prefixes.add(path.slice(0, end));
  }
  const touches = (path: string) => {
    if (changed?.has(path) || prefixes.has(path)) return true;
    for (let end = path.indexOf('/'); end !== -1; end = path.indexOf('/', end + 1))
      if (changed?.has(path.slice(0, end))) return true;
    return false;
  };
  let started = 0;
  let hasCleanCandidate = input.hasCleanCandidate ?? false;
  for (const row of rows) {
    const state = hostedLandingStateSchema.parse(JSON.parse(row.value));
    if (
      !state.request.finish ||
      (state.batchId && row.runId) ||
      queue?.lease?.submissionId === state.id ||
      state.observation.pendingReason === 'waiting-for-dependency' ||
      state.observation.pendingReason === 'waiting-for-review'
    )
      continue;
    const finish = await loadFinish(ctx, { projectId: input.projectId, submissionId: state.id });
    if (finish.value.pending) {
      const pending = finish.value.pending;
      if (pending.precompose && pending.main.receiptId === main.receipt.id) {
        const peers = [...new Set([...pending.precompose.peerLanes, ...peerLanes])];
        if (peers.length !== pending.precompose.peerLanes.length)
          await writeFinish(ctx, finish.row, {
            ...finish.value,
            pending: { ...pending, precompose: { ...pending.precompose, peerLanes: peers } },
          });
        continue;
      }
      // A main transition must not disappear behind an older in-flight probe.
      // Coalesce one latest target, without cancelling or duplicating its job.
      if (pending.precompose && pending.main.receiptId !== main.receipt.id) {
        const next = {
          main: { head: main.head, receiptId: main.receipt.id },
          peerLanes: [...new Set([...(pending.precompose.next?.peerLanes ?? []), ...peerLanes])],
        };
        if (canonicalPayload(next) !== canonicalPayload(pending.precompose.next ?? null))
          await writeFinish(ctx, finish.row, {
            ...finish.value,
            pending: { ...pending, precompose: { ...pending.precompose, next } },
          });
      }
      continue;
    }
    if (
      canonicalPayload(finish.value.precomposed?.main ?? finish.value.source.expectedMain) ===
      canonicalPayload({ head: main.head, receiptId: main.receipt.id })
    )
      continue;
    if (changed) {
      // A grouped or retried request can name a shared Candidate containing
      // other entries. Prioritize the immutable original selection's paths,
      // rather than treating those unrelated accepted paths as this Lane's.
      const selection = await composeRow(ctx, {
        projectId: input.projectId,
        actor: state.actor,
        operationId: finish.value.source.operationId,
      });
      const originalId = selection ? JSON.parse(selection.value).candidateId : state.request.candidateId;
      const original = await readHostedRecord(ctx, {
        projectId: input.projectId,
        actor: state.actor,
        kind: 'candidate',
        key: originalId,
      }).catch(error => {
        // A revoked submitter cannot read source, and must not prevent other
        // queued entries receiving their own conflict result. Its ordinary
        // controller retains authorization settlement ownership.
        if (error instanceof ForgeError && error.code === 'PROJECT_UNAVAILABLE') return null;
        throw error;
      });
      if (!original) continue;
      const candidate = original ? hostedRecordSchema.options[3].parse(JSON.parse(original.value)) : null;
      // Proven path-disjoint entries get the later clean pass. Unknown coverage
      // stays in the first pass; advice never substitutes for a source merge.
      const mayConflict = !candidate?.governance?.paths || candidate.governance.paths.some(touches);
      const canWarm = !(state.batchId || state.batchOriginId || state.batchNeedsSoloCompose || row.runId);
      if (input.cleanPass ? mayConflict : !mayConflict) {
        if (!input.cleanPass && !mayConflict && canWarm) hasCleanCandidate = true;
        continue;
      }
      // A group/fallback or independently checking entry already owns its
      // preparation. Warm only the next ordinary unchecked disjoint entry;
      // Installed shared evidence owns its source; composing groups can still
      // receive actual-main conflict probes before the shared result is consumed.
      if (input.cleanPass && !canWarm) continue;
    }
    await reserveFinishRetry(
      ctx,
      finish.row,
      finish.value,
      'CHECK_EVIDENCE_REFRESH',
      { peerLanes: [...peerLanes], paths: [], runnable: row.runnable },
      main,
    );
    started++;
    // Repeating every known-disjoint merge after every landing is quadratic
    // source work. Warm only the next clean entry; retain the full conflict
    // window for overlapping or unknown coverage.
    if (input.cleanPass) break;
  }
  if (input.cleanPass && started) return started;
  const remaining = (input.remaining ?? PRECOMPOSE_ENTRIES) - rows.length;
  if (rows.length === PRECOMPOSE_PAGE && remaining > 0)
    await ctx.scheduler.runAfter(
      0,
      makeFunctionReference<'mutation'>('projectHostedLandingPrecompose:start'),
      {
        ...input,
        after: rows.at(-1)!.sequence,
        remaining,
        peerLanes: [...peerLanes],
        hasCleanCandidate,
        peerMainReceiptId: main.receipt.id,
      },
    );
  else if (changed && !input.cleanPass && hasCleanCandidate)
    await ctx.scheduler.runAfter(
      0,
      makeFunctionReference<'mutation'>('projectHostedLandingPrecompose:start'),
      {
        projectId: input.projectId,
        receiptIds: input.receiptIds,
        ...(input.candidate ? { candidate: input.candidate } : input.paths ? { paths: input.paths } : {}),
        cleanPass: true,
        peerLanes: [...peerLanes],
        peerMainReceiptId: main.receipt.id,
      },
    );
  return started;
}
