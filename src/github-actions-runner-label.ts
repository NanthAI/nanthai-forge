// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';

// Dispatch inputs are strings (at most 65,535 characters in total). Keep label
// data bounded without restricting custom provider names to an invented alphabet.
const label = z
  .string()
  .min(1)
  .max(256)
  .refine(value => value.trim().length > 0 && !/[\x00-\x1f\x7f]/.test(value), {
    message: 'Runner labels must be nonblank and contain no control characters.',
  });
export const githubActionsRunsOnSchema = z.union([label, z.array(label).min(1).max(100)]);
export type GithubActionsRunsOn = z.infer<typeof githubActionsRunsOnSchema>;

// Standard GitHub labels. Custom labels cannot reveal their billing provider
// without consulting the repository's runner inventory; never imply they are free.
const githubHosted = new Set([
  'ubuntu-latest',
  'ubuntu-slim',
  'ubuntu-22.04',
  'ubuntu-24.04',
  'ubuntu-26.04',
  'ubuntu-22.04-arm',
  'ubuntu-24.04-arm',
  'ubuntu-26.04-arm',
  'windows-latest',
  'windows-2022',
  'windows-2025',
  'windows-2025-vs2026',
  'windows-11-arm',
  'windows-11-vs2026-arm',
  'macos-latest',
  'macos-14',
  'macos-15',
  'macos-26',
  'macos-15-intel',
  'macos-26-intel',
  'xcode-27',
]);
/** Every label is a standard GitHub-hosted runner; only then must OIDC say `github-hosted`. */
export function githubHostedRunsOn(runsOn: GithubActionsRunsOn) {
  return (typeof runsOn === 'string' ? [runsOn] : runsOn).every(value =>
    githubHosted.has(value.toLowerCase()),
  );
}
export function githubActionsRunnerDescription(runsOn: GithubActionsRunsOn) {
  const labels = typeof runsOn === 'string' ? [runsOn] : runsOn;
  const display = typeof runsOn === 'string' ? runsOn : JSON.stringify(runsOn);
  return `runner: ${display}${labels.every(value => githubHosted.has(value.toLowerCase())) ? '' : ' (not GitHub-hosted: billed by your runner provider)'}`;
}
