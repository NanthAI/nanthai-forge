// SPDX-License-Identifier: Apache-2.0
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { HostedAgentTransport } from '../../dist/hosted-agent-transport.js';
import { workerCli } from '../../dist/worker-cli.js';
import { hostedSelfHostedRunnerSchema } from '../../dist/hosted-check.js';
import { hostedMacRuntime } from '../../dist/hosted-mac-lease.js';
import { checkEnvironment } from '../../dist/check-environment.js';

/** Configure and register using the existing authenticated owner flow. */
export async function startSelfHostedRunner(args, services = {}) {
  if (
    args.length < 3 ||
    args.length > 4 ||
    !/^https?:\/\//.test(args[0]) ||
    !/^[0-9a-f-]{36}$/i.test(args[2])
  )
    throw new Error('Use start.mjs DEPLOYMENT_URL PROJECT_ID MACHINE_UUID [LABELS_JSON_ARRAY].');
  const [url, projectId, machineId, labelsJson = '[]'] = args;
  const labels = JSON.parse(labelsJson);
  if (!Array.isArray(labels) || labels.some(label => typeof label !== 'string' || !label.length))
    throw new Error('Labels must be a JSON array of nonempty strings.');
  const root = process.env.FORGE_RUNNER_STATE_DIR ?? join(homedir(), '.cache', 'forge-runner');
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const transport =
    services.transport ?? new HostedAgentTransport(join(root, 'configuration'), { url, projectId });
  const configuration = hostedSelfHostedRunnerSchema.parse({
    provider: 'self-hosted',
    machineId,
    labels,
    platform: { os: process.platform, arch: process.arch },
    runtime: hostedMacRuntime,
    environmentFingerprint: checkEnvironment().fingerprint,
  });
  // Journal identity includes all pins. Restarts reconcile unknown replies with
  // the same operation; a changed environment creates a distinct request.
  await transport.dispatch('configure-runner', { configuration });
  process.stderr.write(
    'Configured self-hosted runner. Stop with Ctrl+C or SIGTERM; restore prior settings with configure-runner configuration:{...}.\n',
  );
  await (services.worker ?? workerCli)([url, projectId, machineId]);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await startSelfHostedRunner(process.argv.slice(2));
  } catch (error) {
    // Remote error bodies can contain credentials. Print only a stable code.
    process.stderr.write(
      `Self-hosted runner stopped (${error.code ?? 'RUNNER_START_FAILED'}). Check the address, credentials and runner settings.\n`,
    );
    process.exitCode = 1;
  }
}
