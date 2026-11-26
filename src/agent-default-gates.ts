// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { ForgeError } from './errors.js';
import { shellQuote } from './shell-quote.js';
import { localPreflightSummary, preflightOutcome } from './agent-preflight-incomplete.js';
import {
  estimatePreflightMinutes,
  planWithBudget,
  preflightPlan,
  readPreflightReceipt,
  runPreflight,
  PREFLIGHT_SECONDS_PER_FILE,
  type PreflightPlan,
  type PreflightReceipt,
} from './agent-preflight.js';
import type { EffectiveAgentDefaults } from './agent-parallel-defaults.js';
import type { readHostedOverlapAdvice } from './hosted-overlap-client.js';
import { disabledBrowserTests } from './preflight-browser.js';

type Advice = Awaited<ReturnType<typeof readHostedOverlapAdvice>>;
/** Land's quick head run (13ea93bf, lead decision 2026-11-20): when the plan is over the gate's
 * minutes, so land would run no test, it still runs the top of the same run order (fast repo-wide
 * guards, declared and learned guards, the change's own tests, then the tests that load a changed
 * module) for this many seconds of test time. A failure refuses the land; the rest is advised. */
export const LAND_QUICK_SECONDS = 90;
/** The quick run in one line of the advisory: its budget, how many files ran and how many it left. */
const quickSummary = (
  quick: {
    tests: number;
    budgetSeconds?: number | undefined;
    testMs?: number | undefined;
    outcome?: string | undefined;
  },
  planned: number,
) => ({
  budgetSeconds: quick.budgetSeconds ?? LAND_QUICK_SECONDS,
  ran: quick.tests,
  // Every planned file it did not run: stopped for time, or not run here (a missing runner).
  notStarted: Math.max(0, planned - quick.tests),
  ...(quick.testMs !== undefined ? { seconds: Math.round(quick.testMs / 1000) } : {}),
  ...(quick.outcome ? { outcome: quick.outcome } : {}),
});
const command = (root: string, verb: string, body: Record<string, unknown>) =>
  `nforge agent ${shellQuote(root)} ${verb} ${shellQuote(JSON.stringify(body))}`;

function gateEstimateMinutes(root: string, plan: PreflightPlan) {
  if (plan.status !== 'planned') return Infinity;
  const groups = [plan.tests, plan.deferredTests ?? [], plan.reusedTests ?? []];
  const count = groups.reduce((total, files) => total + files.length, 0);
  const disabled = groups.reduce((total, files) => total + disabledBrowserTests(files).length, 0);
  const eligible = count - disabled;
  const estimate = disabled
    ? estimatePreflightMinutes(root, eligible)
    : (plan.totalEstimateMinutes ?? plan.estimateMinutes);
  return Math.max(estimate, Math.ceil((eligible * PREFLIGHT_SECONDS_PER_FILE) / 60));
}

/** Finish gates from the project's agent defaults, applied once per new finish after its save and
 * before compose. Refusals throw; advisories return. No extra server calls: the advice read is
 * the one the finish receipt already makes, cached by the transport. */
