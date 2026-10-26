import { snapshotMetricWeek } from './self-metrics-weekly.js';
// SPDX-License-Identifier: Apache-2.0
import { AsyncLocalStorage } from 'node:async_hooks';
import { appendFileSync, readFileSync, openSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ForgeError } from './errors.js';
import { workActorSchema, type WorkActor } from './work-actor.js';
import type { DiskSample } from './self-metrics-disk.js';
import type { MetricObservation } from './self-metrics-observations.js';
import { sampleSelfMetricDisk } from './self-metrics-disk.js';
import { recordLifecycleOverlap } from './self-metrics-overlap.js';
import { READ_ONLY_ACTIONS } from './agent-read-actions.js';

export type Requester = {
  action: string;
  operationId: string;
  actor: WorkActor | { kind: 'system'; name: string };
  origin: 'command' | 'system';
  savedHead?: { laneId: string; head: string };
};
export type SelfMetricReceipt = Requester & {
  schema: 1;
  kind: 'lifecycle' | 'mutation' | 'observation';
  observation?: MetricObservation;
  disk?: DiskSample;
  at: string;
  errorCode?: string;
  errorCodes?: string[];
  revision?: number;
  deliveries?: { entryId: string; state: 'landed' | 'terminal-failed' }[];
  noOwner?: boolean;
  checkRequests?: { id: string; runId: string; reused: boolean; reuseKey?: string }[];
};
const request = new AsyncLocalStorage<Requester>();
const writers = new WeakMap<Requester, Map<string, number>>();
const closed = new WeakSet<Requester>();
function closeRequest(identity: Requester) {
  closed.add(identity);
  for (const fd of writers.get(identity)?.values() ?? []) {
    try {
      closeSync(fd);
    } catch {
      /* The saved action outcome is already committed. */
    }
  }
  writers.delete(identity);
}
/** Scratch benchmark only; production callers leave recording enabled. */
export const selfMetricsTestHooks = { disabled: false };
const lifecycle = new Set(['start', 'checkpoint', 'sync', 'finish', 'land']);
export const selfMetricsJournalPath = (directory: string, name = 'self-metrics.jsonl') =>
  join(directory, name);

