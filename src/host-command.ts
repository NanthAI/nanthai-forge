// SPDX-License-Identifier: Apache-2.0
import { readRecoveryInventory } from './recovery-inventory.js';
import { readAutoExchangeStatus } from './auto-exchange-status.js';
import { consumeOwnerRequests, startOwnerAcceptanceListener } from './owner-acceptance-consumer.js';
import { flushAgentSync } from './agent-hosted-sync.js';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { WorkStore } from './work-store.js';
import { readHostState, updateHostState } from './host-binding.js';
import { hostProject, HOST_HELP, type HostOptions } from './host-cli.js';
import { formatHostProgress } from './host-progress.js';
import { ForgeError, invariant } from './errors.js';
export async function hostCli(args: string[]) {
  if (!args.length || args.includes('--help')) {
    process.stdout.write(HOST_HELP);
    return;
  }
  const json = args.includes('--json');
  const [root, ...flags] = args.filter(arg => arg !== '--json');
  invariant(root && !root.startsWith('-'), 'BAD_ARGUMENT', HOST_HELP);
  if (flags.length === 1 && flags[0] === '--sync-agent') {
    const store = new WorkStore(root);
    const result = await flushAgentSync(store);
    await consumeOwnerRequests(store).catch(() => {});
    return result;
  }
  if (flags.length === 1 && flags[0] === '--listen') {
    const store = new WorkStore(root);
    const binding = readHostState(store).binding;
    invariant(binding, 'HOST_NOT_BOUND', 'Host this owner first.');
    invariant(
      binding.acceptanceOwner === true,
      'OWNER_NOT_CANONICAL',
      'Run the acceptance listener on the original canonical owner; this binding has no canonical-owner role.',
    );
    process.stderr.write('Listening for hosted acceptance requests; stop with Ctrl+C.\n');
    const stop = startOwnerAcceptanceListener(store, error =>
      process.stderr.write(
        `${error instanceof ForgeError ? error.message : 'Owner connection unavailable; retrying.'}\n`,
      ),
    );
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
    return;
  }
  if (flags.length === 1 && ['--no-auto-sync', '--auto-sync'].includes(flags[0]!)) {
    return updateHostState(new WorkStore(root), state => {
      invariant(state.binding, 'HOST_NOT_BOUND', 'Host this owner first.');
      state.binding.autoSync = flags[0] === '--auto-sync';
      return { autoSync: state.binding.autoSync, sourcePush: 'explicit' };
    });
  }
  if (flags.includes('--status')) {
    invariant(flags.length === 1, 'BAD_ARGUMENT', HOST_HELP);
    const state = readHostState(new WorkStore(root));
    return {
      autoExchange: readAutoExchangeStatus(new WorkStore(root)),
      recovery: await readRecoveryInventory(root),
      bound: Boolean(state.binding),
      canonicalOwner: state.binding?.acceptanceOwner === true,
      ownerRole:
        state.binding?.acceptanceOwner === true
          ? 'canonical owner'
          : state.binding?.acceptanceOwner === false
            ? 'independent copy'
            : 'legacy binding: canonical-owner role not recorded',

      historyBackfilling: Boolean(state.hosting?.ready),
      status: state.hosting?.ready
        ? 'history backfilling'
        : state.hosting
          ? 'hosting'
          : state.binding
            ? 'complete'
            : 'not hosted',
      progress: state.hosting?.progress ?? null,
      errorCode: state.hosting?.errorCode ?? null,
      binding: state.binding ?? null,
      pendingAgentSync: state.agentSync?.pending.length ?? 0,
      pending: state.hosting ?? null,
      pendingPushes: [...(state.push ? [state.push] : []), ...(state.pendingPushes ?? [])],
    };
  }
  const backfill = flags.includes('--backfill'),
    wait = flags.includes('--wait');
  const options: HostOptions = {
    deferBackfill: !backfill && !wait,
    onProgress: event => {
      if (json) process.stdout.write(`${JSON.stringify(event)}\n`);
      else if (!backfill) process.stderr.write(`${formatHostProgress(event)}\n`);
    },
  };
  for (let i = 0; i < flags.length; i++) {
    const flag = flags[i]!;
    if (flag === '--backfill' || flag === '--wait') continue;
    if (flag === '--new') options.new = true;
    else if (['--deployment', '--name', '--visibility'].includes(flag)) {
      const value = flags[++i];
      invariant(value && !value.startsWith('--'), 'BAD_ARGUMENT', HOST_HELP);
      if (flag === '--deployment') options.deployment = value;
      else if (flag === '--name') options.name = value;
      else {
        invariant(value === 'private' || value === 'public', 'BAD_ARGUMENT', HOST_HELP);
        options.visibility = value;
      }
    } else invariant(false, 'BAD_ARGUMENT', HOST_HELP);
  }
  const result = await hostProject(root, options).catch(error => {
    // A detached worker can fail before transport starts (for example expired
    // login). Preserve a safe code for --status, never the provider's text.
    if (backfill)
      updateHostState(new WorkStore(root), state => {
        if (state.hosting)
          state.hosting.errorCode = error instanceof ForgeError ? error.code : 'HOST_INTERRUPTED';
      });
    throw error;
  });
  await consumeOwnerRequests(new WorkStore(root)).catch(() => {});
  if ('historyBackfilling' in result && result.historyBackfilling) {
    const child = spawn(
      process.execPath,
      [fileURLToPath(new URL('./cli.js', import.meta.url)), 'host', root, '--backfill'],
      { detached: true, stdio: 'ignore', env: process.env },
    );
    child.once('error', () =>
      updateHostState(new WorkStore(root), state => {
        if (state.hosting?.operationId === result.operationId)
          state.hosting.errorCode = 'HOST_WORKER_START_FAILED';
      }),
    );
    child.unref();
  }
  return json ? { type: 'host-result', ...result } : result;
}
