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
});
export type HostedMirrorStatus = z.infer<typeof hostedMirrorStatusSchema>;

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
  return `GitHub mirror ${status.repository}: ${status.status} · ${lag}${attempts(status)}${status.error ? ` · ${status.error}` : ''}${status.detail ? ` · ${status.detail}` : ''}${status.nextAttemptAt === null ? '' : ` · retry at ${new Date(status.nextAttemptAt).toISOString()}`}`;
}
