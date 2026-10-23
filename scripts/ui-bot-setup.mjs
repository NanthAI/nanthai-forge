// SPDX-License-Identifier: Apache-2.0
import { execFileSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, chmod, lstat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { ConvexHttpClient } from 'convex/browser';
import { makeFunctionReference } from 'convex/server';
import { ShotError } from './ui-shots/options.mjs';

let stage = 'arguments';
try {
  const { values } = parseArgs({
    options: {
      deployment: { type: 'string' },
      project: { type: 'string' },
      'convex-cwd': { type: 'string' },
      'grant-reader': { type: 'boolean' },
      help: { type: 'boolean' },
    },
  });
  if (values.help) {
    console.log(
      'node scripts/ui-bot-setup.mjs --deployment CONVEX_URL --project ID --convex-cwd CONFIGURED_REPO [--grant-reader]\nCreates/finds the Clerk DEV bot; --grant-reader uses the saved nforge owner login after reader support is deployed.',
    );
  } else {
    const dir = join(homedir(), '.config/forge-ui-bot'),
      file = join(dir, 'credentials.json');
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await chmod(dir, 0o700);
    let credentials;
    try {
      const info = await lstat(file);
      if (!info.isFile() || info.uid !== process.getuid?.() || (info.mode & 0o777) !== 0o600)
        throw new ShotError('Existing bot credentials must be a user-owned 0600 regular file.');
      credentials = JSON.parse(await readFile(file, 'utf8'));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    const email = 'forge-ui-bot+clerk_test@example.com';
    if (credentials && (credentials.email !== email || typeof credentials.password !== 'string'))
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
      const response = await fetch(`https://api.clerk.com/v1${path}`, {
        method,
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        ...(body ? { body: JSON.stringify(body) } : {}),
        redirect: 'error',
        signal: AbortSignal.timeout(30_000),
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
    credentials ??= { email, password: `${randomBytes(36).toString('base64url')}!aA9` };
    credentials = {
      ...credentials,
      deployment,
      projectId,
      convexCwd: resolve(values['convex-cwd'] || credentials.convexCwd || '.'),
    };
    async function save() {
      await writeFile(file, JSON.stringify(credentials) + '\n', { mode: 0o600 });
    }
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
      const authPath = join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'forge/auth.json');
      const info = await lstat(authPath);
      if (!info.isFile() || info.uid !== process.getuid?.() || info.mode & 0o077)
        throw new ShotError('Saved nforge login must be a user-owned 0600 regular file.');
      const auth = JSON.parse(await readFile(authPath, 'utf8')).deployments?.[deployment];
      if (!auth || auth.scope !== 'cli' || auth.expiresAt <= Date.now())
        throw new ShotError('A current owner nforge login with CLI scope is required.');
      const client = new ConvexHttpClient(deployment, { logger: false });
      client.setAuth(auth.token);
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
      credentials.readerGrantOperationId ??= randomUUID();
      await save();
      stage = 'apply deployed reader grant';
      await client.action(makeFunctionReference('projectReaderActions:set'), {
        projectId,
        reader: user.id,
        present: true,
        operationId: credentials.readerGrantOperationId,
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
          'Original reader grant was removed. Clear readerGrantOperationId locally to request a new grant.',
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
