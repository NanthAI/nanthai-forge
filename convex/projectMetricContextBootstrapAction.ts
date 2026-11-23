// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
'use node';

import { v } from 'convex/values';
import { internalAction } from './server';
import { internal } from './_generated/api';
import { exchangeObjectReader } from './projectExchangeReader';
import type { MetricBootstrap } from './projectMetricContextBootstrap';
import { canonicalPayload } from '../src/hosted-source-operation';
import { invariant } from '../src/errors';

export const next = internalAction({
  args: { projectId: v.id('hostedProjects'), operationId: v.string(), step: v.number() },
  returns: v.string(),
  handler: async (ctx, input): Promise<string> => {
    const { projectId, operationId, step } = input;
    const target = { projectId, operationId };
    const inspect: string = await ctx.runQuery(internal.projectMetricContextBootstrap.inspect, target);
    const parsed = JSON.parse(inspect) as { state: MetricBootstrap; owner: string };
    let state = parsed.state;
    invariant(step <= state.step, 'EVIDENCE_CHANGED', 'Replay the original metrics bootstrap step.');
    const reader = exchangeObjectReader(ctx, false, 0);
    const cached = new Map<string, Buffer>();
    let objectReads = 0;
    if (step === state.step)
      for (let count = 0; count < 24 && state.phase !== 'ready' && state.phase !== 'granted'; count++) {
        let page: string | null = null;
        if (state.root) {
          const wanted = [state.root.pin, ...state.pending.map(item => item.pin)];
          const selected = new Map(wanted.map(pin => [pin.sha256, pin]));
          for (const digest of cached.keys()) if (!selected.has(digest)) cached.delete(digest);
          const missing = [...selected.values()].filter(pin => !cached.has(pin.sha256)).slice(0, 8);
          if (missing.length) {
            let fetched = missing;
            let buffers: Buffer[];
            try {
              objectReads += fetched.length;
              buffers = await reader.read(projectId, parsed.owner, fetched);
            } catch (error) {
              // A later root can end up skipped after another compose pins the
              // same chain. Only the selected root can block this checkpoint.
              if (fetched.length === 1) throw error;
              fetched = [state.root.pin];
              objectReads++;
              buffers = await reader.read(projectId, parsed.owner, fetched);
            }
            for (const [index, pin] of fetched.entries()) cached.set(pin.sha256, buffers[index]!);
          }
          page = cached.get(state.root.pin.sha256)!.toString('utf8');
        }
        const next: string = await ctx.runMutation(internal.projectMetricContextBootstrap.advance, {
          ...target,
          step: state.step,
          page,
        });
        state = JSON.parse(next) as MetricBootstrap;
      }
    return canonicalPayload({
      step: state.step,
      phase: state.phase,
      composePages: state.composePages,
      aliases: state.aliases,
      objectReads,
    });
  },
});
