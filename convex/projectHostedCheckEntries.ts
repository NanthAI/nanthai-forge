// SPDX-License-Identifier: Apache-2.0
import type { MutationCtx } from './_generated/server';
import type { Id } from './_generated/dataModel';
import { definedCheckEntryPaths } from '../src/public-governance';
import { checkSchema } from '../src/work-types';

/** Definitions folded into the project row; the definition list endpoint pages the same rows at 100. */
const maxDefinitions = 100;
/**
 * Keep `hostedProjects.checkEntries` equal to the entry files of every check
 * definition and setup action, and `globalRiskPaths` to their declared global-risk globs. It runs only when an owner saves a definition (rare;
 * one indexed read of that project's definitions and one patch), so each landing
 * decision reads the list from the project row it already loaded: no extra read or call.
 */
export async function refreshCheckEntries(ctx: MutationCtx, projectId: Id<'hostedProjects'>) {
  const rows = await ctx.db
    .query('projectHostedCheckSettings')
    .withIndex('by_project_and_kind', q => q.eq('projectId', projectId).eq('kind', 'definition'))
    .take(maxDefinitions);
  const checks = rows.map(row => checkSchema.parse(JSON.parse(row.value)));
  const entries = definedCheckEntryPaths(checks);
  // Declared global-risk globs stay apart from the entries: they are risk for landing order, not
  // paths that need owner approval.
  const globalRiskPaths = [...new Set(checks.flatMap(check => check.globalRiskPaths ?? []))].sort();
  await ctx.db.patch(projectId, { checkEntries: entries, globalRiskPaths });
  return entries;
}
