// SPDX-License-Identifier: Apache-2.0
import { invariant } from './errors.js';
import { WorkStore } from './work-store.js';
import { releaseJson } from './maintainer-release-files.js';
import { releaseRequestSchema } from './maintainer-release-schema.js';
import { maintainerRelease, readMaintainerRelease, releaseSummary } from './maintainer-release.js';

export const RELEASE_HELP = `nforge release ROOT --command-file FILE
nforge release ROOT --resume UUID [--reconcile OBSERVATION_FILE]
nforge release ROOT --status UUID
Explicit maintainer release: accepted main → export → build → dev backend → web → package → install → select CLI.
FILE: {operationId,runtimeDirectory,configurationDirectory,cliPath,npmCli,reuseExport?}.
Reuse the original UUID to resume the original source, even after main moves.
Provider outcomes without a success receipt stay unknown; inspect the original deployment before reconciling.
See docs/operations/release.md. Landing and recovery exchange are independent.
`;
export function maintainerReleaseCli(args: string[]) {
  if (!args.length || args.includes('--help')) {
    process.stdout.write(RELEASE_HELP);
    return;
  }
  const [root, action, value] = args;
  invariant(
    root &&
      value &&
      (args.length === 3 || (action === '--resume' && args.length === 5 && args[3] === '--reconcile')),
    'BAD_ARGUMENT',
    RELEASE_HELP,
  );
  const store = new WorkStore(root);
  if (action === '--status') return releaseSummary(readMaintainerRelease(store, value));
  const result =
    action === '--command-file'
      ? maintainerRelease(store, releaseRequestSchema.parse(releaseJson(value)))
      : action === '--resume'
        ? maintainerRelease(store, value, args[4] ? { reconcile: releaseJson(args[4]) } : {})
        : undefined;
  invariant(result, 'BAD_ARGUMENT', RELEASE_HELP);
  if (!result.complete) process.exitCode = 1;
  return result;
}
