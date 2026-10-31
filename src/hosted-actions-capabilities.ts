// SPDX-License-Identifier: Apache-2.0
import type { z } from 'zod';
import type { directCommandSchema } from './hosted-actions-direct.js';
import { invariant } from './errors.js';
export const actionsPreflightCapability = 'session.preflight';
/** The result call carries the log bytes; the server stores them, so a job skips
 * its separate output call and the result's session read. */
export const actionsInlineLogCapability = 'results.inlineLog';
/** Advertise only implemented extensions. Absent advertisement means the oldest protocol. */
export const hostedActionsCapabilities = [
  'results.testFiles',
  'results.testFiles.truncated',
  'results.execution',
  'session.timingHistory',
  'sourcePack',
  actionsPreflightCapability,
  actionsInlineLogCapability,
] as const;
/** Convex function calls per Actions job: preflight query, then either output
 * (action + mutation) and result (action + session + result mutations), or one
 * result action with its output and result mutations. */
export const actionsJobCalls = (capabilities: readonly string[]) =>
  capabilities.includes(actionsInlineLogCapability) ? 4 : 6;
export const actionsCapabilityFields: Readonly<Record<string, string>> = {
  'session.timings': 'session.timingHistory',
  'result.result.testFiles': 'results.testFiles',
  'result.result.testFiles.truncated': 'results.testFiles.truncated',
  'result.result.execution': 'results.execution',
  'result.logBytes': actionsInlineLogCapability,
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
    if (!value || typeof value !== 'object' || !key || !(key in value)) return value;
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
export const actionsRefusalReasons = ['validation', 'authorization', 'storage', 'cancelled'] as const;
