// SPDX-License-Identifier: Apache-2.0
import { writeFileSync, appendFileSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ActionsJobClient } from '../dist/hosted-actions-job-client.js';
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
  writeFileSync(resolve(process.env.RUNNER_TEMP, 'forge-actions-run.json'), JSON.stringify(result.run));
  appendFileSync(process.env.GITHUB_OUTPUT, `matrix=${JSON.stringify(result.matrix)}\n`);
} else {
  const { hostedCheckRunSchema } = await import('../dist/hosted-check.js');
  client.run = hostedCheckRunSchema.parse(
    JSON.parse(readFileSync(resolve(process.env.RUNNER_TEMP, 'forge-actions-run.json'), 'utf8')),
  );
  const { executeActionsJob } = await import('../dist/hosted-actions-job-run.js');
  process.exitCode = await executeActionsJob(
    client,
    directory,
    resolve(process.env.RUNNER_TEMP, 'forge-actions-plan.json'),
    process.env.FORGE_ACTIONS_SHARD,
  );
}
