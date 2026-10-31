#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
import { supportedNode, nodeRequirement } from '../scripts/node-runtime.mjs';
import { ForgeError, invariant } from './errors.js';
import { describeFailure, recordFailure } from './system-errors.js';

// Checkout installs run 16 concurrent file operations; libuv reads this before its first use.
process.env.UV_THREADPOOL_SIZE ??= '16';
// Bounded local cleanup of Forge temp and peers caches, at most hourly; never fails a command.
try {
  const { sweepClientDisk } = await import('./forge-disk.js');
  sweepClientDisk();
} catch {
  /* advisory */
}
// Hosted clone needs no native owner, graph compiler or local execution services.
// Keep the established CLI as the entry for every other command and direct caller.
if (process.argv[2] !== 'clone') await import('./cli.js');
else {
  try {
    invariant(supportedNode(), 'UNSUPPORTED_NODE', nodeRequirement);
    const { hostedCloneCli } = await import('./hosted-clone-cli.js');
    const output = await hostedCloneCli(process.argv.slice(3));
    if (output !== undefined) process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
  } catch (error) {
    const failure = error instanceof ForgeError ? describeFailure(error) : recordFailure(error);
    process.stderr.write(`${JSON.stringify({ error: failure })}\n`);
    process.exitCode = 1;
  }
}
