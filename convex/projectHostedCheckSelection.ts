// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
'use node';
import { v } from 'convex/values';
import { action } from './cliServer';
import { internal } from './_generated/api';
import { exchangeObjectReader } from './projectExchangeReader';
import { findCheckTimingSnapshot, readCheckTimingSnapshot } from './projectHostedCheckTimingSnapshot';
import { report } from './errors';
import { invariant } from '../src/errors';
import { hostedActionsRecipeSchema } from '../src/hosted-actions';
import { checkPin, type HostedCheckRun } from '../src/hosted-check';
import { canonicalPayload } from '../src/hosted-source-operation';
import { checkSelectionPin, machineSelectionKey, machineSelectionSchema } from '../src/hosted-check-evidence';
import { presignGet, r2Config } from './r2';
import { readExactObject } from './projectR2ExactRead';
import { digest } from '../src/hash';

/** Read the bytes the runner actually pinned, with the same access as check reports. */
export const detail = action({
  args: {
    projectId: v.id('hostedProjects'),
    runId: v.string(),
    timings: v.optional(v.literal(true)),
  },
  returns: v.string(),
  handler: async (ctx, { timings, ...input }) => {
    try {
      const header = () =>
        ctx.runQuery(internal.projectHostedCheckDetail.retained, { ...input, header: true });
      const { plan, provider, fence, timingHistoryGeneration, timingHistoryCleanup, machineSelection } =
        JSON.parse(await header()) as {
          plan: HostedCheckRun['plan'];
          provider: HostedCheckRun['configuration']['provider'];
          fence: number;
          timingHistoryGeneration: string | null;
          timingHistoryCleanup: 'purging' | 'expired' | null;
          machineSelection: unknown;
        };
      if (!plan) return canonicalPayload(timings ? { timingHistory: null } : { selection: null });
      const user = await ctx.auth.getUserIdentity();
      invariant(user, 'PROJECT_UNAVAILABLE', 'Sign in to read check selection.');
      const actions = provider === 'github-actions';
      if (timings && !actions) return canonicalPayload({ timingHistory: null });
      const [bytes] = await exchangeObjectReader(ctx, false, 0).read(input.projectId, user.subject, [
        actions ? plan.manifest : plan.selection,
      ]);
      const value = JSON.parse(bytes!.toString('utf8'));
      if (!actions) {
        let observed;
        if (machineSelection) {
          const pin = checkSelectionPin.parse(machineSelection);
          const key = machineSelectionKey(input.projectId, input.runId, fence);
          const url = await presignGet(r2Config(), key);
          const bytes = await readExactObject(
            { url, size: pin.size },
            {
              failed: 'The original machine selection is unavailable.',
              exceeds: 'The machine selection exceeds its retained size.',
            },
          );
          invariant(
            bytes.length === pin.size && digest(bytes) === pin.sha256,
            'EVIDENCE_CHANGED',
            'The machine selection differs from its retained pin.',
          );
          observed = machineSelectionSchema.parse(
            JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)),
          );
          await header();
        }
        return canonicalPayload({
          selection: {
            scope: observed?.scope ?? value.scope,
            reason: observed?.reason ?? value.reason ?? null,
            tests: observed?.tests ?? null,
            semanticTests: value.semanticTests ?? [],
          },
          groups: observed ? [observed.tests] : [],
          pool: null,
          timingHistory: null,
        });
      }

      const recipe = hostedActionsRecipeSchema.parse(value);
      invariant(
        checkPin(recipe.selection) === plan.selection.sha256 && recipe.groups.length + 1 === plan.shardCount,
        'EVIDENCE_CHANGED',
        'The retained Actions recipe differs from the check selection.',
      );
      const legacySnapshot =
        timingHistoryCleanup !== 'expired' && !recipe.timingHistory && timingHistoryGeneration === input.runId
          ? await findCheckTimingSnapshot(input)
          : null;
      const timingHistory = recipe.timingHistory ?? legacySnapshot?.timingHistoryPin ?? null;
      if (timings) {
        const snapshot =
          timingHistoryCleanup !== 'expired' && recipe.timingHistory
            ? await readCheckTimingSnapshot(input, recipe.timingHistory)
            : (legacySnapshot?.timingHistory ?? null);
        const current = JSON.parse(await header());
        invariant(
          !recipe.timingHistory || snapshot !== null || current.timingHistoryCleanup,
          'SOURCE_UNAVAILABLE',
          'The original check timing history is unavailable.',
        );
        return canonicalPayload({
          timingHistory,
          history: snapshot,
        });
      }
      if (legacySnapshot) await header();
      return canonicalPayload({
        selection: recipe.selection,
        groups: recipe.groups,
        pool: recipe.pool ?? null,
        timingHistory,
      });
    } catch (error) {
      return report(error);
    }
  },
});
