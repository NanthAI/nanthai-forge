// SPDX-License-Identifier: Apache-2.0
import { v } from 'convex/values';
import { internalMutation } from './_generated/server';
import { actionsSession, sessionArgs } from './projectHostedActionsSession';
import { storeSourceOutputs } from './projectConvexSourceOutput';
import { writeHostedCheck } from './projectHostedCheckStore';
import { hostedCheckPlanSchema, checkPin, hostedCheckTerminal } from '../src/hosted-check';
import { hostedActionsRecipeSchema, hostedActionsRuntime } from '../src/hosted-actions';
import { savePin } from '../src/hosted-save';
import { semanticTests } from '../src/intent-semantic-conflict';
import { invariant } from '../src/errors';
export const prepare = internalMutation({
  args: {
    ...sessionArgs,
    recipe: v.string(),
    lockfile: v.string(),
    selectionStorage: v.id('_storage'),
    recipeStorage: v.id('_storage'),
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
    const tests = recipe.groups.flat();
    invariant(
      new Set(tests).size === tests.length &&
        (standard
          ? checkPin([...tests].sort()) === checkPin([...new Set(recipe.selection.tests)].sort()) &&
            semanticTests(run.semanticPlan).every(test => tests.includes(test))
          : recipe.groups.length === 0),
      'EVIDENCE_CHANGED',
      'Actions shard membership differs from the complete selection.',
    );
    const selection = savePin(recipe.selection),
      manifest = savePin(recipe);
    const plan = hostedCheckPlanSchema.parse({
      head: recipe.head,
      definition: recipe.definition,
      runtime: run.configuration.runtime,
      environmentFingerprint: run.request.expectedEnvironment,
      lockfile: input.lockfile,
      selection,
      manifest,
      shardCount: recipe.groups.length + 1,
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
        { ...selection, storageId: input.selectionStorage },
        { ...manifest, storageId: input.recipeStorage },
      ]);
      run.plan = plan;
      run.planDigest = checkPin(plan);
      run.status = 'running';
      await writeHostedCheck(ctx, row._id, run);
    }
    return run;
  },
});
