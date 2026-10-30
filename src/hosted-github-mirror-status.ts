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
  nextAttemptAt: z.number().nullable(),
  error: z.string().nullable(),
  detail: z.string().nullable(),
  jobId: z.string().nullable(),
});
export type HostedMirrorStatus = z.infer<typeof hostedMirrorStatusSchema>;

/** Both clients describe the same recorded facts; elapsed time is display-only. */
export function hostedMirrorStatusText(status: HostedMirrorStatus, now: number) {
  const lag =
    status.lagging === null
      ? 'lag unknown'
      : status.lagging
        ? `behind${status.pendingSince === null ? '' : ` for ${Math.max(0, Math.floor((now - status.pendingSince) / 60_000))}m`}`
        : 'caught up';
  return `GitHub mirror ${status.repository}: ${status.status} · ${lag}${status.failures ? ` · ${status.failures}/5 failed attempts` : ''}${status.error ? ` · ${status.error}` : ''}${status.detail ? ` · ${status.detail}` : ''}${status.nextAttemptAt === null ? '' : ` · retry at ${new Date(status.nextAttemptAt).toISOString()}`}`;
}
