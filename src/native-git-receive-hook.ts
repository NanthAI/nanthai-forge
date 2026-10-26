// SPDX-License-Identifier: Apache-2.0
import { nativeGitReceiveScopeSchema, receiveNativeGitContribution } from './native-git-receive.js';
import { ForgeError } from './errors.js';
try {
  const scope = nativeGitReceiveScopeSchema.parse(
    JSON.parse(Buffer.from(process.argv[2] ?? '', 'base64').toString('utf8')),
  );
  let update = '';
  for await (const bytes of process.stdin) {
    update += String(bytes);
    if (Buffer.byteLength(update) > 4096) throw new Error('Invalid Git ref input.');
  }
  await receiveNativeGitContribution(scope, update);
  process.stdout.write(`Original source retained in native Forge Lane ${scope.operationId}.\n`);
} catch (error) {
  process.stderr.write(
    error instanceof ForgeError
      ? `[${error.code}] ${error.message}\n`
      : 'Forge contribution was not confirmed. Reconcile the original operation URL.\n',
  );
  process.exitCode = 1;
}
