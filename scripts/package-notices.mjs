// SPDX-License-Identifier: Apache-2.0
// Preserve upstream notice bytes for the locked production npm dependency closure.
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const options = new Map(),
  args = process.argv.slice(2);
let check = false,
  installed = false;
for (let i = 0; i < args.length; i++) {
  const key = args[i];
  if (key === '--check' && !check) {
    check = true;
    continue;
  }
  if (key === '--installed' && !installed) {
    installed = true;
    continue;
  }
  if (
    !['--root', '--lock', '--out', '--inventory'].includes(key) ||
    options.has(key) ||
    !args[i + 1] ||
    args[i + 1].startsWith('--')
  )
    throw new Error(
      'Use package-notices.mjs [--root DIRECTORY] [--lock FILE] [--out FILE] [--inventory NPM_PACK_JSON | --installed] [--check].',
    );
  options.set(key, args[++i]);
}
const root = options.has('--root')
  ? resolve(options.get('--root'))
  : fileURLToPath(new URL('..', import.meta.url));
const lockPath = resolve(root, options.get('--lock') ?? 'package-lock.json');
const outputPath = options.has('--out')
  ? resolve(options.get('--out'))
  : join(root, 'THIRD_PARTY_NOTICES.txt');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const lockBytes = readFileSync(lockPath);
const lock = JSON.parse(lockBytes);
const inventory = options.has('--inventory')
  ? JSON.parse(readFileSync(resolve(options.get('--inventory'))))
  : undefined;
if (
  (inventory &&
    (!Array.isArray(inventory) || inventory.length !== 1 || !Array.isArray(inventory[0].files))) ||
  (inventory && installed)
)
  throw new Error('Use one npm pack JSON inventory, or --installed.');
const artifact = !!inventory || installed,
  packed = new Set(inventory?.[0].files.map(file => file.path));
// Required dependency edges remain complete; dev/optional peer overlap can be installed but not bundled by npm.
const required = new Set(),
  pending = [''];
while (pending.length) {
  const parent = pending.pop(),
    entry = lock.packages[parent];
  for (const name of Object.keys(entry.dependencies ?? {})) {
    if (entry.optionalDependencies?.[name]) continue;
    let owner = parent,
      selected;
    while (true) {
      const candidate = `${owner ? owner + '/' : ''}node_modules/${name}`;
      if (lock.packages[candidate]) {
        selected = candidate;
        break;
      }
      if (!owner) throw new Error(`Required dependency is absent from the original lock: ${name}`);
      const index = owner.lastIndexOf('/node_modules/');
      owner = index < 0 ? '' : owner.slice(0, index);
    }
    if (!required.has(selected)) {
      required.add(selected);
      pending.push(selected);
    }
  }
}
const chunks = [
  Buffer.from(
    `NanthAi:Forge third-party npm notices\n\nExact upstream license/notice files for installed locked production dependencies.\nLockfile SHA-256: ${hash(lockBytes)}\nDependencies retain their own licenses; this document does not relicense them.\nThe separately launched native Convex backend is not included in this package.\nNanthAi brand rights are described separately in web/src/assets/NOTICE.md.\n\n`,
  ),
];
const missing = [],
  copied = [],
  omitted = [];
