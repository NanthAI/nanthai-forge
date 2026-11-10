// SPDX-License-Identifier: Apache-2.0
// The restore drill's fresh local self-hosted instance (scripts/selfhost.mjs): CLI, admin client,
// import completion and backend start. Every target is checked to be the local scratch instance.
import { execFileSync, spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';
import { networkFetch, networkTimeout } from '../../dist/network-fetch.js';
import { childEnv } from '../child-env.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url));

/** The pinned Convex CLI against the scratch instance only; stdout/stderr go to a private log. */
export function convexCli(instance, log) {
  const file = join(instance, 'deployment.env');
  const url = new URL(parseEnv(readFileSync(file, 'utf8')).CONVEX_SELF_HOSTED_URL);
  if (url.hostname !== '127.0.0.1')
    throw Object.assign(new Error('Scratch must be local.'), {
      code: 'TARGET_NOT_SCRATCH',
    });
  // Empty selectors stop a project .env.local or the caller's shell from naming another deployment.
  const env = {
    ...childEnv({ allow: ['XDG_CONFIG_HOME'] }),
    CONVEX_DEPLOYMENT: '',
    CONVEX_DEPLOY_KEY: '',
  };
  const argv = args => [join(root, 'node_modules/convex/bin/main.js'), ...args, '--env-file', file];
  return {
    sync: args =>
      execFileSync(process.execPath, argv(args), {
        cwd: root,
        env,
        stdio: ['ignore', log, log],
      }),
    run: args =>
      new Promise(done => {
        const child = spawn(process.execPath, argv(args), {
          cwd: root,
          env,
          stdio: ['ignore', log, log],
        });
        child.once('error', () => done(1));
        child.once('close', code => done(code));
      }),
  };
}

export async function adminClient(instance) {
  const { deadlineConvexClient } = await import('../../dist/network-convex-client.js');
  const env = parseEnv(readFileSync(join(instance, 'deployment.env'), 'utf8'));
  const client = deadlineConvexClient(env.CONVEX_SELF_HOSTED_URL, {
    logger: false,
  });
  client.setAdminAuth(env.CONVEX_SELF_HOSTED_ADMIN_KEY);
  return { client, env };
}

/** The CLI's own progress subscription can time out on a busy backend while the import
 * continues; the import's state row is the authority. */
export async function awaitImport(instance, deadline = Date.now() + 4 * 3600_000) {
  const { makeFunctionReference } = await import('convex/server');
  const { client } = await adminClient(instance);
  for (;;) {
    try {
      const [latest] = (await client.query(makeFunctionReference('_system/cli/queryImport:list'), {})).sort(
        (a, b) => b._creationTime - a._creationTime,
      );
      if (latest?.state.state === 'completed')
        return {
          rows: latest.state.num_rows_written == null ? null : Number(latest.state.num_rows_written),
        };
      if (latest?.state.state === 'failed')
        throw Object.assign(new Error('Import failed.'), {
          code: 'IMPORT_FAILED',
        });
    } catch (error) {
      if (error.code === 'IMPORT_FAILED') throw error;
    }
    if (Date.now() > deadline)
      throw Object.assign(new Error('Import did not finish.'), {
        code: 'IMPORT_TIMEOUT',
      });
    await new Promise(done => setTimeout(done, 5000));
  }
}

export async function startBackend(instance, log, url) {
  const child = spawn(process.execPath, [join(root, 'scripts/selfhost.mjs'), 'start', instance], {
    stdio: ['ignore', log, log],
  });
  for (let attempt = 0; attempt < 300; attempt++) {
    if (child.exitCode !== null) break;
    try {
      if ((await networkFetch(url + '/version', { signal: networkTimeout(1000) }, { retries: 0 })).ok)
        return child;
    } catch {
      /* Not listening yet. */
    }
    await new Promise(done => setTimeout(done, 200));
  }
  child.kill('SIGTERM');
  throw Object.assign(new Error('Scratch backend did not start.'), {
    code: 'BACKEND_START_FAILED',
  });
}