/** One O_APPEND write, no Work revision, lock, network IO or background job. */
export function appendSelfMetric(directory: string, receipt: SelfMetricReceipt, name = 'self-metrics.jsonl') {
  if (selfMetricsTestHooks.disabled) return;
  try {
    const current = request.getStore();
    let destination: string | number = selfMetricsJournalPath(directory, name);
    if (current && !closed.has(current)) {
      let handles = writers.get(current);
      if (!handles) {
        handles = new Map();
        writers.set(current, handles);
      }
      let fd = handles.get(String(destination));
      if (fd === undefined) {
        fd = openSync(destination, 'a', 0o600);
        handles.set(String(destination), fd);
      }
      destination = fd;
    }
    appendFileSync(destination, `${JSON.stringify(receipt)}\n`, { mode: 0o600 });
  } catch {
    // Never turn an already committed action into an apparent failure/retry.
    process.emitWarning('Self-metric receipt could not be recorded.', { code: 'METRIC_RECEIPT_UNAVAILABLE' });
  }
}
export function readSelfMetricJournal(directory: string, name = 'self-metrics.jsonl') {
  let bytes: string;
  try {
    bytes = readFileSync(selfMetricsJournalPath(directory, name), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
      return { receipts: [] as SelfMetricReceipt[], incompleteTrailingRecords: 0 };
    throw error;
  }
  // Only newline-terminated appends are complete. Never repair the journal on read.
  const incompleteTrailingRecords = bytes && !bytes.endsWith('\n') ? 1 : 0;
  const complete = incompleteTrailingRecords ? bytes.slice(0, bytes.lastIndexOf('\n') + 1) : bytes;
  const receipts = complete
    .split('\n')
    .filter(Boolean)
    .map(line => JSON.parse(line) as SelfMetricReceipt);
  return { receipts, incompleteTrailingRecords };
}
export function readSelfMetricReceipts(directory: string, name = 'self-metrics.jsonl'): SelfMetricReceipt[] {
  return readSelfMetricJournal(directory, name).receipts;
}
export function metricRequesterActor(actor: WorkActor) {
  const current = request.getStore();
  if (current) current.actor = actor;
}
export function metricSavedHead(laneId: string, head: string) {
  const current = request.getStore();
  if (current) current.savedHead = { laneId, head };
}
export function metricOperationId(operationId: string) {
  const current = request.getStore();
  if (current) current.operationId = operationId;
}
export function recordOwnerMutation(directory: string, revision?: number, name = 'self-metrics.jsonl') {
  if (selfMetricsTestHooks.disabled) return;
  appendSelfMetric(
    directory,
    {
      schema: 1,
      kind: 'mutation',
      at: new Date().toISOString(),
      ...(revision === undefined ? {} : { revision }),
      ...(request.getStore() ?? {
        action: 'work-write',
        operationId: randomUUID(),
        actor: { kind: 'system' as const, name: 'Forge owner' },
        origin: 'system' as const,
      }),
    },
    name,
  );
  if (name === 'self-metrics.jsonl') {
    sampleSelfMetricDisk(directory);
    snapshotMetricWeek(directory, new Date().toISOString());
  }
}
export function withMetricRequester<T>(input: unknown, actor: WorkActor, run: () => T): T {
  if (selfMetricsTestHooks.disabled || request.getStore()) return run();
  const command = input as { action?: string; operationId?: string } | null;
  const identity: Requester = {
    action: command?.action === 'save' ? 'checkpoint' : (command?.action ?? 'work'),
    operationId: command?.operationId ?? randomUUID(),
    actor,
    origin: 'command',
  };
  return request.run(identity, () => {
    try {
      const result = run();
      if (result instanceof Promise) return result.finally(() => closeRequest(identity)) as T;
      closeRequest(identity);
      return result;
    } catch (error) {
      closeRequest(identity);
      throw error;
    }
  });
}
/** Wrap only public dispatch: retries and nested Work phases keep the requester. */
export async function withLifecycleMetric<T>(
  directory: string,
  input: unknown,
  run: () => Promise<T>,
  name = 'self-metrics.jsonl',
): Promise<T> {
  if (selfMetricsTestHooks.disabled) return run();
  const command = input as { action?: string; actor?: string | WorkActor } | null;
  const action = command?.action === 'save' ? 'checkpoint' : (command?.action ?? 'work');
  if (READ_ONLY_ACTIONS.has(action) || action === 'capabilities') return run();
  // Attribution must not change validation or mask the action's original error.
  const declared = workActorSchema.safeParse(
    command?.actor && typeof command.actor === 'object'
      ? command.actor
      : {
          kind: 'agent',
          name: command?.actor ?? process.env.FORGE_AGENT_NAME ?? process.env.FORGE_ACTOR ?? 'Agent workflow',
        },
  );
  const actor: WorkActor = declared.success ? declared.data : { kind: 'agent', name: 'Agent workflow' };
  return withMetricRequester(input, actor, async () => {
    const current = request.getStore()!;
    let errorCode: string | undefined;
    let errorCodes: string[] = [];
    let deliveries: SelfMetricReceipt['deliveries'];
    let checkRequests: SelfMetricReceipt['checkRequests'];
    try {
      const response = await run();
      const result = (
        response as {
          result?: {
            submission?: { id?: string; observation?: { state?: string }; error?: { code?: string } };
            code?: string;
            error?: { code?: string };
            submissions?: { entryOperationId?: string; state?: string }[];
            entries?: { submissions?: { entryOperationId?: string; state?: string }[] }[];
          };
        }
      )?.result;
      const collect = (item: unknown): string[] => {
        if (!item || typeof item !== 'object') return [];
        const record = item as {
          code?: string;
          error?: { code?: string };
          status?: string;
          entries?: unknown[];
          run?: unknown;
          submission?: unknown;
        };
        if (['accepted', 'landed', 'already-accepted', 'passed'].includes(record.status ?? '')) return [];
        return [
          record.code,
          record.error?.code,
          ...(record.entries ?? []).flatMap(collect),
          ...collect(record.run),
          ...collect(record.submission),
        ].filter((code): code is string => typeof code === 'string');
      };
      errorCodes = [...new Set(collect(result))];
      errorCode = errorCodes[0];
      deliveries = [
        ...(result?.submissions ?? []),
        ...(result?.entries ?? []).flatMap(entry => entry.submissions ?? []),
      ].flatMap(item =>
        item.entryOperationId && (item.state === 'landed' || item.state === 'terminal-failed')
          ? [{ entryId: item.entryOperationId, state: item.state }]
          : [],
      );
      const hosted = result?.submission;
      const state = hosted?.observation?.state;
      if (hosted?.id && (state === 'landed' || state === 'terminal-failed'))
        deliveries.push({ entryId: hosted.id, state });
      const checked = result as typeof result & {
        run?: { runId?: string; reused?: boolean; reuse?: string; reuseKey?: string };
        attempts?: { run?: { runId?: string; reused?: boolean; reuse?: string; reuseKey?: string } }[];
      };
      checkRequests = (checked?.attempts?.length ? checked.attempts.map(a => a.run) : [checked?.run]).flatMap(
        (run, index) =>
          run?.runId
            ? [
                {
                  id: `${current.operationId}:${index}`,
                  runId: run.runId,
                  reused: run.reused === true || run.reuse === 'reused',
                  ...(run.reuseKey ? { reuseKey: run.reuseKey } : {}),
                },
              ]
            : [],
      );
      if (['checkpoint', 'finish', 'land'].includes(action))
        recordLifecycleOverlap(directory, input, response, current, name);
      return response;
    } catch (error) {
      errorCode = error instanceof ForgeError ? error.code : 'INTERNAL_ERROR';
      throw error;
    } finally {
      // Refusal and pre-store argument failures must preserve retained bytes.
      // They cannot establish a valid store in which to write their own receipt.
      if (
        lifecycle.has(action) &&
        !['BAD_ARGUMENT', 'WORK_UPGRADE_REQUIRED', 'INVALID_WORK_STORE', 'UNSAFE_WORK_STORE'].includes(
          errorCode ?? '',
        )
      )
        appendSelfMetric(
          directory,
          {
            ...current,
            action,
            schema: 1,
            kind: 'lifecycle',
            at: new Date().toISOString(),
            ...(errorCode ? { errorCode } : {}),
            ...(errorCodes.length > 1 ? { errorCodes } : {}),
            ...(deliveries?.length ? { deliveries } : {}),
            ...(checkRequests?.length ? { checkRequests } : {}),
          },
          name,
        );
    }
  });
}
