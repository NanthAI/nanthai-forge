// SPDX-License-Identifier: Apache-2.0
import { childEnv } from './child-env.mjs';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const production = process.argv.includes('--prod');
const siteId =
  process.argv.slice(2).find(arg => arg !== '--prod') ||
  JSON.parse(readFileSync('.netlify/state.json', 'utf8')).siteId;
let key = '',
  token = '';
try {
  const backend = args =>
    execFileSync('npx', ['convex', ...args], {
      // The Convex CLI uses this selected deployment credential.
      env: childEnv({
        allow: [
          'CONVEX_DEPLOY_KEY',
          'CONVEX_DEPLOYMENT',
          'CONVEX_SELF_HOSTED_URL',
          'CONVEX_SELF_HOSTED_ADMIN_KEY',
          'XDG_CONFIG_HOME',
        ],
      }),
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
      ...(production ? ['--prod'] : ['--context', 'deploy-preview']),
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
    // Netlify authenticates deployment and Vite reads only public build settings.
    {
      env: childEnv({
        allow: [
          'NETLIFY_AUTH_TOKEN',
          'XDG_CONFIG_HOME',
          'VITE_CONVEX_URL',
          'VITE_CLERK_PUBLISHABLE_KEY',
          'VITE_FORGE_DEMO_REPOSITORY',
          'VITE_FORGE_PERF',
        ],
      }),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    },
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
