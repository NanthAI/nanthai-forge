// SPDX-License-Identifier: Apache-2.0
import { writeFileSync, appendFileSync, readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { writeActionsRunBundle, readActionsRunBundle } from '../dist/hosted-actions-job-bundle.js';
import { actionsCapacityFile, parseActionsCapacity } from '../dist/hosted-actions-capacity.js';
const capacityPath = resolve(process.env.RUNNER_TEMP ?? '.', actionsCapacityFile);
/** The runner queue read: the one step that holds the GitHub token, so no step that plans or
 * runs project code ever does. GitHub-hosted only; anything else observes nothing. */
async function readCapacity() {
  if (process.env.RUNNER_ENVIRONMENT !== 'github-hosted') return undefined;
  const { readActionsCapacity } = await import('./actions-capacity.mjs');
  return readActionsCapacity({
    repository: process.env.GITHUB_REPOSITORY,
    workflow: process.env.GITHUB_WORKFLOW_REF?.match(/\.github\/workflows\/([^/@]+)@/)?.[1],
    runId: process.env.GITHUB_RUN_ID,
    token: process.env.GITHUB_TOKEN,
  });
}
// Candidate-free dependency-cache seed before the check (no Forge call, never fails the job).
if (process.argv[2] === 'seed') {
  const { seedDependencyCache } = await import('../dist/hosted-actions-job-seed.js');
  process.exit(await seedDependencyCache());
}
if (process.argv[2] === 'capacity') {
  writeFileSync(capacityPath, JSON.stringify((await readCapacity()) ?? null));
  process.exit(0);
}
const { ActionsJobClient } = await import('../dist/hosted-actions-job-client.js');
const { hostedCheckRunSchema } = await import('../dist/hosted-check.js');
const client = new ActionsJobClient(
  process.env.FORGE_CONVEX_SITE,
  process.env.FORGE_PROJECT_ID,
  process.env.FORGE_RUN_ID,
);
const directory = resolve(process.env.FORGE_CANDIDATE);
try {
  if (process.argv[2] === 'plan') {
    const { prepareActionsJob } = await import('../dist/hosted-actions-job-plan.js');
    // A workflow with a separate capacity step left its read here; older workflows read it now.
    const capacity = existsSync(capacityPath)
      ? parseActionsCapacity(readFileSync(capacityPath, 'utf8'))
      : await readCapacity();
    const result = await prepareActionsJob(
      client,
      directory,
      resolve(process.env.RUNNER_TEMP, 'forge-objects'),
      capacity,
      // This control checkout's workflow: a declared check needs its toolchain and cache steps.
      installedWorkflow(),
    );
    writeFileSync(resolve(process.env.RUNNER_TEMP, 'forge-actions-state.json'), result.stateBytes);
    writeFileSync(resolve(process.env.RUNNER_TEMP, 'forge-actions-plan.json'), JSON.stringify(result.recipe));
    writeActionsRunBundle(resolve(process.env.RUNNER_TEMP, 'forge-actions-run.json'), {
      ...result.run,
      capabilities: client.capabilities,
      preflightTicket: client.preflightTicket,
      ...(client.proofTicket ? { proofTicket: client.proofTicket } : {}),
      resultBatch: client.resultBatch,
      // Shard pool claim targets: read by the fixed supervisor only, never logged.
      ...(result.claims ? { poolClaims: result.claims } : {}),
    });
    // Forge's own suite installs from the control lockfile, so only it reads the npm download cache.
    const npmCache = result.recipe.standard === true;
    // The only step that writes workflow outputs: it reads the Candidate as data and runs none of
    // its code (Issue 432164bf). The check itself always runs in the separate run step.
    appendFileSync(
      process.env.GITHUB_OUTPUT,
      `matrix=${JSON.stringify(result.matrix)}\nsingle_shard=${result.singleShard}\npack_refresh=${result.packRefresh.refresh}\n` +
        // Declared toolchains and dependency cache for the workflow's setup steps (single-line JSON).
        `toolchains=${JSON.stringify(result.toolchains)}\ndeps_cache=${JSON.stringify(result.depsCache)}\n` +
        `npm_cache=${npmCache}\n` +
        (result.proof ? 'proof=true\n' : ''),
    );
    // Keep source refresh out of the plan/artifact dependency path.
    writeFileSync(
      resolve(process.env.RUNNER_TEMP, 'forge-pack-refresh.json'),
      JSON.stringify(result.packRefresh),
    );
  } else if (process.argv[2] === 'proof') {
    restoreRun();
    const { executeLandingProof } = await import('../dist/hosted-actions-job-proof.js');
    const source = JSON.parse(
      readFileSync(resolve(process.env.RUNNER_TEMP, 'forge-pack-refresh.json'), 'utf8'),
    );
    if (source.proof) await executeLandingProof(client, directory, source.proof);
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
      source.reader = new SourceWorkerReader(cache, source.connection.transport, undefined, 16);
      await refreshActionsSourcePack(client, source, cache);
    } catch {
      console.log('source pack: refresh skipped');
    }
  } else {
    restoreRun();
    const { executeActionsJob, isolateCandidates } = await import('../dist/hosted-actions-job-run.js');
    isolateCandidates();
    process.exitCode = await executeActionsJob(
      client,
      directory,
      resolve(process.env.RUNNER_TEMP, 'forge-actions-plan.json'),
      process.env.FORGE_ACTIONS_SHARD,
    );
  }
} catch (error) {
  if (error?.code !== 'CHECK_CANCELLED') throw error;
  console.log('Forge check cancelled.');
  if (process.argv[2] === 'plan')
    appendFileSync(process.env.GITHUB_OUTPUT, 'matrix=[]\nsingle_shard=\npack_refresh=false\n');
}

/** Unreadable counts as no declared-setup steps, so only declared checks are refused. */
function installedWorkflow() {
  try {
    return readFileSync(new URL('../.github/workflows/forge-check.yml', import.meta.url), 'utf8');
  } catch {
    return '';
  }
}

function restoreRun() {
  const {
    capabilities = [],
    preflightTicket = null,
    poolClaims = null,
    resultBatch = null,
    proofTicket = null,
    ...run
  } = readActionsRunBundle(resolve(process.env.RUNNER_TEMP, 'forge-actions-run.json'));
  client.run = hostedCheckRunSchema.parse(run);
  client.preflightTicket = preflightTicket;
  client.poolClaims = poolClaims;
  client.resultBatch = resultBatch;
  client.proofTicket = proofTicket;
  client.capabilities = Array.isArray(capabilities)
    ? capabilities.filter(value => typeof value === 'string')
    : [];
}
