// SPDX-License-Identifier: Apache-2.0
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createRepo, loadManifest } from '../bench-landing-github.mjs';
import { cliReplies } from './receipts.mjs';
import { sustainedCheckScript } from './sustained-oracle.mjs';
import { fixtureFiles } from './sustained-plan.mjs';
import { sustainedWorkflow } from './sustained-workflow.mjs';

export function runCommand(command, args, { allowFail = false, input, timeoutMs = 60_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'], timeout: timeoutMs });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => (stdout += chunk));
    child.stderr.on('data', chunk => (stderr += chunk));
    child.stdin.on('error', () => {});
    child.stdin.end(input);
    child.on('error', reject);
    child.on('close', (code, signal) => {
      if (code !== 0 && !allowFail) {
        const structured = cliReplies(stdout + '\n' + stderr).findLast(reply => reply.error)?.error;
        const status = signal ? `${command} exited on ${signal}` : `${command} exited with code ${code}`;
        reject(
          Object.assign(Error(structured?.message || stderr.trim().slice(-1000) || status), {
            code: structured?.code,
            signal,
          }),
        );
      } else resolve({ code, stdout, stderr });
    });
  });
}

export function seedSustained(root, plan) {
  const files = fixtureFiles(plan);
  files.set('bench-ci/check.mjs', sustainedCheckScript(plan));
  for (const [path, bytes] of files) {
    const target = join(root, path);
    mkdirSync(dirname(target), { recursive: true });
    if (existsSync(target) && readFileSync(target, 'utf8') !== bytes)
      throw Error('Scratch fixture bytes changed');
    if (!existsSync(target)) writeFileSync(target, bytes);
  }
}

const runnerFile = '.github/workflows/forge-check.yml';
const getGithub = async (args, exec) => JSON.parse((await exec('gh', args)).stdout);

async function pinnedWorkflow(controlCommit, exec) {
  if (!/^[a-f0-9]{40}$/.test(controlCommit)) throw Error('Use a full pinned Forge control commit');
  const control = await getGithub(
    ['api', `repos/NanthAI/nanthai-forge/contents/${runnerFile}?ref=${controlCommit}`],
    exec,
  );
  return sustainedWorkflow(Buffer.from(control.content, 'base64').toString(), controlCommit);
}

export async function readSustainedPins(config, exec = runCommand) {
  const { repo, controlCommit, deployWorkflow = 'convex-bench-deploy.yml' } = config;
  const [workflow, branch, deployments] = await Promise.all([
    pinnedWorkflow(controlCommit, exec),
    getGithub(['api', `repos/${repo}/branches/main`], exec),
    getGithub(
      [
        'run',
        'list',
        '-R',
        'NanthAI/nanthai-forge',
        '--workflow',
        deployWorkflow,
        '--limit',
        '1',
        '--json',
        'displayTitle,status,conclusion,headSha,databaseId',
      ],
      exec,
    ),
  ]);
  const deploy = deployments[0];
  // The dispatch itself runs from the workflow branch; its title records
  // inputs.ref, which the workflow actually checks out and deploys.
  if (
    deploy?.status !== 'completed' ||
    deploy.conclusion !== 'success' ||
    deploy.displayTitle !== 'Deploy bench Convex at ' + controlCommit
  )
    throw Error('Latest bench deployment differs from the approved Forge control pin');
  const runnerHead = branch.commit.sha;
  const current = await getGithub(['api', `repos/${repo}/contents/${runnerFile}?ref=${runnerHead}`], exec);
  if (Buffer.from(current.content, 'base64').toString() !== workflow)
    throw Error('Active scratch workflow differs from the pinned, capped workflow');
  return {
    deployRun: deploy.databaseId,
    deploymentWorkflowCommit: deploy.headSha,
    runnerHead,
    runnerWorkflow: current.sha,
  };
}

/** Provision synthetic source and a separate, public Actions control repository.
 * Nothing is dispatched by setup. The manifest owns deletion and rejects adoption. */
