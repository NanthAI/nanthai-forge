// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';
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
  /** Failed publish jobs that are not the active job (a retargeted mirror's stranded publishes;
   * absent from older servers). */
  failedJobs: z.number().optional(),
  /** The one action that clears a stopped mirror (absent from older servers). */
  nextStep: z.string().nullable().optional(),
});
export type HostedMirrorStatus = z.infer<typeof hostedMirrorStatusSchema>;

/** Errors the owner clears with `nforge github resume`; the text names why it helps. */
const resumeSteps: Record<string, string> = {
  GITHUB_VERIFY_POST_FAILED:
    'the project owner runs nforge github resume PROJECT to post forge/verify again (pushing the pull request branch again also checks the new head); the merge stays blocked until then',
  GITHUB_SYNC_BINDING:
    'the project owner runs nforge github resume PROJECT to point the mirror at the new repository; the next landing then publishes Forge main there',
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
  return `GitHub mirror ${status.repository}: ${status.status} · ${lag}${attempts(status)}${status.error ? ` · ${status.error}` : ''}${status.detail ? ` · ${status.detail}` : ''}${status.nextAttemptAt === null ? '' : ` · retry at ${new Date(status.nextAttemptAt).toISOString()}`}${status.nextStep && !status.detail?.includes('nforge github resume') ? ` · Next: ${status.nextStep}` : ''}`;
}
