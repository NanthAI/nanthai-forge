// SPDX-License-Identifier: Apache-2.0
import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { commitActionsSnapshot } from './github-actions-commit.js';
import { retrySyncGit, syncGit, syncGitSleep } from './github-sync-git.js';
import { durableReplace } from './native-durability.js';
import { invariant } from './errors.js';
import { githubActionsRecipe, githubActionsWorkflow } from './github-actions-workflow.js';
import type { ModalPlan } from './modal-plan.js';

export type ActionsJournal = {
  pin: string;
  repo: string;
  runsOn: string;
  commit?: string;
  pushed?: boolean;
  dispatching?: boolean;
  runId?: number;
  retrying: number[];
  retrySources: Record<string, number>;
  logged: number[];
  oom: number[];
  states: Record<string, string>;
  deleted?: boolean;
};
export function actionsJournal(path: string, plan: ModalPlan, repo: string, runsOn: string) {
  const filename = join(path, 'github-actions.json');
  const journal: ActionsJournal = existsSync(filename)
    ? JSON.parse(readFileSync(filename, 'utf8'))
    : { pin: plan.pin, repo, runsOn, retrying: [], retrySources: {}, logged: [], oom: [], states: {} };
  invariant(journal.pin === plan.pin, 'EVIDENCE_CHANGED', 'Retained Actions plan changed.');
  return { journal, save: () => durableReplace(filename, JSON.stringify(journal)) };
}
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
export async function exportActionsSnapshot(
  plan: ModalPlan,
  journal: ActionsJournal,
  save: () => void,
  git = syncGit,
  commit = commitActionsSnapshot,
  sleep = syncGitSleep,
  progress?: (message: string) => void,
) {
  const root = plan.source,
    ref = `refs/heads/forge-check/${plan.runId}`;
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
    save();
  }
  const remote = `https://github.com/${journal.repo}.git`;
  // A lost push response is reconciled by observing this exact run-owned ref.
  await retrySyncGit(
    async () => {
      const observed = (await git(root, ['ls-remote', '--refs', remote, ref])).trim();
      if (observed) {
        invariant(
          observed === `${journal.commit}\t${ref}`,
          'EVIDENCE_CHANGED',
          'Actions run ref already names different source.',
        );
      } else {
        await gated(journal.repo, () =>
          git(root, ['push', `--force-with-lease=${ref}:`, remote, `${journal.commit}:${ref}`]),
        );
      }
    },
    sleep,
    progress,
  );
  journal.pushed = true;
  save();
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
  await retrySyncGit(
    async () => {
      const observed = (await git(plan.source, ['ls-remote', '--refs', remote, ref])).trim();
      if (observed) {
        invariant(
          observed === `${journal.commit}\t${ref}`,
          'EVIDENCE_CHANGED',
          'Actions cleanup refused changed ref.',
        );
        await git(plan.source, ['push', `--force-with-lease=${ref}:${journal.commit}`, remote, `:${ref}`]);
      }
    },
    sleep,
    progress,
  );
  journal.deleted = true;
  save();
}
