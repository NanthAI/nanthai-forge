#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Removes the nightly contract-suite resources (docs/operations/contract-suites.md): the R2 test
// bucket and its token, the scratch GitHub repository, the runner secrets and their environment,
// and the dev test user. Dry run by default: it reads what exists and prints the plan. `--apply`
// deletes and then checks each resource is gone. Uses the signed-in `cf` and `gh` CLIs.
// Output names resources and settings only; it never prints a value, token id or secret.
//
//   node scripts/contract-teardown.mjs --bucket NAME --cf-token-name NAME --scratch-repo OWNER/NAME \
//     --secrets-repo OWNER/NAME [--environment contracts] [--test-user HANDLE] [--apply]
import { execFileSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';

export const contractSecrets = [
  'CONTRACT_R2_ACCOUNT_ID',
  'CONTRACT_R2_BUCKET',
  'CONTRACT_R2_ACCESS_KEY_ID',
  'CONTRACT_R2_SECRET_ACCESS_KEY',
  'CONTRACT_GITHUB_REPO',
  'CONTRACT_GITHUB_APP_ID',
  'CONTRACT_GITHUB_APP_PRIVATE_KEY',
];

const run = (command, args, { json = true, allowFail = false } = {}) => {
  try {
    const out = execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return json ? JSON.parse(out || 'null') : out;
  } catch (error) {
    if (allowFail) return undefined;
    // stderr of cf/gh carries resource names and HTTP status, never request secrets.
    throw new Error(`${command} ${args.slice(0, 3).join(' ')} failed (exit ${error.status ?? '?'})`);
  }
};

/** Each step: a name, a read-only probe (true when the resource exists) and a delete. */
export function plan(options, cli = run) {
  const steps = [],
    env = options.environment;
  if (options.bucket) {
    steps.push({
      name: `R2 bucket ${options.bucket} (objects, then the bucket)`,
      exists: () => {
        const listed = cli('cf', ['r2', 'buckets', 'list']);
        return (Array.isArray(listed) ? listed : (listed?.buckets ?? [])).some(
          b => b.name === options.bucket,
        );
      },
      remove: () => {
        // Per-run cleanup and the one-day lifecycle rule keep this short; pages of up to 1,000 keys.
        for (let page = 0; page < 1000; page++) {
          const keys = (
            cli('cf', ['r2', 'objects', 'list', '--bucket-name', options.bucket, '--per-page', '1000']) ?? []
          ).map(o => o.key);
          if (!keys.length) break;
          cli(
            'cf',
            [
              'r2',
              'objects',
              'bulk-delete',
              '--bucket-name',
              options.bucket,
              '--force',
              '--body',
              JSON.stringify(keys),
            ],
            { json: false },
          );
        }
        cli('cf', ['r2', 'buckets', 'delete', options.bucket, '--force'], { json: false });
      },
    });
  }
  if (options['cf-token-name']) {
    const find = () =>
      (cli('cf', ['accounts', 'tokens', 'list']) ?? []).filter(t => t.name === options['cf-token-name']);
    steps.push({
      name: `Cloudflare API token ${options['cf-token-name']}`,
      exists: () => find().length > 0,
      remove: () => {
        for (const token of find())
          cli('cf', ['accounts', 'tokens', 'delete', token.id, '--force'], { json: false });
      },
    });
  }
  if (options['scratch-repo']) {
    steps.push({
      name: `GitHub repository ${options['scratch-repo']}`,
      exists: () =>
        cli('gh', ['api', `repos/${options['scratch-repo']}`, '--jq', '{id}'], { allowFail: true }) !==
        undefined,
      remove: () => cli('gh', ['repo', 'delete', options['scratch-repo'], '--yes'], { json: false }),
    });
  }
  if (options['secrets-repo']) {
    const repo = options['secrets-repo'];
    const names = () =>
      (
        cli('gh', ['secret', 'list', '-R', repo, '--env', env, '--json', 'name'], { allowFail: true }) ?? []
      ).map(s => s.name);
    steps.push({
      name: `runner secrets ${contractSecrets.join(', ')} and environment ${env} on ${repo}`,
      exists: () =>
        cli('gh', ['api', `repos/${repo}/environments/${env}`, '--jq', '{name}'], { allowFail: true }) !==
        undefined,
      remove: () => {
        for (const name of names().filter(name => contractSecrets.includes(name)))
          cli('gh', ['secret', 'delete', name, '-R', repo, '--env', env], { json: false });
        cli('gh', ['api', '-X', 'DELETE', `repos/${repo}/environments/${env}`], { json: false });
      },
    });
  }
  return steps;
}

export function teardown(options, cli = run, log = console.log) {
  const steps = plan(options, cli),
    apply = !!options.apply,
    results = [];
  for (const step of steps) {
    const before = step.exists();
    if (!before) results.push({ step: step.name, result: 'absent' });
    else if (!apply) results.push({ step: step.name, result: 'would delete' });
    else {
      step.remove();
      // A non-interactive delete that aborts can still exit 0: confirm the resource is gone.
      results.push({ step: step.name, result: step.exists() ? 'STILL PRESENT' : 'deleted' });
    }
    log(`${results.at(-1).result.padEnd(13)} ${step.name}`);
  }
  // Owner-only: GitHub has no API to delete an App, and the dev test user is removed in the app.
  if (options['app-slug'])
    log(
      `owner step    delete the GitHub App ${options['app-slug']} (organization settings, GitHub Apps, Advanced, Delete)`,
    );
  if (options['test-user'])
    log(
      `owner step    delete the dev test user ${options['test-user']} (see docs/operations/contract-suites.md#teardown)`,
    );
  log(apply ? 'Applied.' : 'Dry run: nothing changed. Re-run with --apply to delete.');
  return results;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { values } = parseArgs({
    options: {
      bucket: { type: 'string' },
      'cf-token-name': { type: 'string' },
      'scratch-repo': { type: 'string' },
      'secrets-repo': { type: 'string' },
      environment: { type: 'string', default: 'contracts' },
      'app-slug': { type: 'string' },
      'test-user': { type: 'string' },
      apply: { type: 'boolean', default: false },
    },
  });
  const results = teardown(values);
  process.exitCode = results.some(r => r.result === 'STILL PRESENT') ? 1 : 0;
}