export async function setupSustained({ config, root, plan, arm, exec = runCommand }) {
  const { repo, manifest, cli, deployment, controlCommit, dogfoodPolicy } = config;
  if (!/^NanthAI\/forge-sustained-[a-z0-9-]+$/.test(repo))
    throw Error('Expected a new NanthAI scratch runner');
  const workflow = await pinnedWorkflow(controlCommit, exec);
  loadManifest(manifest, true);
  const options = { forgeCheckRepo: repo, manifest, visibility: 'public' };
  await createRepo(exec, options, repo, ['--add-readme']);
  const branch = (await exec('gh', ['api', `repos/${repo}`, '--jq', '.default_branch'])).stdout.trim();
  if (branch !== 'main') throw Error('App/OIDC checks need the scratch repository main branch');
  const workflowPath = `repos/${repo}/contents/${runnerFile}`;
  const workflowReply = await exec('gh', ['api', workflowPath], { allowFail: true });
  if (workflowReply.code === 0) {
    if (Buffer.from(JSON.parse(workflowReply.stdout).content, 'base64').toString() !== workflow)
      throw Error('Retained scratch runner workflow differs from the pin');
  } else if (/404/.test(workflowReply.stderr)) {
    // The default branch can be empty until the owner selects this repo on the App.
    await exec('gh', ['api', '--method', 'PUT', workflowPath, '--input', '-'], {
      input: JSON.stringify({
        message: 'Register scratch Forge benchmark check',
        content: Buffer.from(workflow).toString('base64'),
      }),
    });
  } else throw Error('Scratch runner workflow could not be inspected');
  const checkout = join(dirname(root), repo.split('/')[1] + '-main');
  const journalPath = join(root, '.forge', 'sustained-setup.json');
  const operations = existsSync(journalPath)
    ? JSON.parse(readFileSync(journalPath, 'utf8'))
    : (config.operationIds ?? {});
  const run = async (kind, action, parameters) => {
    if (kind === 'x') {
      operations[action] ??= randomUUID();
      writeFileSync(journalPath, JSON.stringify(operations), { mode: 0o600 });
      parameters = { operationId: operations[action], ...parameters };
    }
    const result = await exec(cli, [kind, checkout, action, JSON.stringify(parameters)]);
    const reply = cliReplies(result.stdout).findLast(value => value.action === action && value.result);
    if (!reply) throw Error(`Sustained setup: missing ${action} receipt`);
    return reply.result;
  };
  seedSustained(root, plan);
  if (!existsSync(join(root, '.forge/work/hosted-binding.json')))
    await exec(
      cli,
      [
        'host',
        root,
        '--deployment',
        deployment,
        '--name',
        repo.split('/')[1],
        '--visibility',
        'public',
        '--json',
        '--wait',
      ],
      { timeoutMs: 240_000 },
    );
  const host = JSON.parse((await exec(cli, ['host', root, '--status'])).stdout);
  if (!host.binding?.projectId || host.binding.deployment !== deployment)
    throw Error('Scratch host binding differs from the bench deployment');
  if (!existsSync(join(checkout, '.forge', 'hosted-main.json')))
    await exec(cli, ['clone', host.binding.projectId, checkout, '--deployment', deployment], {
      timeoutMs: 240_000,
    });
  const check = {
    name: 'sustained',
    executable: 'node',
    args: ['bench-ci/check.mjs'],
    environmentLabel: 'ubuntu-latest',
    selection: { shards: 2 },
  };
  const current = await run('agent', 'check-settings', {});
  if (!current.definitions.some(entry => entry.name === check.name))
    await run('x', 'configure-check', { command: check });
  if (current.actions?.repository !== repo)
    await run('x', 'configure-runner', {
      provider: 'github-actions',
      repository: repo,
      runsOn: 'ubuntu-latest',
      concurrencyBudget: 12,
    });
  const acceptance = {
    ...dogfoodPolicy.acceptance,
    ...(arm === 'strict' ? { landingMode: 'strict', batchMaxSize: 8 } : {}),
  };
  await run('x', 'set-policy', { preset: 'trusted', acceptance });
  const policy = await run('agent', 'policy', {});
  const settings = await run('agent', 'check-settings', {});
  if (
    settings.actions?.mode !== 'app-direct' ||
    settings.actions.repository !== repo ||
    policy.acceptance.landingMode !== acceptance.landingMode ||
    policy.acceptance.admissionCheck !== 'full' ||
    policy.acceptance.gate !== 'contract' ||
    policy.acceptance.mode !== 'auto-on-pass' ||
    policy.acceptance.disjointFastPath ||
    policy.acceptance.batchMaxSize !== acceptance.batchMaxSize
  )
    throw Error('Scratch policy or App/OIDC runner readback differs');
  return { repo, checkout, projectId: host.binding.projectId, policy, settings };
}
