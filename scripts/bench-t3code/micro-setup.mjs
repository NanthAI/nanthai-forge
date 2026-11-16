// SPDX-License-Identifier: Apache-2.0
// Shared read-only qualification for rung 2 and the future E3 rematch.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const exec = promisify(execFile);

export function setupProblems(config, env = process.env) {
  const problems = [];
  if (!env.FORGE_AUTH_TOKEN) problems.push('dedicated FORGE_BENCH_TOKEN secret missing');
  if (!env.CONVEX_DEPLOY_KEY) problems.push('convex-bench deployment key missing (meter and alerts)');
  if (!/^https:\/\/[a-z0-9-]+\.convex\.cloud$/.test(config?.forge?.url ?? ''))
    problems.push('bench deployment URL missing');
  if (!config?.forge?.deployment || !config?.forge?.projectId)
    problems.push('bench deployment/project missing');
  if (config?.fixture?.repository !== 'NanthAI/forge-b15d-t3code')
    problems.push('qualified B1.5d fixture repository required');
  if (!/^[0-9a-f]{40}$/.test(config?.fixture?.commit ?? ''))
    problems.push('exact qualified base commit required');
  return problems;
}

/** Secrets stay in the child environment; no config, command failure or URL is printed. */
export async function prepareMicro(root, config, sourceRoot, sha) {
  const problems = setupProblems(config);
  if (problems.length) throw Error(problems.join('; '));
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const meta = join(root, 'meta');
  try {
    await exec('git', [
      'clone',
      '--filter=blob:none',
      '--no-checkout',
      `https://github.com/${config.fixture.repository}`,
      meta,
    ]);
    await exec('git', ['-C', meta, 'cat-file', '-e', `${config.fixture.commit}:.bench/ci.sh`]);
  } catch {
    throw Error('Qualified base unavailable; restore the registered fixture, do not substitute it');
  }
  // The accepted workflow checkout is a dedicated bench build, never the builders' CLI.
  writeFileSync(join(sourceRoot, '.commit'), sha + '\n');
  return { ...config, meta, forge: { ...config.forge, cli: join(sourceRoot, 'dist/cli-entry.js') } };
}

export async function microPins(sha) {
  const command = async args => (await exec('gh', args, { maxBuffer: 4 << 20 })).stdout.trim();
  const deployment = JSON.parse(
    await command([
      'run',
      'list',
      '-R',
      'NanthAI/nanthai-forge',
      '--workflow',
      'convex-bench-deploy.yml',
      '--status',
      'success',
      '-L',
      '1',
      '--json',
      'headSha,databaseId',
    ]),
  )[0];
  if (!deployment) throw Error('No successful bench deployment; lead must deploy the accepted main pin');
  const tree = ref =>
    command([
      'api',
      `repos/NanthAI/nanthai-forge/git/trees/${ref}`,
      '--jq',
      '.tree[] | select(.path == "convex") | .sha',
    ]);
  const [accepted, deployed, workflow] = await Promise.all([
    tree(sha),
    tree(deployment.headSha),
    command([
      'api',
      'repos/NanthAI/nanthai-forge/contents/.github/workflows/forge-check.yml',
      '--jq',
      '.sha',
    ]),
  ]);
  if (!accepted || accepted !== deployed || !workflow)
    throw Error('Bench deployment differs from accepted main; lead must deploy this pin');
  return { sha, convex: deployed, deploymentRun: deployment.databaseId, checkWorkflow: workflow };
}