for (const [path, entry] of Object.entries(lock.packages).sort(([a], [b]) => a.localeCompare(b))) {
  if (!path || entry.dev || entry.link) continue;
  const packageRoot = join(root, path),
    manifestPath = join(packageRoot, 'package.json');
  const selected = !inventory || packed.has(`${path}/package.json`);
  if (!selected || !existsSync(manifestPath)) {
    const record = {
      path,
      version: entry.version,
      reason: artifact
        ? 'No package bytes in the selected artifact production dependency closure.'
        : 'Not installed; no package bytes bundled from this dependency.',
    };
    ((artifact ? !required.has(path) && (!inventory || !selected) : entry.optional) ? omitted : missing).push(
      record,
    );
    continue;
  }
  const manifest = JSON.parse(readFileSync(manifestPath));
  if (manifest.version !== entry.version)
    throw new Error(`Notice version mismatch at ${path}: ${manifest.version} versus locked ${entry.version}`);
  const files = readdirSync(packageRoot).filter(name =>
    /^(?:licen[cs]e|notice|copying)(?:[._-].*)?$/i.test(name),
  );
  // Some upstream packages put the original license text in their README.
  if (
    !files.length &&
    existsSync(join(packageRoot, 'README.md')) &&
    /^##? License\s*$/im.test(readFileSync(join(packageRoot, 'README.md'), 'utf8'))
  )
    files.push('README.md');
  if (typeof manifest.license === 'string') {
    const selected = manifest.license.match(/^SEE LICENSE IN (.+)$/i)?.[1];
    if (selected && !selected.includes('..') && !selected.startsWith('/') && !files.includes(selected))
      files.push(selected);
  }
  const notices = files
    .sort()
    .filter(name => existsSync(join(packageRoot, name)) && lstatSync(join(packageRoot, name)).isFile());
  if (!notices.length && manifest.name?.startsWith('@esbuild/')) {
    const owner = join(root, 'node_modules', 'esbuild');
    const ownerManifest = JSON.parse(readFileSync(join(owner, 'package.json')));
    if (
      ownerManifest.version !== manifest.version ||
      ownerManifest.repository?.url !== manifest.repository?.url
    )
      throw new Error(`Unmatched upstream binary owner: ${path}`);
    const source = 'node_modules/esbuild/LICENSE.md',
      bytes = readFileSync(join(root, source));
    chunks.push(
      Buffer.from(
        `===== ${manifest.name}@${manifest.version}: original upstream esbuild license =====\nPlatform package has no separate notice; exact same-version/same-repository esbuild text follows.\nSource: ${source}; original bytes: ${bytes.length}; SHA-256: ${hash(bytes)}\n`,
      ),
      bytes,
      Buffer.from('\n===== End original file =====\n\n'),
    );
    copied.push({
      package: manifest.name,
      version: manifest.version,
      path: source,
      bytes: bytes.length,
      sha256: hash(bytes),
    });
    continue;
  }
  if (!notices.length) {
    missing.push({
      path,
      name: manifest.name,
      version: manifest.version,
      license: entry.license,
      reason: 'No installed upstream license/notice file found.',
    });
    continue;
  }
  for (const file of notices) {
    const bytes = readFileSync(join(packageRoot, file));
    const sha256 = hash(bytes);
    chunks.push(
      Buffer.from(
        `===== ${manifest.name}@${manifest.version}: ${path}/${file} =====\nOriginal bytes: ${bytes.length}; SHA-256: ${sha256}\n`,
      ),
      bytes,
      Buffer.from('\n===== End original file =====\n\n'),
    );
    copied.push({
      package: manifest.name,
      version: manifest.version,
      path: `${path}/${file}`,
      bytes: bytes.length,
      sha256,
    });
  }
}
if (missing.length) throw new Error(`Upstream notices incomplete: ${JSON.stringify(missing)}`);
chunks.push(
  Buffer.from(
    `${artifact ? 'Locked dependencies absent from this artifact production closure' : 'Platform-optional dependencies absent from this installation'}, with no bytes bundled:\n${JSON.stringify(omitted, null, 2)}\n`,
  ),
);
const output = Buffer.concat(chunks);
if (check) {
  if (!existsSync(outputPath) || !readFileSync(outputPath).equals(output))
    throw new Error('Third-party notices differ from the installed locked production closure.');
} else writeFileSync(outputPath, output);
console.log(
  JSON.stringify({
    packages: new Set(copied.map(file => file.package)).size,
    noticeFiles: copied.length,
    bytes: output.length,
    sha256: hash(output),
    ...(artifact
      ? { omittedUnbundledPackages: omitted.length }
      : { omittedPlatformPackages: omitted.length }),
    installedProductionClosure: 'complete',
  }),
);
