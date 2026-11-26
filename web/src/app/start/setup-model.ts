// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// Getting started's rows from where the project's setup stands (convex/projectSetup.ts) and the line feed the project
// frame already reads. Pure: the screen renders these and tests read them. Each step says who did it and when when
// Forge recorded that, and says nothing it was not told.

/** The setup read's shape (convex/projectSetup.ts setupView), restated so the screen does not import server code. */
export type SetupView = {
  owner: string | null;
  viewerIsOwner: boolean;
  offerEarnedTrust?: true;
  created: { at: number; by: string | null };
  repository: { fullName: string; at: number; by: string | null } | null;
  mirror: { repository: string; at: number } | null;
  check:
    | { kind: 'ci-file'; repository: string; workflow: string; chosenAt: number }
    | { kind: 'forge-runner'; repository: string | null; publicLogs: boolean; chosenAt: number }
    | { kind: 'machine'; chosenAt: number }
    | { kind: 'other'; provider: string; chosenAt: number }
    | null;
  firstLanding: { at: number } | null;
  approvalsAnswered: boolean;
};

export type SkippableStep = 'import' | 'github' | 'agent' | 'land';
export type SetupVisibility = 'automatic' | 'hidden' | 'shown';
export type SetupPreferences = { visibility: SetupVisibility; skipped: SkippableStep[]; revision: number };
export type SetupChange = { visibility: SetupVisibility } | { step: SkippableStep; skip: boolean };
export const defaultSetupPreferences: SetupPreferences = {
  visibility: 'automatic',
  skipped: [],
  revision: 0,
};

type StepState = 'done' | 'next' | 'moving' | 'later' | 'skipped';
export type SetupStep = {
  id: SkippableStep | 'check';
  optional?: boolean;
  title: string;
  fact: string;
  state: StepState;
  by?: string | null;
  at?: number;
};

/** What the check that decides a landing is, in a few words. */
export function checkWords(check: NonNullable<SetupView['check']>) {
  switch (check.kind) {
    case 'ci-file':
      return `${check.workflow}, on ${check.repository} GitHub Actions`;
    case 'forge-runner':
      return `Forge’s check workflow, on ${check.repository ?? 'a runner repository'} GitHub Actions`;
    case 'machine':
      return 'A machine you run';
    case 'other':
      return `A ${check.provider} runner`;
  }
}

/** The steps in the order they usually happen; any order works. `lanes` is how many Lanes the line shows now. */
export function setupSteps(
  view: SetupView,
  project: string,
  lanes: number,
  skipped: readonly SkippableStep[] = [],
): SetupStep[] {
  const landed = !!view.firstLanding;
  const steps: SetupStep[] = [
    {
      id: 'import',
      title: `Import ${project}`,
      fact: 'History kept. GitHub is unchanged.',
      state: 'done',
      by: view.created.by,
      at: view.created.at,
    },
    {
      id: 'github',
      optional: true,
      title: 'Connect GitHub (optional)',
      fact: view.repository
        ? `${view.repository.fullName} connected. Use it to mirror main or run a CI file on GitHub Actions.`
        : 'Connect for a mirror or to run a CI file on GitHub Actions.',
      state: view.repository ? 'done' : 'next',
      by: view.repository?.by,
      at: view.repository?.at,
    },
    view.check
      ? {
          id: 'check',
          title: 'Choose the check that decides a landing',
          fact: checkWords(view.check),
          state: 'done',
          at: view.check.chosenAt,
        }
      : {
          id: 'check',
          title: 'Choose the check that decides a landing',
          fact: 'A check is required to land. Bring your own CI; GitHub is not required.',
          state: 'next',
        },
    lanes > 0 || landed
      ? { id: 'agent', title: 'Connect an agent', fact: 'An agent has started a Lane.', state: 'done' }
      : {
          id: 'agent',
          title: 'Connect an agent',
          fact: 'Paste one line into the agent app you already use. You approve its device once.',
          state: 'next',
        },
    landed
      ? {
          id: 'land',
          title: 'Land a first change',
          fact: 'On main, checked by your check.',
          state: 'done',
          at: view.firstLanding!.at,
        }
      : lanes > 0
        ? {
            id: 'land',
            title: 'Land a first change',
            fact: 'A Lane is on its way. A held landing shows under Needs you.',
            state: 'moving',
          }
        : {
            id: 'land',
            title: 'Land a first change',
            fact: 'Your agent picks something small, and it reaches main.',
            state: 'later',
          },
  ];
  return steps.map(step =>
    step.id !== 'check' && skipped.includes(step.id) ? { ...step, state: 'skipped' } : step,
  );
}

export function setupProgress(steps: SetupStep[]) {
  const counted = steps.filter(step => !step.optional && step.state !== 'skipped');
  return { done: counted.filter(step => step.state === 'done').length, total: counted.length };
}

/** Getting started shows until the first landing; then once more for the one question, until it is answered. */
export function gettingStartedShown(view: SetupView) {
  return !view.firstLanding || (view.viewerIsOwner && !view.approvalsAnswered);
}

/** Ask "who approves the next landings?" once: after the first landing, to the owner, until someone has set it. */
export function askWhoApproves(view: SetupView) {
  return !!view.firstLanding && view.viewerIsOwner && !view.approvalsAnswered;
}
