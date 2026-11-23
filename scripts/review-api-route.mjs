// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// Which provider answers the review round (Items f082efd6, 3bd3eb0f). `runRoutes` tries providers in order
// and spills to the next; `runDouble` (core Lanes) asks both at once and merges. Both stay inside the
// per-call, daily and monthly caps and write every attempt to the spend log.
import { SPILL_CODES, callProvider, failureReason } from './review-api-call.mjs';
import { formatMerged, mergeFindings } from './review-api-merge.mjs';
import {
  ReviewError,
  checkCaps,
  dailyCapUsd,
  estimateUsd,
  formatReport,
  priceFor,
  spentOn,
} from './review-api-lib.mjs';

const CAP_CODES = new Set(['REVIEW_CALL_CAP', 'REVIEW_DAY_CAP', 'REVIEW_MONTH_CAP']);
// A provider that cannot be priced is unavailable, not a reason to drop the other one's review.
const UNAVAILABLE = new Set([...CAP_CODES, 'REVIEW_PRICE_UNKNOWN']);

export function planFor(ctx, { provider, model }) {
  const price = priceFor(provider, model, ctx.priceOverride);
  // Image tokens (the mock check) are not bytes of prompt text; price them at the input rate.
  const estimate =
    estimateUsd(price, ctx.promptBytes, ctx.maxOutputTokens) +
    ((ctx.extraInputTokens ?? 0) * price.input) / 1_000_000;
  const capsFor = () => {
    const log = ctx.readLog();
    checkCaps({
      estimate,
      spentTodayUsd: spentOn(ctx.day, log, provider),
      maxCallUsd: ctx.maxCallUsd,
      maxDayUsd: dailyCapUsd(ctx.config, provider, ctx.dayCapFlag),
      spentMonthUsd: spentOn(ctx.day.slice(0, 7), log, provider),
      monthlyCreditUsd: ctx.config.providers[provider].monthlyCreditUsd,
    });
  };
  return { price, estimate, capsFor };
}

/** One provider call; `ctx.callOptions` swaps the schema and parser (the mock check). */
export const call = (ctx, route, plan) =>
  callProvider({
    ...ctx.callOptions,
    deps: ctx.deps,
    args: ctx.args,
    input: ctx.input,
    route,
    tier: ctx.tier,
    price: plan.price,
    estimate: plan.estimate,
    system: ctx.system,
    user: ctx.user,
    maxOutputTokens: ctx.maxOutputTokens,
    roomToRetry: plan.capsFor,
  });

/**
 * Routes are tried in order. A provider with no room under its caps, no key, or one that keeps failing
 * (429/5xx after one retry, a timeout or network error, an unusable reply) hands over to the next; a
 * per-call cap breach is about this prompt, not the provider, and stops the review. When every route
 * fails the builder falls back to a subscription reviewer. A pinned provider never spills.
 */
export async function runRoutes(ctx) {
  const { args, deps, routes, tier } = ctx;
  const routeNotes = [];
  const failures = [];
  let lastError;
  let onlyCaps = true;
  for (const route of routes) {
    const { provider, model } = route;
    const plan = planFor(ctx, route);
    try {
      plan.capsFor();
    } catch (error) {
      if (error.code !== 'REVIEW_DAY_CAP' && error.code !== 'REVIEW_MONTH_CAP') throw error;
      routeNotes.push(`${provider} is at its ${error.code === 'REVIEW_DAY_CAP' ? 'daily' : 'monthly'} cap`);
      failures.push(`${provider}: ${error.message}`);
      lastError = error;
      continue;
    }
    const routeNote = routeNotes.length
      ? `Routed to ${provider}/${model} because ${routeNotes.join('; ')}.`
      : undefined;
    if (args['dry-run'])
      return deps.out(
        `Dry run: ${ctx.promptBytes} prompt bytes, worst case $${plan.estimate.toFixed(3)} on ${provider}/${model} (tier ${tier}); nothing sent.${routeNote ? ` ${routeNote}` : ''}`,
      );
    try {
      const done = await call(ctx, route, plan);
      const meta = {
        provider,
        model,
        tier,
        usage: done.usage,
        usd: done.usd,
        spentTodayUsd: spentOn(ctx.day, ctx.readLog(), provider), // settled log: failed attempts count as the cap sees them
        route: routeNote,
      };
      return deps.out(
        args.json ? JSON.stringify({ ...done.parsed, ...meta }) : formatReport(done.parsed, meta),
      );
    } catch (error) {
      if (!SPILL_CODES.has(error.code)) throw error;
      onlyCaps = false;
      routeNotes.push(`${provider} failed (${failureReason(error)})`);
      failures.push(`${provider}: ${error.message}`);
      lastError = error;
    }
  }
  if (routes.length === 1) throw lastError; // pinned: the original error, no spill
  throw new ReviewError(
    onlyCaps ? lastError.code : 'REVIEW_NO_REVIEWER',
    `${failures.join(' ')} No API reviewer has room or answered on either provider; use a subscription reviewer.`,
  );
}

/** One provider's side of the double review: an answered run, or a run with the reason it did not. */
async function doubleRun(ctx, route) {
  const { provider, model } = route;
  try {
    const plan = planFor(ctx, route);
    plan.capsFor();
    const done = await call(ctx, route, plan);
    return {
      provider,
      model,
      parsed: done.parsed,
      usage: done.usage,
      usd: done.usd,
      spentTodayUsd: spentOn(ctx.day, ctx.readLog(), provider),
    };
  } catch (error) {
    if (!UNAVAILABLE.has(error.code) && !SPILL_CODES.has(error.code)) throw error;
    const reason = UNAVAILABLE.has(error.code) ? error.message : failureReason(error);
    return { provider, model, error: reason, capOnly: CAP_CODES.has(error.code) };
  }
}

/**
 * Core Lanes: both providers review the same prompt at the same time, each under its own caps, and the
 * findings are merged with the source of each. If one provider has no room, no key or fails, the other
 * alone runs and the output says so; when neither answers the builder uses a subscription reviewer.
 */
export async function runDouble(ctx) {
  const { args, deps, routes, tier } = ctx;
  if (args['dry-run']) {
    const lines = routes.map(route => {
      const plan = planFor(ctx, route);
      return `${route.provider}/${route.model} worst case $${plan.estimate.toFixed(3)}`;
    });
    return deps.out(
      `Dry run: ${ctx.promptBytes} prompt bytes, double review (tier ${tier}) on ${lines.join(' and ')}; nothing sent.`,
    );
  }
  const runs = await Promise.all(routes.map(route => doubleRun(ctx, route)));
  const answered = runs.filter(run => run.parsed);
  if (!answered.length)
    throw new ReviewError(
      runs.every(run => run.capOnly) ? 'REVIEW_DAY_CAP' : 'REVIEW_NO_REVIEWER',
      `${runs.map(run => `${run.provider}: ${run.error}`).join(' ')} No API reviewer has room or answered on either provider; use a subscription reviewer.`,
    );
  const merged = mergeFindings(answered);
  const notes = runs
    .filter(run => run.error)
    .map(
      run =>
        `Only ${answered[0].provider} reviewed this core Lane: ${run.provider} did not (${run.error}). Treat it as a single-provider review.`,
    );
  deps.out(
    args.json
      ? JSON.stringify({
          ...merged,
          tier,
          notes,
          runs: runs.map(({ parsed: _parsed, ...run }) => run),
        })
      : formatMerged(merged, runs, notes),
  );
}
