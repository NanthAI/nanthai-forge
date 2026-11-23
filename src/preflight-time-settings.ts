// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { z } from 'zod';
import { declaredPreflight } from './project-config.js';

export const PREFLIGHT_LOCAL_BUDGET_SECONDS = 180;
/** Default for every local test phase, including package commands, finish and retry. */
export const PREFLIGHT_RUN_CEILING_SECONDS = 600;

const choiceSchema = z.object({
  seconds: z.number().nonnegative(),
  source: z.enum(['project', 'run', 'default', 'quick']),
  reason: z.string(),
});
export const preflightTimeSettingsSchema = z.object({
  budget: choiceSchema,
  ceiling: choiceSchema,
});
export type PreflightTimeSettings = z.infer<typeof preflightTimeSettingsSchema>;

function projectSeconds(
  key: 'budgetSeconds' | 'ceilingSeconds',
  options: { packageJson: string | undefined; forgeJson: string | undefined },
  acceptsZero: boolean,
) {
  try {
    const setting = declaredPreflight(key, options.packageJson, options.forgeJson);
    if (
      setting &&
      typeof setting.value === 'number' &&
      Number.isFinite(setting.value) &&
      (setting.value > 0 || (acceptsZero && setting.value === 0))
    )
      return { seconds: setting.value, source: 'project' as const, reason: `Set in ${setting.label}.` };
  } catch {
    // Timing hints do not make a previously usable project plan unavailable.
  }
  return undefined;
}

/** Project and per-run overrides. The experiment keeps the existing planner and reply shape
 * unless explicitly enabled. Package plans consume only the ceiling. */
export function preflightTimeSettings(
  config: { packageJson: string | undefined; forgeJson: string | undefined },
  runBudget: number | undefined,
): PreflightTimeSettings | undefined {
  if (process.env.FORGE_PREFLIGHT_TIME_SETTINGS !== '1') return undefined;
  const projectBudget = projectSeconds('budgetSeconds', config, true) ?? {
    seconds: PREFLIGHT_LOCAL_BUDGET_SECONDS,
    source: 'default' as const,
    reason: 'Uses the default budget.',
  };
  const projectCeiling = projectSeconds('ceilingSeconds', config, false) ?? {
    seconds: PREFLIGHT_RUN_CEILING_SECONDS,
    source: 'default' as const,
    reason: 'Uses the default ceiling.',
  };
  return {
    budget:
      runBudget === undefined
        ? projectBudget
        : { seconds: runBudget, source: 'run', reason: 'This run passed budgetSeconds.' },
    ceiling:
      runBudget !== undefined && runBudget > projectCeiling.seconds
        ? { seconds: runBudget, source: 'run', reason: 'This run passed a budgetSeconds above the ceiling.' }
        : projectCeiling,
  };
}
