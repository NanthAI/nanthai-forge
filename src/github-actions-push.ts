// SPDX-License-Identifier: Apache-2.0
import { GitSyncError, retrySyncGit, syncGit, syncGitSleep } from './github-sync-git.js';
import { ActionsPushUnknown, pushRejectionClass, type ActionsAttempt } from './github-actions-infra.js';
import { invariant } from './errors.js';
import type { ActionsJournal } from './github-actions-export.js';
import type { ModalPlan } from './modal-plan.js';

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
  plan: ModalPlan,
  journal: ActionsJournal,
  save: () => void,
  git = syncGit,
  sleep = syncGitSleep,
  progress?: (message: string) => void,
) {
  const ref = `refs/heads/forge-check/${plan.runId}`,
    remote = `https://github.com/${journal.repo}.git`;
  const discover = () =>
    retrySyncGit(
      async () => {
        const observed = (await git(plan.source, ['ls-remote', '--refs', remote, ref])).trim();
        (journal.branchEvidence ??= []).push({
          source: 'git',
          observedAt: new Date().toISOString(),
          commit: observed ? observed.split('\t')[0]! : null,
        });
        save();
        invariant(
          !observed || observed === `${journal.commit}\t${ref}`,
          'EVIDENCE_CHANGED',
          'Actions run ref already names different source.',
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
  if (await discover()) return adopt();
  // Old commit-only journals may have died after sending. Never infer absence.
  const unresolved = () => {
    const previous = journal.pushAttempts?.at(-1);
    const definitiveRejection =
      journal.pushOutcome === 'rejected' &&
      previous?.outcome === 'rejected' &&
      ['ref-rejected', 'access-rejected'].includes(previous.rejectionClass ?? '');
    return journal.pushed || (journal.pushOutcome !== 'not-sent' && !definitiveRejection);
  };
  const lookup = async () => {
    for (const delay of [2_000, 4_000, 8_000, 16_000, 30_000]) {
      await sleep(delay);
      if (await discover()) return adopt();
    }
    (journal.discovery ??= []).push({ phase: 'push', observedAt: new Date().toISOString(), matches: 0 });
    save();
    progress?.(
      'pending-infra: push not yet visible; later reconciliation will adopt the original ref, without another push.',
    );
    throw new ActionsPushUnknown();
  };
  if (unresolved()) {
    if (!journal.pushOutcome || journal.pushOutcome === 'rejected') {
      journal.pushOutcome = 'ambiguous';
      save();
    }
    return lookup();
  }
  let first = true;
  await retrySyncGit(
    async () => {
      // A definitive rejection authorizes another attempt, still under the exact lease.
      if (!first) {
        if (await discover()) return adopt();
        if (unresolved()) return lookup();
      }
      first = false;
      const attempt: ActionsAttempt = { outcome: 'ambiguous' };
      (journal.pushAttempts ??= []).push(attempt);
      journal.pushOutcome = 'ambiguous';
      save();
      try {
        await gated(journal.repo, () =>
          git(plan.source, ['push', `--force-with-lease=${ref}:`, remote, `${journal.commit}:${ref}`]),
        );
        attempt.outcome = journal.pushOutcome = 'accepted';
        journal.pushed = true;
        save();
      } catch (error) {
        const rejection = error instanceof GitSyncError ? pushRejectionClass(error.detail) : undefined;
        if (rejection) {
          attempt.outcome = journal.pushOutcome = 'rejected';
          attempt.rejectionClass = rejection;
        }
        save();
        if (rejection) throw error;
        progress?.('Actions push response ambiguous; looking up the original ref.');
        await lookup();
      }
    },
    sleep,
    progress,
  );
}
