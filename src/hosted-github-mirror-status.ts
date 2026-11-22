// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';
export const mirrorPushMode = z.enum(['automatic', 'every-landing', 'batch-quick-landings']);
export const mirrorCadencePolicy = z
  .object({
    push: mirrorPushMode.optional(),
    pushNowPaths: z.array(z.string().min(1)).optional(),
  })
  .strict();
export const mirrorStatusesPermission =
  'GitHub App repository permission Commit statuses: Write (statuses:write).';
const minute = 60_000;
export const mirrorRedHoldMs = 15 * minute;
export const mirrorCheckSamples = 20;
const mirrorMaxWindowMs = 10 * minute;

export const mirrorCadenceSchema = z.object({
  value: mirrorPushMode,
  medianFullCheckMs: z.number().nullable(),
  samples: z.number(),
  windowMs: z.number(),
  boundsMs: z.tuple([z.number(), z.number()]),
  maxHoldMs: z.number(),
  pushNowPaths: z.array(z.string()),
  reason: z.string(),
});

type MirrorPolicy = { push?: z.infer<typeof mirrorPushMode>; pushNowPaths?: string[] };

export function mirrorCadence(policy: MirrorPolicy, durations: readonly number[]) {
  const value = policy.push ?? 'automatic';
  const ordered = [...durations].sort((a, b) => a - b);
  const middle = Math.floor(ordered.length / 2);
  const medianFullCheckMs = !ordered.length
    ? null
    : ordered.length % 2
      ? ordered[middle]!
      : (ordered[middle - 1]! + ordered[middle]!) / 2;
  const boundsMs: [number, number] = [minute, mirrorMaxWindowMs];
  const windowMs =
    value === 'every-landing' || medianFullCheckMs === null
      ? 0
      : Math.round(Math.max(boundsMs[0], Math.min(boundsMs[1], medianFullCheckMs)));
  const reason =
    value === 'every-landing'
      ? 'Every landing was selected.'
      : medianFullCheckMs === null
        ? 'The mirror pushes every landing until a full check reports its wall time.'
        : `${value === 'automatic' ? 'Automatic' : 'Batch quick landings'} batches within ${windowMs / 1000}s of the last push, from a ${medianFullCheckMs / 1000}s median across ${ordered.length} full checks.`;
  return {
    value,
    medianFullCheckMs,
    samples: ordered.length,
    windowMs,
    boundsMs,
    maxHoldMs: mirrorRedHoldMs,
    pushNowPaths: policy.pushNowPaths ?? [],
    reason,
  };
}

export function mirrorDeadline(input: {
  firstAt: number;
  lastPushAt?: number;
  windowMs: number;
  red: boolean;
  revert: boolean;
  flushPaths: boolean;
}) {
  if (input.revert) return input.firstAt;
  const cap = input.firstAt + mirrorRedHoldMs;
  if (input.red) return cap;
  if (input.flushPaths || input.lastPushAt === undefined || input.windowMs === 0) return input.firstAt;
  return Math.max(
    input.firstAt,
    Math.min(cap, input.firstAt + input.windowMs, input.lastPushAt + input.windowMs),
  );
}

export const mirrorHeldSchema = z.object({ count: z.number(), until: z.number(), red: z.boolean() });
export const hostedMirrorStatusSchema = z.object({
  repository: z.string(),
  status: z.enum(['synced', 'syncing', 'retrying', 'failed', 'disabled', 'unknown']),
  targetHead: z.string().nullable(),
  mirroredHead: z.string().nullable(),
  gitHead: z.string().nullable(),
  lagging: z.boolean().nullable(),
  pendingSince: z.number().nullable(),
  mirroredAt: z.number().nullable(),
  failures: z.number(),
  /** Attempt budget of the current retry policy while retrying (absent from older servers). */
  attemptLimit: z.number().nullable().optional(),
  nextAttemptAt: z.number().nullable(),
  error: z.string().nullable(),
  detail: z.string().nullable(),
  jobId: z.string().nullable(),
  push: mirrorCadenceSchema.optional(),
  held: mirrorHeldSchema.optional(),
  verifyError: z.string().optional(),
  /** Failed publish jobs that are not the active job (a retargeted mirror's stranded publishes;
   * absent from older servers). */
  failedJobs: z.number().optional(),
  /** Item c63c2171: the GitHub commit the owner chose to bring in failed to land; GitHub's main keeps it. */
  kept: z.literal(true).optional(),
  /** The one action that clears a stopped mirror (absent from older servers). */
  nextStep: z.string().nullable().optional(),
});
export type HostedMirrorStatus = z.infer<typeof hostedMirrorStatusSchema>;

/** Errors the owner clears with `nforge github resume`; the text names why it helps. */
const resumeSteps: Record<string, string> = {
  GITHUB_VERIFY_POST_FAILED:
    'the project owner runs nforge github resume PROJECT to post forge/verify again (pushing the pull request branch again also checks the new head); the merge stays blocked until then',
  GITHUB_SYNC_BINDING:
    'the project owner runs nforge github resume PROJECT to point the mirror at the new repository and queue current main there',
};
/** What a person or agent does about a stopped mirror, or null when nothing is needed. One place
 * for the web, the CLI and MCP (Issue 68361cd5). */
export function hostedMirrorNextStep(status: Pick<HostedMirrorStatus, 'status' | 'error'>) {
  if (status.status !== 'failed') return null;
  // The inbound landing failure already says to fix and land its Lane; resume does not apply.
  if (status.error === 'GITHUB_INBOUND_FAILED') return null;
  return (
    resumeSteps[status.error ?? ''] ??
    'fix the cause, then the project owner runs nforge github resume PROJECT (or Resume in the mirror panel); the cursor and State are kept'
  );
}

function attempts({ status, failures, attemptLimit }: HostedMirrorStatus) {
  if (!failures) return '';
  // A retrying job names its policy budget; a terminal one only what it spent.
  if (status === 'retrying') return ` · ${failures}/${attemptLimit ?? 5} failed attempts`;
  return ` · ${failures} failed attempt${failures === 1 ? '' : 's'}`;
}

/** Both clients describe the same recorded facts; elapsed time is display-only. */
export function hostedMirrorStatusText(status: HostedMirrorStatus, now: number) {
  const lag =
    status.lagging === null
      ? 'lag unknown'
      : status.lagging
        ? `behind${status.pendingSince === null ? '' : ` for ${Math.max(0, Math.floor((now - status.pendingSince) / 60_000))}m`}`
        : 'caught up';
  const hold = status.held
    ? ` · ${status.held.count} held until ${new Date(status.held.until).toISOString()}${status.held.red ? ' while main is red' : ''}`
    : '';
  const verify = status.verifyError
    ? ` · forge/verify could not post (${status.verifyError})${status.verifyError === 'GITHUB_APP_PERMISSIONS' ? ` · ${mirrorStatusesPermission}` : ''}`
    : '';
  return `GitHub mirror ${status.repository}: ${status.status} · ${lag}${hold}${attempts(status)}${status.error ? ` · ${status.error}` : ''}${status.detail ? ` · ${status.detail}` : ''}${status.nextAttemptAt === null ? '' : ` · retry at ${new Date(status.nextAttemptAt).toISOString()}`}${status.nextStep && !status.detail?.includes('nforge github resume') ? ` · Next: ${status.nextStep}` : ''}${verify}`;
}
