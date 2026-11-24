#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { beginCheckoutPrepObservation } from './checkout-prep-observation.js';
import { isAbsolute } from 'node:path';
import { supportedNode, nodeRequirement } from '../scripts/node-runtime.mjs';
import { invariant } from './errors.js';
import { reportFailure } from './system-errors.js';
import { cliTeachContext } from './error-teaching.js';

if (['agent', 'x'].includes(process.argv[2]!)) beginCheckoutPrepObservation();

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
    const teaching = cliTeachContext(process.argv.slice(2));
    const failure = reportFailure(error, teaching);
    process.stderr.write(`${JSON.stringify({ error: failure })}\n`);
    process.exit(1);
  }
}

// Diagnose locally first; valid work passes freshness before hooks and execution.
let runCommand = false;
try {
  invariant(supportedNode(), 'UNSUPPORTED_NODE', nodeRequirement);
  if (process.env.FORGE_HELD_LAND_WORKER === '1') {
    const { activateMeasurementSubmitter } = (await import(
      /* @vite-ignore */ new URL('./hosted-land-measurement.js', import.meta.url).href
    )) as typeof import('./hosted-land-measurement.js');
    if (!(await activateMeasurementSubmitter(process.argv[3]!, JSON.parse(process.argv[5]!))))
      process.exit(1);
  }
  const { cliStartup } = await import('./cli-version.js');
  runCommand = await cliStartup();
} catch (error) {
  const teaching = cliTeachContext(process.argv.slice(2));
  const failure = reportFailure(error, teaching);
  process.stderr.write(`${JSON.stringify({ error: failure })}\n`);
  process.exitCode = 1;
}
if (runCommand) {
  const { cliDeferredCommand, cliDiagnosticCommand } = await import('./cli-version.js');
  // --version and --help only print: they never prepare the runtime (hooks, disk sweep).
  if (!cliDiagnosticCommand(process.argv.slice(2))) {
    (await import('./cli-command-ready.js')).enableCliRuntimePreparation();
    if (!cliDeferredCommand(process.argv.slice(2)))
      await (await import('./cli-command-ready.js')).prepareCliRuntime();
  }
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
      const teaching = cliTeachContext(process.argv.slice(2));
      const failure = reportFailure(error, teaching);
      process.stderr.write(`${JSON.stringify({ error: failure })}\n`);
      process.exitCode = 1;
    }
  }
}
