#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
import { isAbsolute } from 'node:path';
import { supportedNode, nodeRequirement } from '../scripts/node-runtime.mjs';
import { ForgeError, invariant } from './errors.js';
import { describeFailure, recordFailure } from './system-errors.js';

// Check before hook setup and imports that resolve relative paths.
try {
  process.cwd();
} catch {
  const root = ['agent', 'x', 'status', 'pull'].includes(process.argv[2]!) ? process.argv[3] : undefined;
  const advice =
    root && isAbsolute(root)
      ? `cd '${root.replaceAll("'", "'\\''")}'`
      : 'cd /, then cd /absolute/path/to/your/Forge/checkout';
  process.stderr.write(
    `${JSON.stringify({
      error: {
        code: 'CWD_UNAVAILABLE',
        message: `The current working directory was removed or is unavailable. Run ${advice} and retry the original command.`,
      },
    })}\n`,
  );
  process.exit(1);
}

// `nforge wait ID` is the short resume form for this session's own recorded wait.
if (process.argv[2] === 'wait') {
  try {
    const { resolveTurnWait } = await import('./agent-turn-wait.js');
    process.argv.splice(2, process.argv.length - 2, ...resolveTurnWait(process.argv.slice(3)));
  } catch (error) {
    const failure = error instanceof ForgeError ? describeFailure(error) : recordFailure(error);
    process.stderr.write(`${JSON.stringify({ error: failure })}\n`);
    process.exit(1);
  }
}

// Diagnose locally first; valid work passes freshness before hooks and execution.
let runCommand = false;
try {
  invariant(supportedNode(), 'UNSUPPORTED_NODE', nodeRequirement);
  const { cliStartup } = await import('./cli-version.js');
  runCommand = await cliStartup();
} catch (error) {
  const failure = error instanceof ForgeError ? describeFailure(error) : recordFailure(error);
  process.stderr.write(`${JSON.stringify({ error: failure })}\n`);
  process.exitCode = 1;
}
if (runCommand) {
  (await import('./cli-command-ready.js')).enableCliRuntimePreparation();
  if (!(await import('./cli-version.js')).cliDeferredCommand(process.argv.slice(2)))
    await (await import('./cli-command-ready.js')).prepareCliRuntime();
  // Hosted clone needs no native owner, graph compiler or local execution services.
  // Keep the established CLI as the entry for every other command and direct caller.
  if (!['clone', 'pull'].includes(process.argv[2]!)) await import('./cli.js');
  else {
    try {
      invariant(supportedNode(), 'UNSUPPORTED_NODE', nodeRequirement);
      const { hostedCloneCli } = await import('./hosted-clone-cli.js');
      const beforeDispatch = async () => (await import('./cli-command-ready.js')).cliCommandReady();
      const beforeLocal = async () => (await import('./cli-command-ready.js')).prepareCliRuntime();
      const output =
        process.argv[2] === 'pull'
          ? await (
              await import('./hosted-pull-cli.js')
            ).hostedPullCli(process.argv.slice(3), beforeDispatch, beforeLocal)
          : await hostedCloneCli(process.argv.slice(3), undefined, beforeDispatch, beforeLocal);
      if (output !== undefined) process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
    } catch (error) {
      const failure = error instanceof ForgeError ? describeFailure(error) : recordFailure(error);
      process.stderr.write(`${JSON.stringify({ error: failure })}\n`);
      process.exitCode = 1;
    }
  }
}
