// SPDX-License-Identifier: Apache-2.0
import { chmodSync, constants, copyFileSync, lstatSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fingerprintPrivateFile } from './files.js';
import { invariant } from './errors.js';
import type { WorkData } from './work-types.js';

export type BackupFile = { path: string; size: number; sha256?: string };
export type ArtifactAlias = { path: string; target: string };
const code = 'INVALID_WORK_BACKUP';
const artifact = /^check-[0-9a-f-]{36}\/artifacts\/artifact-[0-9]+\.bin$/;

// Aliases are transport references only. The full logical file manifest stays authoritative.
export function artifactArchivePlan(manifest: {
  schema?: unknown;
  kind?: unknown;
  files: BackupFile[];
  artifactAliases?: unknown;
  unavailable?: unknown;
}) {
  invariant(
    new Set(manifest.files.map(file => file.path)).size === manifest.files.length,
    code,
    'Native backup repeats file paths.',
  );
  const raw = manifest.artifactAliases;
  if (raw === undefined) {
    invariant(
      manifest.schema !== 2 || manifest.kind !== 'forge-native-work-backup',
      code,
      'Deduplicated native backup omits its artifact references.',
    );
    return { physical: manifest.files, aliases: [] as ArtifactAlias[] };
  }
  invariant(
    manifest.schema === 2 && manifest.kind === 'forge-native-work-backup' && Array.isArray(raw),
    code,
    'Artifact references require native backup schema 2.',
  );
  const aliases: ArtifactAlias[] = [];
  for (const value of raw) {
    invariant(
      value &&
        typeof value === 'object' &&
        Object.keys(value).sort().join(',') === 'path,target' &&
        typeof value.path === 'string' &&
        typeof value.target === 'string' &&
        artifact.test(value.path) &&
        artifact.test(value.target),
      code,
      'Only retained build outputs can use artifact references.',
    );
    aliases.push({ path: value.path, target: value.target });
  }
  const names = new Set(aliases.map(alias => alias.path));
  invariant(names.size === aliases.length, code, 'Native backup repeats artifact references.');
  const files = new Map(manifest.files.map((file, index) => [file.path, { file, index }]));
  for (const alias of aliases) {
    const source = files.get(alias.path),
      target = files.get(alias.target);
    invariant(
      source &&
        target &&
        target.index < source.index &&
        !names.has(alias.target) &&
        source.file.sha256 &&
        source.file.sha256 === target.file.sha256 &&
        source.file.size === target.file.size &&
        (!Array.isArray(manifest.unavailable) ||
          (!manifest.unavailable.includes(alias.path) && !manifest.unavailable.includes(alias.target))),
      code,
      'Artifact references must name an earlier available physical output with identical bytes.',
    );
  }
  return { physical: manifest.files.filter(file => !names.has(file.path)), aliases };
}

export function deduplicateArtifactFiles(files: BackupFile[]) {
  const originals = new Map<string, string>(),
    aliases: ArtifactAlias[] = [];
  for (const file of files) {
    if (!artifact.test(file.path)) continue;
    const key = `${file.sha256}:${file.size}`,
      target = originals.get(key);
    if (target) aliases.push({ path: file.path, target });
    else originals.set(key, file.path);
  }
  return aliases;
}

export function validateArtifactAliasRecords(data: WorkData, files: BackupFile[], aliases: ArtifactAlias[]) {
  const paths = new Set(aliases.flatMap(alias => [alias.path, alias.target]));
  for (const file of files.filter(file => paths.has(file.path))) {
    const match = /^check-([0-9a-f-]{36})\/artifacts\/(artifact-[0-9]+\.bin)$/.exec(file.path)!;
    const recorded = data.runs
      .find(run => run.id === match[1])
      ?.artifacts?.find(item => item.status === 'retained' && item.filename === match[2]);
    invariant(
      recorded?.status === 'retained' && recorded.sha256 === file.sha256 && recorded.size === file.size,
      code,
      'Artifact references must preserve an original retained Work output.',
    );
  }
}

// Resolve only inside a private captured directory, using separate regular files, never links.
export async function materializeArtifactAliases(
  directory: string,
  files: BackupFile[],
  aliases: ArtifactAlias[],
) {
  const byPath = new Map(files.map(file => [file.path, file]));
  for (const alias of aliases) {
    const expected = byPath.get(alias.path)!;
    const source = join(directory, alias.target),
      destination = join(directory, alias.path);
    const before = await fingerprintPrivateFile(source, code);
    invariant(
      before.size === expected.size && before.sha256 === expected.sha256,
      code,
      'Original artifact bytes differ from their reference.',
    );
    mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
    copyFileSync(source, destination, constants.COPYFILE_EXCL);
    chmodSync(destination, 0o600);
    const copied = await fingerprintPrivateFile(destination, code),
      after = await fingerprintPrivateFile(source, code);
    const sourceStat = lstatSync(source),
      destinationStat = lstatSync(destination);
    invariant(
      copied.sha256 === before.sha256 &&
        after.sha256 === before.sha256 &&
        copied.size === before.size &&
        after.size === before.size &&
        sourceStat.nlink === 1 &&
        destinationStat.nlink === 1 &&
        (sourceStat.dev !== destinationStat.dev || sourceStat.ino !== destinationStat.ino),
      code,
      'Artifact reference expansion did not preserve independent original bytes.',
    );
  }
}
