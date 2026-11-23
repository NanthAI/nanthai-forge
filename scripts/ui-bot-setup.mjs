// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { homedir } from 'node:os';
import { parseArgs } from 'node:util';
import { savedCredential } from '../dist/auth-store.js';
import { deadlineConvexClient } from '../dist/network-convex-client.js';
import { makeFunctionReference } from 'convex/server';
import { ShotError } from './ui-shots/options.mjs';
import { grantPasskeyBotReader } from './ui-bot-grant.mjs';
import { launchBotBrowser } from './ui-shots/browser.mjs';
import { openBotCredentialStore } from './ui-shots/bot-credential-store.mjs';
import { provisionBotPasskey } from './ui-shots/passkey-enrollment.mjs';
import { oldPasskeyRefused, rotateBotPasskey } from './ui-shots/passkey-rotation.mjs';

// Dev site origin: FORGE_DEV_WEB_ORIGIN overrides this default after a site move; --base must equal it.
const devOrigin = process.env.FORGE_DEV_WEB_ORIGIN ?? 'https://dev.forge.nanthai.tech';
const devDeployment = 'https://benevolent-wildebeest-974.convex.cloud';

function ownerClient(deployment) {
  const auth = savedCredential(deployment);
  if (!auth || auth.scope !== 'cli' || auth.expiresAt <= Date.now())
    throw new ShotError('A current owner nforge login with CLI scope is required.');
  const client = deadlineConvexClient(deployment, { logger: false });
  client.setAuth(auth.token);
  return client;
}

async function setupPasskey(values, phase) {
  const origin = values.base ?? devOrigin;
  const deployment = values.deployment ?? devDeployment;
  const web = new URL(devOrigin);
  if (
    web.protocol !== 'https:' ||
    web.origin !== devOrigin ||
    origin !== devOrigin ||
    deployment !== devDeployment
  )
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
  const browser = await launchBotBrowser();
  let token;
  try {
    const config = { origin, deployment };
    if (values.rotate) {
      // Replace every passkey on the bot account with one new one, then prove the old ones are refused.
      if (!data.passkey)
        throw new ShotError('Rotation needs a saved passkey to sign in with; run --passkey first.');
      const old = structuredClone(data.passkey);
      const done = await rotateBotPasskey(browser, config, data, save);
      const refused = await oldPasskeyRefused(browser, config, old);
      console.log(
        `Rotated: added ${done.added}, removed ${done.removed.join(', ')}; old dev id refused: ${refused}.`,
      );
      if (!refused) throw new ShotError('The old passkey still signs in.');
    }
    token = await provisionBotPasskey(browser, config, data, save);
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
      rotate: { type: 'boolean' },
      project: { type: 'string' },
      'grant-reader': { type: 'boolean' },
      help: { type: 'boolean' },
    },
  });
  if (values.help) {
    console.log(
      'node scripts/ui-bot-setup.mjs --passkey --project ID [--grant-reader]\nEnrolls or verifies the native DEV bot. --rotate replaces all its passkeys with one new one. --grant-reader uses the saved nforge owner login.',
    );
  } else {
    await setupPasskey(values, next => (stage = next));
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
