// SPDX-License-Identifier: Apache-2.0
import { v } from 'convex/values';
import { query } from './cliServer';
import { recordCaller } from './projectHostedFrictionStore';
import { acceptanceRow } from './projectHostedAcceptanceStore';
import { loadLandingAttempt } from './projectHostedLandingStore';
import { readHostedRecord } from './projectHostedRecords';
import { hostedAcceptanceSchema } from '../src/hosted-acceptance';
import { hostedRecordSchema } from '../src/hosted-records';
import { canonicalPayload } from '../src/hosted-source-operation';
import {
  MAX_DELEGATIONS,
  applyCulprit,
  applyLanding,
  candidateLevel,
  describeTrust,
  emptyTrust,
  pathLevels,
  resolvedTrustConfig,
  type ResolvedTrust,
  type TrustState,
} from '../src/agent-trust';
import type { DecisionRecord } from '../src/decision-types';
import type { HostedCheckRun } from '../src/hosted-check';
import type { Doc, Id } from './_generated/dataModel';
import type { MutationCtx, QueryCtx } from './_generated/server';
import { invariant } from '../src/errors';
import { report } from './errors';

/** B2.6. Trust is a bounded per-(project, actor) row updated on landing and culprit events;
 * reads are one row per actor, only when the project's policy has a `trust` block. No timers:
 * decay is computed from the stored timestamps when the score is read. */
export const trustConfigOf = (project: Doc<'hostedProjects'>): ResolvedTrust | null =>
  project.autonomyPolicy?.trust ? resolvedTrustConfig(project.autonomyPolicy.trust) : null;
const trustRow = (ctx: QueryCtx | MutationCtx, projectId: Id<'hostedProjects'>, actor: string) =>
  ctx.db
    .query('projectHostedTrust')
    .withIndex('by_project_and_actor', q => q.eq('projectId', projectId).eq('actor', actor))
    .unique();
const toState = (row: Doc<'projectHostedTrust'> | null, at: string): TrustState =>
  row
    ? {
        landings: row.landings,
        firstAt: row.firstAt,
        areas: row.areas,
        applied: row.applied,
        delegations: row.delegations,
      }
    : emptyTrust(at);
