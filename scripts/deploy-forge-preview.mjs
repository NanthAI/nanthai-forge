// SPDX-License-Identifier: Apache-2.0
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const siteId = process.argv[2] || JSON.parse(readFileSync('.netlify/state.json', 'utf8')).siteId;
let key = '',
  token = '';
try {
  const backend = args =>
    execFileSync('npx', ['convex', ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  key = backend(['env', 'get', 'FORGE_WORKER_KEY']);
  token = backend(['env', 'get', 'GITHUB_PUBLIC_TOKEN']);
  const cloud = new URL(process.env.VITE_CONVEX_URL);
  if (!siteId || !key || !token || cloud.protocol !== 'https:' || !cloud.hostname.endsWith('.convex.cloud'))
    throw new Error();
  cloud.hostname = cloud.hostname.replace(/\.cloud$/, '.site');
  // Free supports per-deploy function overrides; scoped site variables require Pro.
  const output = execFileSync(
    'npx',
    [
      '--yes',
      'netlify-cli@27.10.2',
      'deploy',
      '--build',
      '--skip-functions-cache',
      '--context',
      'deploy-preview',
      '--site',
      siteId,
      '--env',
      `FORGE_CONVEX_SITE_URL=${cloud.origin}`,
      '--env',
      'NODE_OPTIONS=--max-old-space-size=640',
      '--secret-env',
      `FORGE_WORKER_KEY=${key}`,
      '--secret-env',
      `GITHUB_PUBLIC_TOKEN=${token}`,
      '--json',
    ],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  );
  const result = JSON.parse(output);
  const url = new URL(result.deploy_url);
  if (url.protocol !== 'https:' || !url.hostname.endsWith('.netlify.app')) throw new Error();
  backend(['env', 'set', 'NETLIFY_WORKER_URL', `${url.origin}/.netlify/functions/analyze-background`]);
  console.log(JSON.stringify({ siteId: result.site_id, deployId: result.deploy_id, url: url.origin }));
} catch (error) {
  let message = String(error.stdout ?? '') + String(error.stderr ?? '');
  for (const value of [key, token]) if (value) message = message.replaceAll(value, '[redacted]');
  console.error(
    message ||
      'Preview setup failed; credential values withheld. Check the linked site and Forge backend configuration.',
  );
  process.exitCode = 1;
}
