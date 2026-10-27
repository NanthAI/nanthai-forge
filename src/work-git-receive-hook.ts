// SPDX-License-Identifier: Apache-2.0
import { nativeContributionScope, receiveContribution } from './work-git-receive.js';
import { ForgeError } from './errors.js';
try {
  const scope = nativeContributionScope.parse(
    JSON.parse(Buffer.from(process.argv[2] ?? '', 'base64').toString('utf8')),
  );
  let update = '';
  for await (const bytes of process.stdin) {
    update += String(bytes);
    if (Buffer.byteLength(update) > 4096) throw new Error('Invalid native ref input.');
  }
  await receiveContribution(scope, update);
  process.stdout.write(`Original source retained in Forge Lane ${scope.operationId}.\n`);
} catch (error) {
  process.stderr.write(
    error instanceof ForgeError
      ? `[${error.code}] ${error.message}\n`
      : 'Forge contribution was not confirmed. Existing source/work are retained; reconcile the original operation URL.\n',
  );
  process.exitCode = 1;
}
