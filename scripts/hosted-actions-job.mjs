// SPDX-License-Identifier: Apache-2.0
import { writeFileSync, appendFileSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ActionsJobClient } from '../dist/hosted-actions-job-client.js';
import { hostedCheckRunSchema } from '../dist/hosted-check.js';
const client = new ActionsJobClient(
  process.env.FORGE_CONVEX_SITE,
  process.env.FORGE_PROJECT_ID,
  process.env.FORGE_RUN_ID,
);
const directory = resolve(process.env.FORGE_CANDIDATE);
if (process.argv[2] === 'plan') {
  const { prepareActionsJob } = await import('../dist/hosted-actions-job-plan.js');
  const result = await prepareActionsJob(
    client,
    directory,
    resolve(process.env.RUNNER_TEMP, 'forge-objects'),
  );
  writeFileSync(resolve(process.env.RUNNER_TEMP, 'forge-actions-plan.json'), JSON.stringify(result.recipe));
  writeFileSync(
    resolve(process.env.RUNNER_TEMP, 'forge-actions-run.json'),
    JSON.stringify({ ...result.run, capabilities: client.capabilities }),
  );
  appendFileSync(
    process.env.GITHUB_OUTPUT,
    `matrix=${JSON.stringify(result.matrix)}\npack_refresh=${result.packRefresh.refresh}\n`,
  );
  // Keep source refresh out of the plan/artifact dependency path.
  writeFileSync(
    resolve(process.env.RUNNER_TEMP, 'forge-pack-refresh.json'),
    JSON.stringify(result.packRefresh),
  );
} else if (process.argv[2] === 'pack') {
  const { refreshActionsSourcePack } = await import('../dist/hosted-actions-job-pack.js');
  const { SourceWorkerReader } = await import('../dist/hosted-source-worker-reader.js');
  try {
    restoreRun();
    if (!client.capabilities.includes('sourcePack')) process.exit(0);
    const cache = resolve(process.env.RUNNER_TEMP, 'forge-objects');
    const source = JSON.parse(
      readFileSync(resolve(process.env.RUNNER_TEMP, 'forge-pack-refresh.json'), 'utf8'),
    );
    client.sourcePack = source.sourcePack;
    const { warmPackCache } = await import('../dist/hosted-actions-job-pack.js');
    await warmPackCache(source.state, directory, cache);
    source.connection = client.transport();
    source.reader = new SourceWorkerReader(cache, source.connection.transport);
    await refreshActionsSourcePack(client, source, cache);
  } catch {
    console.log('source pack: refresh skipped');
  }
} else {
  restoreRun();
  const { executeActionsJob } = await import('../dist/hosted-actions-job-run.js');
  process.exitCode = await executeActionsJob(
    client,
    directory,
    resolve(process.env.RUNNER_TEMP, 'forge-actions-plan.json'),
    process.env.FORGE_ACTIONS_SHARD,
  );
}

function restoreRun() {
  const { capabilities = [], ...run } = JSON.parse(
    readFileSync(resolve(process.env.RUNNER_TEMP, 'forge-actions-run.json'), 'utf8'),
  );
  client.run = hostedCheckRunSchema.parse(run);
  client.capabilities = Array.isArray(capabilities)
    ? capabilities.filter(value => typeof value === 'string')
    : [];
}
