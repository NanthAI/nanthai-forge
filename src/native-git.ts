import { scanSourcePaths } from './source-paths.js';
// SPDX-License-Identifier: Apache-2.0
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { TextDecoder } from 'node:util';
import { NativeSource, nativeMarker, type NativeFile } from './native-source.js';
import { WorkStore } from './work-store.js';
import type { GitProjection } from './work-types.js';
import { workGit } from './work-git.js';
import { asyncGitTreeWriter } from './native-git-tree.js';
import { batchObjectWriter } from './native-git-batch.js';
import { nativeGitRunner } from './native-git-runner.js';
import { nativeCommitBytes, reuseNativeGit } from './native-git-reuse.js';
export { treeForGit } from './native-git-tree.js';
import { fullGitBundle } from './work-git-bundle.js';
import { withGithubTransport } from './work-github.js';
import { safeRelative } from './files.js';
import { digest } from './hash.js';
import { ForgeError, invariant } from './errors.js';

import { createWork } from './work-create.js';

const gitId = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
export function filesFromGit(root: string, head: string, source: NativeSource): NativeFile[] {
  const bytes = workGit(
    root,
    ['--no-lazy-fetch', 'ls-tree', '-rz', '--full-tree', head],
    undefined,
    false,
    true,
  );
  return bytes
    .subarray(0, bytes.length - 1)
    .toString('binary')
    .split('\0')
    .filter(Boolean)
    .map((record): NativeFile => {
      const split = record.indexOf('\t'),
        header = record.slice(0, split).split(' ');
      let path: string;
      try {
        path = new TextDecoder('utf-8', { fatal: true }).decode(
          Buffer.from(record.slice(split + 1), 'binary'),
        );
      } catch {
        throw new ForgeError(
          'UNSUPPORTED_NATIVE_GIT_FILE',
          'Git source path is not UTF-8. Original history is retained.',
        );
      }
      invariant(
        split > 0 &&
          safeRelative(path) &&
          !path
            .toLowerCase()
            .split('/')
            .some(part => ['.git', '.forge'].includes(part)) &&
          header[1] === 'blob' &&
          ['100644', '100755', '120000'].includes(header[0]!),
        'UNSUPPORTED_NATIVE_GIT_FILE',
        `Native workspace cannot represent this tracked path: ${path}. Original repository is preserved.`,
      );
      const blob = source.put(
        workGit(root, ['--no-lazy-fetch', 'cat-file', 'blob', header[2]!], undefined, false, true),
      );
      return {
        path,
        blob,
        mode: header[0] === '120000' ? 'symlink' : header[0] === '100755' ? 'executable' : 'file',
      };
    })
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}
function refs(root: string) {
  return workGit(root, ['for-each-ref', '--format=%(refname) %(objectname)'])
    .trim()
    .split('\n')
    .filter(Boolean)
    .map(line => {
      const [ref, head] = line.split(' ');
      return { ref: ref!, head: head! };
    });
}
function fresh(target: string) {
  const destination = resolve(target);
  invariant(
    !existsSync(destination),
    'RESTORE_TARGET_EXISTS',
    'Choose a new destination; original files and repositories are retained.',
  );
  const scratch = realpathSync(mkdtempSync(join(realpathSync(dirname(destination)), '.forge-git-boundary-')));
  return { destination, scratch };
}
function publish(output: string, destination: string) {
  invariant(
    !existsSync(destination),
    'RESTORE_TARGET_EXISTS',
    'Destination appeared during transfer; concurrent files are retained.',
  );
  mkdirSync(destination, { mode: 0o700 });
  try {
    renameSync(output, destination);
  } catch (error) {
    try {
      rmdirSync(destination);
    } catch {
      /* Preserve concurrent files. */
    }
    throw error;
  }
}
export async function importNativeGit(input: string, commit: string, target: string) {
  invariant(
    gitId.test(commit),
    'BAD_ARGUMENT',
    'Select an exact original Git commit ID. Run git rev-parse HEAD in the Git repository and pass that full ID.',
  );
  const store = new WorkStore(input),
    { destination, scratch } = fresh(target);
  try {
    invariant(!store.native, 'BAD_ARGUMENT', 'Select an existing Git-backed repository.');
    invariant(
      workGit(store.root, ['--no-lazy-fetch', 'rev-parse', '--verify', `${commit}^{commit}`]).trim() ===
        commit,
      'BAD_ARGUMENT',
      'Select an original commit, not a tag object.',
    );
    const owner = join(scratch, 'owner');
    mkdirSync(owner, { mode: 0o700 });
    const source = new NativeSource(owner);
    const files = filesFromGit(store.root, commit, source),
      format = workGit(store.root, ['rev-parse', '--show-object-format']).trim();
    invariant(
      format === 'sha1' || format === 'sha256',
      'UNSUPPORTED_NATIVE_GIT_FORMAT',
      'This native Git format is unavailable.',
    );
    const pins = refs(store.root),
      selected = `refs/forge/native-import/${randomUUID()}`;
    pins.push({ ref: selected, head: commit });
    const bundle = join(scratch, 'source.bundle');
    await withGithubTransport(store, async transport => {
      await fullGitBundle(transport, pins, bundle, 'INVALID_NATIVE_GIT');
    });
    const bundleId = source.put(readFileSync(bundle));
    const head = source.writeState(files, [], 'Imported original Git source', new Date().toISOString(), {
      bundle: bundleId,
      commit,
      format,
    });
    const workspace = join(scratch, 'workspace');
    source.materialize(head, workspace, false);
    invariant(
      JSON.stringify(
        scanSourcePaths(workspace, {
          retained: files.map(file => file.path),
          preserveRetained: true,
        }),
      ) === JSON.stringify(files.map(file => file.path)),
      'UNSUPPORTED_NATIVE_GIT_FILE',
      'Tracked Git files cannot be represented in this native workspace. Original repository is preserved; no partial source is imported.',
    );
    renameSync(join(owner, '.forge'), join(workspace, '.forge'));
    nativeMarker(workspace);
    new WorkStore(workspace).save(createWork(head));
    publish(workspace, destination);
    return {
      root: destination,
      nextCommand: `nforge agent ${"'" + destination.replaceAll("'", "'\\''") + "'"} start '{"outcome":"First change"}'`,
      main: 'No main Channel yet. Start a Lane, define a check and finish; a person reviews and accepts the checked Candidate to establish main. See nforge docs quickstart.',
      head,
      commit,
      format,
      bundleSha256: bundleId,
      files: files.length,
      refs: pins.length,
      coverage:
        'Complete original objects reachable from retained local refs and selected commit. Original Git Work, reflog-only/unreachable objects, working edits and credentials remain in their original owner.',
    };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
export async function exportNativeGit(input: string, head: string, target: string, reuse?: string) {
  invariant(/^[0-9a-f]{64}$/.test(head), 'BAD_ARGUMENT', 'Select an exact retained native State.');
  const store = new WorkStore(input);
  invariant(store.native, 'BAD_ARGUMENT', 'Select a native Forge owner or Lane.');
  const source = new NativeSource(store.root),
    states = [...source.ancestors(head)],
    { destination, scratch } = fresh(target);
  const runner = nativeGitRunner(),
    git = runner.git;
  try {
    const formats = new Set(
      states.flatMap(id => (source.state(id).git ? [source.state(id).git!.format] : [])),
    );
    invariant(
      formats.size <= 1,
      'UNSUPPORTED_NATIVE_GIT_FORMAT',
      'Imported Git object formats differ; original native source is retained.',
    );
    const format = [...formats][0] ?? 'sha1',
      output = join(scratch, 'output');
    mkdirSync(output, { mode: 0o700 });
    const repo = join(output, 'repository.git');
    const init = () =>
      git(scratch, [
        'init',
        '--bare',
        '--template=',
        `--object-format=${format}`,
        '--initial-branch=forge',
        repo,
      ]);
    await init();
    const original = new Map<string, string>();
    async function loadOriginal() {
      original.clear();
      for (const bundle of new Set(
        states.flatMap(id => (source.state(id).git ? [source.state(id).git!.bundle] : [])),
      )) {
        const path = join(scratch, bundle + '.bundle');
        writeFileSync(path, source.object(bundle), { mode: 0o600 });
        await git(repo, ['--no-lazy-fetch', 'bundle', 'verify', path]);
        for (const record of (await git(repo, ['--no-lazy-fetch', 'bundle', 'unbundle', path]))
          .trim()
          .split('\n')) {
          const [oid, ref] = record.split(' ');
          invariant(
            oid && gitId.test(oid) && ref && ref.startsWith('refs/'),
            'INVALID_NATIVE_GIT',
            'Original bundle refs are invalid.',
          );
          const prior = original.get(ref);
          invariant(
            !prior || prior === oid,
            'NATIVE_GIT_REF_CONFLICT',
            'Imported bundles retain different original refs; no destination is published.',
          );
          original.set(ref, oid);
        }
      }
      for (const [ref, oid] of original) await git(repo, ['update-ref', ref, oid]);
    }
    await loadOriginal();
    let reused = { mappings: new Map<string, string>(), blobs: new Map<string, string>() };
    if (reuse) {
      try {
        reused = await reuseNativeGit(reuse, source, states, format, repo, scratch, git);
      } catch {
        process.stderr.write('export-native-git: reuse source is unusable; falling back to full export.\n');
        rmSync(repo, { recursive: true, force: true });
        await init();
        await loadOriginal();
      }
    }
    const mappings = new Map<string, string>(),
      writeObject = batchObjectWriter(scratch, args => runner.batch(repo, args));
    let trees: ReturnType<typeof runner.batch> | undefined;
    const writeTree = asyncGitTreeWriter(
      source,
      bytes => writeObject('blob', bytes),
      bytes => {
        trees ??= runner.batch(repo, ['mktree', '--batch', '-z']);
        return trees.request(bytes);
      },
      reused.blobs,
    );
    async function project(id: string): Promise<string> {
      const existing = mappings.get(id);
      if (existing) return existing;
      const state = source.state(id);
      if (reused.mappings.has(id)) {
        await Promise.resolve();
        for (const parent of state.parents) await project(parent);
        const commit = reused.mappings.get(id)!;
        mappings.set(id, commit);
        return commit;
      }
      const tree = await writeTree(state.files);
      let commit: string;
      const parents: string[] = [];
      for (const parent of state.parents) parents.push(await project(parent));
      if (state.git) {
        invariant(
          (await git(repo, ['--no-lazy-fetch', 'rev-parse', `${state.git.commit}^{tree}`])).trim() === tree,
          'INVALID_NATIVE_GIT',
          'Original imported tree differs from its native State.',
        );
        commit = state.git.commit;
      } else {
        commit = await writeObject('commit', nativeCommitBytes(id, state, tree, parents));
      }
      mappings.set(id, commit);
      return commit;
    }
    const commit = await project(head);
    await runner.finishBatches();
    const branch = `refs/heads/forge-native/${head}`;
    await git(repo, ['update-ref', branch, commit, '']);
    await git(repo, ['symbolic-ref', 'HEAD', branch]);
    const pins = (await git(repo, ['for-each-ref', '--format=%(refname) %(objectname)']))
      .trim()
      .split('\n')
      .filter(Boolean)
      .map(line => {
        const [ref, head] = line.split(' ');
        return { ref: ref!, head: head! };
      });
    pins.push({ ref: 'HEAD', head: commit });
    writeFileSync(join(repo, 'objects/info/alternates'), '');
    const bundle = await fullGitBundle(repo, pins, join(output, 'source.bundle'), 'INVALID_NATIVE_GIT', git);
    const mapping = {
      schema: 1,
      kind: 'forge-native-git-projection',
      head,
      commit,
      format,
      bundleSha256: bundle.sha256,
      states: [...mappings].map(([state, commit]) => ({ state, commit })),
      coverage:
        'Original imported Git objects/refs plus deterministic native-State commits. Forge Work/checks/discussions/acceptances remain in the separate native Work archive; exported authorship is not authenticated.',
    };
    writeFileSync(join(output, 'mapping.json'), JSON.stringify(mapping, null, 2), {
      flag: 'wx',
      mode: 0o600,
    });
    publish(output, destination);
    return { ...mapping, path: destination, bundle: { ...bundle, path: join(destination, 'source.bundle') } };
  } finally {
    await runner.close();
    rmSync(scratch, { recursive: true, force: true });
  }
}

// This is an explicit Git boundary; ordinary native Work never uses the projection as source authority.
export async function prepareNativeProjection(store: WorkStore, head: string) {
  const scratch = mkdtempSync(join(store.directory, 'projection-'));
  try {
    const exported = await exportNativeGit(store.root, head, join(scratch, 'export'));
    const source = new NativeSource(store.root);
    const bundle = readFileSync(exported.bundle.path),
      mapping = readFileSync(join(exported.path, 'mapping.json'));
    const projection: GitProjection = {
      state: head,
      head: exported.commit,
      format: exported.format as GitProjection['format'],
      bundle: digest(bundle),
      mapping: digest(mapping),
    };
    // Caller inserts objects together with its referencing Work record under the existing Work lock.
    return {
      projection,
      bundle,
      mapping,
      retain: () => {
        source.put(bundle);
        source.put(mapping);
        return projection;
      },
    };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
export function validateNativeProjection(store: WorkStore, head: string, projection: GitProjection) {
  const source = new NativeSource(store.root);
  source.state(head);
  const bytes = source.object(projection.mapping);
  let mapping: unknown;
  try {
    mapping = JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new ForgeError('INVALID_NATIVE_GIT', 'Retained native Git mapping is invalid.');
  }
  const pins = mapping as {
    schema?: number;
    kind?: string;
    head?: string;
    commit?: string;
    format?: string;
    bundleSha256?: string;
    states?: { state: string; commit: string }[];
  };
  invariant(
    projection.state === head &&
      pins?.schema === 1 &&
      pins.kind === 'forge-native-git-projection' &&
      pins.head === head &&
      pins.commit === projection.head &&
      pins.format === projection.format &&
      pins.bundleSha256 === projection.bundle &&
      Array.isArray(pins.states) &&
      pins.states.some(item => item?.state === head && item.commit === projection.head),
    'INVALID_NATIVE_GIT',
    'The retained Git projection differs from its original native State.',
  );
  source.object(projection.bundle);
  return projection;
}
export function publicationHead(publication: { head: string; projection?: GitProjection | undefined }) {
  return publication.projection?.head ?? publication.head;
}
