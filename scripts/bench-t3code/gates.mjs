// SPDX-License-Identifier: Apache-2.0
// B1.5d cell start gates. A refusal means nothing ran; the driver waits and retries.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sharedDeps } from './deps.mjs';
import { agentOf } from './agent.mjs';
import { probeFilesystemEvents, filesystemEventRefusal } from '../filesystem-event-health.mjs';

/** Shared standalone-preflight and per-cell gate; always probe the workspace volume. */
export async function filesystemEventGate(targetDirectory, probe = probeFilesystemEvents) {
  const filesystemEvents = await probe(targetDirectory);
  const refusal = filesystemEventRefusal(filesystemEvents);
  return { filesystemEvents, refusals: refusal ? [refusal] : [] };
}

/** GiB available on the data volume, the same figure `df -g /System/Volumes/Data` prints. */
export function diskFreeGb() {
  const line = execFileSync('df', ['-k', '/System/Volumes/Data'], { encoding: 'utf8' })
    .trim()
    .split('\n')
    .at(-1)
    .trim()
    .split(/\s+/);
  return Number(line[3]) / 1024 / 1024;
}

/** Estimated peak disk of a cell: full-tree checkouts (.repos included, ~0.5 GB each). */
export function diskNeed(arm, N, dry) {
  const parts =
    arm === 'github'
      ? { hub: 0.6, checkouts: N * 0.5 }
      : { laneRoots: N * 0.5, resetVerifyAndOracleRoots: 1.5 };
  if (!dry) parts.buildAndTestCaches = N * 0.2;
  const needGb = Object.values(parts).reduce((a, b) => a + b, 0);
  return { parts, needGb, floorGb: 15, requiredGb: 15 + needGb };
}

/** Usage windows of the run's agent provider (`codex-usage` / `claude-usage`). A window is gated
 * only when the provider reports it: the Claude plan reports a 5h window only while one is open
 * (no window means no 5h use to wait for), the Codex plan a weekly one and a 5h one if it has it.
 * An unreadable probe refuses (weekly null). */
export function usageGate(provider = 'codex') {
  try {
    const u = JSON.parse(execFileSync(`${provider}-usage`, ['--json'], { encoding: 'utf8' }));
    return {
      provider,
      session5h: u.session5h?.usedPercent ?? null,
      has5h: Boolean(u.session5h),
      weekly: u.weekly?.usedPercent ?? null,
      checkedAt: u.checkedAt,
    };
  } catch {
    return { provider, session5h: null, has5h: provider === 'claude', weekly: null, error: 'unreadable' };
  }
}

/** Weekly stop from `config.usageGate.weeklyStopPercent`: 85 by default; null means the owner pays
 * past the weekly limit with credits, so only an unreadable probe or the 5h window waits. */
export const weeklyStopOf = config => {
  const v = config?.usageGate?.weeklyStopPercent;
  return v === null ? null : typeof v === 'number' ? v : 85;
};

/** Why a cell may not start on these usage readings: weekly at or above the stop, or a 5h window > 40%. */
export function usageProblems(u, weeklyStop = 85) {
  const p = [];
  if (u.error) p.push(`${u.provider} usage unreadable`);
  else if (weeklyStop !== null && (u.weekly === null || u.weekly >= weeklyStop))
    p.push(`${u.provider} weekly usage ${u.weekly}% at or above ${weeklyStop}%`);
  if (u.has5h && (u.session5h === null || u.session5h > 40))
    p.push(`${u.provider} 5h usage ${u.session5h}% above 40%`);
  return p;
}

/** Every start rule from PLAN.md, with the readings behind it. */
export async function gates(
  { arm, N, dry, config, start, flags, B, pinProblems, snapshotProblems, differences, pinFile },
  { filesystemProbe = probeFilesystemEvents } = {},
) {
  const { filesystemEvents, refusals } = await filesystemEventGate(join(B, 'ws'), filesystemProbe);
  if (refusals.length) return { refusals, warnings: [], filesystemEvents };
  const pin = await pinProblems(start.harness);
  if (pin.length && !(dry && flags.includes('--unpinned')))
    refusals.push(`harness not pinned: ${pin.join(', ')}`);
  // A dry run cannot freeze other builders' landings: main-tracking readings are warnings.
  const liveMain = dry;
  const warnings = [];
  // In a batch the driver brought the held CLI to main at batch start; main may move since.
  const inBatch = Boolean(pinFile);
  refusals.push(...snapshotProblems(start, { requireFreeze: !dry, liveMain, inBatch }));
  if (liveMain)
    warnings.push(...snapshotProblems(start, { requireFreeze: false }).filter(p => !refusals.includes(p)));
  let runPin = null;
  if (pinFile) {
    runPin = JSON.parse(readFileSync(pinFile, 'utf8'));
    const d = differences(runPin, start, { liveMain, unpinned: dry && flags.includes('--unpinned') });
    if (d.length) refusals.push(`versions differ from the run pin: ${d.join('; ')}`);
  }
  const usage = usageGate(agentOf(config).provider);
  if (!dry) {
    refusals.push(...usageProblems(usage));
    if (config.qualifiedHarness !== start.harness.commit)
      refusals.push(
        `no passing dry run of harness ${start.harness.commit?.slice(0, 12)} (config.qualifiedHarness)`,
      );
    if (!sharedDeps(B, config.baseCheckout)) refusals.push('shared dependency install missing (deps.mjs)');
  }
  if (config.forge.mainBase !== config.github.mainBase)
    refusals.push('both arms must start from one base tree (config forge.mainBase = github.mainBase)');
  if (!existsSync(join(B, 'PLAN.md'))) refusals.push('PLAN.md missing in BENCH_ROOT');
  const disk = { freeGb: diskFreeGb(), ...diskNeed(arm, N, dry) };
  if (disk.freeGb < disk.requiredGb)
    refusals.push(`disk ${disk.freeGb.toFixed(1)} GB free < ${disk.requiredGb.toFixed(1)} GB required`);
  return {
    refusals,
    warnings,
    filesystemEvents,
    pinProblems: pin,
    runPin: runPin ? { at: runPin.at } : null,
    usage,
    disk,
  };
}
