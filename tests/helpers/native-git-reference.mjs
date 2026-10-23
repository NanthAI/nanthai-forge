// SPDX-License-Identifier: Apache-2.0
// The pre-batch projection algorithm, retained as an independent object/byte oracle.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { NativeSource } from '../../dist/native-source.js';
import { treeForGit } from '../../dist/native-git-tree.js';
import { nativeCommitBytes } from '../../dist/native-git-reuse.js';
import { fullGitBundle } from '../../dist/work-git-bundle.js';
import { workGit } from '../../dist/work-git.js';
export async function referenceExport(root, head, output) {
  const source = new NativeSource(root),
    repo = join(output, 'repository.git');
  mkdirSync(output);
  workGit(output, ['init', '--bare', '--template=', '--object-format=sha1', '--initial-branch=forge', repo]);
  const mappings = new Map();
  function project(id) {
    if (mappings.has(id)) return mappings.get(id);
    const state = source.state(id),
      tree = treeForGit(repo, state.files, source);
    const parents = state.parents.map(project);
    const commit = workGit(
      repo,
      ['hash-object', '-t', 'commit', '-w', '--stdin'],
      nativeCommitBytes(id, state, tree, parents),
    ).trim();
    mappings.set(id, commit);
    return commit;
  }
  const commit = project(head),
    branch = `refs/heads/forge-native/${head}`;
  workGit(repo, ['update-ref', branch, commit, '']);
  workGit(repo, ['symbolic-ref', 'HEAD', branch]);
  writeFileSync(join(repo, 'objects/info/alternates'), '');
  const bundle = await fullGitBundle(
    repo,
    [
      { ref: branch, head: commit },
      { ref: 'HEAD', head: commit },
    ],
    join(output, 'source.bundle'),
    'INVALID_NATIVE_GIT',
  );
  const mapping = {
    schema: 1,
    kind: 'forge-native-git-projection',
    head,
    commit,
    format: 'sha1',
    bundleSha256: bundle.sha256,
    states: [...mappings].map(([state, commit]) => ({ state, commit })),
    coverage:
      'Original imported Git objects/refs plus deterministic native-State commits. Forge Work/checks/discussions/acceptances remain in the separate native Work archive; exported authorship is not authenticated.',
  };
  writeFileSync(join(output, 'mapping.json'), JSON.stringify(mapping, null, 2));
  return { ...mapping, path: output, bundle: { ...bundle, path: join(output, 'source.bundle') } };
}
