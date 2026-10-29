// SPDX-License-Identifier: Apache-2.0
import type { z } from 'zod';
import type { directCommandSchema } from './hosted-actions-direct.js';
import { invariant } from './errors.js';
/** Advertise only implemented extensions. Absent advertisement means the oldest protocol. */
export const hostedActionsCapabilities = [
  'results.testFiles',
  'session.timingHistory',
  'sourcePack',
] as const;
export const actionsCapabilityFields: Readonly<Record<string, string>> = {
  'session.timings': 'session.timingHistory',
  'result.result.testFiles': 'results.testFiles',
};
/** Whole-command extensions gate every nested runner-sent field. */
export const actionsCapabilityCommands: Readonly<Record<string, string>> = { sourcePack: 'sourcePack' };
export function actionsCommandForCapabilities(
  command: z.infer<typeof directCommandSchema>,
  capabilities: readonly string[],
) {
  const required = actionsCapabilityCommands[command.kind];
  invariant(
    !required || capabilities.includes(required),
    'RUNNER_UNAVAILABLE',
    'Actions command capability unavailable.',
  );
  let result = command as Record<string, unknown>;
  const omit = (value: Record<string, unknown>, path: string[]): Record<string, unknown> => {
    const [key, ...rest] = path;
    if (!key || !(key in value)) return value;
    const copy = { ...value };
    if (!rest.length) delete copy[key];
    else copy[key] = omit(value[key] as Record<string, unknown>, rest);
    return copy;
  };
  for (const [path, capability] of Object.entries(actionsCapabilityFields)) {
    const [kind, ...fields] = path.split('.');
    if (kind === command.kind && !capabilities.includes(capability)) result = omit(result, fields);
  }
  return result;
}
export const actionsRefusalReasons = ['validation', 'authorization', 'storage'] as const;
