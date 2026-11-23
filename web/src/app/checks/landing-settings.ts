// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// How a landing is checked, one row per setting (Item 871e9b73): the value in effect in words, where it comes from
// (the owner set it, the default, or Automatic: Forge picks it from the project's own data), and, behind the row, what
// the setting does, what it costs, how a change applies and the owner's command that changes it. Pure, from the policy
// the page already reads: no call. A setting with no effect on this project is not listed. Automatic is said only
// where Forge really picks from recorded data today (the size of a group checked together); the rest wait for Item
// bd0f850e. Every claim here follows the engine: src/hosted-landing-batch.ts, src/hosted-landing-admission.ts,
// src/landing-mode.ts and the owner gate and pinned digest in src/policy-digest.ts.
import type { AutonomyPolicy } from '../../../../src/autonomy-policy';
import type { LandingModeView } from '../../../../src/landing-mode';

type Acceptance = AutonomyPolicy['acceptance'];
export type SettingSource = 'set by the owner' | 'default' | 'Automatic';
/** How a set-policy edit of this setting applies (src/policy-digest.ts; before the first landing nothing is held,
 * convex/projectSettingApprovals.ts agentSettingRule): `held` waits for the owner when a CLI or agent sign-in sends it and restarts landings waiting in the queue; `fast-held` holds only a switch to fast and leaves
 * queued landings alone; `at-once` is never held and leaves queued landings alone. */
export type SettingChange = 'held' | 'fast-held' | 'at-once';
export type LandingSetting = {
  id: 'mode' | 'pre-queue' | 'group' | 'width' | 'early' | 'revert';
  title: string;
  value: string;
  source: SettingSource;
  /** A state that holds now and is not the setting itself (fast landing paused, and why). Shown on the shut line. */
  note?: string;
  /** What it does, then what it costs or saves. Shown only when the row is opened. */
  does: string;
  costs: string;
  change: SettingChange;
  /** The policy fragment an owner sends with set-policy to change it; `values` are the choices in words. */
  key: string;
  values: string;
  docs: string;
};

const from = (set: boolean): SettingSource => (set ? 'set by the owner' : 'default');

/** Changes waiting to land share checks only when landings land on a passing check and grouping is not turned off:
 * the same rule as `hostedBatching` (src/hosted-landing-batch.ts), which tests/app-check-routes.test.mjs pins. */
export const groupsChanges = (a: Acceptance) =>
  a.mode === 'auto-on-pass' && (a.landing === undefined || a.landing === 'batched');

