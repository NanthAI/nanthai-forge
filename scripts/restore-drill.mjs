// SPDX-License-Identifier: Apache-2.0
// Restore drill: weekly backup ZIP -> fresh local self-hosted deployment -> byte-for-byte checks.
// Reads the backup and one project's R2 prefix (GET/LIST only). Writes only to the new scratch
// instance and its in-memory bucket, never to the source deployment or bucket.
import { randomBytes } from 'node:crypto';
import { readFileSync, statfsSync } from 'node:fs';
import { mkdir, open, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { backupManifestName } from './hosted-backup-freshness.mjs';
import { main as selfhost, release, releases, portNumber } from './selfhost.mjs';
import { deploySmoke } from './selfhost-smoke-support.mjs';
import { networkFetch, networkTimeout } from '../dist/network-fetch.js';
import { r2Client } from './lib/hosted-backup-r2.mjs';
import * as project from './lib/restore-drill-project.mjs';
import { adminClient, awaitImport, convexCli, startBackend } from './lib/restore-drill-instance.mjs';

const usage = `Usage: node --env-file=PRIVATE_R2_ENV scripts/restore-drill.mjs --project PROJECT_ID --dir NEW_PRIVATE_DIR
  [--prefix hosted-backups/dev/] [--backup NAME] [--port 3420] [--reserve-gib N] [--backend-archive ZIP] [--keep]
Needs npm run build:core, Python 3 and R2_ACCOUNT_ID/R2_BUCKET/R2_ACCESS_KEY_ID/R2_SECRET_ACCESS_KEY.
Exit: 0 = restored and equal, 2 = a comparison differs, 1 = a step failed.`;

export function parseCommand(args) {
  const { values } = parseArgs({
    args,
    options: {
      project: { type: 'string' },
      dir: { type: 'string' },
      prefix: { type: 'string', default: 'hosted-backups/dev/' },
      backup: { type: 'string' },
      port: { type: 'string', default: '3420' },
      'reserve-gib': { type: 'string', default: '0' },
      'backend-archive': { type: 'string' },
      keep: { type: 'boolean', default: false },
      help: { type: 'boolean' },
    },
  });
  if (values.help) return { help: true };
  if (
    !/^[a-z0-9]{32}$/.test(values.project ?? '') ||
    !values.dir ||
    !/^[\w-]+(\/[\w-]+)*\/$/.test(values.prefix)
  )
    throw Object.assign(new Error(usage), { code: 'ARGUMENT_INVALID' });
  return {
    projectId: values.project,
    dir: resolve(values.dir),
    prefix: values.prefix,
    backup: values.backup ?? null,
    port: portNumber(values.port),
    reserveGib: Number(values['reserve-gib']),
    backendArchive: values['backend-archive'] ?? null,
    keep: values.keep,
  };
}

function freeGib(path) {
  const stats = statfsSync(path);
  return (stats.bavail * stats.bsize) / 2 ** 30;
}

export async function drill(command, env = process.env) {
  const steps = {},
    report = {
      operation: 'restore-drill',
      projectId: command.projectId,
      steps,
    };
  let backend, bucket, step;
  const timed = async (name, run) => {
    step = name;
    const start = performance.now();
    try {
      return await run();
    } finally {
      steps[name] = Math.round(performance.now() - start);
    }
  };
  const reserve = () => {
    if (freeGib(command.dir) < command.reserveGib)
      throw Object.assign(new Error('Disk reserve reached.'), {
        code: 'DISK_RESERVE',
      });
  };
  await mkdir(command.dir, { mode: 0o700 }); // A new directory: never reuse or overwrite a drill.
  const log = await open(join(command.dir, 'drill.log'), 'wx', 0o600);
  const instance = join(command.dir, 'instance');
  try {
    const source = r2Client(env);
    const manifest = await timed('backup.select', async () => {
      const names = (await source.list(command.prefix))
        .map(key => key.slice(command.prefix.length))
        .filter(name => backupManifestName.test(name) && (!command.backup || name.startsWith(command.backup)))
        .sort();
      if (!names.length)
        throw Object.assign(new Error('No backup.'), {
          code: 'BACKUP_MISSING',
        });
      const key = command.prefix + names.at(-1);
      return { key, ...(await source.manifest(key)) };
    });
    report.backup = {
      name: manifest.key.slice(command.prefix.length).split('/')[0],
      time: manifest.time,
      size: manifest.size,
      sha256: manifest.sha256,
      documentCount: manifest.documentCount ?? null,
    };
    reserve();
    const zip = join(command.dir, 'backup.zip');
    await timed('backup.download', async () => {
      const got = await source.download(manifest.key.replace(/manifest\.json$/, 'snapshot.zip'), zip);
      if (got.size !== manifest.size || got.sha256 !== manifest.sha256)
        throw Object.assign(new Error('Backup checksum differs.'), {
          code: 'BACKUP_CHECKSUM_MISMATCH',
        });
    });
    // The backup verifier's whole-snapshot validation runs in the same pass.
    const backupSide = await timed('backup.read', () => project.readProjectSnapshot(zip, command.projectId));
    report.backup.tables = Object.keys(backupSide.deployment.tables).length;
    report.backup.projectRows = backupSide.rows.size;
    await timed('instance.create', async () => {
      let archive = command.backendArchive;
      if (!archive) {
        const asset = releases[release][`${process.platform}-${process.arch}`];
        archive = join(command.dir, asset.name);
        const response = await networkFetch(
          `https://github.com/get-convex/convex-backend/releases/download/${release}/${asset.name}`,
          { signal: networkTimeout(600_000) },
        );
        if (!response.ok)
          throw Object.assign(new Error('Backend download failed.'), {
            code: 'BACKEND_DOWNLOAD_FAILED',
          });
        const file = await open(archive, 'wx', 0o600);
        for await (const bytes of response.body) await file.write(bytes);
        await file.close();
      }
      // init verifies the pinned SHA-256; its notices go to stderr so stdout stays one JSON report.
      const print = console.log;
      console.log = (...lines) => console.error(...lines);
      try {
        await selfhost(['init', instance, archive, String(command.port)]);
      } finally {
        console.log = print;
      }
      if (!command.backendArchive) await rm(archive);
    });
    const url = `http://127.0.0.1:${command.port}`;
    backend = await timed('instance.start', () => startBackend(instance, log.fd, url));
    const cli = convexCli(instance, log.fd);
    const projectZip = join(command.dir, 'project.zip');
    report.filter = await timed('backup.filter', () =>
      project.filterProject(zip, projectZip, command.projectId),
    );
    reserve();
    report.import = await timed('import', async () => {
      await cli.run(['import', projectZip, '--yes']); // fresh instance: the default mode requires empty tables
      return awaitImport(instance);
    });
    const restoredZip = join(command.dir, 'restored.zip');
    await timed('restored.export', async () => {
      if ((await cli.run(['export', '--include-file-storage', '--path', restoredZip])) !== 0)
        throw Object.assign(new Error('Export failed.'), {
          code: 'CONVEX_EXPORT_FAILED',
        });
    });
    const restoredSide = await timed('restored.read', () =>
      project.readProjectSnapshot(restoredZip, command.projectId, {
        whole: false,
      }),
    );
    report.projectRows = project.compareProjectRows(backupSide.rows, restoredSide.rows);
    const { startFakeR2, fakeR2Config } = await import('../tests/fake-r2.mjs');
    bucket = await startFakeR2(fakeR2Config, { local: true });
    report.objects = await timed('objects.copy', () =>
      project.copyProjectObjects({
        source,
        projectId: command.projectId,
        referenced: backupSide.r2Keys,
        put: (key, body) => bucket.objects.set(bucket.key(key), body),
      }),
    );
    await timed('code.deploy', () =>
      deploySmoke(cli.sync, {
        issuer: '',
        token: '',
        // A synthetic keyring: Secret Object values are not part of this drill.
        keys: JSON.stringify({
          active: 'drill',
          keys: { drill: randomBytes(32).toString('base64') },
        }),
        r2: {
          R2_ACCOUNT_ID: fakeR2Config.accountId,
          R2_BUCKET: fakeR2Config.bucket,
          R2_ACCESS_KEY_ID: fakeR2Config.accessKeyId,
          R2_SECRET_ACCESS_KEY: fakeR2Config.secretAccessKey,
          R2_ENDPOINT: bucket.endpoint,
        },
      }),
    );
    report.app = await timed('app.read', async () => {
      process.env.FORGE_OBJECT_CACHE = 'off'; // an empty cache: every byte comes from the restored app
      const [{ ConvexExchange }, { ConvexLaneTransport }, { HostedCheckoutCache }, { parseNativeState }] =
        await Promise.all([
          import('../dist/exchange-client.js'),
          import('../dist/hosted-lane-transport.js'),
          import('../dist/hosted-checkout-cache.js'),
          import('../dist/native-state-format.js'),
        ]);
      const { env: target } = await adminClient(instance);
      const exchange = new ConvexExchange(url, 'restore-drill', command.projectId, '', null);
      const issuer = 'https://restore-drill.invalid';
      // The scratch admin key acts as the restored project's owner; no source credential is used.
      exchange.client.setAdminAuth(target.CONVEX_SELF_HOSTED_ADMIN_KEY, {
        subject: backupSide.owner,
        issuer,
        tokenIdentifier: `${issuer}|${backupSide.owner}`,
      });
      const cacheRoot = join(command.dir, 'cache'),
        objects = join(cacheRoot, 'objects');
      const cache = new HostedCheckoutCache(cacheRoot, new ConvexLaneTransport(exchange), objects, null);
      const main =
        backupSide.deployment.work.find(work => work.projectId === command.projectId)?.main ?? null;
      return project.readProjectThroughApp({
        exchange,
        cache,
        parseState: parseNativeState,
        readObject: digest => readFileSync(join(objects, digest)),
        objects: backupSide.objects,
        main,
      });
    });
    report.equal =
      report.projectRows.equal &&
      report.objects.missingCount === 0 &&
      report.objects.digestMismatch.length === 0 &&
      report.app.main.equal &&
      report.app.sizeMismatch.length === 0;
  } catch (error) {
    // A refusal by the restored app arrives as a ConvexError: its code is in `data`.
    report.failed = { step, code: error?.code ?? error?.data?.code ?? 'DRILL_FAILED' };
  } finally {
    step = 'teardown';
    if (backend && backend.exitCode === null) {
      const exited = new Promise(done => backend.once('exit', done));
      backend.kill('SIGTERM');
      await exited;
    }
    await bucket?.close();
    await log.close();
    if (!command.keep) await rm(command.dir, { recursive: true, force: true });
    report.teardown = {
      backendStopped: !backend || backend.exitCode !== null || backend.signalCode !== null,
      removed: !command.keep,
    };
  }
  report.cost = {
    r2: {
      list: 1 + (report.objects?.requests.list ?? 0),
      get: 2 + (report.objects?.requests.get ?? 0),
      bytes: (report.backup?.size ?? 0) + (report.objects?.bytes ?? 0),
    },
    sourceConvexCalls: 0,
  };
  report.totalMs = Object.values(steps).reduce((total, ms) => total + ms, 0);
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.umask(0o077);
  try {
    const command = parseCommand(process.argv.slice(2));
    if (command.help) console.log(usage);
    else {
      const report = await drill(command);
      console.log(JSON.stringify(report, null, 2));
      process.exitCode = report.failed ? 1 : report.equal ? 0 : 2;
    }
  } catch (error) {
    console.error(
      error.code === 'ARGUMENT_INVALID'
        ? error.message
        : JSON.stringify({ code: error?.code ?? 'DRILL_FAILED' }),
    );
    process.exitCode = 1;
  }
}
