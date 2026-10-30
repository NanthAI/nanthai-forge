import { CUTOVER_UPGRADE } from './cutover-version.js';
// SPDX-License-Identifier: Apache-2.0
import { workerPath } from './worker-install.js';
import { transitionBoundSourceAuthority } from './source-authority-client.js';
import { cutoverBoundProject, boundCutoverPins } from './source-cutover-client.js';
import { readFileSync } from 'node:fs';
import { deleteHostedProject, parseDeleteProjectOptions } from './host-delete.js';
import { checkServiceEnv } from './worker-environment.js';
import { effectivePolicy as childPolicy } from './autonomy-policy.js';
import { readRecoveryInventory } from './recovery-inventory.js';

import { spawn } from 'node:child_process';

import { WorkStore } from './work-store.js';
import { readHostState, updateHostState, abandonPendingHost } from './host-binding.js';
import { hostProject, HOST_HELP, type HostOptions } from './host-cli.js';
import { formatHostProgress } from './host-progress.js';
import { ForgeError, invariant } from './errors.js';
export async function hostCli(args: string[], host: typeof hostProject = hostProject) {
  if (!args.length || args.includes('--help')) {
    process.stdout.write(HOST_HELP);
    return;
  }
  const json = args.includes('--json');
  const [root, ...flags] = args.filter(arg => arg !== '--json');
  invariant(root && !root.startsWith('-'), 'BAD_ARGUMENT', HOST_HELP);
  if (flags.length === 1 && flags[0] === '--cutover-pins') return boundCutoverPins(new WorkStore(root));
  if (flags[0] === '--cutover-file') {
    invariant(
      flags[1] && flags.length === 3 && ['--dry-run', '--apply'].includes(flags[2]!),
      'BAD_ARGUMENT',
      'Use --cutover-file REQUEST.json --dry-run or --apply.',
    );
    return cutoverBoundProject(
      new WorkStore(root),
      JSON.parse(readFileSync(flags[1], 'utf8')),
      flags[2] === '--dry-run',
    );
  }
  if (flags.length === 2 && flags[0] === '--source-authority')
    return transitionBoundSourceAuthority(new WorkStore(root), JSON.parse(flags[1]!));
  if (flags[0] === '--abandon-pending') {
    invariant(
      flags.length === 4 && flags[2] === '--confirm' && flags[1] && flags[3],
      'BAD_ARGUMENT',
      'Use --abandon-pending OPERATION_UUID --confirm OPERATION_UUID.',
    );
    return abandonPendingHost(new WorkStore(root), flags[1], flags[3]);
  }
  if (flags.includes('--delete-project')) {
    const result = await deleteHostedProject(root, {
      ...parseDeleteProjectOptions(flags),
      onProgress: message => {
        if (json) process.stdout.write(`${JSON.stringify({ type: 'host-delete-progress', message })}\n`);
        else process.stderr.write(`${message}\n`);
      },
    });
    return json ? { type: 'host-delete-result', ...result } : result;
  }
  if (flags.some(flag => ['--listen', '--sync-agent', '--auto-sync', '--no-auto-sync'].includes(flag)))
    throw new ForgeError('CLI_UPGRADE_REQUIRED', CUTOVER_UPGRADE);
  if (flags.includes('--status') || (json && flags.length === 0)) {
    invariant(flags.length === 0 || flags.length === 1, 'BAD_ARGUMENT', HOST_HELP);
    const store = new WorkStore(root, { readOnly: true });
    const state = readHostState(store);
    return {
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
      agentSyncError: state.agentSync?.headError ?? null,
      agentSyncNextAttemptAt: state.agentSync?.nextAttemptAt ?? null,
      rejectedAgentSync: state.agentSync?.rejected ?? [],
      discardedAgentSync: state.agentSync?.discarded ?? 0,
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
    if (flag === '--backfill' || flag === '--wait' || flag === '--resume') continue;
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
  if (!flags.includes('--resume'))
    invariant(
      !readHostState(new WorkStore(root, { readOnly: true })).hosting,
      'HOST_RESUME_REQUIRED',
      'Hosting is pending. Read host ROOT --status, or use host ROOT --resume to continue it.',
    );
  const result = await host(root, options).catch(error => {
    // A detached worker can fail before transport starts (for example expired
    // login). Preserve a safe code for --status, never the provider's text.
    if (backfill)
      updateHostState(new WorkStore(root), state => {
        if (state.hosting)
          state.hosting.errorCode = error instanceof ForgeError ? error.code : 'HOST_INTERRUPTED';
      });
    throw error;
  });
  if ('historyBackfilling' in result && result.historyBackfilling) {
    const store = new WorkStore(root);
    // FORGE_AUTH_TOKEN authenticates this worker's hosted source/metadata requests.
    const child = spawn(
      process.execPath,
      [workerPath(new URL('./cli.js', import.meta.url)), 'host', root, '--backfill', '--resume'],
      {
        detached: true,
        stdio: 'ignore',
        env: checkServiceEnv(
          store.page('checks', 0, Number.MAX_SAFE_INTEGER).records,
          childPolicy(store.readRecords()?.data() ?? store.load()),
          ['FORGE_AUTH_TOKEN', 'FORGE_DEPLOYMENT_URL'],
        ),
      },
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
