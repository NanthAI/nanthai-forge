// SPDX-License-Identifier: Apache-2.0
import { existsSync, lstatSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { scanSourcePaths } from './source-paths.js';
import { canonicalRoot } from './root-paths.js';
import { digest } from './hash.js';
import { indexedBlob, readCheckoutStatIndex } from './checkout-stat-index.js';
import { readHostedLaneCheckout } from './hosted-lane-checkout-marker.js';
import { ForgeError } from './errors.js';
import { shellQuote } from './agent-brief-render.js';
import { preflightPlan, readPreflightReceipt, PREFLIGHT_SECONDS_PER_FILE } from './agent-preflight.js';
import { answerId, hostedOverlapNotice } from './hosted-overlap-notice.js';
import type { EffectiveAgentDefaults } from './agent-parallel-defaults.js';
import type { readHostedOverlapAdvice } from './hosted-overlap-client.js';

type Advice = Awaited<ReturnType<typeof readHostedOverlapAdvice>>;
const command = (root: string, verb: string, body: Record<string, unknown>) =>
  `nforge agent ${shellQuote(root)} ${verb} ${shellQuote(JSON.stringify(body))}`;

/** Finish gates from the project's agent defaults, applied once per new finish after its save and
 * before compose. Refusals throw; advisories return. No extra server calls: the overlap read is
 * the one the finish receipt already makes, cached by the transport. */
export function finishGates(
  root: string,
  defaults: EffectiveAgentDefaults | undefined,
  lane: { laneId: string; head: string; tree?: string },
  advice: Advice | undefined,
  overlapAnswer?: 'accept-order',
) {
  const advisories: Record<string, unknown> = {};
  if (!defaults) return advisories;
  const pending = (advice?.unacknowledgedOverlaps.items ?? []).filter(item => item.class === 'blocking');
  if (defaults.overlapGate !== 'off' && pending.length) {
    const ack = command(root, 'ack', { laneId: lane.laneId });
    const files = pending.map(item => item.file).join(', ');
    if (defaults.overlapGate === 'block' && overlapAnswer !== 'accept-order') {
      // The refusal carries the notices it judged, from this same read: a save can change the
      // evidence after an earlier receipt printed its banner (c8b842a9). No extra call.
      const notice = hostedOverlapNotice(root, lane.laneId, {
        unacknowledgedOverlaps: {
          count: pending.length,
          coverage: advice!.unacknowledgedOverlaps.coverage ?? 'complete',
          items: pending,
        },
      })!;
      const named = notice.items
        .map(
          item =>
            `${item.file} (${item.reason}${item.with.length ? `; with Lane ${item.with.map(p => p.lane).join(', ')}` : ''})`,
        )
        .join('; ');
      throw new ForgeError(
        'OVERLAP_UNANSWERED',
        `Answer the blocking overlap notice(s) on ${files} before landing (project overlapGate: block). Blocking: ${named}. Keep your change and land in order: ${notice.acknowledge}. Or route around: ${notice.routeAround}. Or include "overlapAnswer":"accept-order" in land --save.`,
        undefined,
        { overlapNotice: notice, command: notice.acknowledge },
      );
    }
    advisories.overlap =
      overlapAnswer === 'accept-order'
        ? {
            status: 'answered',
            choice: overlapAnswer,
            notices: pending.map(item => item.noticeId),
            files: pending.map(item => item.file),
          }
        : {
            status: 'unanswered',
            files: pending.map(item => item.file),
            acknowledge: ack,
          };
  }
  if (defaults.preflight !== 'off') {
    const receipt = readPreflightReceipt(root, lane.laneId);
    const sameSource =
      receipt?.laneId === lane.laneId &&
      (receipt.tree && lane.tree ? receipt.tree === lane.tree : receipt.head === lane.head);
    if (sameSource && receipt?.environment)
      advisories.preflight = {
        status: 'environment',
        ...receipt.environment,
        tests: receipt.tests,
        ...(receipt.exitCode ? { exitCode: receipt.exitCode } : {}),
        at: receipt.at,
      };
    // Must-run files the budget did not start: never shown as a pass, never refused as a failure
    // (the landing check runs them); the receipt's one command finishes them first.
    else if (sameSource && receipt?.incomplete)
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
    else if (sameSource && receipt?.passed)
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
        const failed = sameSource ? ' Its last run failed.' : '';
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
        if (defaults.preflight === 'require' && gateMinutes <= defaults.preflightMaxMinutes && !plan.advisory)
          throw new ForgeError(
            'PREFLIGHT_REQUIRED',
            `Run the ${plan.tests.length} affected test file(s) for saved head ${lane.head.slice(0, 12)} first (about ${plan.estimateMinutes} min): ${run}.${failed} Then land again.`,
          );
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

/** Answers for every listed notice with stable ids, so a repeated ack replays the same answers. */
export function ackAnswers(laneId: string, advice: Advice, choice: string, text?: string) {
  return advice.unacknowledgedOverlaps.items.map(item => ({
    operationId: answerId(laneId, item.noticeId),
    laneId,
    noticeId: item.noticeId,
    choice,
    ...(text ? { text } : {}),
  }));
}

/** Files newer than the save whose bytes are confirmed against the saved baseline per call. */
const VERIFY_FILES = 256,
  VERIFY_BYTES = 64 * 1024 * 1024;
/** Minutes the oldest unsaved edit has waited. File times against the checkout marker's save time
 * pick candidates among the paths a save would capture (the same walk and ignore rules as save, so
 * build outputs and other ignored or generated files are never edits); a candidate whose bytes and mode still equal the saved
 * baseline (a rewrite with the same content, a lazily materialized file) is not an edit. The stat
 * index skips reads it vouches for; at most VERIFY_FILES/VERIFY_BYTES are read, anything past that
 * counts as unsaved. No server call; null when nothing differs from the save. */
export function unsavedMinutes(root: string, now = Date.now()) {
  const marker = join(root, '.forge', 'hosted-lane.json');
  if (!existsSync(marker)) return null;
  const savedAt = statSync(marker).mtimeMs;
  let baseline: Map<string, { blob: string; mode: string }> | null = null;
  try {
    baseline = new Map(readHostedLaneCheckout(root)?.state.files.map(file => [file.path, file]) ?? []);
  } catch {
    /* An unreadable marker vouches for nothing: every newer file counts. */
  }
  // Saved paths stay candidates even where an ignore rule now covers them, exactly as save keeps them.
  const newer: { path: string; at: number }[] = [];
  const scan = { retained: [...(baseline?.keys() ?? [])], validate: false };
  for (const path of scanSourcePaths(canonicalRoot(root), scan)) {
    const at = lstatSync(join(root, path)).mtimeMs;
    if (at > savedAt) newer.push({ path, at });
  }
  if (!newer.length) return null;
  const minutes = (at: number) => Math.max(0, Math.floor((now - at) / 60_000));
  const index = baseline ? readCheckoutStatIndex(root) : null;
  const budget = { files: VERIFY_FILES, bytes: VERIFY_BYTES };
  for (const file of newer.sort((a, b) => a.at - b.at))
    if (!baseline || !index || !savedBytes(root, file.path, baseline, index, budget)) return minutes(file.at);
  return null;
}
/** True when the file at path still holds its saved baseline bytes and mode. */
function savedBytes(
  root: string,
  path: string,
  baseline: Map<string, { blob: string; mode: string }>,
  index: ReturnType<typeof readCheckoutStatIndex>,
  budget: { files: number; bytes: number },
) {
  const old = baseline.get(path);
  if (!old) return false;
  try {
    const absolute = join(root, path),
      stat = lstatSync(absolute);
    if (!stat.isFile()) return false;
    const mode = stat.mode & 0o111 ? 'executable' : 'file';
    if (mode !== old.mode) return false;
    if (indexedBlob(index, path, stat, old.blob)) return true;
    if (budget.files <= 0 || budget.bytes < stat.size) return false;
    budget.files--;
    budget.bytes -= stat.size;
    return digest(readFileSync(absolute)) === old.blob;
  } catch {
    return false;
  }
}

export function checkpointNudge(
  root: string,
  laneId: string | undefined,
  defaults: EffectiveAgentDefaults | undefined,
  minutes: number | null,
  /** A live landing froze the saved source: report unsaved time, never advise a checkpoint. */
  frozen = false,
) {
  if (minutes === null || !defaults) return {};
  return {
    unsavedFor: minutes,
    ...(!frozen && defaults.checkpointNudgeMinutes > 0 && minutes >= defaults.checkpointNudgeMinutes
      ? {
          nudge: `Unsaved edits for ${minutes} min; save now: ${command(root, 'save', laneId ? { laneId, message: 'checkpoint' } : { message: 'checkpoint' })}`,
        }
      : {}),
  };
}
