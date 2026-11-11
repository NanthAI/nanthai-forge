// SPDX-License-Identifier: Apache-2.0
import { detachCheckReports, objectReportTransport } from './projectHostedCheckReports';
import { v } from 'convex/values';
import { internalMutation } from './server';
import { actionsSession, sessionArgs } from './projectHostedActionsSession';
import { storeSourceOutputs } from './projectConvexSourceOutput';
import { writeHostedCheck } from './projectHostedCheckStore';
import { hostedCheckPlanSchema, checkPin, hostedCheckTerminal, testsNotAffected } from '../src/hosted-check';
import { isStandardForgeCheck } from '../src/standard-check';
import { hostedActionsRecipeSchema, hostedActionsRuntime } from '../src/hosted-actions';
import { actionsDeclaration } from '../src/actions-toolchains';
import { savePin } from '../src/hosted-save';
import { semanticTests } from '../src/intent-semantic-conflict';
import { checkGateSchema } from '../src/bet2-gate';
import { canonicalPayload } from '../src/hosted-source-operation';
import { invariant } from '../src/errors';
import { secretAllowEvidenceSchema } from '../src/secret-allow';
import { validCommandPlan } from '../src/check-command-scope';
import { runFallback } from '../src/fallback-reasons';
import { isScopedRecheck } from '../src/scoped-recheck-policy';
export const prepare = internalMutation({
  args: {
    ...sessionArgs,
    recipe: v.string(),
    lockfile: v.string(),
    selectionStorage: v.optional(v.id('_storage')),
    selectionR2Key: v.optional(v.string()),
    recipeStorage: v.optional(v.id('_storage')),
    recipeR2Key: v.optional(v.string()),
    /** The plan starts the optional source-pack job (friction 0064c3b2). */
    packRefresh: v.optional(v.literal(true)),
    resultsBatch: v.optional(v.literal(true)),
    resultsPacked: v.optional(v.literal(true)),
  },
  // JSON text (Issue 0c457ae4): a replayed plan can return a finished run with per-file reports.
  returns: v.string(),
  handler: async (ctx, input) => {
    const { row, run } = await actionsSession(ctx, input);
    const replay = !!run.plan;
    const recipe = hostedActionsRecipeSchema.parse(JSON.parse(input.recipe)),
      { pin, ...pins } = recipe;
    const standard = isStandardForgeCheck(run.check);
    invariant(
      pin === checkPin(pins) &&
        recipe.head === run.request.expectedHead &&
        recipe.definition === run.check.definition &&
        recipe.standard === standard &&
        checkPin(recipe.command) ===
          checkPin([standard ? 'node' : run.check.executable, ...run.check.args]) &&
        // A runner that cannot set up the declared toolchains or cache never runs the check without them.
        checkPin(recipe.actions ?? null) === checkPin(actionsDeclaration(run.check) ?? null),
      'EVIDENCE_CHANGED',
      'Actions plan differs from its source, configured command or declared toolchains.',
    );
    // An opaque command is never docs-scoped unless its check declared the docs paths.
    invariant(
      standard || recipe.selection.scope !== 'docs' || run.check.docsPaths?.length,
      'EVIDENCE_CHANGED',
      'Actions plan skipped a command whose check declares no docs paths.',
    );
    const tests = recipe.groups.flat();
    invariant(
      new Set(tests).size === tests.length &&
        (standard
          ? checkPin([...tests].sort()) === checkPin([...new Set(recipe.selection.tests)].sort()) &&
            (run.gate?.mode === 'probe' ||
              semanticTests(run.semanticPlan).every(test => tests.includes(test)))
          : validCommandPlan(run, recipe)),
      'EVIDENCE_CHANGED',
      'Actions shard membership differs from the complete selection.',
    );
    // Gate tests a configured command must run are handed to it in the plan, not as shard files.
    const required = standard ? tests : recipe.selection.tests;
    if (run.gate) {
      const echo = recipe.selection.gate === undefined ? null : checkGateSchema.parse(recipe.selection.gate);
      if (echo) {
        const { effective, ...declared } = echo;
        const original = { ...run.gate };
        delete original.effective;
        invariant(
          canonicalPayload(declared) === canonicalPayload(original) &&
            effective ===
              (recipe.selection.scope === 'full'
                ? 'full'
                : recipe.selection.scope === 'docs'
                  ? 'docs'
                  : 'contract') &&
            (effective !== 'contract' || !['full', 'audit'].includes(run.gate.mode)) &&
            (effective !== 'contract' || (run.gate.tests ?? []).every(test => required.includes(test))),
          'EVIDENCE_CHANGED',
          'Actions selection differs from its server gate.',
        );
        run.gate = echo;
      } else {
        const covered = (run.gate.tests ?? []).every(test => required.includes(test));
        const union = semanticTests(run.semanticPlan);
        // Pre-gate planners can report scoped for a docs-only B3.2 union.
        // Recognize that exact legacy selection, not an arbitrary scoped pass.
        const legacyDocs =
          standard &&
          recipe.selection.scope === 'scoped' &&
          covered &&
          union.length > 0 &&
          recipe.selection.reason ===
            'Only Markdown documentation changed (including packaged docs); composed Intent contract union' &&
          checkPin([...tests].sort()) === checkPin([...union].sort());
        const effective =
          recipe.selection.scope === 'full'
            ? 'full'
            : recipe.selection.scope === 'docs' || legacyDocs
              ? 'docs'
              : recipe.selection.scope === 'scoped' && run.gate.mode === 'contract' && covered
                ? 'contract'
                : null;
        invariant(effective, 'EVIDENCE_CHANGED', 'A legacy plan must cover the server gate.');
        run.gate = { ...run.gate, effective };
      }
    } else
      invariant(
        recipe.selection.gate === undefined,
        'EVIDENCE_CHANGED',
        'Only a server-stamped run can return gate metadata.',
      );
    const selection = savePin(recipe.selection),
      manifest = savePin(recipe);
    // Tests the change's paths do not reach are skipped, not pending (Issue 9e71abcc).
    const skipped =
      recipe.groups.length === 0
        ? testsNotAffected(recipe.selection, standard, run.check.docsPaths)
        : undefined;
    // Allow entries the change adds against main (Issue 93e14bb0), for the receipt mark. A malformed
    // value is dropped: the landing then marks the allow-file change as unscanned and still alerts.
    const allowChanges = secretAllowEvidenceSchema.safeParse(
      (recipe.selection.secretScan as { allowChanges?: unknown } | undefined)?.allowChanges,
    );
    const plan = hostedCheckPlanSchema.parse({
      head: recipe.head,
      definition: recipe.definition,
      runtime: run.configuration.runtime,
      environmentFingerprint: run.request.expectedEnvironment,
      lockfile: input.lockfile,
      selection,
      manifest,
      shardCount: recipe.groups.length + 1,
      ...(skipped ? { skipped } : {}),
      ...(allowChanges.success ? { secretAllow: allowChanges.data } : {}),
      ...(isScopedRecheck(run.gate) && recipe.selection.scope === 'scoped'
        ? {
            scoped: {
              reason: recipe.selection.reason.slice(0, 300) || 'Scoped recheck',
              tests: new Set(required).size,
            },
          }
        : {}),
    });
    invariant(
      run.configuration.runtime === hostedActionsRuntime,
      'EVIDENCE_CHANGED',
      'Actions runtime differs.',
    );
    if (run.plan)
      invariant(run.planDigest === checkPin(plan), 'EVIDENCE_CHANGED', 'Original Actions plan is immutable.');
    else {
      invariant(
        !hostedCheckTerminal(run) && !run.cancelRequested,
        'WORK_STALE',
        'Check is no longer active.',
      );
      await storeSourceOutputs(ctx, input.projectId, run.executionId!, [
        {
          ...selection,
          ...(input.selectionR2Key ? { r2Key: input.selectionR2Key } : { storageId: input.selectionStorage }),
        },
        {
          ...manifest,
          ...(input.recipeR2Key ? { r2Key: input.recipeR2Key } : { storageId: input.recipeStorage }),
        },
      ]);
      run.plan = plan;
      run.planDigest = checkPin(plan);
      // A runner's fallback code and its reason ride this plan write; unknown codes are dropped (7c2e69e1, 7cb61db1).
      Object.assign(run, runFallback(recipe.selection));
      // Recorded for the run's evidence; every pass reads the required jobs' conclusions.
      const transport = objectReportTransport(run);
      invariant(
        !transport || input.resultsBatch,
        'CLI_UPGRADE_REQUIRED',
        'Use a runner with check-report-detail result batches.',
      );
      if (transport) transport.packed = !!input.resultsPacked;
      else if (input.resultsBatch) {
        detachCheckReports(run);
        const batch = await ctx.db
          .query('projectHostedActionsResults')
          .withIndex('by_project_and_run_and_index', q =>
            q.eq('projectId', input.projectId).eq('runId', run.id).eq('index', -2),
          )
          .unique();
        if (!batch)
          await ctx.db.insert('projectHostedActionsResults', {
            projectId: input.projectId,
            runId: run.id,
            index: -2,
            digest: run.planDigest!,
            ...(input.resultsPacked ? { state: '{"packed":true}' } : {}),
          });
      }
      if (input.packRefresh && run.actions) run.actions.packRefresh = true;
      run.status = 'running';
      if (run.gate) await ctx.db.patch(row._id, { gate: run.gate });
      await writeHostedCheck(ctx, row._id, run);
    }
    if (input.resultsPacked && replay) {
      const batch = await ctx.db
        .query('projectHostedActionsResults')
        .withIndex('by_project_and_run_and_index', q =>
          q.eq('projectId', input.projectId).eq('runId', run.id).eq('index', -2),
        )
        .unique();
      invariant(
        batch?.state === '{"packed":true}',
        'WORK_OPERATION_CHANGED',
        'Retry the original result transport.',
      );
    }
    return JSON.stringify(run);
  },
});
