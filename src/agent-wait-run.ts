import { providerLogUrl } from './check-log-policy.js';
// SPDX-License-Identifier: Apache-2.0
import { pendingActionsInfra } from './github-actions-infra.js';
import { runWork } from './work-run.js';
import { ForgeError } from './errors.js';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { readSource } from './files.js';
import { processAlive } from './local-process.js';
import { receiptSchema } from './work-run-receipt.js';
import { shardLogName } from './check-shard-logs.js';
import type { WorkStore } from './work-store.js';
import type { CheckRun } from './work-types.js';

export type WaitEvent = {
  type: 'lane' | 'operation' | 'check' | 'shard' | 'notice' | 'progress' | 'submission' | 'train';
  id: string;
  status: string;
  terminal: boolean;
  ok: boolean;
  [key: string]: unknown;
};
export const activeCheck = (status: string) => ['queued', 'preparing', 'running'].includes(status);
export const infrastructure = (status: string) =>
  ['interrupted', 'runner-unavailable', 'runner-budget-exhausted'].includes(status);
export function waitJson(store: WorkStore, path: string): unknown {
  const bytes = readSource(store.directory, path, 4 * 1024 * 1024);
  if (!bytes) return undefined;
  try {
    return JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new ForgeError('INVALID_WORK_STORE', `Invalid wait observation metadata: ${path}`);
  }
}
const shardSchema = z.array(
  z.object({
    executionId: z.string(),
    index: z.number().int().nonnegative(),
    attempt: z.number().int().nonnegative(),
    exitCode: z.number().int().optional(),
    infrastructure: z.string().optional(),
  }),
);

/** Observe completion bytes and local death without recovery writes or remote adoption. */
export function waitRun(store: WorkStore, original: CheckRun): { event: WaitEvent; children: WaitEvent[] } {
  const run = structuredClone(original),
    outputId = run.reusedFrom?.runId ?? run.id,
    path = `check-${outputId}`;
  if (activeCheck(run.status)) {
    const receipt = receiptSchema.safeParse(waitJson(store, `${path}/result.json`));
    if (
      receipt.success &&
      (!['modal', 'github-actions'].includes(run.backend?.actual ?? '') ||
        receipt.data.backend?.pin === run.backend?.pin)
    )
      Object.assign(run, receipt.data);
    else if (
      run.runner.host === hostname() &&
      !['modal', 'github-actions'].includes(run.backend?.actual ?? '') &&
      !processAlive(run.runner)
    ) {
      run.status = 'interrupted';
      run.details = 'Local runner ended before a completion receipt; execution was not restarted.';
    }
  }
  const parsed = shardSchema.safeParse(waitJson(store, `${path}/modal-shard-logs.json`));
  const plan = z
    .object({ groups: z.array(z.unknown()) })
    .safeParse(waitJson(store, `${path}/modal-plan.json`));
  const children: WaitEvent[] = (parsed.success ? parsed.data : []).map(shard => ({
    type: 'shard',
    id: shard.executionId,
    runId: run.id,
    shard: shard.index,
    attempt: shard.attempt + 1,
    status: shard.infrastructure
      ? 'interrupted'
      : shard.exitCode === undefined
        ? 'running'
        : shard.exitCode === 0
          ? 'passed'
          : 'failed',
    terminal: shard.exitCode !== undefined || !!shard.infrastructure,
    ok: shard.exitCode === 0,
    failureClass: shard.infrastructure ? 'infrastructure' : shard.exitCode ? 'check' : null,
    reason: shard.infrastructure ?? null,
    providerUrl: providerLogUrl(run),
    logPath: providerLogUrl(run)
      ? null
      : join(
          store.directory,
          path,
          'shards',
          shardLogName(
            plan.success && shard.index === plan.data.groups.length ? 'static' : shard.index,
            shard.attempt + 1,
          ),
        ),
  }));
  try {
    const output = runWork(
      store,
      {
        action: 'read-check-output',
        operationId: outputId,
        stream: 'stdout',
        offset: 0,
        bytes: 65536,
        tail: 65536,
      },
      store.revision(),
    ) as { result: { text: string } };
    for (const line of output.result.text.split('\n')) {
      const match = /^\[modal (\d+)\] (.+)$/.exec(line);
      if (match)
        children.push({
          type: 'progress',
          id: `${run.id}:${match[1]}`,
          runId: run.id,
          status: 'reported',
          terminal: false,
          ok: false,
          reason: match[2],
        });
    }
  } catch (error) {
    if (!(error instanceof ForgeError && error.code === 'NOT_FOUND')) throw error;
  }
  const pendingInfra = pendingActionsInfra(run);
  const failureClass = pendingInfra
    ? null
    : infrastructure(run.status)
      ? 'infrastructure'
      : run.status === 'failed'
        ? 'check'
        : null;
  return {
    event: {
      type: 'check',
      id: run.id,
      status: pendingInfra ? 'pending-infra' : run.status,
      terminal: !pendingInfra && !activeCheck(run.status),
      ok: run.status === 'passed',
      failureClass,
      reason: run.error?.message ?? run.details,
      ...(run.reusedFrom ? { reusedFrom: run.reusedFrom } : {}),
      failureSummary: run.failureSummary ?? null,
      providerUrl: providerLogUrl(run),
      logPath: providerLogUrl(run) ? null : join(store.directory, path, 'stdout.log'),
      stderrPath: providerLogUrl(run) ? null : join(store.directory, path, 'stderr.log'),
      failingShardLogPaths: children.filter(shard => shard.terminal && !shard.ok).map(shard => shard.logPath),
      shards: {
        started: children.filter(child => child.type === 'shard').length,
        completed: children.filter(shard => shard.type === 'shard' && shard.terminal).length,
      },
    },
    children,
  };
}