export function landingSettings(policy: AutonomyPolicy, landing?: LandingModeView | null): LandingSetting[] {
  const paused = landing?.state === 'suspended' ? (landing.reason ?? 'not reported') : null;
  const a: Acceptance = policy.acceptance;
  const grouped = groupsChanges(a);
  const rows: LandingSetting[] = [
    {
      id: 'mode',
      title: 'Landing mode',
      value: a.landingMode === 'fast' ? (paused ? 'Fast, paused' : 'Fast') : 'Strict',
      source: from(a.landingMode !== undefined),
      ...(paused
        ? { note: `Landing strictly for now: ${paused.replace(/^Fast landing is paused: /, '')}` }
        : {}),
      does: 'Strict: a change lands on a check of exactly what reaches main, or on its own check when it is proved separate from what main gained. Fast: when main moved under a change and the overlap is only a tested doc or a shared root file that is not order-sensitive, the change lands on its own check and main is checked after the landing.',
      costs:
        'Strict runs a second check in those cases. Fast saves it and does not promise a green main at every landing: the next main check finds a break, and Forge reverts the one proven change or opens a fix. Fast pauses by itself while main is red, while main’s last check is too old, or after main broke often lately.',
      change: 'fast-held',
      key: 'acceptance.landingMode',
      values: '"strict" or "fast"',
      docs: '/docs/pre-queue-checks/#landing-modes',
    },
    ...(grouped
      ? [
          {
            id: 'pre-queue',
            title: 'Check before the queue',
            value:
              a.admissionCheck === 'full'
                ? 'On'
                : a.admissionCheck === true
                  ? 'On, affected tests only'
                  : 'Off',
            source: from(a.admissionCheck !== undefined),
            does: 'Off: a change is checked once, in the queue, together with what lands ahead of it. On: each Lane’s own check runs first, so a failing change never enters the queue.',
            costs:
              'On pays one more check per change. It earns that back when changes often fail their first check or checks are long; with mostly passing changes it costs minutes and time.',
            change: 'held',
            key: 'acceptance.admissionCheck',
            values: 'false or "full"',
            docs: '/docs/pre-queue-checks/#when-to-turn-it-off',
          } satisfies LandingSetting,
        ]
      : []),
    // Grouping is listed while landings land on a passing check: "One at a time" is then a real owner choice.
    ...(a.mode === 'auto-on-pass'
      ? [
          {
            id: 'group',
            title: 'Changes checked together',
            value: !grouped
              ? 'One at a time'
              : a.batchMaxSize !== undefined
                ? `Up to ${a.batchMaxSize.toLocaleString()}`
                : 'Up to 8',
            source: !grouped || a.batchMaxSize !== undefined ? 'set by the owner' : 'Automatic',
            does: 'Changes waiting to land share one check. When that check fails, Forge finds the failing change and the rest still land. When changes are checked before they queue, only changes that passed their own check are grouped, and a change waits for its group only while no runner slot is free (at most 5 minutes).',
            costs:
              'A larger group spends fewer minutes per change while changes pass, and more re-checks when one fails. Automatic picks the size from how often the last 20 shared checks failed.',
            change: 'held',
            // One at a time, the size has no effect: the setting that matters is whether changes are grouped.
            ...(grouped
              ? { key: 'acceptance.batchMaxSize', values: '1 to 8' }
              : { key: 'acceptance.landing', values: '"batched" to check changes together' }),
            docs: '/docs/operations/landing-batches/',
          } satisfies LandingSetting,
        ]
      : []),
    {
      id: 'early',
      title: 'Resolve a conflict early',
      value: a.earlyResolve === 'off' ? 'Off' : 'On',
      source: from(a.earlyResolve !== undefined),
      does: 'When a change will conflict with one that lands just ahead of it, its agent is told while the checks still run, not after they finish.',
      costs:
        'Saves the wait for a check that could not have landed. It changes advice only, never what a landing must pass.',
      change: 'at-once',
      key: 'acceptance.earlyResolve',
      values: '"on" or "off"',
      docs: '/docs/pre-queue-checks/#resolve-an-exact-predecessor-conflict-early',
    },
    {
      id: 'revert',
      title: 'Revert a change that breaks main',
      value: a.autoRevert === false ? 'Off' : 'On',
      source: from(a.autoRevert !== undefined),
      does: 'When main’s check fails after a landing and one change is proved to be the cause, Forge reverts that change. The revert is an ordinary landing and can be undone.',
      costs: 'Off leaves main failing until someone lands a fix; the failure still opens a "Fix main" Item.',
      change: 'held',
      key: 'acceptance.autoRevert',
      values: 'true or false',
      docs: '/docs/workflows/#hosted-acceptance-gate',
    },
  ];
  // Groups checked at once: listed only when the owner set it and groups are checked; unset, it is a fixed 6
  // (HOSTED_PIPELINE_GROUPS), not a choice the project made.
  if (grouped && policy.checks?.concurrency !== undefined)
    rows.splice(rows.findIndex(row => row.id === 'group') + 1, 0, {
      id: 'width',
      title: 'Groups checked at once',
      value: policy.checks.concurrency.toLocaleString(),
      source: 'set by the owner',
      does: 'How many groups of waiting changes are checked at the same time, each on top of the one ahead of it.',
      costs: 'More at once lands a busy queue sooner and wastes more checks when a group ahead fails.',
      change: 'held',
      key: 'checks.concurrency',
      values: '1 to 16',
      docs: '/docs/operations/landing-batches/',
    });
  return rows;
}

/** How a change to this setting applies, in words, for the owner reading the opened line. */
export const changeWords: Record<SettingChange, string> = {
  held: 'Sent from a CLI or agent sign-in once the project has landed anything, the change waits for your approval on the web. Once it applies, landings waiting in the queue are prepared again under it.',
  'fast-held':
    'Sent from a CLI or agent sign-in once the project has landed anything, a switch to fast waits for your approval on the web; back to strict applies at once. Landings waiting in the queue keep their place.',
  'at-once':
    'It applies at once, never waits for approval, and landings waiting in the queue keep their place.',
};

/** The owner's command for one setting, with the value left for the owner to fill in. */
export function settingCommand(setting: LandingSetting) {
  const [group, name] = setting.key.split('.');
  return `nforge x . set-policy '{"${group}":{"${name}":VALUE}}'`;
}