export function finishGates(
  root: string,
  defaults: EffectiveAgentDefaults | undefined,
  lane: { laneId: string; head: string; tree?: string; base?: string },
  advice: Advice | undefined,
  runRequired: boolean | (() => void) = false,
  replayBudgetRefusal = false,
): Record<string, unknown> {
  const advisories: Record<string, unknown> = {};
  if (!defaults) return advisories;
  if (defaults.preflight !== 'off') {
    const heavyOptions = {
      heavySlot: true,
      ...(lane.base ? { comparisonBase: lane.base } : {}),
      ...(typeof runRequired === 'function' ? { afterHeavyWait: runRequired } : {}),
    };
    let receipt = readPreflightReceipt(root, lane.laneId);
    const sameSource =
      receipt?.laneId === lane.laneId &&
      (receipt.tree && lane.tree ? receipt.tree === lane.tree : receipt.head === lane.head);
    // A full preflight run of this head: neither static-only nor land's quick head run.
    const fullRun = sameSource && receipt && !receipt.staticOnly && !receipt.quick ? receipt : null;
    const recordRun = (run: PreflightReceipt, reused: boolean) => {
      advisories.localPreflight = localPreflightSummary(run, reused);
    };
    const preflightRecovery = () =>
      advisories.localPreflight ? { localPreflight: advisories.localPreflight } : {};
    const runLocal: typeof runPreflight = (...args) => {
      const result = runPreflight(...args);
      recordRun(result, false);
      return result;
    };
    if (fullRun) recordRun(fullRun, true);
    else if (sameSource && receipt?.staticOnly) recordRun(receipt, true);
    const run = command(root, 'preflight', { laneId: lane.laneId });
    const refuseStaticFailure = (result: typeof receipt) => {
      const failed = result?.static?.filter(check => check.outcome === 'failed');
      if (!failed?.length) return;
      const causes = failed
        .map(
          check =>
            `${check.name}${check.files?.length ? ` (${check.files.slice(0, 5).join(', ')})` : ''}: ${check.excerpt || 'failed'}. ${check.fix ? `Fix: ${check.fix.map(shellQuote).join(' ')}` : `Fix the reported files, then rerun: ${(check.command ?? []).map(shellQuote).join(' ')}`}.`,
        )
        .join(' ');
      const fix = failed.find(check => check.fix)?.fix;
      if (result && !advisories.localPreflight) recordRun(result, true);
      throw new ForgeError(
        'PREFLIGHT_REQUIRED',
        `Inline preflight failed static checks for saved head ${lane.head.slice(0, 12)}. ${causes} Fix the reported files, save, then run land --save with the same options and a fresh operationId.`,
        undefined,
        {
          ...preflightRecovery(),
          ...(fix ? { command: fix.map(shellQuote).join(' ') } : {}),
          static: result!.static,
        },
      );
    };
    if (sameSource) refuseStaticFailure(receipt);
    if (fullRun?.environment && preflightOutcome(fullRun) === 'environment')
      advisories.preflight = {
        status: 'environment',
        ...fullRun.environment,
        tests: fullRun.tests,
        ...(fullRun.exitCode ? { exitCode: fullRun.exitCode } : {}),
        at: fullRun.at,
      };
    // Must-run files the budget did not start: never shown as a pass, never refused as a failure
    // (the landing check runs them); the receipt's one command finishes them first.
    else if (fullRun?.incomplete && preflightOutcome(fullRun) === 'incomplete')
      advisories.preflight = {
        status: 'incomplete',
        tests: fullRun.tests,
        mustRunNotRun: fullRun.incomplete.mustRun,
        // Absent when the rest outlives one agent wait: an undefined field would fail the
        // retained land payload, so land itself refused (friction ad80e037, 2026-11-19).
        ...(fullRun.incomplete.finish ? { finish: fullRun.incomplete.finish } : {}),
        estimateMinutes: fullRun.incomplete.estimateMinutes,
        reason: fullRun.incomplete.mustRun
          ? `NOT COMPLETE: ${fullRun.incomplete.mustRun} must-run test file(s) did not run locally; only the landing check runs them unless you finish them first.`
          : `NOT COMPLETE: ${fullRun.incomplete.needs?.files.length ?? 0} browser test file(s) skipped locally. The landing check runs them. To run them locally: ${fullRun.incomplete.needs?.next ?? 'see the receipt'}.`,
        deferredTests: fullRun.deferredTests ?? 0,
        at: fullRun.at,
      };
    else if (fullRun && preflightOutcome(fullRun) === 'passed')
      advisories.preflight = {
        status: 'passed',
        tests: fullRun.tests,
        at: fullRun.at,
        deferredTests: fullRun.deferredTests ?? 0,
        reusedTests: fullRun.reusedTests ?? 0,
        ...(fullRun.rule ? { rule: fullRun.rule } : {}),
        ...(fullRun.trimmedTiers ? { trimmedTiers: fullRun.trimmedTiers } : {}),
        ...(fullRun.deferredTo ? { deferredTo: fullRun.deferredTo } : {}),
        ...(fullRun.testMs !== undefined ? { testSeconds: Math.round(fullRun.testMs / 1000) } : {}),
        ...(fullRun.peakRssMb !== undefined ? { peakRssMb: fullRun.peakRssMb } : {}),
      };
    else {
      const plan = preflightPlan(root, advice?.changedPaths);
      // A static failure blocks only when it is this change's; failures already on main advise.
      const changed = advice?.changedPaths?.complete ? advice.changedPaths.paths : null;
      // Tests may be advised by policy, estimate or inferred setup. Their status must not
      // skip independent static commands, nor can a static-only pass satisfy the test gate.
      const gateMinutes = gateEstimateMinutes(root, plan);
      // A replay may price the same head differently. Honor the quick receipt that already
      // exhausted its budget on this operation, even if the new estimate would require a full run
      // (operations an older CLI refused with PREFLIGHT_BUDGET_EXCEEDED at the quick cap).
      // A failed quick run is never reused: each land runs it again, as an under-budget land reruns
      // its failed plan, so a test that passes on rerun (a flake) does not block it (Item 29b2d1ca).
      let quick =
        sameSource &&
        receipt?.quick &&
        defaults.preflight === 'require' &&
        preflightOutcome(receipt) !== 'failed'
          ? receipt
          : null;
      const replayQuick = replayBudgetRefusal && Boolean(quick);
      let quickCapped = false;
      // Tests run in the Lane folder: one that rewrites a tracked file must not let this land submit
      // the saved head as checked (a local scan, no server call). Its own failure is reported first.
      const stillSaved = () => {
        if (typeof runRequired === 'function') runRequired();
      };
      let quickRan = false;
      const requireTests =
        plan.status === 'planned' &&
        plan.tests.length > 0 &&
        defaults.preflight === 'require' &&
        gateMinutes <= defaults.preflightMaxMinutes &&
        !plan.advisory &&
        !replayQuick;
      const staticPlan =
        plan.status === 'planned'
          ? plan
          : {
              ...plan,
              status: 'planned' as const,
              scope: 'static',
              tests: [],
              estimateMinutes: 0,
              command: null,
            };
      // Over-budget landings run one quick preflight with static checks, so its typechecks and
      // tests can share a slot. Only under require: a quick failure cached before a switch to advise
      // refuses nothing.
      // Not when this head already has a full run (it failed: its advice stands), nor for a plan with
      // no local wall-time budget (a package-graph plan, trim:false), which only the ceiling bounds.
      if (
        runRequired &&
        !quick &&
        !fullRun &&
        plan.status === 'planned' &&
        plan.tests.length > 0 &&
        plan.local &&
        plan.local.trim !== false &&
        defaults.preflight === 'require' &&
        !plan.advisory &&
        gateMinutes > defaults.preflightMaxMinutes
      ) {
        if (typeof runRequired === 'function') runRequired();
        // Reuse static results already recorded for this head.
        const staticDone =
          receipt?.laneId === lane.laneId && receipt.head === lane.head ? receipt.static : undefined;
        // The plan land just made, in its run order, with only the budget cut: re-planning would cost
        // as much again (about 12 s on Forge itself) for the same head.
        const result = runLocal(
          root,
          lane.laneId,
          lane.head,
          planWithBudget(plan, LAND_QUICK_SECONDS),
          lane.tree,
          false,
          changed,
          { ...heavyOptions, quick: true, ...(staticDone ? { staticDone } : {}) },
        );
        receipt = quick = result;
        // A group still running at the cap is stopped and left to the landing check, exactly like the
        // files the cap never started: the land goes on. Refusing here only made the agent replay into
        // the same advisory (99b4062c: 33 of 67 quick runs, 2026-11-21..23).
        quickCapped = Boolean(result.quickTimedOut);
        quickRan = true;
      } else if (
        runRequired &&
        !requireTests &&
        staticPlan.static?.selected.length &&
        !(sameSource && receipt?.static?.length)
      ) {
        if (typeof runRequired === 'function') runRequired();
        receipt = runLocal(root, lane.laneId, lane.head, staticPlan, lane.tree, true, changed, heavyOptions);
        refuseStaticFailure(receipt);
      }
      if (quick) {
        if (!quickRan) recordRun(quick, true);
        refuseStaticFailure(quick);
        if (preflightOutcome(quick) === 'failed')
          throw new ForgeError(
            'PREFLIGHT_REQUIRED',
            `Inline preflight failed for saved head ${lane.head.slice(0, 12)}: the plan is over ${defaults.preflightMaxMinutes} min, so land ran its top-ranked tests for ${quick.budgetSeconds ?? LAND_QUICK_SECONDS} s, and ${quick.failure?.files.length ? quick.failure.files.join(', ') : 'one'} failed.${quick.failure ? ` ${quick.failure.excerpt}` : ''} Fix it, save, then run land --save with the same options and a fresh operationId. Each land runs these tests again, so one that passes on rerun does not block it.`,
            undefined,
            {
              ...preflightRecovery(),
              command: run,
              quick: quickSummary(quick, plan.status === 'planned' ? plan.tests.length : quick.tests),
            },
          );
        if (quickRan) stillSaved();
      }
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
          fullRun && !fullRun.passed
            ? ` Its last run failed.${
                fullRun.exitCode || fullRun.failure
                  ? ` ${[
                      fullRun.exitCode ? `Exit ${fullRun.exitCode}` : '',
                      fullRun.failure
                        ? `on ${fullRun.failure.files.join(', ') || 'the selected tests'}: ${fullRun.failure.excerpt}`
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
          fullRun && !fullRun.passed
            ? { lastRun: { passed: false, exitCode: fullRun.exitCode, at: fullRun.at } }
            : {};
        if (requireTests) {
          if (runRequired) {
            if (typeof runRequired === 'function') runRequired();
            // Reuse this plan and its existing local wall-time budget. No hosted read, new
            // operation or recursive dispatch: the caller continues the original finish.
            const result = runLocal(
              root,
              lane.laneId,
              lane.head,
              plan,
              lane.tree,
              false,
              changed,
              heavyOptions,
            );
            refuseStaticFailure(result);
            const failed = preflightOutcome(result) === 'failed';
            // A failure is fixed and run again: retry reruns only stopped files and refuses a failed stop.
            const next = failed ? run : (result.incomplete?.finish ?? result.stoppedRerun ?? run);
            if (
              failed ||
              result.stoppedForTime ||
              result.static?.some(check => check.outcome === 'timed-out')
            )
              throw new ForgeError(
                failed ? 'PREFLIGHT_REQUIRED' : 'PREFLIGHT_BUDGET_EXCEEDED',
                `Inline preflight ${failed ? 'failed' : 'exceeded its budget'} for saved head ${lane.head.slice(0, 12)}.${result.failure ? ` ${result.failure.excerpt}` : ''} Continue with: ${next}. Then replay the same land operation.`,
                undefined,
                { ...preflightRecovery(), command: next },
              );
            stillSaved();
            return { ...finishGates(root, defaults, lane, advice), ...preflightRecovery() };
          }
          throw new ForgeError(
            'PREFLIGHT_REQUIRED',
            `Run the ${plan.tests.length} affected test file(s) for saved head ${lane.head.slice(0, 12)} first (about ${plan.estimateMinutes} min): ${run}.${failed} Then land again.`,
            undefined,
            preflightRecovery(),
          );
        }
        advisories.preflight = {
          status: 'advised',
          ...summary,
          ...lastRun,
          ...(quick ? { quick: quickSummary(quick, plan.tests.length) } : {}),
          ...(plan.advisory
            ? { reason: plan.advisory }
            : replayQuick || quickCapped
              ? { reason: 'inline quick preflight reached its local budget' }
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
    if (receipt?.static?.length && (sameSource || receipt.head === lane.head)) {
      // A failure that is not this change's (pre-existing on main, or not judgeable here) is one line each.
      const notes = receipt.static.filter(check => check.advisory).map(c => `${c.name}: ${c.advisory}`);
      advisories.preflight = {
        ...((advisories.preflight as Record<string, unknown> | undefined) ?? { status: 'none', tests: 0 }),
        static: receipt.static,
        ...(notes.length ? { staticAdvisory: notes.join(' ') } : {}),
      };
    }
  }
  return advisories;
}
export { unsavedMinutes, checkpointNudge } from './agent-nudge.js';
