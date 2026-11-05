// SPDX-License-Identifier: Apache-2.0
// Pure: also runs in the Convex non-Node runtime.
import { invariant } from './errors.js';
import type { PlanningItem, PlanningWrite } from './work-planning-types.js';

export type PlanningPut = Extract<PlanningWrite, { action: 'put-planning-item' }>;

/**
 * The one place a put becomes a full item (local Work, hosted replay and the Convex projection
 * all reduce through it). A field the put omits keeps the stored value, so a status-only move
 * cannot clear a body; clearing a field needs an explicit empty value ("" / [] / null).
 * Creating needs kind and title; body, status and links default to empty/open.
 */
export function resolvePlanningPut(
  command: PlanningPut,
  current?: Pick<PlanningItem, 'kind' | 'title' | 'body' | 'status' | 'intentIds' | 'initiativeId'>,
) {
  invariant(
    current || (command.kind && command.title),
    'BAD_ARGUMENT',
    'Creating a planning item needs `kind` and `title`.',
  );
  return {
    kind: (command.kind ?? current?.kind)!,
    title: (command.title ?? current?.title)!,
    body: command.body ?? current?.body ?? '',
    status: command.status ?? current?.status ?? 'open',
    intentIds: [...new Set(command.intentIds ?? current?.intentIds ?? [])].sort(),
    initiativeId: command.initiativeId === null ? undefined : (command.initiativeId ?? current?.initiativeId),
    reason: command.reason,
  };
}
