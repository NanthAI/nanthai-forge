// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { exclusion, sourceExclusion, fingerprintPrivateFile, readSource } from '../dist/files.js';
import { touchCtime } from './helpers.mjs';

test('source exclusions keep secret-named modules and env templates while protecting credentials', () => {
  for (const path of [
    'src/secret-crypto.ts',
    'convex/secrets.ts',
    'tests/secrets.test.mjs',
    'web/src/Secrets.tsx',
    'src/credentials.py',
    'src/secrets.rs',
    'src/secret.java',
    '.env.example',
    '.env.sample',
    '.env.template',
  ]) {
    assert.equal(sourceExclusion(path), null, path);
    assert.equal(exclusion(path), 'sensitive-name', `analysis keeps its existing policy: ${path}`);
  }
  for (const path of [
    '.env',
    '.env.local',
    '.env.production',
    '.env.example.local',
    '.env.sample.bak',
    '.env.ts',
    '.npmrc',
    '.netrc',
    'credentials.json',
    'credentials.production.json',
    'secrets.json',
    'secret-backup.txt',
    'tls/cert.pem',
    'tls/private.key',
    'tls/client.p12',
    'tls/client.pfx',
    'tls/client.keystore',
    '.ssh/id_rsa',
    '.aws/credentials',
    'private-artifacts/secret-crypto.ts',
    '.forge/secrets.ts',
  ]) {
    assert.notEqual(sourceExclusion(path), null, path);
    assert.equal(sourceExclusion(path), exclusion(path), path);
  }
});

test('private fingerprints reconcile stable metadata-only changes and reject changing content or authority', async t => {
  const root = fs.mkdtempSync(join(tmpdir(), 'forge-fingerprint-')),
    path = join(root, 'retained');
  const bytes = Buffer.alloc(2 * 1024 * 1024, 17),
    original = fs.createReadStream;
  t.after(() => {
    fs.createReadStream = original;
    syncBuiltinESMExports();
    fs.rmSync(root, { recursive: true });
  });
  for (const kind of ['once', 'content', 'permissions', 'link', 'replacement', 'ongoing']) {
    if (fs.existsSync(path)) fs.chmodSync(path, 0o600);
    fs.writeFileSync(path, bytes, { mode: 0o600 });
    let reads = 0;
    fs.createReadStream = (...args) => {
      const stream = original(...args),
        read = ++reads;
      stream.once('data', () => {
        if (kind === 'ongoing' || read === 1) {
          if (kind === 'content') {
            // Same-size rewrites are detected through mtime; coarse Linux timestamps can leave it unchanged
            // within one tick, so model a write that lands in a later tick.
            const { mtimeMs } = fs.statSync(path);
            fs.writeFileSync(path, Buffer.alloc(bytes.length, 23));
            fs.utimesSync(path, new Date(), new Date(mtimeMs + 1000));
          } else if (kind === 'link') fs.linkSync(path, join(root, 'linked'));
          else if (kind === 'replacement') {
            fs.renameSync(path, join(root, 'moved'));
            fs.writeFileSync(path, bytes, { mode: 0o600 });
          } else if (kind === 'permissions') fs.chmodSync(path, 0o400);
          else touchCtime(path);
        }
      });
      return stream;
    };
    syncBuiltinESMExports();
    if (kind === 'once') {
      assert.deepEqual(await fingerprintPrivateFile(path), {
        size: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex'),
      });
      assert.equal(reads, 2);
    } else await assert.rejects(fingerprintPrivateFile(path), { code: 'INVALID_FILE_EXPORT' }, kind);
    fs.createReadStream = original;
    syncBuiltinESMExports();
    if (fs.existsSync(join(root, 'linked'))) fs.unlinkSync(join(root, 'linked'));
    if (fs.existsSync(join(root, 'moved'))) fs.unlinkSync(join(root, 'moved'));
  }
});

test('source reads reconcile ctime-only hydration with identical stable reread and retain content/path/authority failures', t => {
  const root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'forge-source-hydration-'))),
    path = join(root, 'source.ts');
  const original = fs.readSync;
  t.after(() => {
    fs.readSync = original;
    syncBuiltinESMExports();
    fs.rmSync(root, { recursive: true });
  });
  const bytes = Buffer.from('export const value = 123;\n');
  for (const kind of ['once', 'content', 'mtime', 'permissions', 'link', 'replacement', 'symlink']) {
    fs.rmSync(path, { force: true });
    fs.writeFileSync(path, bytes, { mode: 0o600 });
    let reads = 0;
    fs.readSync = (...args) => {
      const count = original(...args),
        read = ++reads;
      if (read === 1 || kind === 'ongoing') {
        const stat = fs.statSync(path);
        if (kind === 'content') {
          fs.writeFileSync(path, Buffer.from('export const value = 999;\n'));
          fs.utimesSync(path, stat.atime, stat.mtime);
        } else if (kind === 'mtime') fs.utimesSync(path, stat.atime, new Date(stat.mtimeMs + 1000));
        else if (kind === 'link') fs.linkSync(path, join(root, 'linked'));
        else if (kind === 'replacement' || kind === 'symlink') {
          fs.renameSync(path, join(root, 'moved'));
          if (kind === 'symlink') fs.symlinkSync(join(root, 'moved'), path);
          else fs.writeFileSync(path, bytes, { mode: 0o600 });
        } else if (kind === 'permissions') fs.chmodSync(path, 0o400);
        else touchCtime(path);
      }
      return count;
    };
    syncBuiltinESMExports();
    if (kind === 'once') {
      assert.deepEqual(readSource(root, 'source.ts', 4096), bytes);
      assert.ok(reads >= 3, 'Metadata-only reconciliation rereads source bytes.');
    } else
      assert.throws(() => readSource(root, 'source.ts', 4096, undefined), { code: 'SOURCE_CHANGED' }, kind);
    fs.readSync = original;
    syncBuiltinESMExports();
    for (const name of ['linked', 'moved'])
      if (fs.existsSync(join(root, name))) fs.unlinkSync(join(root, name));
  }
});

test('source reads reject continuously unstable metadata even with identical bytes', t => {
  const root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'forge-source-unstable-')));
  const original = fs.fstatSync;
  t.after(() => {
    fs.fstatSync = original;
    syncBuiltinESMExports();
    fs.rmSync(root, { recursive: true });
  });
  fs.writeFileSync(join(root, 'source.ts'), 'export const value = 1;');
  let observations = 0;
  fs.fstatSync = (...args) => {
    const value = original(...args);
    value.ctimeMs += ++observations;
    return value;
  };
  syncBuiltinESMExports();
  assert.throws(() => readSource(root, 'source.ts', 4096), { code: 'SOURCE_CHANGED' });
});
