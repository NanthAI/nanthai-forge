// SPDX-License-Identifier: Apache-2.0
import { readFileSync } from 'node:fs';
import { ForgeError, invariant } from './errors.js';
import { hostedActionError } from './hosted-action-error.js';
import { recoverOwner, reconnectOwner } from './recovery-owner.js';

export const RECOVERY_HELP = `nforge recover NEW_OWNER --command-file REQUEST.json
nforge recover OWNER reconnect|client --command-file REQUEST.json
Request: {operationId,url,projectId,archivePath?,cacheRoot?}. No credentials in this file.
Run nforge login URL with existing project-owner authority. Guided restore requires a fresh destination.
The guided command obtains a matching checkpoint and hosted journal, restores all saved Lanes and
available evidence, reports coverage, and explicitly reconnects to the existing project as owner.
archivePath selects this project's exact native .tar.gz checkpoint. A weekly deployment ZIP must
first be imported into a fresh deployment with matching application/auth/configuration; see recovery-drill.
Retry the same request/destination after interruption, including a lost reconnect reply.
reconnect binds an existing independent restore as owner; client returns an old owner to an independent
copy without consuming canonical requests. Open current source separately with exchange pull --target.
No lease, access condition, source acceptance, push, process restart or new hosted project is created.
`;
export async function recoveryCli(args: string[]) {
  if (!args.length || args.includes('--help')) {
    process.stdout.write(RECOVERY_HELP);
    return;
  }
  const [root, action] = args,
    mode = action === 'reconnect' || action === 'client' ? action : null,
    flags = args.slice(mode ? 2 : 1);
  invariant(
    root && flags.length === 2 && flags[0] === '--command-file' && flags[1],
    'BAD_ARGUMENT',
    RECOVERY_HELP,
  );
  const input: unknown = JSON.parse(readFileSync(flags[1], 'utf8'));
  try {
    return mode
      ? await reconnectOwner(root, input, mode === 'client' ? 'client' : 'owner')
      : await recoverOwner(root, input);
  } catch (error) {
    const problem = hostedActionError(error, 'recovery');
    throw problem.code === 'HOSTED_ACTION_FAILED'
      ? new ForgeError(
          problem.code,
          problem.message.replace('Push again to resume', 'Run the same recovery command to resume'),
        )
      : problem;
  }
}
