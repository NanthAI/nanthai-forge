// SPDX-License-Identifier: Apache-2.0
// The GitHub mirror in one sentence (Item c63c2171): the same words on the web Mirror screen and in
// `nforge github status`, from the recorded facts only (no clock), including an honest "no mirror".
import type { HostedMirrorStatus } from './hosted-github-mirror-status.js';

export type MirrorDirection = 'off' | 'one-way' | 'two-way';
/** The states the Mirror screen draws with the two-ends pattern. */
export type MirrorState =
  | 'off'
  | 'paused'
  | 'level'
  | 'behind'
  | 'retrying'
  | 'moved'
  | 'inbound-failed'
  | 'refused'
  | 'stopped'
  | 'not-pushed'
  | 'unknown';
export type MirrorPolicy = { repo: string; autoPush?: boolean; inbound?: boolean } | null | undefined;
export type MirrorSummary = {
  repository: string | null;
  direction: MirrorDirection;
  state: MirrorState;
  /** Act now (needs a person), watch (moving by itself) or reference (nothing to do). */
  weight: 'act' | 'watch' | 'reference';
  sentence: string;
  /** One plain next action, or null when nothing needs anyone. */
  next: string | null;
};

export function mirrorDirection(policy: MirrorPolicy): MirrorDirection {
  return !policy?.autoPush ? 'off' : policy.inbound ? 'two-way' : 'one-way';
}

/** `project` names the project in commands (a path or an id); the web passes '.'. */
export function mirrorSummary(
  policy: MirrorPolicy,
  status: HostedMirrorStatus | null | undefined,
  project = '.',
): MirrorSummary {
  const direction = mirrorDirection(policy);
  const repository = status?.repository ?? policy?.repo ?? null;
  const base = { repository, direction };
  if (policy && !policy.autoPush)
    return {
      ...base,
      state: 'paused',
      weight: 'reference',
      sentence: `The mirror to ${policy.repo} is paused; the link stays, and landings stay on Forge until you resume.`,
      next: null,
    };
  if (direction === 'off')
    return {
      ...base,
      state: 'off',
      weight: 'reference',
      sentence: `No mirror. Landings stay on Forge${repository ? ` and ${repository} on GitHub is not updated` : ''}.`,
      next: `nforge github connect ${project} --repo ${repository ?? 'OWNER/NAME'} (a person allows it on GitHub once)`,
    };
  const repo = repository!;
  const back =
    direction === 'two-way'
      ? 'and pushes there come back as landings'
      : 'and pushes made on GitHub are not taken in';
  if (!status)
    return {
      ...base,
      state: 'unknown',
      weight: 'reference',
      sentence: `The mirror to ${repo} is on (${direction}); its status is known once the project's main is hosted.`,
      next: null,
    };
  const stopped = (state: MirrorState, why: string): MirrorSummary => ({
    ...base,
    state,
    weight: 'act',
    sentence: `${why} Landings on Forge continue.`,
    next: status.nextStep ?? null,
  });
  if (status.status === 'failed') {
    if (status.error === 'GITHUB_INBOUND_FAILED')
      return {
        ...base,
        state: 'inbound-failed',
        weight: 'act',
        sentence:
          'A push on GitHub failed its check here, so the next landing takes it out of GitHub’s main. Landings on Forge continue.',
        next: 'fix and land the Lane named in the detail to keep that change, or let it drop',
      };
    if (status.error === 'GITHUB_SYNC_CHANGED')
      return stopped('moved', `GitHub’s main moved without Forge, so the mirror to ${repo} stopped.`);
    if (status.error === 'GITHUB_SYNC_API')
      return stopped('refused', `GitHub refused Forge’s push to ${repo}, so the mirror stopped.`);
    return stopped('stopped', `The mirror to ${repo} stopped (${status.error ?? 'failed'}).`);
  }
  if (status.status === 'retrying')
    return {
      ...base,
      state: 'retrying',
      weight: 'watch',
      sentence: `GitHub is behind: a push to ${repo} failed and Forge retries it${status.nextAttemptAt === null ? '' : ` at ${new Date(status.nextAttemptAt).toISOString()}`}. Nothing needs you yet.`,
      next: null,
    };
  if (status.status === 'syncing' || status.lagging)
    return status.mirroredHead === null && status.status !== 'syncing'
      ? {
          ...base,
          state: 'not-pushed',
          weight: 'reference',
          sentence: `The mirror to ${repo} is on (${direction}); the next landing pushes Forge main there.`,
          next: null,
        }
      : {
          ...base,
          state: 'behind',
          weight: 'watch',
          sentence: `GitHub is behind Forge; Forge is pushing to ${repo} in order. Nothing needs you.`,
          next: null,
        };
  if (status.status === 'synced')
    return {
      ...base,
      state: 'level',
      weight: 'reference',
      sentence: `GitHub is level with Forge. Each landing pushes one commit to ${repo}, ${back}.`,
      next: null,
    };
  return {
    ...base,
    state: 'not-pushed',
    weight: 'reference',
    sentence: `The mirror to ${repo} is on (${direction}); the next landing pushes Forge main there.`,
    next: null,
  };
}
