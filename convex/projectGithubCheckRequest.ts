// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import type { MutationCtx } from './server';
import type { Id } from './_generated/dataModel';
import { checkSetting } from './projectHostedCheckStore';
import { landingCheckSelection } from './projectHostedCheckEntries';

/** The project's verify check, or its only check; null lets project policy decide. */
export async function checkRequest(ctx: MutationCtx, projectId: Id<'hostedProjects'>) {
  const rows = await ctx.db
    .query('projectHostedCheckSettings')
    .withIndex('by_project_and_kind', q => q.eq('projectId', projectId).eq('kind', 'definition'))
    .take(100);
  const checks = rows.map(row => ({ ...JSON.parse(row.value), id: row.key }));
  const id = landingCheckSelection(checks);
  const selected = checks.find(check => check.id === id);
  if (!selected) return null;
  const runner = await checkSetting(ctx, projectId, 'runner', 'runner');
  if (!runner) return null;
  const configuration = JSON.parse(runner.value);
  return {
    kind: 'request' as const,
    checkId: selected.id,
    expectedDefinition: selected.definition,
    expectedConfiguration: runner.digest,
    expectedEnvironment: configuration.environmentFingerprint,
  };
}
