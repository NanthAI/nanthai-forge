// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import assert from 'node:assert/strict';
import {
  chmodSync,
  lstatSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { temporaryDirectory } from '../scripts/test-temp.mjs';
import { digest } from '../dist/hash.js';
import { HostedCheckoutCache } from '../dist/hosted-checkout-cache.js';
import { prepareMachineCheckout } from '../dist/hosted-mac-source.js';

function fixture(t) {
  const root = temporaryDirectory(t, 'forge-machine-source-');
  const machine = join(root, 'objects');
  const bytesByBlob = new Map();
  const described = [],
    downloaded = [];
  const transport = {
    objects: async ids => {
      described.push(ids);
      return ids.map(sha256 => ({ sha256, size: bytesByBlob.get(sha256).length }));
    },
    downloadToFile: async ({ sha256 }, path) => {
      downloaded.push(sha256);
      writeFileSync(path, bytesByBlob.get(sha256));
    },
  };
  function file(path, source, mode = 'file') {
    const bytes = Buffer.from(source),
      blob = digest(bytes);
    bytesByBlob.set(blob, bytes);
    return { path, blob, mode };
  }
  async function checkout(name, files, options = {}) {
    const cache = new HostedCheckoutCache(join(root, name, 'cache'), transport, undefined, machine);
    const path = join(root, name, 'source');
    const descriptions = described.length,
      downloads = downloaded.length;
    await prepareMachineCheckout(path, cache, transport, files, new AbortController().signal, {
      machine,
      ...options,
    });
    return {
      path,
      privateObjects: cache.objects,
      described: described.slice(descriptions),
      downloaded: downloaded.slice(downloads),
    };
  }
  return { machine, file, checkout };
}

function snapshot(root, directory = '') {
  return readdirSync(join(root, directory))
    .sort()
    .flatMap(name => {
      const path = directory ? `${directory}/${name}` : name;
      const entry = join(root, path),
        stat = lstatSync(entry);
      return stat.isDirectory()
        ? snapshot(root, path)
        : [
            {
              path,
              mode: stat.mode,
              bytes: stat.isSymbolicLink()
                ? readlinkSync(entry, { encoding: 'buffer' })
                : readFileSync(entry),
            },
          ];
    });
}

test('warm machine objects produce the same Candidate paths, bytes and modes as a fresh install', async t => {
  const { file, checkout, machine } = fixture(t);
  const unchanged = file('shared.txt', 'shared\n');
  const modeOnly = file('run.sh', '#!/bin/sh\n');
  const previous = [unchanged, modeOnly, file('removed/old.txt', 'delete me'), file('value', 'old')];
  await checkout('previous', previous);

  const addition = file('value/new.txt', 'first\nsecond\n');
  const rules = file('.gitattributes', 'value/*.txt text eol=crlf\n');
  const link = file('value-link', 'value/new.txt', 'symlink');
  const gitlink = file('vendor', '1'.repeat(40), 'gitlink');
  const candidate = [unchanged, { ...modeOnly, mode: 'executable' }, addition, rules, link, gitlink];
  const warm = await checkout('warm', candidate, { rawBlobs: [gitlink.blob] });
  assert.equal(warm.described.length, 1);
  assert.deepEqual(
    warm.downloaded,
    [addition, rules, link, gitlink].map(file => file.blob),
  );
  assert.deepEqual(readFileSync(join(warm.privateObjects, gitlink.blob)), Buffer.from('1'.repeat(40)));
  assert.equal(readFileSync(join(warm.path, addition.path), 'utf8'), 'first\r\nsecond\r\n');
  const fresh = await checkout('fresh', candidate, { machine: null });
  const another = await checkout('warm-again', candidate);
  assert.deepEqual(another.described, [], 'a fully cached Candidate adds no metadata calls');
  assert.deepEqual(another.downloaded, []);
  assert.deepEqual(snapshot(warm.path), snapshot(fresh.path));
  assert.deepEqual(snapshot(another.path), snapshot(fresh.path));
  writeFileSync(join(warm.path, unchanged.path), 'local change');
  assert.equal(readFileSync(join(another.path, unchanged.path), 'utf8'), 'shared\n');
  assert.equal(readFileSync(join(machine, unchanged.blob), 'utf8'), 'shared\n');
});

test('a missing or corrupt machine object is fetched before the Candidate can run', async t => {
  const { file, checkout, machine } = fixture(t);
  const healthy = file('healthy', 'healthy');
  const missing = file('missing', 'missing');
  const corrupt = file('corrupt', 'correct');
  const files = [healthy, missing, corrupt];
  const baseline = await checkout('initial', files);
  unlinkSync(join(machine, missing.blob));
  writeFileSync(join(machine, corrupt.blob), 'changed');
  const recovered = await checkout('recovered', files);
  assert.deepEqual(recovered.downloaded, [missing.blob, corrupt.blob]);
  assert.deepEqual(snapshot(recovered.path), snapshot(baseline.path));
  const next = await checkout('repaired-cache', files);
  assert.deepEqual(next.downloaded, []);
  assert.deepEqual(snapshot(next.path), snapshot(baseline.path));
});

const posixPermissions = process.platform !== 'win32' && process.getuid?.() !== 0;

test(
  'an unreadable regular or link object falls back to verified private source',
  { skip: !posixPermissions },
  async t => {
    const { file, checkout, machine } = fixture(t);
    const regular = file('target', 'good data');
    const link = file('link', 'target', 'symlink');
    const files = [regular, link];
    const baseline = await checkout('initial', files);
    for (const unreadable of files) {
      chmodSync(join(machine, unreadable.blob), 0o000);
      const recovered = await checkout(`unreadable-${unreadable.mode}`, files);
      assert.deepEqual(recovered.downloaded, [unreadable.blob]);
      assert.deepEqual(snapshot(recovered.path), snapshot(baseline.path));
    }
  },
);

test(
  'a read-only machine store leaves fresh source acquisition available',
  { skip: !posixPermissions },
  async t => {
    const { file, checkout, machine } = fixture(t);
    const cached = file('cached', 'already on disk');
    await checkout('initial', [cached]);
    const missing = file('missing', 'from the host');
    chmodSync(machine, 0o500);
    try {
      const candidate = await checkout('read-only-store', [cached, missing]);
      assert.deepEqual(candidate.downloaded, [missing.blob]);
      assert.deepEqual(readdirSync(candidate.path).sort(), ['cached', 'missing']);
      assert.equal(readFileSync(join(candidate.path, 'missing'), 'utf8'), 'from the host');
    } finally {
      chmodSync(machine, 0o700);
    }
  },
);
