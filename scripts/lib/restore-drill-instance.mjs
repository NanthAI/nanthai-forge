// SPDX-License-Identifier: Apache-2.0
// The restore drill's fresh local self-hosted instance (scripts/selfhost.mjs): CLI, admin client,
// import completion and backend start. Every target is checked to be the local scratch instance.
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';
import { networkFetch, networkTimeout } from '../../dist/network-fetch.js';
import { childEnv } from '../child-env.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url));

/** The pinned Convex CLI against the scratch instance only; stdout/stderr go to a private log. */
export function convexCli(instance, log, signal) {
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
  const run = args =>
    new Promise(done => {
      const child = spawn(process.execPath, argv(args), {
        cwd: root,
        env,
        stdio: ['ignore', log, log],
        signal,
      });
      child.once('error', () => done(1));
      child.once('close', code => done(code));
    });
  return {
    run,
    /** Like `run`, but a non-zero exit throws (asynchronous, so the disk watch keeps running). */
    call: async args => {
      if ((await run(args)) !== 0)
        throw Object.assign(new Error('Scratch CLI failed.'), { code: 'CONVEX_CLI_FAILED' });
    },
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

const importFailed = () => Object.assign(new Error('Import failed.'), { code: 'IMPORT_FAILED' });

/** The failed import's cause, by name. The drill adds each schema table a backup lacks to the import
 * empty, so a table numbered by the schema push is replaced too; a conflict left is named here. Only
 * table names leave the backend's message; never row data. */
export function importFailure(state) {
  const conflict = /New table `([^`]+)` has IDs that conflict with existing table `([^`]+)`/.exec(
    state?.error_message ?? '',
  );
  if (!conflict) return importFailed();
  return Object.assign(new Error('The backup predates a table in the current schema.'), {
    code: 'BACKUP_OLDER_THAN_SCHEMA',
    tables: { backup: conflict[1], schema: conflict[2] },
    next: 'Take a new backup (the hosted-backup workflow) and run the drill on it.',
  });
}

/** The scratch import API (what `convex import` uses), fed as the ZIP is produced so the ZIP is
 * never a file. Parts respect the backend's 5 MiB minimum. Returns the import id. */
/** Upload a snapshot ZIP as it is produced (parts of `partBytes`) and start the import. The import
 * starts only once `ready` settles (the drill's schema push), so rows land in indexed tables. */
export async function importStream({ url, adminKey, zip, signal, ready = null, partBytes = 16 << 20 }) {
  const call = async (path, body, type = 'application/json') => {
    const response = await networkFetch(
      url + path,
      {
        method: 'POST',
        headers: { authorization: `Convex ${adminKey}`, 'content-type': type },
        body,
        signal: AbortSignal.any([signal, networkTimeout(600_000)]),
      },
      { retries: 0 },
    ).catch(() => null);
    if (!response?.ok) throw importFailed();
    const text = await response.text(); // perform_import answers with an empty body
    return text ? JSON.parse(text) : null;
  };
  const { uploadToken } = await call('/api/import/start_upload');
  const partTokens = [];
  let pending = [],
    size = 0;
  const send = async () => {
    const body = Buffer.concat(pending);
    ((pending = []), (size = 0));
    const path = `/api/import/upload_part?uploadToken=${encodeURIComponent(uploadToken)}&partNumber=${partTokens.length + 1}`;
    partTokens.push(await call(path, body, 'application/octet-stream'));
  };
  for await (const chunk of zip) {
    pending.push(chunk);
    size += chunk.length;
    if (size >= partBytes) await send();
  }
  if (size || !partTokens.length) await send();
  await ready;
  const finished = await call(
    '/api/import/finish_upload',
    JSON.stringify({ import: { mode: 'requireEmpty', format: 'zip' }, uploadToken, partTokens }),
  );
  return {
    importId: finished.importId,
    parts: partTokens.length,
    perform: () => call('/api/perform_import', JSON.stringify({ importId: finished.importId })),
  };
}

/** The import's own state row is the authority (a progress subscription can time out on a busy
 * backend while the import continues). A parsed upload waits for confirmation; confirm it once. */
export async function awaitImport(instance, upload, signal, deadline = Date.now() + 4 * 3600_000) {
  const { makeFunctionReference } = await import('convex/server');
  const { client } = await adminClient(instance);
  let confirmed = false;
  for (;;) {
    signal?.throwIfAborted();
    const row = await client
      .query(makeFunctionReference('_system/cli/queryImport:list'), {})
      .then(rows => rows.find(item => item._id === upload.importId))
      .catch(() => null);
    const state = row?.state.state;
    if (state === 'completed')
      return { rows: row.state.num_rows_written == null ? null : Number(row.state.num_rows_written) };
    if (state === 'failed') throw importFailure(row.state);
    if (state === 'waiting_for_confirmation' && !confirmed) {
      await upload.perform();
      confirmed = true;
      continue;
    }
    if (Date.now() > deadline)
      throw Object.assign(new Error('Import did not finish.'), {
        code: 'IMPORT_TIMEOUT',
      });
    await new Promise(done => setTimeout(done, 1000));
  }
}

export async function startBackend(instance, log, url) {
  const answering = () =>
    networkFetch(url + '/version', { signal: networkTimeout(1000) }, { retries: 0 }).then(
      response => response.ok,
      () => false,
    );
  // Another backend on this port would answer for ours (two drills on one machine).
  if (await answering()) throw Object.assign(new Error('Scratch port in use.'), { code: 'PORT_IN_USE' });
  const child = spawn(process.execPath, [join(root, 'scripts/selfhost.mjs'), 'start', instance], {
    stdio: ['ignore', log, log],
    // The schema push backfills every index over the restored rows; at the backend's live-traffic
    // pace that alone took over an hour on dogfood.
    env: { ...process.env, INDEX_BACKFILL_CHUNK_SIZE: '1000', INDEX_BACKFILL_CHUNK_RATE: '1000' },
  });
  for (let attempt = 0; attempt < 300; attempt++) {
    if (child.exitCode !== null) break;
    if (await answering()) return child;
    await new Promise(done => setTimeout(done, 200));
  }
  child.kill('SIGTERM');
  throw Object.assign(new Error('Scratch backend did not start.'), {
    code: 'BACKEND_START_FAILED',
  });
}

/** A free loopback port whose successor is free too (the backend's site proxy), so concurrent
 * drills on one machine never share a backend. */
export async function freePortPair() {
  const { createServer } = await import('node:net');
  const listen = port =>
    new Promise(done => {
      const server = createServer();
      server.once('error', () => done(null));
      server.listen(port, '127.0.0.1', () => done(server));
    });
  for (let attempt = 0; attempt < 20; attempt++) {
    const first = await listen(0);
    const port = first?.address().port;
    const second = port && port < 65535 ? await listen(port + 1) : null;
    await Promise.all([first, second].filter(Boolean).map(server => new Promise(done => server.close(done))));
    if (second) return port;
  }
  throw Object.assign(new Error('No free port.'), { code: 'PORT_UNAVAILABLE' });
}
