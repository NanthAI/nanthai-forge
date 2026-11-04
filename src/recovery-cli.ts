// SPDX-License-Identifier: Apache-2.0
import { readFileSync } from 'node:fs';
import { ForgeError, invariant } from './errors.js';
import { hostedActionError } from './hosted-action-error.js';
import { recoverRunner } from './recovery-runner.js';

export const RECOVERY_HELP = `nforge recover NEW_DIRECTORY --command-file REQUEST.json
Request: {operationId,url,projectId}. No credentials in this file.
Route B restores a runner/cache under hosted authority; it creates no accepting owner.
Run nforge login URL using existing owner access. Keep the operationId and destination on retry.
Recovery never restarts commands. Start a recovered server worker separately with
nforge worker URL PROJECT_ID MACHINE_UUID using its existing configuration/collector credentials.
Weekly deployment ZIP restoration remains a separate operator procedure.
`;
export async function recoveryCli(args: string[]) {
  if (!args.length || args.includes('--help')) {
    process.stdout.write(RECOVERY_HELP);
    return;
  }
  const [root, ...flags] = args;
  invariant(
    root && flags.length === 2 && flags[0] === '--command-file' && flags[1],
    'BAD_ARGUMENT',
    RECOVERY_HELP,
  );
  const input: unknown = JSON.parse(readFileSync(flags[1], 'utf8'));
  try {
    return await recoverRunner(root, input);
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
