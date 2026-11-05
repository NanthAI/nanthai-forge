// SPDX-License-Identifier: Apache-2.0
import { cliStartup } from './cli-version.js';
let entryPoint = false;
let preparation: Promise<void> | undefined;
/** The executable entry owns startup; direct CLI/module callers retain their lifecycle. */
export function enableCliRuntimePreparation() {
  entryPoint = true;
}
export function cliRuntimeCallbacks(args: string[]) {
  return entryPoint
    ? {
        beforeDispatch: (input?: { stdin?: string }) => cliCommandReady(args, input),
        beforeLocal: () => prepareCliRuntime(args),
      }
    : {};
}
/** Prepare this pinned runtime once, after valid work passed freshness checks. */
export function prepareCliRuntime(args = process.argv.slice(2)) {
  return (preparation ??= (async () => {
    process.env.UV_THREADPOOL_SIZE ??= '16';
    if (!args.includes('uninstall-hooks') && !args.includes('install-hooks')) {
      const { ensureEditHooks } = await import('./agent-install-hooks.js');
      ensureEditHooks();
    }
    try {
      const { sweepClientDisk } = await import('./forge-disk.js');
      sweepClientDisk();
    } catch {
      /* advisory */
    }
  })());
}
export async function cliCommandReady(args = process.argv.slice(2), input?: { stdin?: string }) {
  if (!(await cliStartup(args, undefined, undefined, { ...input, validated: true }))) return false;
  await prepareCliRuntime(args);
  return true;
}
