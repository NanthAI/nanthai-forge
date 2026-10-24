// SPDX-License-Identifier: Apache-2.0
import {
  constants,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { NativeSource, type NativeState } from './native-source.js';
import { gitTreeHasher } from './native-git-tree.js';
import { digest } from './hash.js';
import { invariant } from './errors.js';

const stateId = z.string().regex(/^[0-9a-f]{64}$/),
  commitId = z.string().regex(/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/);
const mappingSchema = z.object({
  schema: z.literal(1),
  kind: z.literal('forge-native-git-projection'),
  head: stateId,
  commit: commitId,
  format: z.enum(['sha1', 'sha256']),
  bundleSha256: stateId,
  states: z.array(z.object({ state: stateId, commit: commitId })),
});
type Git = (root: string, args: string[], input?: string | Buffer) => Promise<string>;
export function nativeCommitBytes(id: string, state: NativeState, tree: string, parents: string[]) {
  const seconds = Math.floor(Date.parse(state.at) / 1000);
  invariant(Number.isSafeInteger(seconds), 'INVALID_NATIVE_GIT', 'Native source time is invalid.');
  return Buffer.from(
    `tree ${tree}\n${parents.map(parent => `parent ${parent}\n`).join('')}author NanthAi Forge <forge@localhost> ${seconds} +0000\ncommitter NanthAi Forge <forge@localhost> ${seconds} +0000\n\n${state.message}\n\nForge-State: ${id}\n`,
  );
}

/** Read only the portable bundle, never a previous repository's config, hooks or alternates. */
export async function reuseNativeGit(
  previous: string,
  source: NativeSource,
  states: string[],
  format: 'sha1' | 'sha256',
  repo: string,
  scratch: string,
  git: Git,
) {
  const mapping = mappingSchema.parse(JSON.parse(readFileSync(join(previous, 'mapping.json'), 'utf8'))),
    mappings = new Map(mapping.states.map(item => [item.state, item.commit])),
    closure = source.ancestors(mapping.head);
  invariant(
    mapping.format === format &&
      states.includes(mapping.head) &&
      mappings.get(mapping.head) === mapping.commit &&
      mappings.size === mapping.states.length &&
      mappings.size === closure.size &&
      [...closure].every(id => mappings.has(id)),
    'INVALID_NATIVE_GIT',
    'Reuse mapping does not cover an ancestor projection in this native history.',
  );
  const bytes = readFileSync(join(previous, 'source.bundle'));
  invariant(digest(bytes) === mapping.bundleSha256, 'INVALID_NATIVE_GIT', 'Reuse bundle digest differs.');
  const bundle = join(scratch, 'reuse.bundle');
  writeFileSync(bundle, bytes, { flag: 'wx', mode: 0o600 });
  invariant(
    (await git(repo, ['rev-parse', '--show-object-format'])).trim() === mapping.format,
    'INVALID_NATIVE_GIT',
    'Reuse object format differs.',
  );
  await git(repo, ['--no-lazy-fetch', 'bundle', 'verify', bundle]);
  const packs = new Set(readdirSync(join(repo, 'objects/pack')));
  await git(repo, ['--no-lazy-fetch', 'bundle', 'unbundle', bundle]);
  await git(repo, ['--no-lazy-fetch', 'fsck', '--full', '--strict', '--no-reflogs', '--no-dangling']);
  const commits = [...new Set(mappings.values())],
    present = (await git(repo, ['--no-lazy-fetch', 'cat-file', '--batch-check'], commits.join('\n') + '\n'))
      .trim()
      .split('\n');
  invariant(
    present.length === commits.length &&
      present.every((line, index) => line.startsWith(`${commits[index]} commit `)),
    'INVALID_NATIVE_GIT',
    'Reuse commit objects are absent.',
  );
  // A self-consistent bundle is insufficient: prove its mapping against current
  // immutable source bytes without issuing any Git object-write commands.
  const blobs = new Map<string, string>(),
    objects = new Set<string>(),
    treeFor = gitTreeHasher(source, format, blobs, objects);
  for (const [id, commit] of mappings) {
    objects.add(commit);
    const state = source.state(id),
      tree = treeFor(state.files);
    if (state.git) {
      invariant(
        commit === state.git.commit && (await git(repo, ['rev-parse', `${commit}^{tree}`])).trim() === tree,
        'INVALID_NATIVE_GIT',
        'Reuse imported tree differs from native source.',
      );
    } else {
      const raw = nativeCommitBytes(
          id,
          state,
          tree,
          state.parents.map(parent => mappings.get(parent)!),
        ),
        expected = createHash(format).update(`commit ${raw.length}\0`).update(raw).digest('hex');
      invariant(commit === expected, 'INVALID_NATIVE_GIT', 'Reuse commit differs from native source.');
    }
  }
  // Full exports leave native objects loose. Clone those independent files rather
  // than rewriting every old object through unpack-objects. Never copy config,
  // refs, hooks, alternates or pack deltas into the final projection.
  for (const blob of blobs.values()) objects.add(blob);
  for (const oid of objects) {
    const prefix = oid.slice(0, 2),
      name = oid.slice(2),
      directory = join(previous, 'repository.git/objects', prefix),
      path = join(directory, name);
    if (!existsSync(path)) continue; // Imported objects can already be in original packs.
    invariant(
      lstatSync(directory).isDirectory() && lstatSync(path).isFile(),
      'INVALID_NATIVE_GIT',
      'Reuse loose object is invalid.',
    );
    mkdirSync(join(repo, 'objects', prefix), { recursive: true, mode: 0o700 });
    copyFileSync(path, join(repo, 'objects', prefix, name), constants.COPYFILE_FICLONE);
  }
  // Retain only original imported packs, which were installed before reuse.
  // Reusing native pack deltas can change a subsequent bundle's byte identity.
  for (const name of readdirSync(join(repo, 'objects/pack')))
    if (!packs.has(name)) rmSync(join(repo, 'objects/pack', name));
  await git(repo, ['--no-lazy-fetch', 'fsck', '--full', '--strict', '--no-reflogs', '--no-dangling']);
  invariant(
    (await git(repo, ['--no-lazy-fetch', 'cat-file', '--batch-check'], commits.join('\n') + '\n')).trim() ===
      present.join('\n'),
    'INVALID_NATIVE_GIT',
    'Reuse loose commit objects are absent.',
  );
  return { mappings, blobs };
}
