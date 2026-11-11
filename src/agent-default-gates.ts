// SPDX-License-Identifier: Apache-2.0
import { ForgeError } from './errors.js';
import { shellQuote } from './shell-quote.js';
import { preflightOutcome } from './agent-preflight-incomplete.js';
import {
  preflightPlan,
  readPreflightReceipt,
  runPreflight,
  PREFLIGHT_SECONDS_PER_FILE,
} from './agent-preflight.js';
import type { EffectiveAgentDefaults } from './agent-parallel-defaults.js';
import type { readHostedOverlapAdvice } from './hosted-overlap-client.js';

type Advice = Awaited<ReturnType<typeof readHostedOverlapAdvice>>;
const command = (root: string, verb: string, body: Record<string, unknown>) =>
  `nforge agent ${shellQuote(root)} ${verb} ${shellQuote(JSON.stringify(body))}`;

/** Finish gates from the project's agent defaults, applied once per new finish after its save and
 * before compose. Refusals throw; advisories return. No extra server calls: the advice read is
 * the one the finish receipt already makes, cached by the transport. */
export function finishGates(
  root: string,
  defaults: EffectiveAgentDefaults | undefined,
  lane: { laneId: string; head: string; tree?: string },
  advice: Advice | undefined,
  runRequired: boolean | (() => void) = false,
) {
  const advisories: Record<string, unknown> = {};
  if (!defaults) return advisories;
  if (defaults.preflight !== 'off') {
    const receipt = readPreflightReceipt(root, lane.laneId);
    const sameSource =
      receipt?.laneId === lane.laneId &&
      (receipt.tree && lane.tree ? receipt.tree === lane.tree : receipt.head === lane.head);
    if (sameSource && receipt?.environment && preflightOutcome(receipt) === 'environment')
      advisories.preflight = {
        status: 'environment',
        ...receipt.environment,
        tests: receipt.tests,
        ...(receipt.exitCode ? { exitCode: receipt.exitCode } : {}),
        at: receipt.at,
      };
    // Must-run files the budget did not start: never shown as a pass, never refused as a failure
    // (the landing check runs them); the receipt's one command finishes them first.
    else if (sameSource && receipt?.incomplete && preflightOutcome(receipt) === 'incomplete')
      advisories.preflight = {
        status: 'incomplete',
        tests: receipt.tests,
        mustRunNotRun: receipt.incomplete.mustRun,
        finish: receipt.incomplete.finish,
        estimateMinutes: receipt.incomplete.estimateMinutes,
        reason: `NOT COMPLETE: ${receipt.incomplete.mustRun} must-run test file(s) did not run locally; only the landing check runs them unless you finish them first.`,
        deferredTests: receipt.deferredTests ?? 0,
        at: receipt.at,
      };
    else if (sameSource && receipt && preflightOutcome(receipt) === 'passed')
      advisories.preflight = {
        status: 'passed',
        tests: receipt.tests,
        at: receipt.at,
        deferredTests: receipt.deferredTests ?? 0,
        reusedTests: receipt.reusedTests ?? 0,
        ...(receipt.rule ? { rule: receipt.rule } : {}),
        ...(receipt.trimmedTiers ? { trimmedTiers: receipt.trimmedTiers } : {}),
        ...(receipt.deferredTo ? { deferredTo: receipt.deferredTo } : {}),
        ...(receipt.testMs !== undefined ? { testSeconds: Math.round(receipt.testMs / 1000) } : {}),
        ...(receipt.peakRssMb !== undefined ? { peakRssMb: receipt.peakRssMb } : {}),
      };
    else {
      const plan = preflightPlan(root, advice?.changedPaths);
      const run = command(root, 'preflight', { laneId: lane.laneId });
      if (plan.status === 'unavailable')
        advisories.preflight = { status: 'unavailable', reason: plan.reason };
      else if (plan.tests.length) {
        const summary = {
          tests: plan.tests.length,
          deferredTests: plan.deferredTests?.length ?? 0,
          totalEstimateMinutes: plan.totalEstimateMinutes ?? plan.estimateMinutes,
          selected: plan.tests.slice(0, 20),
          estimateMinutes: plan.estimateMinutes,
          ...(plan.local ? { local: plan.local.summary } : {}),
          run,
        };
        // A failed run names its cause (exit code, files, the start of its error output) and the two
        // ways forward, never a bare "failed" (9ab983fd).
        const failed =
          sameSource && receipt && !receipt.passed
            ? ` Its last run failed.${
                receipt.exitCode || receipt.failure
                  ? ` ${[
                      receipt.exitCode ? `Exit ${receipt.exitCode}` : '',
                      receipt.failure
                        ? `on ${receipt.failure.files.join(', ') || 'the selected tests'}: ${receipt.failure.excerpt}`
                        : '',
                    ]
                      .filter(Boolean)
                      .join(' ')}`
                  : ''
              } Fix that failure and run preflight again. If it is this Lane's setup and not your change (a dependency, service or fixture only CI has), declare the project's own runner with preflight.tests in forge.json, or set the project preflight policy to advise.`
            : sameSource
              ? ' Its last run failed.'
              : '';
        // A command Forge inferred (no declared runner) is advice: it can need setup only the
        // project's CI does, so its result is reported and never required.
        const lastRun =
          sameSource && receipt && !receipt.passed
            ? { lastRun: { passed: false, exitCode: receipt.exitCode, at: receipt.at } }
            : {};
        // Learned timings may make a run advisory, but must never expand the set
        // that the existing fixed-cost policy made mandatory.
        const gateMinutes = Math.max(
          plan.totalEstimateMinutes ?? plan.estimateMinutes,
          Math.ceil(
            ((plan.tests.length + (plan.deferredTests?.length ?? 0) + (plan.reusedTests?.length ?? 0)) *
              PREFLIGHT_SECONDS_PER_FILE) /
              60,
          ),
        );
        if (
          defaults.preflight === 'require' &&
          gateMinutes <= defaults.preflightMaxMinutes &&
          !plan.advisory
        ) {
          if (runRequired) {
            if (typeof runRequired === 'function') runRequired();
            // Reuse this plan and its existing local wall-time budget. No hosted read, new
            // operation or recursive dispatch: the caller continues the original finish.
            const result = runPreflight(root, lane.laneId, lane.head, plan, lane.tree);
            const next = result.incomplete?.finish ?? result.stoppedRerun ?? run;
            if (
              preflightOutcome(result) === 'failed' ||
              result.stoppedForTime ||
              result.static?.some(check => check.outcome === 'timed-out')
            )
              throw new ForgeError(
                'PREFLIGHT_REQUIRED',
                `Inline preflight ${preflightOutcome(result) === 'failed' ? 'failed' : 'exceeded its budget'} for saved head ${lane.head.slice(0, 12)}.${result.failure ? ` ${result.failure.excerpt}` : ''} Continue with: ${next}. Then replay the same land operation.`,
                undefined,
                { command: next },
              );
            return finishGates(root, defaults, lane, advice);
          }
          throw new ForgeError(
            'PREFLIGHT_REQUIRED',
            `Run the ${plan.tests.length} affected test file(s) for saved head ${lane.head.slice(0, 12)} first (about ${plan.estimateMinutes} min): ${run}.${failed} Then land again.`,
          );
        }
        advisories.preflight = {
          status: 'advised',
          ...summary,
          ...lastRun,
          ...(plan.advisory
            ? { reason: plan.advisory }
            : defaults.preflight === 'require'
              ? { reason: `over ${defaults.preflightMaxMinutes} min` }
              : {}),
        };
      } else if (plan.deferredTests?.length) {
        advisories.preflight = {
          status: 'advised',
          tests: 0,
          deferredTests: plan.deferredTests.length,
          ...(plan.local ? { local: plan.local.summary } : {}),
          reason: 'pre-queue Lane check coverage',
        };
      }
    }
  }
  return advisories;
}
export { unsavedMinutes, checkpointNudge } from './agent-nudge.js';
