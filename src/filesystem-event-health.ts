// SPDX-License-Identifier: Apache-2.0
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { lstatSync, readdirSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { childEnv } from '../scripts/child-env.mjs';
import { EVENT_PROBE_PREFIX } from './forge-cache-paths.js';
import { clientCacheRoot } from './root-paths.js';

export const filesystemHealthSchema = z.object({
  ok: z.boolean(),
  latencyMs: z.number().nullable(),
  fseventsdRssMb: z.number().nullable(),
  fseventsdCpuPercent: z.number().nullable(),
  reason: z.string().nullable(),
  attempts: z.array(z.object({ latencyMs: z.number().nullable(), reason: z.string().nullable() })),
});
export type FilesystemHealth = z.infer<typeof filesystemHealthSchema>;

const STALE_PROBE_MS = 60_000;
/** Remove what probes left behind: this run's own folder, other runs' folders older than any probe
 * can live (a killed caller), and `.forge-event-probe-*` folders older clients left inside the
 * checkout. A live concurrent probe's folder is never touched. Never anything else. */
export function clearEventProbes(root: string, own: string, now = Date.now()) {
  const probes = join(clientCacheRoot(root), 'event-probe');
  for (const [directory, owned] of [
    [probes, (name: string) => name === own || /^[0-9a-f-]{36}$/.test(name)],
    [join(root, '.forge'), (name: string) => name.startsWith(EVENT_PROBE_PREFIX)],
  ] as const)
    try {
      for (const name of readdirSync(directory)) {
        if (!owned(name)) continue;
        const path = join(directory, name);
        if (name === own || now - lstatSync(path).mtimeMs > STALE_PROBE_MS)
          rmSync(path, { recursive: true, force: true });
      }
    } catch {
      /* Nothing there, or not readable: nothing of ours to remove. */
    }
}

/** Installed diagnostic code only; native open and close remain outside this process.
 * Three existing 2 s attempt envelopes plus the 500 ms stats request; the outer bound sits above
 * that budget so a slow probe finishes its own cleanup, and a probe killed anyway is cleared after. */
export function filesystemEventHealth(root: string, execute = spawnSync): FilesystemHealth {
  const id = randomUUID();
  let result: { stdout?: unknown; error?: Error | undefined; signal?: unknown; status?: unknown };
  try {
    result = execute(
      process.execPath,
      [
        fileURLToPath(new URL('../scripts/filesystem-event-health.mjs', import.meta.url)),
        root,
        '--watcher-close-health',
        '--private-root',
        `--probe-id=${id}`,
      ],
      { env: childEnv(), encoding: 'utf8', timeout: 9000, killSignal: 'SIGKILL', maxBuffer: 16384 },
    );
  } finally {
    clearEventProbes(root, id);
  }
  try {
    return filesystemHealthSchema.parse(JSON.parse(String(result.stdout)));
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
