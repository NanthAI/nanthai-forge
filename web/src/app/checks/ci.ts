// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// "Which CI do you have?" (Item 0c9207b8): the four answers, drawn alike, and which one main's own files point to.
// Pure: it reads the names in one page of main's root folder (use-workflows.ts) and never opens or runs a CI file. A
// file it did not see is never reported as absent: with more root entries than one page, nothing is preselected.

export type Ci = 'github' | 'gitlab' | 'other' | 'none';
export const CI_ORDER: readonly Ci[] = ['github', 'gitlab', 'other', 'none'];
export const ciTitles: Record<Ci, string> = {
  github: 'GitHub Actions',
  gitlab: 'GitLab CI',
  other: 'Another CI, or your own machines',
  none: 'No CI yet',
};

/** What main's root says about each CI: a .github folder, GitLab's file, or another CI's file or folder. */
export type CiFiles = { github: boolean; gitlab: string | null; other: string | null };
type RootEntry = { name: string; kind: string };

const GITLAB = '.gitlab-ci.yml';
/** Root files and folders that other CI systems read. Shown by path, as found. */
const OTHER = new Set([
  '.buildkite',
  '.circleci',
  '.teamcity',
  '.woodpecker',
  '.cirrus.yml',
  '.drone.yml',
  '.travis.yml',
  '.woodpecker.yml',
  'Jenkinsfile',
  'appveyor.yml',
  'azure-pipelines.yml',
  'bitbucket-pipelines.yml',
]);

export function ciFiles(root: readonly RootEntry[]): CiFiles {
  return {
    github: root.some(entry => entry.kind === 'dir' && entry.name === '.github'),
    gitlab: root.some(entry => entry.kind === 'file' && entry.name === GITLAB) ? GITLAB : null,
    other: root.find(entry => OTHER.has(entry.name))?.name ?? null,
  };
}

/** The answer to preselect. `complete`: the whole root was read, so "no CI file" is a fact and not a guess. */
export function ciPreferred(files: CiFiles, workflows: number, complete: boolean): Ci | undefined {
  if (workflows > 0) return 'github';
  if (files.gitlab) return 'gitlab';
  if (files.other) return 'other';
  return complete ? 'none' : undefined;
}

/** The one line under an answer: what Forge found on main for it, or nothing. */
export function ciFact(ci: Ci, files: CiFiles, workflows: number) {
  if (ci === 'github')
    return workflows > 0
      ? `${workflows.toLocaleString()} workflow file${workflows === 1 ? '' : 's'} on main.`
      : '';
  const found = ci === 'gitlab' ? files.gitlab : ci === 'other' ? files.other : null;
  return found ? `${found} on main.` : '';
}
