// SPDX-License-Identifier: Apache-2.0
import { v } from 'convex/values';
import { internalMutation } from './server';
import { actionsSession, sessionArgs } from './projectHostedActionsSession';
import { storeSourceOutputs } from './projectConvexSourceOutput';
import { writeHostedCheck } from './projectHostedCheckStore';
import { hostedCheckPlanSchema, checkPin, hostedCheckTerminal, testsNotAffected } from '../src/hosted-check';
import { hostedActionsRecipeSchema, hostedActionsRuntime } from '../src/hosted-actions';
import { savePin } from '../src/hosted-save';
import { semanticTests } from '../src/intent-semantic-conflict';
import { checkGateSchema } from '../src/bet2-gate';
import { canonicalPayload } from '../src/hosted-source-operation';
import { invariant } from '../src/errors';
import { secretAllowEvidenceSchema } from '../src/secret-allow';
export const prepare = internalMutation({
  args: {
    ...sessionArgs,
    recipe: v.string(),
    lockfile: v.string(),
    selectionStorage: v.optional(v.id('_storage')),
    selectionR2Key: v.optional(v.string()),
    recipeStorage: v.optional(v.id('_storage')),
    recipeR2Key: v.optional(v.string()),
  },
  returns: v.any(),
  handler: async (ctx, input) => {
    const { row, run } = await actionsSession(ctx, input);
    const recipe = hostedActionsRecipeSchema.parse(JSON.parse(input.recipe)),
      { pin, ...pins } = recipe;
    const standard =
      /(?:^|\/)node$/.test(run.check.executable) &&
      JSON.stringify(run.check.args) === '["scripts/forge-check.mjs"]';
    invariant(
      pin === checkPin(pins) &&
        recipe.head === run.request.expectedHead &&
        recipe.definition === run.check.definition &&
        recipe.standard === standard &&
        checkPin(recipe.command) === checkPin([standard ? 'node' : run.check.executable, ...run.check.args]),
      'EVIDENCE_CHANGED',
      'Actions plan differs from its source or configured command.',
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
          : recipe.groups.length === 0),
      'EVIDENCE_CHANGED',
      'Actions shard membership differs from the complete selection.',
    );
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
            (effective !== 'contract' || (run.gate.tests ?? []).every(test => tests.includes(test))),
          'EVIDENCE_CHANGED',
          'Actions selection differs from its server gate.',
        );
        run.gate = echo;
      } else {
        const covered = (run.gate.tests ?? []).every(test => tests.includes(test));
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
      run.status = 'running';
      if (run.gate) await ctx.db.patch(row._id, { gate: run.gate });
      await writeHostedCheck(ctx, row._id, run);
    }
    return run;
  },
});
