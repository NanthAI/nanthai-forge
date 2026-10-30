// SPDX-License-Identifier: Apache-2.0
import { GitSyncError, redactGitStderr, retrySyncGit, syncGit, syncGitSleep } from './github-sync-git.js';
import {
  ActionsPushFailed,
  ActionsPushUnknown,
  actionsPushFailureMessage,
  type ActionsAttempt,
} from './github-actions-infra.js';
import type { ActionsJournal } from './github-actions-export.js';
import type { RemoteCheckPlan } from './remote-check-plan.js';

const PUSH_ATTEMPTS = 5;
const DISCOVERY_MS = 60_000;
const DISCOVERY_OBSERVATIONS = 5;
const delays = [2_000, 4_000, 8_000, 16_000, 30_000];
// At most two pushes per check repo at once inside this process.
const pushGates = new Map<string, Promise<void>[]>();
async function gated<T>(repo: string, use: () => Promise<T>) {
  const active = pushGates.get(repo) ?? [];
  pushGates.set(repo, active);
  while (active.length >= 2) await Promise.race(active);
  const turn = use();
  const slot = turn.then(
    () => undefined,
    () => undefined,
  );
  active.push(slot);
  try {
    return await turn;
  } finally {
    active.splice(active.indexOf(slot), 1);
    if (!active.length) pushGates.delete(repo);
  }
}
export async function ensureActionsPush(
  plan: RemoteCheckPlan,
  journal: ActionsJournal,
  save: () => void,
  git = syncGit,
  sleep = syncGitSleep,
  progress?: (message: string) => void,
  now = Date.now,
) {
  const ref = `refs/heads/forge-check/${plan.runId}`,
    remote = `https://github.com/${journal.repo}.git`;
  if (journal.pushFailure) throw new ActionsPushFailed(journal.pushFailure);
  const fail = (code: string, message: string): never => {
    journal.pushFailure = { code, message };
    journal.terminal = true;
    save();
    throw new ActionsPushFailed(journal.pushFailure);
  };
  const exhausted = () =>
    fail(
      'GITHUB_ACTIONS_PUSH_EXHAUSTED',
      `GitHub Actions check push exhausted ${PUSH_ATTEMPTS} attempts for the same commit and run-owned ref; no matching ref was observed. Infrastructure failed without a source verdict. Inspect retained push diagnostics and start a new check after resolving Git access or transport failures.`,
    );
  const discover = () =>
    retrySyncGit(
      async () => {
        const observed = (await git(plan.source, ['ls-remote', '--refs', remote, ref])).trim();
        (journal.branchEvidence ??= []).push({
          source: 'git',
          observedAt: new Date(now()).toISOString(),
          commit: observed ? observed.split('\t')[0]! : null,
        });
        if (journal.pushDiscovery && !observed) journal.pushDiscovery.observations++;
        save();
        if (observed && observed !== `${journal.commit}\t${ref}`)
          fail(
            'EVIDENCE_CHANGED',
            'Actions run ref already names different source; refusing to overwrite it.',
          );
        return !!observed;
      },
      sleep,
      progress,
    );
  const adopt = () => {
    journal.pushed = true;
    save();
  };
  const lookup = async () => {
    // Old journals resume from their earliest retained observation, never a fresh window per launch.
    journal.pushDiscovery ??= {
      startedAt:
        journal.pushAttempts?.at(-1)?.startedAt ??
        journal.branchEvidence?.[0]?.observedAt ??
        new Date(now()).toISOString(),
      observations: 0,
    };
    save();
    const window = journal.pushDiscovery;
    const complete = () =>
      window.observations >= DISCOVERY_OBSERVATIONS && now() - Date.parse(window.startedAt) >= DISCOVERY_MS;
    for (let poll = 0; !complete() && poll < DISCOVERY_OBSERVATIONS; poll++) {
      const remaining = DISCOVERY_MS - (now() - Date.parse(window.startedAt));
      const delay = delays[Math.min(window.observations, delays.length - 1)]!;
      await sleep(remaining > 0 ? Math.min(delay, remaining) : delay);
      if (await discover()) {
        adopt();
        return true;
      }
    }
    if (!complete()) throw new ActionsPushUnknown();
    (journal.discovery ??= []).push({ phase: 'push', observedAt: new Date(now()).toISOString(), matches: 0 });
    save();
    return false;
  };
  if (await discover()) return adopt();
  for (;;) {
    const previous = journal.pushAttempts?.at(-1);
    const rejected =
      journal.pushOutcome === 'rejected' && previous?.outcome === 'rejected' && !!previous.rejectionClass;
    if (rejected && previous.retryable !== true) {
      fail('GITHUB_ACTIONS_PUSH_REJECTED', actionsPushFailureMessage(previous.rejectionClass!));
    }
    const unresolved = journal.pushed || (journal.pushOutcome !== 'not-sent' && !rejected);
    if (unresolved) {
      journal.pushOutcome = 'ambiguous';
      save();
      if (await lookup()) return;
    }
    // Legacy journals without attempts may have sent once before their first durable outcome.
    const attempts = (journal.pushAttempts ??= unresolved ? [{ outcome: 'ambiguous' }] : []);
    if (attempts.length >= PUSH_ATTEMPTS) exhausted();
    if (unresolved)
      progress?.(
        `Actions push absent after bounded discovery; retry ${attempts.length + 1}/${PUSH_ATTEMPTS} with the identical commit and create-only ref lease. A changed ref is never overwritten; cleanup uses the same exact-commit lease.`,
      );
    if (rejected) {
      const ms = Math.min(16_000, 2_000 * 2 ** (attempts.length - 1)) * (0.5 + Math.random());
      progress?.(
        `Git push transient failure; retry ${attempts.length + 1}/5 in ${Math.ceil(ms / 1000)} s after checking the exact remote ref.`,
      );
      await sleep(ms);
    }
    // Recheck immediately before every replacement, including after the discovery/backoff wait.
    if ((unresolved || rejected) && (await discover())) return adopt();
    const attempt: ActionsAttempt = { outcome: 'ambiguous', startedAt: new Date(now()).toISOString() };
    attempts.push(attempt);
    journal.pushDiscovery = { startedAt: attempt.startedAt!, observations: 0 };
    journal.pushOutcome = 'ambiguous';
    save();
    try {
      await gated(journal.repo, () =>
        git(plan.source, ['push', `--force-with-lease=${ref}:`, remote, `${journal.commit}:${ref}`]),
      );
      attempt.outcome = journal.pushOutcome = 'accepted';
      return adopt();
    } catch (error) {
      if (error instanceof GitSyncError) {
        attempt.detail = redactGitStderr(error.detail);
        if (error.rejectionClass) {
          attempt.outcome = journal.pushOutcome = 'rejected';
          attempt.rejectionClass = error.rejectionClass;
          attempt.retryable = error.transient && error.rejectionClass === 'ref-rejected';
        }
      }
      save();
      progress?.(`Actions push ${attempt.outcome}${attempt.detail ? `; git said "${attempt.detail}"` : ''}.`);
    }
  }
}
