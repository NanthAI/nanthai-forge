// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { cp, mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { retainBackendNotice, retainNativeComponentNotices } from '../scripts/selfhost-notices.mjs';
const source = new URL('../docs/vendor-notices/native-components/', import.meta.url);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const withDirectory = async fn => {
  const directory = await mkdtemp(join(tmpdir(), 'forge-native-notice-'));
  try {
    await fn(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
};
const manifest = JSON.parse(await readFile(new URL('manifest.json', source)));
const fixture = async directory => {
  const path = join(directory, 'source');
  await cp(source, path, { recursive: true });
  return pathToFileURL(`${path}/`);
};
test('fresh offline retention preserves all original bytes, partial scope and private permissions', async () =>
  withDirectory(async directory => {
    assert.equal(await retainBackendNotice(directory), true);
    assert.equal(await retainNativeComponentNotices(directory), true);
    const target = join(directory, 'native-component-notices');
    assert.equal((await stat(target)).mode & 0o777, 0o700);
    for (const path of ['manifest.json', 'PARTIAL.md', ...manifest.originals.map(item => item.path)]) {
      const installed = join(target, path);
      assert.deepEqual(await readFile(installed), await readFile(new URL(path, source)), path);
      assert.equal((await stat(installed)).mode & 0o777, 0o600);
    }
    assert.match(await readFile(join(target, 'PARTIAL.md'), 'utf8'), /not a complete binary SBOM/);
    assert.equal(manifest.originals.length, 39);
    for (const item of manifest.originals) {
      const bytes = await readFile(join(target, item.path));
      assert.equal(hash(bytes), item.sha256);
      assert.equal(bytes.length, item.size);
      assert.ok(!item.path.startsWith('/') && !item.path.split('/').includes('..'));
      assert.match(
        item.source,
        /^https:\/\/(?:github\.com|raw\.githubusercontent\.com|static\.crates\.io)\//,
      );
    }
  }));
test('missing or altered original notices remain advisory and preserve existing instance/root notice', async () => {
  for (const variant of ['missing', 'altered'])
    await withDirectory(async directory => {
      const changed = await fixture(directory),
        instance = join(directory, 'instance');
      await mkdir(instance);
      await writeFile(join(instance, 'instance.json'), 'synthetic existing configuration\n');
      assert.equal(await retainBackendNotice(instance), true);
      const rootNotice = await readFile(join(instance, 'LICENSE-convex-backend.md'));
      const selected = new URL(manifest.originals[0].path, changed);
      if (variant === 'missing') await rm(selected);
      else await writeFile(selected, 'changed original');
      assert.equal(await retainNativeComponentNotices(instance, changed), false);
      assert.equal(
        await readFile(join(instance, 'instance.json'), 'utf8'),
        'synthetic existing configuration\n',
      );
      assert.deepEqual(await readFile(join(instance, 'LICENSE-convex-backend.md')), rootNotice);
      await assert.rejects(stat(join(instance, 'native-component-notices')), { code: 'ENOENT' });
    });
});
test('missing manifest and missing/altered disclosure never produce a misleading retained collection', async () => {
  for (const variant of ['missing-manifest', 'missing-disclosure', 'altered-disclosure'])
    await withDirectory(async directory => {
      const changed = await fixture(directory),
        instance = join(directory, 'instance');
      await mkdir(instance);
      const selected = new URL(variant === 'missing-manifest' ? 'manifest.json' : 'PARTIAL.md', changed);
      if (variant === 'altered-disclosure') await writeFile(selected, 'Complete binary clearance');
      else await rm(selected);
      assert.equal(await retainNativeComponentNotices(instance, changed), false);
      await assert.rejects(stat(join(instance, 'native-component-notices')), { code: 'ENOENT' });
    });
});
test('retention does not overwrite existing or interrupted local notice material', async () =>
  withDirectory(async directory => {
    const target = join(directory, 'native-component-notices');
    await mkdir(target);
    await writeFile(join(target, 'PARTIAL.md'), 'preserved local receipt\n');
    assert.equal(await retainNativeComponentNotices(directory), false);
    assert.equal(await readFile(join(target, 'PARTIAL.md'), 'utf8'), 'preserved local receipt\n');
    assert.equal(await retainBackendNotice(directory), true);
    const before = await readFile(join(directory, 'LICENSE-convex-backend.md'));
    assert.equal(await retainBackendNotice(directory), false);
    assert.deepEqual(await readFile(join(directory, 'LICENSE-convex-backend.md')), before);
  }));
