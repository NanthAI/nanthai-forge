// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';
import { hostedAgentCommandSchemas } from './hosted-agent-contract.js';

const keys = [
  'accept',
  'message',
  'check',
  'after',
  'priority',
  'keepOpen',
  'closes',
  'retry',
  'reason',
] as const;
export type ConflictFinishOptions = Pick<
  z.infer<typeof hostedAgentCommandSchemas.finish>,
  (typeof keys)[number]
>;
/** A resolved prefix replaces source selection, never the caller's check/accept
 * intent. Keep only operational fields; old source pins and operation IDs cannot
 * be reused for the newly resolved source. */
export function conflictFinishOptions(value: unknown): ConflictFinishOptions | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const selected = Object.fromEntries(
    keys.filter(key => Object.hasOwn(value, key)).map(key => [key, (value as Record<string, unknown>)[key]]),
  );
  const parsed = hostedAgentCommandSchemas.finish.safeParse(selected);
  if (!parsed.success) return undefined;
  return Object.fromEntries(
    keys.filter(key => Object.hasOwn(parsed.data, key)).map(key => [key, parsed.data[key]]),
  ) as ConflictFinishOptions;
}
