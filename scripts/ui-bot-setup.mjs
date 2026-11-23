// SPDX-License-Identifier: Apache-2.0
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { savedCredential } from '../dist/auth-store.js';
import { deadlineConvexClient } from '../dist/network-convex-client.js';
import { networkFetch, networkTimeout } from '../dist/network-fetch.js';
import { makeFunctionReference } from 'convex/server';
import { ShotError } from './ui-shots/options.mjs';
import { grantPasskeyBotReader, readerGrantOperationId } from './ui-bot-grant.mjs';
import { convexToken, launchBotBrowser } from './ui-shots/browser.mjs';
import { openBotCredentialStore } from './ui-shots/bot-credential-store.mjs';
import { provisionBotPasskey } from './ui-shots/passkey-enrollment.mjs';

const devOrigin = 'https://dev.forge.nanthai.tech';
const devDeployment = 'https://benevolent-wildebeest-974.convex.cloud';

function ownerClient(deployment) {
  const auth = savedCredential(deployment);
  if (!auth || auth.scope !== 'cli' || auth.expiresAt <= Date.now())
    throw new ShotError('A current owner nforge login with CLI scope is required.');
  const client = deadlineConvexClient(deployment, { logger: false });
  client.setAuth(auth.token);
  return client;
}

async function clerkHandle(page, deployment) {
  const token = await convexToken(page);
  if (!token) throw new ShotError('Could not verify the existing Forge bot session.');
  const client = deadlineConvexClient(deployment, { logger: false });
  client.setAuth(token);
  try {
    return (await client.query(makeFunctionReference('urlAccounts:current'), {}))?.handle;
  } finally {
    client.clearAuth();
  }
}

async function setupPasskey(values, phase) {
  const origin = values.base ?? devOrigin;
  const deployment = values.deployment ?? devDeployment;
  if (origin !== devOrigin || deployment !== devDeployment)
    throw new ShotError('Native bot enrollment is for the Forge dev site and deployment.');

  const { data, save } = await openBotCredentialStore(homedir());
  const projectId = values.project || data.projectId;
  if (!projectId) throw new ShotError('Supply --project on the first run.');
  phase('verify saved owner login');
  const owner = values['grant-reader'] ? ownerClient(deployment) : null;
  const project = await owner?.query(makeFunctionReference('projectAccess:people'), { projectId, limit: 1 });
  if (project && project.role !== 'owner')
    throw new ShotError('The saved nforge login must own the requested project.');
  phase('native bot passkey enrollment');
  const browser = await launchBotBrowser({ kind: data.email && !data.passkey ? 'clerk' : 'passkey' });
  let token;
  try {
    token = await provisionBotPasskey(browser, { origin, deployment, clerkHandle }, data, save);
    data.projectId = projectId;
    await save();
  } finally {
    await browser.close();
  }
  console.log('Native DEV bot ready. The private credential file has mode 0600.');
  if (!owner) return;

  phase('owner-authorized reader grant');
  const bot = deadlineConvexClient(deployment, { logger: false });
  bot.setAuth(token);
  await grantPasskeyBotReader({
    owner,
    project,
    bot,
    ref: makeFunctionReference,
    credentials: data.passkey,
    save,
    projectId,
    deployment,
  });
  console.log('Reader access verified for the native bot.');
}

