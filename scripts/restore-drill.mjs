// SPDX-License-Identifier: Apache-2.0
// Restore drill: weekly backup ZIP -> fresh local self-hosted deployment -> byte-for-byte checks.
// Reads the backup and one project's R2 prefix (GET/LIST only), streamed: neither is written
// whole to disk. Writes only to the new scratch instance and its in-memory bucket, never to the
// source deployment or bucket.
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync, statfsSync } from 'node:fs';
import { lstat, mkdir, open, readdir, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { backupManifestName } from './hosted-backup-freshness.mjs';
import { main as selfhost, release, releases, portNumber } from './selfhost.mjs';
import { deploySmoke } from './selfhost-smoke-support.mjs';
import { networkFetch, networkTimeout } from '../dist/network-fetch.js';
import { r2Client } from './lib/hosted-backup-r2.mjs';
import * as project from './lib/restore-drill-project.mjs';
import {
  adminClient,
  awaitImport,
  convexCli,
  freePortPair,
  importStream,
  startBackend,
} from './lib/restore-drill-instance.mjs';

const usage = `Usage: node --env-file=PRIVATE_R2_ENV scripts/restore-drill.mjs --project PROJECT_ID --dir NEW_PRIVATE_DIR
  [--prefix hosted-backups/dev/ (or HOSTED_DURABILITY_R2_PREFIX)] [--backup NAME] [--port N (default: a free pair)] [--reserve-gib N] [--backend-archive ZIP] [--keep]
Needs npm run build:core, Python 3 and R2_ACCOUNT_ID/R2_BUCKET/R2_ACCESS_KEY_ID/R2_SECRET_ACCESS_KEY.
Exit: 0 = restored and equal, 2 = a comparison differs, 1 = a step failed.`;

export function parseCommand(args, env = process.env) {
  const { values } = parseArgs({
    args,
    options: {
      project: { type: 'string' },
      dir: { type: 'string' },
      prefix: { type: 'string', default: env.HOSTED_DURABILITY_R2_PREFIX || 'hosted-backups/dev/' },
      backup: { type: 'string' },
      port: { type: 'string' },
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
    port: values.port === undefined ? null : portNumber(values.port),
    reserveGib: Number(values['reserve-gib']),
    backendArchive: values['backend-archive'] ?? null,
    keep: values.keep,
  };
}

async function stopBackend(backend) {
  if (!backend || backend.exitCode !== null || backend.signalCode !== null) return;
  const exited = new Promise(done => backend.once('exit', done));
  backend.kill('SIGTERM');
  await exited;
}

function freeGib(path) {
  const stats = statfsSync(path);
  return (stats.bavail * stats.bsize) / 2 ** 30;
}

/** Bytes the drill directory occupies on disk (allocated blocks, so sparse files count as used). */
async function scratchBytes(path) {
  let total = 0;
  for (const entry of await readdir(path, { withFileTypes: true, recursive: true }).catch(() => [])) {
    if (!entry.isFile()) continue;
    total += await lstat(join(entry.parentPath, entry.name)).then(
      stats => stats.blocks * 512,
      () => 0,
    );
  }
  return total;
}

const failed = (message, code) => Object.assign(new Error(message), { code });

export async function drill(command, env = process.env) {
  const steps = {},
    report = {
      operation: 'restore-drill',
      projectId: command.projectId,
      steps,
    };
  const started = performance.now(),
    stop = new AbortController(),
    disk = { reserveGib: command.reserveGib, minFreeGib: null, peakScratchBytes: 0 };
  let backend, bucket, objectsRun;
  const timed = async (name, run) => {
    const start = performance.now();
    try {
      return await run();
    } catch (error) {
      error.step ??= name;
      throw error;
    } finally {
      steps[name] = Math.round(performance.now() - start);
    }
  };
  // The reserve holds at all times, not only between steps: a breach stops every step at once.
  const sample = async () => {
    const free = freeGib(command.dir);
    disk.minFreeGib = Math.min(disk.minFreeGib ?? free, Math.floor(free * 10) / 10);
    if (free < command.reserveGib && !stop.signal.aborted) {
      stop.abort(failed('Disk reserve reached.', 'DISK_RESERVE'));
      backend?.kill('SIGTERM');
    }
    disk.peakScratchBytes = Math.max(disk.peakScratchBytes, await scratchBytes(command.dir));
  };
  await mkdir(command.dir, { mode: 0o700 }); // A new directory: never reuse or overwrite a drill.
  const log = await open(join(command.dir, 'drill.log'), 'wx', 0o600);
  let sampling = Promise.resolve();
  const watch = setInterval(() => (sampling = sampling.then(sample).catch(() => {})), 2000);
  const instance = join(command.dir, 'instance');
  const reads = { get: 0, bytes: 0 };
  let source;
  try {
    await sample();
    stop.signal.throwIfAborted();
    source = r2Client(env);
    const manifest = await timed('backup.select', async () => {
      const names = (await source.list(command.prefix))
        .map(key => key.slice(command.prefix.length))
        .filter(name => backupManifestName.test(name) && (!command.backup || name.startsWith(command.backup)))
        .sort();
      if (!names.length) throw failed('No backup.', 'BACKUP_MISSING');
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
    await timed('instance.create', async () => {
      let archive = command.backendArchive;
      if (!archive) {
        const asset = releases[release][`${process.platform}-${process.arch}`];
        archive = join(command.dir, asset.name);
        const response = await networkFetch(
          `https://github.com/get-convex/convex-backend/releases/download/${release}/${asset.name}`,
          { signal: AbortSignal.any([stop.signal, networkTimeout(600_000)]) },
        );
        if (!response.ok) throw failed('Backend download failed.', 'BACKEND_DOWNLOAD_FAILED');
        const file = await open(archive, 'wx', 0o600);
        for await (const bytes of response.body) await file.write(bytes);
        await file.close();
      }
      // init verifies the pinned SHA-256; its notices go to stderr so stdout stays one JSON report.
      const print = console.log;
      console.log = (...lines) => console.error(...lines);
      try {
        await selfhost(['init', instance, archive, String(command.port ?? (await freePortPair()))]);
      } finally {
        console.log = print;
      }
      if (!command.backendArchive) await rm(archive);
    });
    const { env: target } = await adminClient(instance);
    const url = target.CONVEX_SELF_HOSTED_URL;
    backend = await timed('instance.start', () => startBackend(instance, log.fd, url));
    const cli = convexCli(instance, log.fd, stop.signal);
    const { startFakeR2, fakeR2Config } = await import('../tests/fake-r2.mjs');
    const prefix = `v1/p/${command.projectId}/`;
    // The scratch bucket holds only what the restored app writes; reads of the project's prefix
    // go to the source (GET only), so the prefix is never copied.
    bucket = await startFakeR2(fakeR2Config, {
      local: true,
      readThrough: async key => {
        if (!key.startsWith(prefix)) return null;
        const body = await source.bytes(key).catch(() => null);
        if (body) {
          reads.get++;
          reads.bytes += body.length;
        }
        return body;
      },
    });
    // The current source goes in first, while the backup streams: the import then writes every
    // row into indexed, schema-checked tables, instead of a push rebuilding 400 indexes over the
    // restored rows afterwards (over two hours on dogfood). Nothing calls a function before the
    // rows are read back (no crons; imports bring no scheduled jobs).
    const deployRun = timed('code.deploy', () =>
      deploySmoke(cli.call, {
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
    deployRun.catch(() => {}); // awaited by the import; a failure surfaces there
    // One streamed pass over the backup: its checksum, the backup verifier's whole-snapshot
    // validation, the project's rows, and the one-project ZIP uploaded into the scratch import as
    // it is written. Neither the backup nor that ZIP is ever a file.
    let upload;
    const backupSide = await timed('backup.read', async () => {
      const hash = createHash('sha256');
      let size = 0;
      async function* checked() {
        for await (const bytes of source.stream(manifest.key.replace(/manifest\.json$/, 'snapshot.zip'))) {
          hash.update(bytes);
          size += bytes.length;
          yield bytes;
        }
      }
      const side = await project.readProjectSnapshot(checked(), command.projectId, {
        sink: async zip => {
          upload = await importStream({
            url,
            adminKey: target.CONVEX_SELF_HOSTED_ADMIN_KEY,
            zip,
            signal: stop.signal,
            ready: deployRun,
          });
        },
        signal: stop.signal,
      });
      if (size !== manifest.size || hash.digest('hex') !== manifest.sha256)
        throw failed('Backup checksum differs.', 'BACKUP_CHECKSUM_MISMATCH');
      return side;
    });
    await deployRun;
    report.backup.tables = Object.keys(backupSide.deployment.tables).length;
    report.backup.projectRows = backupSide.rows.size;
    report.filter = { ...backupSide.filter, uploadParts: upload.parts };
    // Every object of the prefix is checked straight from the source while the instance works.
    objectsRun = timed('objects.verify', () =>
      project.verifyProjectObjects({
        source,
        projectId: command.projectId,
        referenced: backupSide.r2Keys,
        sizes: backupSide.objects,
        signal: stop.signal,
      }),
    ).then(
      result => ({ result }),
      error => ({ error }),
    );
    report.import = await timed('import', async () => {
      const imported = await awaitImport(instance, upload, stop.signal);
      // The backend keeps the uploaded ZIP; the rows are in the database now.
      await rm(join(instance, 'files', 'snapshot_imports'), { recursive: true, force: true });
      return imported;
    });
    // Read back before any function runs, straight from the restored database with the backend
    // stopped (no lock contention, nothing changes underneath): no export file.
    await stopBackend(backend);
    const restored = await timed('restored.read', () =>
      project.readRestoredRows(join(instance, 'database.sqlite3'), command.projectId),
    );
    backend = await timed('instance.restart', () => startBackend(instance, log.fd, url));
    report.projectRows = {
      ...project.compareProjectRows(backupSide.rows, restored.rows),
      tables: restored.tables,
    };
    report.app = await timed('app.read', async () => {
      process.env.FORGE_OBJECT_CACHE = 'off'; // an empty cache: every byte comes from the restored app
      const [{ ConvexExchange }, { ConvexLaneTransport }, { HostedCheckoutCache }, { parseNativeState }] =
        await Promise.all([
          import('../dist/exchange-client.js'),
          import('../dist/hosted-lane-transport.js'),
          import('../dist/hosted-checkout-cache.js'),
          import('../dist/native-state-format.js'),
        ]);
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
    const checked = await objectsRun;
    if (checked.error) throw checked.error;
    report.objects = checked.result;
    report.equal =
      report.projectRows.equal &&
      report.objects.missingCount === 0 &&
      report.objects.digestMismatchCount === 0 &&
      report.objects.sizeMismatchCount === 0 &&
      report.app.main.equal &&
      report.app.sizeMismatch.length === 0;
  } catch (error) {
    // A refusal by the restored app arrives as a ConvexError: its code is in `data`.
    report.failed = {
      step: error?.step ?? 'drill',
      code: stop.signal.aborted
        ? stop.signal.reason.code
        : (error?.code ?? error?.data?.code ?? 'DRILL_FAILED'),
      ...(error?.tables ? { tables: error.tables, next: error.next } : {}),
    };
  } finally {
    clearInterval(watch);
    if (!stop.signal.aborted) stop.abort(failed('Drill finished.', 'DRILL_STOPPED'));
    await objectsRun;
    await sampling.then(sample).catch(() => {});
    await stopBackend(backend);
    await bucket?.close();
    await log.close();
    if (!command.keep) await rm(command.dir, { recursive: true, force: true });
    report.teardown = {
      backendStopped: !backend || backend.exitCode !== null || backend.signalCode !== null,
      removed: !command.keep,
    };
  }
  report.disk = disk;
  report.cost = {
    r2: {
      list: 1 + (report.objects?.requests.list ?? 0),
      get: 2 + (report.objects?.requests.get ?? 0) + reads.get,
      bytes: (report.backup?.size ?? 0) + (report.objects?.bytes ?? 0) + reads.bytes,
    },
    sourceConvexCalls: 0,
  };
  report.totalMs = Math.round(performance.now() - started);
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
