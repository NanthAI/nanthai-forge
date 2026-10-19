// SPDX-License-Identifier: Apache-2.0
import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

// Write authoritative objects directly: git add would apply attributes and filters.
// Read only the selected State, never its ancestry or imported Git bundles.
export async function seedNativeGit(root, head, target) {
  const { NativeSource } = await import('../dist/native-source.js');
  const { treeForGit } = await import('../dist/native-git.js');
  const { workGit } = await import('../dist/work-git.js');
  const source = new NativeSource(root);
  const state = source.state(head);
  if (existsSync(target)) {
    const count = workGit(target, ['rev-list', '--all', '--count']).trim();
    const tree = treeForGit(target, state.files, source);
    if (count !== '1' || workGit(target, ['rev-parse', 'HEAD^{tree}']).trim() !== tree)
      throw new Error(
        'Existing benchmark seed differs from the one-commit main tree; use a fresh --work directory',
      );
    return target;
  }
  mkdirSync(dirname(target), { recursive: true });
  const scratch = mkdtempSync(join(dirname(target), '.bench-seed-'));
  try {
    workGit(scratch, ['init', '--bare', '--template=', '--initial-branch=main', '.']);
    const tree = treeForGit(scratch, state.files, source);
    const raw = `tree ${tree}\nauthor Forge Benchmark <benchmark@localhost> 0 +0000\ncommitter Forge Benchmark <benchmark@localhost> 0 +0000\n\nBenchmark source snapshot\n`;
    const commit = workGit(
      scratch,
      ['hash-object', '-t', 'commit', '-w', '--stdin'],
      Buffer.from(raw),
    ).trim();
    workGit(scratch, ['update-ref', 'refs/heads/main', commit]);
    renameSync(scratch, target);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  return target;
}

// Stage only replaced workflows; adding the entire checkout can normalize
// untouched tracked CRLF files through the source repository's attributes.
export async function prepareGithubClone(exec, seed, clone, workflow) {
  await exec('git', ['clone', '--quiet', seed, clone]);
  const workflows = join(clone, '.github', 'workflows');
  rmSync(workflows, { recursive: true, force: true });
  mkdirSync(workflows, { recursive: true });
  writeFileSync(join(workflows, 'bench-check.yml'), workflow);
  await exec('git', ['-C', clone, 'add', '-A', '--', '.github/workflows']);
  await exec('git', ['-C', clone, 'commit', '--quiet', '-m', 'Benchmark workflow']);
  await exec('git', ['-C', clone, 'branch', '-M', 'main']);
}