let stage = 'arguments';
try {
  const { values } = parseArgs({
    options: {
      deployment: { type: 'string' },
      base: { type: 'string' },
      passkey: { type: 'boolean' },
      project: { type: 'string' },
      'convex-cwd': { type: 'string' },
      'grant-reader': { type: 'boolean' },
      help: { type: 'boolean' },
    },
  });
  if (values.help) {
    console.log(
      'node scripts/ui-bot-setup.mjs --deployment CONVEX_URL --project ID --convex-cwd CONFIGURED_REPO [--grant-reader]\nCreates/finds the Clerk DEV bot.\nnode scripts/ui-bot-setup.mjs --passkey --project ID [--grant-reader]\nEnrolls or verifies the native DEV bot. --grant-reader uses the saved nforge owner login.',
    );
  } else if (values.passkey) {
    await setupPasskey(values, next => (stage = next));
  } else {
    const { data: credentials, save } = await openBotCredentialStore(homedir());
    const email = 'forge-ui-bot+clerk_test@example.com';
    if (
      Object.hasOwn(credentials, 'email') &&
      (credentials.email !== email || typeof credentials.password !== 'string')
    )
      throw new ShotError('Existing bot credentials have an unexpected identity or no password.');
    const deployment = values.deployment || credentials?.deployment;
    const projectId = values.project || credentials?.projectId;
    if (!deployment || !projectId) throw new ShotError('Supply --deployment and --project on the first run.');
    const origin = new URL(deployment);
    if (origin.protocol !== 'https:' || origin.origin !== deployment)
      throw new ShotError('Deployment must be an HTTPS origin.');
    stage = 'Clerk DEV provisioning';
    const key = execFileSync('npx', ['convex', 'env', 'get', 'CLERK_SECRET_KEY'], {
      cwd: resolve(values['convex-cwd'] || credentials?.convexCwd || '.'),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 60_000,
    }).trim();
    if (!key.startsWith('sk_test_')) throw new ShotError('A Clerk DEV secret key is required.');
    async function clerk(path, method = 'GET', body) {
      const response = await networkFetch(`https://api.clerk.com/v1${path}`, {
        method,
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        ...(body ? { body: JSON.stringify(body) } : {}),
        redirect: 'error',
        signal: networkTimeout(30_000),
      });
      if (!response.ok)
        throw new ShotError(`Clerk provisioning returned HTTP ${response.status}; response redacted.`);
      return response.json();
    }
    const matches = (await clerk(`/users?email_address=${encodeURIComponent(email)}`)).filter(user =>
      user.email_addresses.some(address => address.email_address === email),
    );
    if (matches.length > 1) throw new ShotError('Multiple bot users match; no changes made.');
    const hadProvisionedIdentity = Boolean(credentials?.userId);
    credentials.email ??= email;
    credentials.password ??= `${randomBytes(36).toString('base64url')}!aA9`;
    credentials.deployment = deployment;
    credentials.projectId = projectId;
    credentials.convexCwd = resolve(values['convex-cwd'] || credentials.convexCwd || '.');
    await save();
    let user = matches[0];
    if (!user)
      user = await clerk('/users', 'POST', {
        email_address: [email],
        password: credentials.password,
        first_name: 'forge-ui-bot',
      });
    else if (!hadProvisionedIdentity)
      user = await clerk(`/users/${encodeURIComponent(user.id)}`, 'PATCH', {
        password: credentials.password,
      });
    if (credentials.userId && credentials.userId !== user.id)
      throw new ShotError('The saved bot identity differs from Clerk; no grant applied.');
    credentials.userId = user.id;
    await save();
    console.log('Clerk DEV bot ready; credentials saved outside the repo with mode 0600.');
    if (values['grant-reader']) {
      stage = 'owner-authorized reader grant (requires deployed reader support)';
      const client = ownerClient(deployment);
      stage = 'verify owner project access';
      const project = await client.query(makeFunctionReference('projectWork:state'), { projectId });
      if (project.owner === user.id)
        throw new ShotError('The bot is an owner; a reader grant cannot remove existing write access.');
      stage = 'verify bot has no contributor grant';
      const contributors = await client.query(makeFunctionReference('projectContributors:list'), {
        projectId,
      });
      if (contributors.some(row => row.contributor === user.id))
        throw new ShotError(
          'The bot has contributor access; a reader grant cannot remove existing write access.',
        );
      const operationId = readerGrantOperationId(credentials, deployment, projectId);
      await save();
      stage = 'apply deployed reader grant';
      await client.action(makeFunctionReference('projectReaderActions:set'), {
        projectId,
        reader: user.id,
        present: true,
        operationId,
      });
      stage = 'verify reader grant';
      let cursor = null,
        found = false;
      do {
        const result = await client.query(makeFunctionReference('projectReaders:list'), {
          projectId,
          paginationOpts: { numItems: 100, cursor },
        });
        found ||= result.page.some(row => row.reader === user.id);
        cursor = result.isDone ? null : result.continueCursor;
      } while (cursor);
      if (!found)
        throw new ShotError(
          "Original reader grant was removed. Delete this project's entry from readerGrantOperationIds locally to request a new grant.",
        );
      console.log('Reader grant verified. Bot has no owner or contributor grant.');
    }
  }
} catch (error) {
  const code = /^[A-Z_]+$/.test(error?.data?.code) ? ` (${error.data.code})` : '';
  const detail =
    error instanceof ShotError
      ? error.message
      : /Could not find (?:public )?function/.test(error?.message ?? '')
        ? 'Hosted reader support is not deployed. The lead must deploy the accepted backend first.'
        : 'Details redacted. Check local configuration, connectivity and deployed reader support.';
  console.error(`ui-bot-setup failed during ${stage}${code}: ${detail}`);
  process.exitCode = 1;
}
