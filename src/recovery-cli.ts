// SPDX-License-Identifier: Apache-2.0
import { readFileSync } from 'node:fs';
import { ForgeError, invariant } from './errors.js';
import { hostedActionError } from './hosted-action-error.js';
import { recoverOwner, reconnectOwner } from './recovery-owner.js';

export const RECOVERY_HELP = `nforge recover NEW_DIRECTORY --command-file REQUEST.json
nforge recover OWNER reconnect|client --command-file REQUEST.json
Request: {operationId,url,projectId,archivePath?,cacheRoot?}. No credentials in this file.
Native-owner and server-shadow projects retain full owner recovery/reconnect. Native-owner
bound projects keep local acceptance, including after rollback to native-owner.
Server authority (or a pending switch to server) selects Route B runner/cache recovery instead.
It creates no native accepting owner and writes hosted only for normal runner registration.
Server Route B takes {operationId,url,projectId}; archivePath/cacheRoot belong to native recovery.
Run nforge login URL using existing owner access. Keep the operationId and destination on retry.
Recovery never restarts commands. Start a recovered server worker separately with
nforge worker URL PROJECT_ID MACHINE_UUID using its existing configuration/collector credentials.
Weekly deployment ZIP restoration and explicit higher-epoch authority rollback remain separate.
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
