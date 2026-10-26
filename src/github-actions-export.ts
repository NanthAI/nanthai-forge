// SPDX-License-Identifier: Apache-2.0
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { commitActionsSnapshot } from './github-actions-commit.js';
import { retrySyncGit, syncGit, syncGitSleep } from './github-sync-git.js';
import { durableReplace } from './native-durability.js';
import { invariant } from './errors.js';
import { githubActionsRecipe, githubActionsWorkflow } from './github-actions-workflow.js';
import type { JobUsage } from './check-cost.js';
import type { ModalPlan } from './modal-plan.js';
import type { ActionsFailure } from './github-actions-api.js';
import { ensureActionsPush } from './github-actions-push.js';
import type { ActionsAttempt, ActionsBranchEvidence, ActionsDiscovery } from './github-actions-infra.js';
import type { ActionsJobLogEvidence } from './github-actions-job-evidence.js';

export type ActionsJournal = {
  pin: string;
  repo: string;
  runsOn: string;
  rateUsdPerMinute?: number | null;
  jobUsage?: JobUsage[];
  commit?: string;
  pushed?: boolean;
  pushOutcome?: 'not-sent' | 'ambiguous' | 'accepted' | 'rejected';
  pushAttempts?: ActionsAttempt[];
  pushDiscovery?: { startedAt: string; observations: number };
  pushFailure?: { code: string; message: string };
  dispatchAttempts?: ActionsAttempt[];
  branchEvidence?: ActionsBranchEvidence[];
  discovery?: ActionsDiscovery[];
  dispatching?: boolean;
  dispatchOutcome?: 'accepted' | 'rejected' | 'ambiguous';
  dispatchStatus?: number;
  dispatchError?: ActionsFailure;
  apiFailures?: ActionsFailure[];
  dispatchRejections?: number;
  dispatchLookupExhausted?: boolean;
  dispatchDiscovery?: { startedAt: string; observations: number };
  dispatchFailure?: { code: string; message: string };
  dispatchRecoveryUsed?: boolean;
  runId?: number;
  retrying: number[];
  retrySources: Record<string, number>;
  logged: number[];
  oom: number[];
  states: Record<string, string>;
  stuckJobs?: Record<string, ActionsJobLogEvidence & { runConclusion: string | null; message: string }>;
  deleted?: boolean;
  terminal?: boolean;
};
export function actionsJournal(path: string, plan: ModalPlan, repo: string, runsOn: string) {
  const filename = join(path, 'github-actions.json');
  const journal: ActionsJournal = existsSync(filename)
    ? JSON.parse(readFileSync(filename, 'utf8'))
    : { pin: plan.pin, repo, runsOn, retrying: [], retrySources: {}, logged: [], oom: [], states: {} };
  invariant(journal.pin === plan.pin, 'EVIDENCE_CHANGED', 'Retained Actions plan changed.');
  return { journal, save: () => durableReplace(filename, JSON.stringify(journal)) };
}
export async function exportActionsSnapshot(
  plan: ModalPlan,
  journal: ActionsJournal,
  save: () => void,
  git = syncGit,
  commit = commitActionsSnapshot,
  sleep = syncGitSleep,
  progress?: (message: string) => void,
) {
  const root = plan.source;
  if (!journal.commit) {
    for (const directory of ['.github', '.github/workflows']) {
      const path = join(root, directory);
      invariant(
        !existsSync(path) || (lstatSync(path).isDirectory() && !lstatSync(path).isSymbolicLink()),
        'EVIDENCE_CHANGED',
        'Actions generated directory is not a directory.',
      );
      mkdirSync(path, { recursive: true });
    }
    const generated = new Map([
      ['.github/workflows/forge-check.yml', githubActionsWorkflow(journal.runsOn)],
      ['.github/forge-check-plan.json', JSON.stringify(githubActionsRecipe(plan))],
    ]);
    for (const [name, text] of generated) {
      const path = join(root, name!);
      invariant(
        !existsSync(path) || !lstatSync(path).isSymbolicLink(),
        'EVIDENCE_CHANGED',
        'Actions generated file is a symbolic link.',
      );
      writeFileSync(path, text!, { mode: 0o600 });
    }
    journal.commit = commit(plan, generated);
    journal.pushOutcome = 'not-sent';
    save();
  }
  await ensureActionsPush(plan, journal, save, git, sleep, progress);
}
export async function deleteActionsRef(
  plan: ModalPlan,
  journal: ActionsJournal,
  save: () => void,
  git = syncGit,
  sleep = syncGitSleep,
  progress?: (message: string) => void,
) {
  if (journal.deleted) return;
  const ref = `refs/heads/forge-check/${plan.runId}`,
    remote = `https://github.com/${journal.repo}.git`;
  // Deletion needs no source objects. A reclaimed export can use an empty disposable Git repo.
  const temporary = existsSync(join(plan.source, '.git'))
    ? undefined
    : mkdtempSync(join(tmpdir(), 'forge-ref-cleanup-'));
  const root = temporary ?? plan.source;
  try {
    if (temporary) await git(root, ['init', '--bare', '--template=']);
    await retrySyncGit(
      async () => {
        const observed = (await git(root, ['ls-remote', '--refs', remote, ref])).trim();
        if (observed) {
          invariant(
            observed === `${journal.commit}\t${ref}`,
            'EVIDENCE_CHANGED',
            'Actions cleanup refused changed ref.',
          );
          await git(root, ['push', `--force-with-lease=${ref}:${journal.commit}`, remote, `:${ref}`]);
        }
      },
      sleep,
      progress,
    );
    journal.deleted = true;
    save();
  } finally {
    if (temporary) rmSync(temporary, { recursive: true, force: true });
  }
}
