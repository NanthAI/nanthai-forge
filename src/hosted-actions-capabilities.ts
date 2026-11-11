// SPDX-License-Identifier: Apache-2.0
import type { z } from 'zod';
import type { directCommandSchema } from './hosted-actions-direct.js';
import { invariant } from './errors.js';
export const actionsPreflightCapability = 'session.preflight';
/** Larger source descriptor windows, with a transaction-bounded prefix reply. */
export const actionsSourceBatchCapability = 'source.batch';
/** Trusted recipe leaves arrive in the same current-access descriptor window. */
export const actionsSourceClosureCapability = 'source.closures';
/** Neighbouring packed objects share one exact-range grant and verified download. */
export const actionsSourceRunsCapability = 'source.runs';
/** State-bound physical manifest plans and compact exact-key grant replies. */
export const actionsSourceStateCapability = 'source.state';
/** The result call carries the log bytes; the server stores them, so a job skips
 * its separate output call and the result's session read. */
export const actionsInlineLogCapability = 'results.inlineLog';
/** The plan call returns one create-only claim PUT and one HEAD per shard pool unit, and results
 * carry the files a home shard yielded to the pool (scripts/shard-pool.mjs). */
export const actionsPoolCapability = 'checks.pool';
/** The plan's recipe may pin declared toolchains and dependency cache (src/actions-toolchains.ts). */
export const actionsToolchainsCapability = 'checks.toolchains';
/** Read-only single-repository tokens for private submodules in the project's App installation. */
export const actionsSubmoduleAccessCapability = 'checks.submoduleAccess';
/** The plan call says it starts the optional source-pack job; a pass then reads the required
 * jobs' conclusions instead of waiting for the run's (friction 0064c3b2). */
export const actionsPackVerdictCapability = 'checks.packVerdict';
/** Results say where the shard ran project code (`user` or `shared`); the run and receipt keep it. */
export const actionsBatchCapability = 'results.batch';
export const actionsIsolationCapability = 'results.isolation';
/** Advertise only implemented extensions. Absent advertisement means the oldest protocol. */
export const hostedActionsCapabilities = [
  'results.testFiles',
  'results.testFiles.truncated',
  'results.execution',
  'session.timingHistory',
  'sourcePack',
  actionsSourceBatchCapability,
  actionsSourceClosureCapability,
  actionsSourceRunsCapability,
  actionsPreflightCapability,
  actionsInlineLogCapability,
  actionsPoolCapability,
  actionsToolchainsCapability,
  actionsSubmoduleAccessCapability,
  actionsPackVerdictCapability,
  actionsIsolationCapability,
  actionsBatchCapability,
  'results.packed',
] as const;
/** Batched jobs use only their existing preflight; result collection is fixed work per run.
 * Legacy Convex function calls per Actions job: preflight query, then either output
 * (action + mutation) and result (action + session + result mutations), or one
 * result action with its output and result mutations. */
export const actionsJobCalls = (capabilities: readonly string[]) =>
  capabilities.includes(actionsBatchCapability)
    ? 1
    : capabilities.includes(actionsInlineLogCapability)
      ? 4
      : 6;
export const actionsCapabilityFields: Readonly<Record<string, string>> = {
  'source.batch': actionsSourceBatchCapability,
  'source.closures': actionsSourceClosureCapability,
  'source.runs': actionsSourceRunsCapability,
  'source.bound': actionsSourceStateCapability,
  'source.state': actionsSourceStateCapability,
  'source.object': actionsSourceStateCapability,
  'source.all': actionsSourceStateCapability,
  'source.fallback': actionsSourceStateCapability,
  'session.timings': 'session.timingHistory',
  'result.result.testFiles': 'results.testFiles',
  'result.result.testFiles.truncated': 'results.testFiles.truncated',
  'result.result.execution': 'results.execution',
  'result.logBytes': actionsInlineLogCapability,
  'plan.plan.recipe.pool': actionsPoolCapability,
  'result.result.pool': actionsPoolCapability,
  'plan.plan.recipe.actions': actionsToolchainsCapability,
  'plan.resultsBatch': actionsBatchCapability,
  'plan.resultsPacked': 'results.packed',
  'plan.packRefresh': actionsPackVerdictCapability,
  'result.result.isolation': actionsIsolationCapability,
};
/** Whole-command extensions gate every nested runner-sent field. */
export const actionsCapabilityCommands: Readonly<Record<string, string>> = {
  results: actionsBatchCapability,
  sourcePack: 'sourcePack',
  submoduleAccess: actionsSubmoduleAccessCapability,
};
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
/** `limit`: the request broke a Convex value limit; it fails the same way on every retry. */
export const actionsRefusalReasons = [
  'validation',
  'authorization',
  'storage',
  'cancelled',
  'limit',
] as const;
