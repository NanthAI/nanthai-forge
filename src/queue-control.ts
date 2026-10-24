// SPDX-License-Identifier: Apache-2.0
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  queueEntries,
  compareTickets,
  cancelTickets,
  checkQueueDirectory,
  operationTickets,
} from './check-queue.js';
import { workLocked } from './work-lock.js';
import { invariant } from './errors.js';

/** Ticket markers are idempotent and scoped to immutable process/ticket identities. */
export function controlQueue(
  action: 'list' | 'cancel' | 'prioritize',
  operation?: string,
  directory = checkQueueDirectory(),
) {
  const entries = queueEntries(directory).sort(compareTickets);
  if (action === 'list') {
    const grouped = new Map<string, (typeof entries)[number]>();
    for (const item of entries) {
      const key = item.ticket?.operationId ?? item.ticket?.runId ?? item.path;
      const prior = grouped.get(key);
      if (!prior || prior.ticket?.control) grouped.set(key, item);
    }
    return [...grouped.values()].sort(compareTickets).map((item, index) => ({
      position: index + 1,
      operation: item.ticket?.operationId ?? item.ticket?.runId,
      lane: item.ticket?.laneId,
      runId: item.ticket?.runId,
      phase: item.ticket?.phase ?? 'choosing',
      ageMs: item.ticket?.createdAt === undefined ? null : Date.now() - item.ticket.createdAt,
      holder: { pid: item.pid, actor: item.ticket?.actor },
      priority: item.ticket?.priority,
    }));
  }
  invariant(operation, 'BAD_ARGUMENT', 'Queue mutation requires an operation id.');
  const selected = operationTickets(operation, directory);
  if (action === 'cancel') return { operation, cancelled: cancelTickets(operation, directory) };
  return workLocked(join(directory, 'admission.lock'), () => {
    const first =
      Math.min(
        0,
        ...entries.map(item => {
          try {
            return Number(readFileSync(join(item.path, 'priority'), 'utf8')) || 0;
          } catch {
            return 0;
          }
        }),
      ) - 1;
    for (const item of selected) {
      try {
        writeFileSync(join(item.path, 'priority'), String(first), { mode: 0o600 });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
    return { operation, prioritized: selected.length };
  });
}
export function queueCli(args: string[]) {
  const [action, operation] = args;
  invariant(
    (action === 'list' && args.length === 1) ||
      ((action === 'cancel' || action === 'prioritize') && args.length === 2),
    'BAD_ARGUMENT',
    'Use queue list | cancel OPERATION | prioritize OPERATION.',
  );
  return controlQueue(action as 'list' | 'cancel' | 'prioritize', operation);
}