async function save(
  ctx: MutationCtx,
  projectId: Id<'hostedProjects'>,
  actor: string,
  row: Doc<'projectHostedTrust'> | null,
  state: TrustState,
) {
  if (row) await ctx.db.replace(row._id, { projectId, actor, ...state });
  else await ctx.db.insert('projectHostedTrust', { projectId, actor, ...state });
}
/** Called once per accepted landing, inside the publishing transaction. */
export async function noteTrustLanding(
  ctx: MutationCtx,
  input: {
    project: Doc<'hostedProjects'>;
    actor: string;
    receiptId: string;
    at: string;
    paths: string[] | null;
    run: HostedCheckRun | null;
  },
) {
  const config = trustConfigOf(input.project);
  if (!config || input.run?.status === 'failed') return;
  const row = await trustRow(ctx, input.project._id, input.actor);
  const gate = input.run?.gate;
  const state = applyLanding(toState(row, input.at), config, {
    id: `landing:${input.receiptId}`,
    paths: input.paths,
    contractTests: gate?.effective === 'contract' ? (gate.tests?.length ?? 0) : 0,
    at: input.at,
  });
  await save(ctx, input.project._id, input.actor, row, state);
}
/** Called when a culprit finding names an accepted receipt: lowers trust on that landing's areas only. */
export async function noteTrustCulprit(ctx: MutationCtx, project: Doc<'hostedProjects'>, receiptId: string) {
  const config = trustConfigOf(project);
  if (!config) return;
  const accepted = await acceptanceRow(ctx, { projectId: project._id, receiptId });
  if (!accepted) return;
  const receipt = hostedAcceptanceSchema.parse(JSON.parse(accepted.value));
  const attempt = await loadLandingAttempt(ctx, { projectId: project._id, attemptId: receipt.attemptId });
  const candidate = await readHostedRecord(ctx, {
    projectId: project._id,
    actor: project.owner,
    kind: 'candidate',
    key: receipt.candidate.id,
  });
  const parsed = candidate ? hostedRecordSchema.parse(JSON.parse(candidate.value)) : null;
  const paths = parsed?.kind === 'candidate' ? (parsed.governance?.paths ?? null) : null;
  const at = new Date().toISOString();
  const row = await trustRow(ctx, project._id, attempt.actor.id);
  if (!row) return;
  await save(
    ctx,
    project._id,
    attempt.actor.id,
    row,
    applyCulprit(toState(row, at), config, { id: `culprit:${receiptId}`, paths, at }),
  );
}
/** A delegation or its revocation is the decision record itself; this only materialises it for the gate. */
export async function applyTrustDelegation(
  ctx: MutationCtx,
  projectId: Id<'hostedProjects'>,
  record: DecisionRecord,
) {
  if (!record.delegation && !record.supersedes) return;
  const at = record.at;
  if (record.supersedes) {
    const prior = await ctx.db
      .query('projectHostedDecisions')
      .withIndex('by_project_and_id', q => q.eq('projectId', projectId).eq('id', record.supersedes!))
      .unique();
    const old = prior ? (JSON.parse(prior.value) as DecisionRecord).delegation : undefined;
    if (old) {
      const row = await trustRow(ctx, projectId, old.actor);
      if (row)
        await save(ctx, projectId, old.actor, row, {
          ...toState(row, at),
          delegations: row.delegations.filter(d => d.decisionId !== record.supersedes),
        });
    }
  }
  const delegation = record.delegation;
  if (!delegation) return;
  const row = await trustRow(ctx, projectId, delegation.actor);
  const state = toState(row, at);
  invariant(
    state.delegations.length < MAX_DELEGATIONS,
    'BAD_ARGUMENT',
    'This actor has too many delegations; supersede one first.',
  );
  await save(ctx, projectId, delegation.actor, row, {
    ...state,
    delegations: [
      ...state.delegations.filter(d => d.decisionId !== record.id),
      {
        decisionId: record.id,
        patterns: delegation.paths,
        level: delegation.level,
        ...(delegation.until ? { until: delegation.until } : {}),
      },
    ],
  });
}
/** Gate reader: zero reads unless `trust.enabled`; one row per distinct actor, cached per call site. */
export function trustGateReader(ctx: QueryCtx | MutationCtx, project: Doc<'hostedProjects'>) {
  const config = trustConfigOf(project);
  if (!config?.enabled) return async () => null;
  const rows = new Map<string, Promise<Doc<'projectHostedTrust'> | null>>();
  return async (actor: string, paths: string[] | null) => {
    if (!rows.has(actor)) rows.set(actor, trustRow(ctx, project._id, actor));
    const now = Date.now();
    return candidateLevel(
      toState(await rows.get(actor)!, new Date(now).toISOString()),
      config,
      actor,
      paths,
      now,
    );
  };
}
/** Brief text for the caller's own trust, or empty when the project has no trust policy. */
export async function trustBrief(
  ctx: QueryCtx,
  project: Doc<'hostedProjects'>,
  actor: string,
  paths: string[],
) {
  const config = trustConfigOf(project);
  if (!config) return '';
  const now = Date.now();
  const state = toState(await trustRow(ctx, project._id, actor), new Date(now).toISOString());
  const scope = paths.length ? ` This work: ${candidateLevel(state, config, actor, paths, now).reason}.` : '';
  return describeTrust(state, config, actor, now) + scope;
}
/** Effective level of the caller for given paths (an Intent's changed paths), for Intent pages and briefs. */
export const effective = query({
  args: { projectId: v.id('hostedProjects'), paths: v.optional(v.array(v.string())) },
  returns: v.string(),
  handler: async (ctx, { projectId, paths }) => {
    try {
      const { actor, project } = await recordCaller(ctx, projectId);
      const config = trustConfigOf(project);
      if (!config) return canonicalPayload({ trust: 'off' });
      const now = Date.now();
      const state = toState(await trustRow(ctx, projectId, actor), new Date(now).toISOString());
      return canonicalPayload({
        trust: config.enabled ? 'enforced' : 'recording',
        summary: describeTrust(state, config, actor, now),
        ...(paths ? { paths: pathLevels(state, config, actor, paths.slice(0, 200), now) } : {}),
      });
    } catch (error) {
      return report(error);
    }
  },
});
