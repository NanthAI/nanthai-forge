// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { backup, readBackupStatus, pruneBackups } from '../scripts/lib/hosted-backup.mjs';
import { parseCommand } from '../scripts/hosted-durability.mjs';
import { durabilityFixture } from './hosted-durability-fixture.mjs';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const id = '11111111-1111-4111-8111-111111111111';
const now = new Date('2026-10-21T03:00:00.000Z');
const prefix = 'hosted/synthetic/';
function fakeClient() {
  const objects = new Map(),
    uploads = new Map(),
    deleted = [];
  let creates = 0;
  return {
    objects,
    deleted,
    get creates() {
      return creates;
    },
    async head(key) {
      const bytes = objects.get(key);
      return bytes ? { size: bytes.length, sha256: hash(bytes) } : null;
    },
    async digest(key) {
      const bytes = objects.get(key);
      return { size: bytes.length, sha256: hash(bytes) };
    },
    async create() {
      const uploadId = String(++creates);
      uploads.set(uploadId, []);
      return uploadId;
    },
    async part(key, uploadId, number, bytes) {
      uploads.get(uploadId)[number - 1] = bytes;
      return `"part-${number}"`;
    },
    async complete(key, uploadId) {
      objects.set(key, Buffer.concat(uploads.get(uploadId)));
    },
    async put(key, bytes) {
      assert.equal(objects.has(key), false);
      objects.set(key, bytes);
    },
    async list() {
      return [...objects.keys()];
    },
    async remove(key) {
      deleted.push(key);
      objects.delete(key);
    },
  };
}
async function setup(fn) {
  const directory = await mkdtemp(join(tmpdir(), 'forge-backup-test-'));
  const command = {
    command: 'backup',
    deployment: 'synthetic',
    bucket: 'fake',
    prefix,
    stateDirectory: directory,
    operationId: id,
  };
  const client = fakeClient();
  const options = {
    client,
    now,
    identity: {
      package: 'synthetic',
      version: '1',
      lockfileSha256: 'a'.repeat(64),
      backupSourceSha256: 'b'.repeat(64),
    },
    verifySnapshot: async () => ({ files: { count: 1 } }),
  };
  let exports = 0;
  const exporter = async (_, path) => {
    exports++;
    await writeFile(path, 'synthetic zip bytes');
  };
  try {
    return await fn({ directory, command, client, options, exporter, exports: () => exports });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
const backupName = day => `${prefix}2026-10-${String(day).padStart(2, '0')}T03-00-00.000Z-${id}/`;
function seed(client) {
  for (let day = 1; day <= 6; day++) {
    client.objects.set(backupName(day) + 'manifest.json', Buffer.from('{}'));
    client.objects.set(backupName(day) + 'snapshot.zip', Buffer.from('zip'));
  }
  for (const key of [
    'other/prefix/manifest.json',
    prefix + 'unmanaged.txt',
    prefix + 'nested/' + backupName(1) + 'manifest.json',
  ])
    client.objects.set(key, Buffer.from('preserve'));
}

test('backup exports, verifies a real fixture ZIP, uploads, verifies bytes and records identity', () =>
  setup(async x => {
    delete x.options.verifySnapshot;
    delete x.options.identity;
    const exporter = async (_, path) => {
      const script =
        "import sys,json,zipfile\nf=json.load(sys.stdin)\nwith zipfile.ZipFile(sys.argv[1],'w') as z:\n for table,rows in f.items():\n  z.writestr(table+'/documents.jsonl',''.join(json.dumps(r)+'\\n' for r in rows))\n z.writestr('_storage/blob','payload')\n";
      assert.equal(
        spawnSync('python3', ['-c', script, path], { input: JSON.stringify(durabilityFixture()) }).status,
        0,
      );
    };
    const result = await backup(x.command, exporter, x.options);
    assert.equal(result.complete, true);
    assert.equal(result.missedWeek, true);
    const manifest = JSON.parse([...x.client.objects].find(([key]) => key.endsWith('manifest.json'))[1]);
    assert.equal(manifest.deployment, 'synthetic');
    assert.equal(manifest.sha256, result.sha256);
    assert.equal(manifest.size, result.size);
    assert.equal(manifest.identity.package, '@nanthai/forge');
    assert.match(manifest.identity.backupSourceSha256, /^[a-f0-9]{64}$/);
    assert.match(manifest.identity.lockfileSha256, /^[a-f0-9]{64}$/);
    assert.equal(manifest.storedFiles.count, 1);
    assert.equal((await readBackupStatus(x.directory, now)).missedWeek, false);
  }));

test('partial upload and exporter/verification failures never list or prune', () =>
  setup(async x => {
    seed(x.client);
    x.client.list = async () => assert.fail('failed run cannot enumerate retention');
    await assert.rejects(
      backup(
        x.command,
        async () => {
          throw new Error('fake export failed');
        },
        x.options,
      ),
    );
    await assert.rejects(
      backup(x.command, x.exporter, {
        ...x.options,
        verifySnapshot: async () => {
          throw new Error('invalid ZIP');
        },
      }),
    );
    x.client.part = async () => {
      throw new Error('fake upload failed');
    };
    await assert.rejects(backup(x.command, x.exporter, x.options));
    assert.deepEqual(x.client.deleted, []);
    assert.equal((await readBackupStatus(x.directory, now)).pending, true);
  }));

test('checksum mismatch fails before manifest or pruning, including mismatching readback with matching HEAD', () =>
  setup(async x => {
    x.client.digest = async () => ({ size: 19, sha256: '0'.repeat(64) });
    x.client.list = async () => assert.fail('checksum mismatch cannot prune');
    await assert.rejects(backup(x.command, x.exporter, x.options), { code: 'BACKUP_CHECKSUM_MISMATCH' });
    assert.equal(
      [...x.client.objects.keys()].some(key => key.endsWith('manifest.json')),
      false,
    );
  }));

test('lost multipart completion response retries the original key without exporting or uploading twice', () =>
  setup(async x => {
    const complete = x.client.complete;
    x.client.complete = async (...args) => {
      await complete(...args);
      throw new Error('lost response');
    };
    await assert.rejects(backup(x.command, x.exporter, x.options));
    assert.equal(x.client.objects.size, 1);
    const result = await backup(x.command, x.exporter, x.options);
    assert.equal(result.complete, true);
    assert.equal(x.exports(), 1);
    assert.equal(x.client.creates, 1);
    assert.equal(x.client.objects.size, 2);
    assert.deepEqual(await backup(x.command, () => assert.fail('completed replay'), x.options), result);
  }));

test('lost manifest response reconciles the existing manifest before pruning', () =>
  setup(async x => {
    const put = x.client.put;
    x.client.put = async (...args) => {
      await put(...args);
      throw new Error('lost response');
    };
    await assert.rejects(backup(x.command, x.exporter, x.options));
    x.client.put = () => assert.fail('manifest must not be duplicated');
    assert.equal((await backup(x.command, x.exporter, x.options)).complete, true);
    assert.equal(x.exports(), 1);
  }));

test('partial multipart retry replaces deterministic parts and keeps a single completed object', () =>
  setup(async x => {
    const part = x.client.part;
    let fail = true;
    x.client.part = async (...args) => {
      const etag = await part(...args);
      if (fail && args[2] === 2) throw new Error('lost part');
      return etag;
    };
    const exporter = async (_, path) => writeFile(path, Buffer.alloc(16 * 1024 * 1024 + 1, 3));
    await assert.rejects(backup(x.command, exporter, x.options));
    assert.equal(x.client.objects.size, 0);
    fail = false;
    assert.equal((await backup(x.command, exporter, x.options)).complete, true);
    assert.equal(x.client.creates, 1);
  }));

test('pruning keeps exactly four including the just-written backup and ignores other prefixes', () =>
  setup(async x => {
    seed(x.client);
    const result = await backup(x.command, x.exporter, x.options);
    assert.equal(result.pruned, 3);
    assert.equal(
      [...x.client.objects.keys()].filter(
        k => k.startsWith(prefix) && /T03-00-00\.000Z-[^/]+\/manifest.json$/.test(k) && !k.includes('nested'),
      ).length,
      4,
    );
    assert.equal(x.client.objects.has('other/prefix/manifest.json'), true);
    assert.equal(x.client.objects.has(prefix + 'unmanaged.txt'), true);
    assert.equal(x.client.deleted.length, 6);
    assert.equal(
      x.client.deleted.some(k => k.includes('2026-10-21')),
      false,
    );
  }));

test('pruning protects the current backup even if its clock is older than retained backups', () =>
  setup(async x => {
    seed(x.client);
    const current = backupName(1) + 'snapshot.zip';
    await pruneBackups(x.client, prefix, current);
    assert.equal(x.client.objects.has(current), true);
    assert.equal(x.client.deleted.length, 4);
  }));

test('missed week status is offline, marks stale or first runs, and survives a failed attempt', () =>
  setup(async x => {
    assert.equal((await readBackupStatus(x.directory, now)).missedWeek, true);
    await backup(x.command, x.exporter, x.options);
    const later = new Date(now.getTime() + 7 * 86400000 + 1);
    assert.equal((await readBackupStatus(x.directory, later)).missedWeek, true);
    const next = { ...x.command, operationId: '22222222-2222-4222-8222-222222222222' };
    await assert.rejects(
      backup(
        next,
        async () => {
          throw new Error('failed');
        },
        { ...x.options, now: later },
      ),
    );
    const state = JSON.parse(await readFile(join(x.directory, 'last-run.json'), 'utf8'));
    assert.equal(state.lastSuccess, now.toISOString());
    assert.equal(state.lastAttempt.status, 'failed');
  }));

test('backup arguments require an explicit bounded prefix and preserve the existing R2 bucket name', () => {
  const env = {
    R2_BUCKET: 'fake',
    HOSTED_DURABILITY_R2_PREFIX: prefix,
    HOSTED_DURABILITY_STATE_DIR: '/tmp/synthetic',
    HOSTED_DURABILITY_DEPLOYMENT: 'prod:synthetic',
  };
  assert.equal(parseCommand(['backup'], env).deployment, 'synthetic');
  for (const value of ['', '/', '../', 'a/../', 'a', 'a//'])
    assert.throws(() => parseCommand(['backup', '--prefix', value], env));
  assert.equal(parseCommand(['backup-status'], env).command, 'backup-status');
});

test('a delayed upload retry reports stale snapshot time rather than pretending the data is fresh', () =>
  setup(async x => {
    const complete = x.client.complete;
    x.client.complete = async (...args) => {
      await complete(...args);
      throw new Error('lost response');
    };
    await assert.rejects(backup(x.command, x.exporter, x.options));
    const later = new Date(now.getTime() + 8 * 86400000);
    const result = await backup(x.command, x.exporter, { ...x.options, now: later });
    assert.equal(result.time, now.toISOString());
    assert.equal((await readBackupStatus(x.directory, later)).missedWeek, true);
  }));

test('pending backups cannot silently switch target or operation and concurrent calls cannot export twice', () =>
  setup(async x => {
    let entered;
    const ready = new Promise(resolve => {
      entered = resolve;
    });
    let resume;
    const held = new Promise(resolve => {
      resume = resolve;
    });
    const first = backup(
      x.command,
      async (_, path) => {
        entered();
        await held;
        await writeFile(path, 'synthetic zip bytes');
      },
      x.options,
    );
    await ready;
    try {
      await assert.rejects(backup(x.command, x.exporter, x.options), { code: 'BACKUP_BUSY' });
    } finally {
      resume();
    }
    await first;
    await assert.rejects(backup({ ...x.command, prefix: 'elsewhere/' }, x.exporter, x.options), {
      code: 'BACKUP_TARGET_MISMATCH',
    });
  }));

test('offline status CLI emits one line, uses exit 2 when overdue, and needs no credentials', () =>
  setup(async x => {
    const run = () =>
      spawnSync(
        process.execPath,
        ['scripts/hosted-durability.mjs', 'backup-status', '--state-dir', x.directory],
        { encoding: 'utf8', env: { PATH: process.env.PATH } },
      );
    let result = run();
    assert.equal(result.status, 2);
    assert.equal(result.stdout.trim().split('\n').length, 1);
    assert.equal(JSON.parse(result.stdout).missedWeek, true);
    await backup(x.command, x.exporter, { ...x.options, now: new Date() });
    result = run();
    assert.equal(result.status, 0);
    assert.equal(JSON.parse(result.stdout).lastAttempt.status, 'passed');
  }));

test('a re-export after a failed export gets the fresh observation key and a pending operation keeps its id', () =>
  setup(async x => {
    await assert.rejects(
      backup(
        x.command,
        async () => {
          throw new Error('failed export');
        },
        x.options,
      ),
    );
    await assert.rejects(
      backup({ ...x.command, operationId: '22222222-2222-4222-8222-222222222222' }, x.exporter, x.options),
      { code: 'BACKUP_PENDING' },
    );
    const later = new Date('2026-10-28T03:00:00.000Z');
    const result = await backup(x.command, x.exporter, { ...x.options, now: later });
    assert.equal(result.time, later.toISOString());
    assert.ok([...x.client.objects.keys()].every(key => key.includes('2026-10-28T03-00-00.000Z')));
  }));

test('database-only weekly backup excludes files and pins storage mode in its manifest and receipt', () =>
  setup(async x => {
    x.command.databaseOnly = true;
    const result = await backup(
      x.command,
      async (_, path, options) => {
        assert.equal(options.databaseOnly, true);
        await writeFile(path, 'database-only snapshot');
      },
      {
        ...x.options,
        verifySnapshot: async (_, options) => {
          assert.equal(options.databaseOnly, true);
          return { files: { count: 0 } };
        },
      },
    );
    assert.equal(result.includeFileStorage, false);
    const key = [...x.client.objects.keys()].find(key => key.endsWith('/manifest.json'));
    const manifest = JSON.parse(x.client.objects.get(key));
    assert.equal(manifest.databaseOnly, true);
    assert.equal(manifest.includeFileStorage, false);
    assert.equal(manifest.storedFiles.count, 0);
    await assert.rejects(backup({ ...x.command, databaseOnly: false }, x.exporter, x.options), {
      code: 'BACKUP_TARGET_MISMATCH',
    });
  }));
