// SPDX-License-Identifier: Apache-2.0
import type { MutationCtx, QueryCtx } from './_generated/server';
import type { LandingRow } from './projectHostedLandingStore';
import type { HostedLandingState } from '../src/hosted-landing';
import { readHostedRecord } from './projectHostedRecords';
import { hostedRecordSchema } from '../src/hosted-records';
import { ForgeError } from '../src/errors';
import { effectivePolicy } from '../src/autonomy-policy';

/** The net changed paths the compose worker signed on this entry's Candidate
 * (`governance.paths`), or null when they are not retained or unreadable: unknown
 * paths are never unrelated. One record read, only for an entry that could be overtaken. */
export async function landingChangedPaths(
  ctx: QueryCtx | MutationCtx,
  row: Pick<LandingRow, 'projectId' | 'actor'>,
  state: HostedLandingState,
) {
  try {
    const record = await readHostedRecord(ctx, {
      projectId: row.projectId,
      actor: row.actor,
      kind: 'candidate',
      key: state.request.candidateId,
    });
    if (!record) return null;
    const candidate = hostedRecordSchema.parse(JSON.parse(record.value));
    return candidate.kind === 'candidate' && candidate.governance?.paths.length
      ? candidate.governance.paths
      : null;
  } catch (error) {
    if (error instanceof ForgeError) return null;
    throw error;
  }
}

/** The overtaking side: its paths and the project's check entry files and declared
 * global-risk globs (global-risk for any runner, folded into the project row when a
 * definition is saved). Null
 * when either is unknown, so nothing is overtaken. */
export async function overtakingSide(
  ctx: QueryCtx | MutationCtx,
  row: Pick<LandingRow, 'projectId' | 'actor'>,
  state: HostedLandingState,
) {
  const project = await ctx.db.get(row.projectId);
  if (!project?.checkEntries) return null;
  const paths = await landingChangedPaths(ctx, row, state);
  const { acceptance } = effectivePolicy(project);
  return paths
    ? {
        paths,
        checkEntries: [...project.checkEntries, ...(project.globalRiskPaths ?? [])],
        // A passed check may carry across heads (the first-check proof), so an independent
        // older entry is graph-sealed (src/landing-overtake.ts sealedOlder).
        proofs: acceptance.hostedCrossHeadReuse !== false && acceptance.mode === 'auto-on-pass',
      }
    : null;
}
