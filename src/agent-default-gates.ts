// SPDX-License-Identifier: Apache-2.0
import { existsSync, lstatSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { ForgeError } from './errors.js';
import { shellQuote } from './agent-brief-render.js';
import { preflightPlan, readPreflightReceipt } from './agent-preflight.js';
import { answerId } from './hosted-overlap-notice.js';
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
  lane: { laneId: string; head: string },
  advice: Advice | undefined,
) {
  const advisories: Record<string, unknown> = {};
  if (!defaults) return advisories;
  const pending = advice?.unacknowledgedOverlaps.items ?? [];
  if (defaults.overlapGate !== 'off' && pending.length) {
    const ack = command(root, 'ack', { laneId: lane.laneId });
    const files = pending.map(item => item.file).join(', ');
    if (defaults.overlapGate === 'block')
      throw new ForgeError(
        'OVERLAP_UNANSWERED',
        `Answer the overlap notice(s) on ${files} before landing (project overlapGate: block). Keep your change and land in order: ${ack}. Or route around: add "choice":"split". Then land again.`,
      );
    advisories.overlap = { status: 'unanswered', files: pending.map(item => item.file), acknowledge: ack };
  }
  if (defaults.preflight !== 'off') {
    const receipt = readPreflightReceipt(root, lane.laneId);
    if (receipt?.head === lane.head && receipt.passed)
      advisories.preflight = { status: 'passed', tests: receipt.tests, at: receipt.at };
    else {
      const plan = preflightPlan(root, advice?.changedPaths);
      const run = command(root, 'preflight', { laneId: lane.laneId });
      if (plan.status === 'unavailable')
        advisories.preflight = { status: 'unavailable', reason: plan.reason };
      else if (plan.tests.length) {
        const summary = {
          tests: plan.tests.length,
          selected: plan.tests.slice(0, 20),
          estimateMinutes: plan.estimateMinutes,
          run,
        };
        const failed = receipt?.head === lane.head ? ' Its last run failed.' : '';
        if (defaults.preflight === 'require' && plan.estimateMinutes <= defaults.preflightMaxMinutes)
          throw new ForgeError(
            'PREFLIGHT_REQUIRED',
            `Run the ${plan.tests.length} affected test file(s) for saved head ${lane.head.slice(0, 12)} first (about ${plan.estimateMinutes} min): ${run}.${failed} Then land again.`,
          );
        advisories.preflight = {
          status: 'advised',
          ...summary,
          ...(defaults.preflight === 'require' ? { reason: `over ${defaults.preflightMaxMinutes} min` } : {}),
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

const IGNORED = new Set(['node_modules', 'dist', '.forge', '.git', '.turbo', 'coverage']);
/** Minutes the oldest unsaved edit has waited, from file times against the checkout marker's
 * save time. Local stat only (no reads, no server call); null when nothing is newer. */
export function unsavedMinutes(root: string, now = Date.now()) {
  const marker = join(root, '.forge', 'hosted-lane.json');
  if (!existsSync(marker)) return null;
  const savedAt = statSync(marker).mtimeMs;
  let oldest = Infinity,
    visited = 0;
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (++visited > 20_000) return;
      if (IGNORED.has(entry.name)) continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile()) {
        const at = lstatSync(path).mtimeMs;
        if (at > savedAt && at < oldest) oldest = at;
      }
    }
  };
  walk(root);
  return oldest === Infinity ? null : Math.max(0, Math.floor((now - oldest) / 60_000));
}

export function checkpointNudge(
  root: string,
  laneId: string | undefined,
  defaults: EffectiveAgentDefaults | undefined,
  minutes: number | null,
) {
  if (minutes === null || !defaults) return {};
  return {
    unsavedFor: minutes,
    ...(defaults.checkpointNudgeMinutes > 0 && minutes >= defaults.checkpointNudgeMinutes
      ? {
          nudge: `Unsaved edits for ${minutes} min; save now: ${command(root, 'save', laneId ? { laneId, message: 'checkpoint' } : { message: 'checkpoint' })}`,
        }
      : {}),
  };
}
