// SPDX-License-Identifier: Apache-2.0
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { childEnv } from '../scripts/child-env.mjs';

export const filesystemHealthSchema = z.object({
  ok: z.boolean(),
  latencyMs: z.number().nullable(),
  fseventsdRssMb: z.number().nullable(),
  fseventsdCpuPercent: z.number().nullable(),
  reason: z.string().nullable(),
  attempts: z.array(z.object({ latencyMs: z.number().nullable(), reason: z.string().nullable() })),
});
export type FilesystemHealth = z.infer<typeof filesystemHealthSchema>;

/** Installed diagnostic code only; native open and close remain outside this process.
 * Three existing 2 s attempt envelopes plus the 500 ms stats request, bounded overall. */
export function filesystemEventHealth(root: string, execute = spawnSync): FilesystemHealth {
  const result = execute(
    process.execPath,
    [
      fileURLToPath(new URL('../scripts/filesystem-event-health.mjs', import.meta.url)),
      root,
      '--watcher-close-health',
      '--private-root',
    ],
    { env: childEnv(), encoding: 'utf8', timeout: 7000, killSignal: 'SIGKILL', maxBuffer: 16384 },
  );
  try {
    return filesystemHealthSchema.parse(JSON.parse(result.stdout));
  } catch {
    return {
      ok: false,
      latencyMs: null,
      fseventsdRssMb: null,
      fseventsdCpuPercent: null,
      reason: `filesystem diagnostic unavailable (${result.error?.message ?? result.signal ?? result.status})`,
      attempts: [],
    };
  }
}

export const filesystemEnvironmentSchema = z.object({
  category: z.literal('ENVIRONMENT'),
  code: z.literal('FILESYSTEM_EVENTS_UNHEALTHY'),
  message: z.string(),
  next: z.string(),
  health: filesystemHealthSchema,
});

export function filesystemEnvironment(health: FilesystemHealth, next: string) {
  return {
    category: 'ENVIRONMENT' as const,
    code: 'FILESYSTEM_EVENTS_UNHEALTHY' as const,
    message: `Local filesystem event delivery is degraded: ${health.reason}. On macOS, check fseventsd; an operator can run sudo killall fseventsd, then rerun nforge doctor.`,
    next,
    health,
  };
}
