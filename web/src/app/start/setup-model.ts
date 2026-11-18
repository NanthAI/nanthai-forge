// SPDX-License-Identifier: Apache-2.0
// Getting started's rows from where the project's setup stands (convex/projectSetup.ts) and the line feed the project
// frame already reads. Pure: the screen renders these and tests read them. Each step says who did it and when when
// Forge recorded that, and says nothing it was not told.

/** The setup read's shape (convex/projectSetup.ts setupView), restated so the screen does not import server code. */
export type SetupView = {
  owner: string | null;
  viewerIsOwner: boolean;
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

type StepState = 'done' | 'next' | 'moving' | 'later';
export type SetupStep = {
  id: 'import' | 'repository' | 'mirror' | 'check' | 'agent' | 'land';
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
export function setupSteps(view: SetupView, project: string, lanes: number): SetupStep[] {
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
    view.repository
      ? {
          id: 'repository',
          title: 'Connect the GitHub repository',
          fact: view.repository.fullName,
          state: 'done',
          by: view.repository.by,
          at: view.repository.at,
        }
      : {
          id: 'repository',
          title: 'Connect the GitHub repository',
          fact: 'Only you can allow Forge on GitHub.',
          state: 'next',
        },
    view.mirror
      ? {
          id: 'mirror',
          title: 'Mirror main to GitHub',
          fact: `On. Each landing pushes one commit to ${view.mirror.repository}.`,
          state: 'done',
          at: view.mirror.at,
        }
      : {
          id: 'mirror',
          title: 'Mirror main to GitHub',
          fact: view.repository
            ? 'Off. A CI file checks Forge’s branches only through the mirror.'
            : 'After the repository.',
          state: view.repository ? 'next' : 'later',
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
          fact: 'Nothing can land until a check is chosen.',
          // Not held behind the GitHub mirror: only a CI file on GitHub needs it, and any CI can decide a landing.
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
  return steps;
}

/** Getting started shows until the first landing; then once more for the one question, until it is answered. */
export function gettingStartedShown(view: SetupView) {
  return !view.firstLanding || (view.viewerIsOwner && !view.approvalsAnswered);
}

/** Ask "who approves the next landings?" once: after the first landing, to the owner, until someone has set it. */
export function askWhoApproves(view: SetupView) {
  return !!view.firstLanding && view.viewerIsOwner && !view.approvalsAnswered;
}
